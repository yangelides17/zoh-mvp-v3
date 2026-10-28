import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { migrationsFolder } from "../src/db/paths.js";
import * as schema from "../src/db/schema.js";
import type { Replier } from "../src/claude/replier.js";
import type { MediaFetcher } from "../src/media/storage.js";
import { maskNumber } from "../src/pipeline/inbound.js";
import type { SendblueClient } from "../src/sendblue/client.js";
import type { NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { appDeps, memoryKeeperFor, nudgeSchedulerFor } from "../src/wiring.js";
import type { MemoryKeeper } from "../src/memory/keeper.js";
import { renderPage } from "../src/memory/render.js";
import { getPages } from "../src/memory/store.js";
import { getTesterByPhone } from "../src/testers/testers.js";
import { evalApiKey } from "./cli.js";
import { EVAL_DAY, EvalClock, zonedDate } from "./clock.js";
import { localDate } from "../src/coach/state.js";
import { guessTimeZone } from "../src/testers/area-codes.js";
import type { ConversationPlan, ConversationResult, Seed, TokenUsage, TranscriptLine } from "./types.js";

const WEBHOOK_SECRET = "eval-webhook-secret";
const LINE = "+15555550100";

/**
 * Stands in for Sendblue: records each text instead of sending it, and refuses any
 * number other than the one fake tester this app was built for.
 */
export class RecordingSendblue implements SendblueClient {
  readonly sent: { number: string; content: string; at: Date }[] = [];
  constructor(
    private readonly allowed: string,
    private readonly now: () => Date,
  ) {}
  async sendMessage(input: { number: string; content?: string }) {
    if (input.number !== this.allowed) throw new Error("Eval Sendblue only texts its own fake tester");
    this.sent.push({ number: input.number, content: input.content ?? "", at: this.now() });
    return { messageHandle: `eval-out-${this.sent.length}`, status: "QUEUED", raw: { status: "QUEUED", eval: true } };
  }
  async sendTypingIndicator() {
    return true;
  }
}

/** No media in the eval yet; anything that tries to download is a bug in a scenario. */
export const noMediaFetcher: MediaFetcher = async () => {
  throw new Error("The eval has no media to fetch");
};

/** Fake number in the reserved 555-01xx range, with the scenario's area code. */
export function fakeNumber(areaCode: string, index: number): string {
  return `+1${areaCode}55501${String(index % 100).padStart(2, "0")}`;
}

/**
 * Config for the eval's app: only the Claude settings come from the environment.
 * Sendblue, bucket and Speaches settings are never read, so no real client can be built.
 */
export function evalConfig(env: NodeJS.ProcessEnv, phone: string): Config {
  return loadConfig({
    DATABASE_URL: "pglite://in-memory",
    ANTHROPIC_API_KEY: evalApiKey(env),
    CLAUDE_MODEL: env.CLAUDE_MODEL,
    CLAUDE_MAX_TOKENS: env.CLAUDE_MAX_TOKENS,
    ALLOWED_NUMBERS: phone,
    TYPING_INDICATOR: "false",
    LOG_LEVEL: "silent",
  });
}

/** Blocks any request to Sendblue from this process, as a second lock behind the fake client. */
export function guardFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/sendblue/i.test(new URL(url).hostname)) throw new Error("The eval must never call Sendblue");
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

export interface EvalApp {
  built: BuiltApp;
  db: Db;
  client: PGlite;
  sendblue: RecordingSendblue;
  clock: EvalClock;
  phone: string;
  /** The production nudge tick on the same app; the eval runs it when a case says "advance to". */
  nudger: NudgeScheduler;
  /** The overnight memory pass, for features that grade memory; ticked alongside the nudger. */
  keeper?: MemoryKeeper;
  close(): Promise<void>;
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** The production app, built through src/wiring.ts, on a fresh in-memory database. */
export async function startEvalApp(opts: {
  config: Config;
  phone: string;
  clock: EvalClock;
  /** Tests pass a fake coach; the eval leaves this out and gets the real one from wiring. */
  replier?: Replier;
  /** Run the overnight memory pass when the clock passes 3 am (the memory feature). */
  memory?: boolean;
}): Promise<EvalApp> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  const sendblue = new RecordingSendblue(opts.phone, opts.clock.now);
  const deps = appDeps(
    opts.config,
    db as unknown as Db,
    {
      sendblue,
      media: undefined,
      transcriber: undefined,
      fetchMedia: noMediaFetcher,
      allowedNumbers: [opts.phone],
      now: opts.clock.now,
      ...(opts.replier ? { replier: opts.replier } : {}),
    },
    { webhookSecret: WEBHOOK_SECRET, logger: false },
  );
  const built = await buildApp(deps);
  const nudger = nudgeSchedulerFor(deps, quietLog, LINE);
  const keeper = opts.memory ? memoryKeeperFor(opts.config, deps, quietLog) : undefined;
  return {
    built,
    db: db as unknown as Db,
    client,
    sendblue,
    clock: opts.clock,
    phone: opts.phone,
    nudger,
    keeper,
    async close() {
      await nudger.stop();
      await keeper?.stop();
      await built.queue.idle();
      await built.app.close();
      await client.close();
    },
  };
}

/** Sends one tester text through the real webhook and returns ZOH's replies to it. */
export async function textZoh(app: EvalApp, text: string, handle: string): Promise<TranscriptLine[]> {
  const before = app.sendblue.sent.length;
  const at = app.clock.now();
  const res = await app.built.app.inject({
    method: "POST",
    url: "/webhooks/sendblue",
    headers: { "sb-signing-secret": WEBHOOK_SECRET },
    payload: {
      content: text,
      is_outbound: false,
      status: "RECEIVED",
      message_handle: handle,
      date_sent: at.toISOString(),
      from_number: app.phone,
      number: app.phone,
      to_number: LINE,
      sendblue_number: LINE,
      media_url: "",
      message_type: "message",
      group_id: "",
      service: "iMessage",
    },
  });
  if (res.statusCode !== 200) throw new Error(`Webhook answered ${res.statusCode}`);
  await app.built.queue.idle();
  return app.sendblue.sent.slice(before).map((s) => ({ from: "zoh" as const, text: s.content, at: s.at.toISOString() }));
}

/** A case line that moves time instead of texting: "advance to 18:50". */
export const ADVANCE_LINE = /^advance to (\d{2}:\d{2})$/i;

/**
 * Moves the clock minute by minute to the next local `hhmm`, running the nudge tick each minute
 * as production does, and returns the texts ZOH started on the way.
 */
export async function advanceTo(app: EvalApp, hhmm: string, timeZone: string): Promise<TranscriptLine[]> {
  const now = app.clock.now();
  let target = zonedDate(localDate(now, timeZone), hhmm, timeZone);
  if (target <= now) target = zonedDate(localDate(now, timeZone, 1), hhmm, timeZone);
  const before = app.sendblue.sent.length;
  let next = Math.ceil(now.getTime() / 60_000) * 60_000;
  for (; next <= target.getTime(); next += 60_000) {
    app.clock.set(new Date(next));
    await app.nudger.tick(app.clock.now());
    await app.keeper?.tick(app.clock.now());
  }
  app.clock.set(target);
  return app.sendblue.sent.slice(before).map((s) => ({ from: "zoh" as const, text: s.content, at: s.at.toISOString(), started: true }));
}

/** Plays the tester's side: returns the next text, or null when the tester is done. */
export interface Tester {
  next(transcript: TranscriptLine[]): Promise<string | null>;
  usage(): TokenUsage;
  /** Why it stopped when next() returned null. */
  readonly endReason: "simulator" | "script";
}

/** Replays a regression case's lines in order, one per turn. */
export function scriptedTester(lines: string[]): Tester {
  let i = 0;
  return {
    endReason: "script",
    async next() {
      return i < lines.length ? (lines[i++] as string) : null;
    },
    usage: () => ({ input: 0, output: 0 }),
  };
}

/** Rough human pacing: reading and typing time grows with the length of the text. */
export function typingDelayMs(text: string): number {
  return 20_000 + Math.min(text.length, 300) * 300;
}

export interface RunOptions {
  maxTurns: number;
  index: number;
  env: NodeJS.ProcessEnv;
  replier?: Replier;
  /** The feature grades memory: run the overnight pass and read back what it wrote. */
  memory?: boolean;
}

/** Gap between seeded texts, which end a minute before the run's first text. */
const SEED_STEP_MS = 60_000;

/**
 * Puts a tester partway in: their row, saved answers, the conversation so far and, for an
 * active seed, a locked plan starting today. Returns that conversation as context lines.
 */
export async function seedTester(app: EvalApp, seed: Seed): Promise<TranscriptLine[]> {
  const now = app.clock.now();
  const gap = (seed.history.length + 1) * SEED_STEP_MS + seed.history_hours_ago * 60 * 60_000;
  const startedAt = new Date(now.getTime() - gap);
  // Stored rows get real times, like the messages the app itself stores (database default);
  // the eval clock only sets what the coach reads as "now" and the times the grader sees.
  const storedStart = new Date(Date.now() - gap);
  const { timeZone, status } = guessTimeZone(app.phone);
  const [tester] = await app.db
    .insert(schema.testers)
    .values({
      phone: app.phone,
      name: seed.name,
      goalSlug: seed.goal,
      phase: seed.plan ? "active" : seed.phase,
      timeZone,
      timeZoneStatus: status,
      consentAt: storedStart,
      contextStartedAt: storedStart,
    })
    .returning();
  const a = seed.answers;
  await app.db.insert(schema.planInputs).values({
    testerId: tester!.id,
    goalSlug: seed.goal,
    what: a.what,
    where: a.where,
    when: a.when,
    howLong: a.how_long,
    tracksWith: a.tracks_with,
  });
  if (seed.plan) {
    const p = seed.plan;
    const [plan] = await app.db.insert(schema.plans).values({
      testerId: tester!.id,
      goalSlug: seed.goal,
      status: "locked",
      version: 1,
      setupStep: p.setup_step,
      step: p.step,
      place: p.place,
      stepTime: p.time,
      days: p.days,
      proof: p.proof,
      proofNote: p.proof_note,
      reason: p.reason,
      minutes: p.minutes,
      startDate: localDate(now, timeZone, -p.started_days_ago),
      commitment: "I'm in",
      needsReview: true,
      // Locked the day before day 1 (on the eval clock), so today's kickoff isn't skipped as "just
      // locked" and seeded step days count toward the slip ladder.
      lockedAt: new Date(startedAt.getTime() - (p.started_days_ago + 1) * 24 * 60 * 60_000),
    }).returning();
    for (const d of seed.step_days) {
      await app.db
        .insert(schema.stepDays)
        .values({ testerId: tester!.id, date: localDate(now, timeZone, -d.days_ago), planId: plan!.id, status: d.status });
    }
  }
  const context: TranscriptLine[] = [];
  for (const [i, line] of seed.history.entries()) {
    const at = new Date(startedAt.getTime() + i * SEED_STEP_MS);
    await app.db.insert(schema.messages).values({
      direction: line.from === "tester" ? "inbound" : "outbound",
      contactNumber: app.phone,
      lineNumber: LINE,
      content: line.text,
      createdAt: new Date(storedStart.getTime() + i * SEED_STEP_MS),
      // What the nudge tick reads as the text's time, on the eval clock.
      sentAt: at,
    });
    context.push({ from: line.from, text: line.text, at: at.toISOString() });
  }
  return context;
}

/** Runs one conversation end to end against a fresh app and reads back what was saved. */
export async function runConversation(plan: ConversationPlan, tester: Tester, opts: RunOptions): Promise<ConversationResult> {
  const phone = fakeNumber(plan.areaCode, opts.index);
  const clock = new EvalClock(zonedDate(EVAL_DAY, plan.startTime, plan.timeZone));
  const app = await startEvalApp({ config: evalConfig(opts.env, phone), phone, clock, replier: opts.replier, memory: opts.memory });
  const context = plan.seed ? await seedTester(app, plan.seed) : [];
  const transcript: TranscriptLine[] = [];
  let endedBy: ConversationResult["endedBy"] = "turn-cap";
  let error: string | undefined;
  try {
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      const text = await tester.next([...context, ...transcript]);
      if (text === null) {
        endedBy = tester.endReason;
        break;
      }
      const advance = ADVANCE_LINE.exec(text.trim());
      if (advance) {
        transcript.push(...(await advanceTo(app, advance[1]!, plan.timeZone)));
        continue;
      }
      transcript.push({ from: "tester", text, at: clock.now().toISOString() });
      clock.advance(5_000);
      transcript.push(...(await textZoh(app, text, `eval-${plan.key}-${turn}`)));
      clock.advance(typingDelayMs(text));
    }
  } catch (err) {
    endedBy = "error";
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    const savedState = await readSavedState(app.client, phone);
    const messages = await app.client.query<{ n: number; errors: string[] | null }>(
      "select count(*)::int as n, array_remove(array_agg(distinct error), null) as errors from messages",
    );
    const row = messages.rows[0];
    return {
      plan,
      phone,
      context,
      transcript,
      endedBy,
      error,
      ...(opts.memory ? { memory: await readMemory(app) } : {}),
      savedState,
      messageCount: row?.n ?? 0,
      appErrors: row?.errors ?? [],
      usage: tester.usage(),
    };
  } finally {
    await app.close();
  }
}

/**
 * Every row, outside the messages log, that belongs to this tester: rows holding their
 * number, then rows pointing at those rows' ids (e.g. a goal or plan inputs keyed by tester id).
 * Generic on purpose, so it picks up whatever tables T1 and T2 add.
 */
export async function readSavedState(client: PGlite, phone: string): Promise<Record<string, unknown[]>> {
  const tables = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'messages' order by table_name",
  );
  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  for (const { table_name } of tables.rows) {
    const rows = await client.query<Record<string, unknown>>(`select * from "${table_name.replace(/"/g, '""')}"`);
    rowsByTable.set(table_name, rows.rows);
  }
  const keys = new Set<unknown>([phone]);
  const picked = new Map<string, Set<Record<string, unknown>>>();
  // Two hops covers tester -> goal/plan rows -> rows keyed by those.
  for (let hop = 0; hop < 3; hop++) {
    for (const [table, rows] of rowsByTable) {
      for (const row of rows) {
        if (Object.values(row).some((v) => keys.has(v))) {
          if (!picked.has(table)) picked.set(table, new Set());
          picked.get(table)!.add(row);
          if (row.id !== undefined) keys.add(row.id);
        }
      }
    }
  }
  const out: Record<string, unknown[]> = {};
  for (const [table, rows] of picked) out[table] = [...rows].map((row) => plainRow(row, phone));
  return out;
}

/** The tester's memory as the coach would read it: every page, core pages first, daily docs last. */
export async function readMemory(app: EvalApp): Promise<string> {
  const tester = await getTesterByPhone(app.db, app.phone);
  if (!tester) return "(no tester)";
  const order = ["self", "preferences", "goal", "person", "subject", "daily"];
  const pages = (await getPages(app.db, tester.id)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (pages.length === 0) return "(nothing in memory: the overnight pass didn't run or found no texts)";
  return (await Promise.all(pages.map((p) => renderPage(app.db, tester, p)))).join("\n\n");
}

/** JSON-friendly, with the (fake) number masked like everywhere else. */
function plainRow(row: Record<string, unknown>, phone: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v === phone ? maskNumber(phone) : v]),
  );
}
