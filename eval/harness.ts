import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { migrationsFolder } from "../src/db/paths.js";
import * as schema from "../src/db/schema.js";
import type { Replier } from "../src/claude/replier.js";
import { maskNumber } from "../src/pipeline/inbound.js";
import type { SendblueClient } from "../src/sendblue/client.js";
import type { NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { appDeps, memoryKeeperFor, nudgeSchedulerFor } from "../src/wiring.js";
import type { MemoryKeeper } from "../src/memory/keeper.js";
import { renderPage } from "../src/memory/render.js";
import { addFact, createPage, ensureCorePages, ensureGoalPages, getPages, link } from "../src/memory/store.js";
import { and, desc, eq } from "drizzle-orm";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { stepLog, type ConsoleCoach } from "../src/console/chat.js";
import { loadCurrentPlan } from "../src/coach/state.js";
import { serviceDate } from "../src/nudges/schedule.js";
import { COACH_AUTHOR } from "../src/console/requests.js";
import { getTesterByPhone } from "../src/testers/testers.js";
import { evalApiKey } from "./cli.js";
import { EVAL_DAY, EvalClock, zonedDate } from "./clock.js";
import { evalMediaFetcher, evalTranscriber, parseMediaLine } from "./media.js";
import { localDate } from "../src/coach/state.js";
import { guessTimeZone } from "../src/testers/area-codes.js";
import type { ConversationPlan, ConversationResult, Seed, TokenUsage, TranscriptLine } from "./types.js";

const WEBHOOK_SECRET = "eval-webhook-secret";
const CONSOLE_SECRET = "eval-console-secret";
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
  async optIn(number: string) {
    if (number !== this.allowed) throw new Error("Eval Sendblue only touches its own fake tester");
  }
}

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
    CONSOLE_PASSWORD: "eval-console-password",
    CONSOLE_SESSION_SECRET: CONSOLE_SECRET,
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
  /** Errors the nudge tick and memory pass logged (they never reach a message row), for the report. */
  backgroundErrors: string[];
  close(): Promise<void>;
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** Quiet, except errors are kept: a nudge that keeps failing to be written would otherwise vanish. */
function errorKeepingLog(errors: string[]): Logger {
  const error = (obj: unknown, msg?: string) => {
    const err = (obj as { err?: { message?: string } } | undefined)?.err?.message;
    errors.push([msg, err].filter(Boolean).join(": "));
  };
  return { ...quietLog, error } as unknown as Logger;
}

/** The production app, built through src/wiring.ts, on a fresh in-memory database. */
export async function startEvalApp(opts: {
  config: Config;
  phone: string;
  clock: EvalClock;
  /** Tests pass a fake coach; the eval leaves this out and gets the real one from wiring. */
  replier?: Replier;
  /** Tests pass a fake console coach; the eval gets the real one from wiring. */
  consoleCoach?: ConsoleCoach;
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
      // Case photos come from eval/fixtures; voice notes carry their transcript (eval/media.ts).
      transcriber: evalTranscriber,
      fetchMedia: evalMediaFetcher,
      // Photo descriptions are for memory's search, not the reply being graded: skip the extra Claude call.
      describer: undefined,
      allowedNumbers: [opts.phone],
      now: opts.clock.now,
      ...(opts.replier ? { replier: opts.replier } : {}),
    },
    { webhookSecret: WEBHOOK_SECRET, logger: false, ...(opts.consoleCoach ? { consoleCoach: opts.consoleCoach } : {}) },
  );
  const built = await buildApp(deps);
  const backgroundErrors: string[] = [];
  const nudger = nudgeSchedulerFor(deps, errorKeepingLog(backgroundErrors), LINE);
  const keeper = opts.memory ? memoryKeeperFor(opts.config, deps, errorKeepingLog(backgroundErrors)) : undefined;
  return {
    built,
    db: db as unknown as Db,
    client,
    sendblue,
    clock: opts.clock,
    phone: opts.phone,
    nudger,
    keeper,
    backgroundErrors,
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
export async function textZoh(app: EvalApp, text: string, handle: string, mediaUrl = ""): Promise<TranscriptLine[]> {
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
      media_url: mediaUrl,
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

/** A case line from a founder in the console chat: "console Yanni: ...", "console Yanni (exact, now): ...". */
export const CONSOLE_LINE = /^console (\w+)(?: \((exact(?:, now)?)\))?: ([\s\S]+)$/i;

/**
 * Sends a founder's line through the real console chat route, as that founder, and returns it
 * with ZOH's console answer. A "send exactly this" line gets one nudge tick a minute later, as
 * production would, so the text it sends joins the transcript.
 */
export async function consoleSay(app: EvalApp, line: RegExpExecArray): Promise<TranscriptLine[]> {
  const [, name, flags, text] = line as unknown as [string, string, string | undefined, string];
  const tester = await getTesterByPhone(app.db, app.phone);
  if (!tester) throw new Error("A console line needs a tester: seed one first");
  const at = app.clock.now();
  const before = await app.db.select({ id: schema.consoleMessages.id }).from(schema.consoleMessages).where(eq(schema.consoleMessages.testerId, tester.id));
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(at, name), CONSOLE_SECRET))}`;
  const form = new URLSearchParams({ text, ...(flags ? { exact: "on" } : {}), ...(flags?.endsWith("now") ? { sendNow: "on" } : {}) });
  const res = await app.built.app.inject({
    method: "POST",
    url: `/console/testers/${tester.id}/chat`,
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    payload: form.toString(),
  });
  if (res.statusCode !== 303) throw new Error(`Console chat answered ${res.statusCode}: ${res.body.slice(0, 200)}`);
  await app.built.queue.idle();
  const seen = new Set(before.map((r) => r.id));
  const answers = (await app.db.select().from(schema.consoleMessages).where(eq(schema.consoleMessages.testerId, tester.id)))
    .filter((m) => !seen.has(m.id) && m.kind === "coach" && m.author === COACH_AUTHOR)
    .map((m) => ({ from: "zoh" as const, text: m.body, at: m.createdAt.toISOString(), console: true }));
  const out: TranscriptLine[] = [{ from: "founder", text: `${name}${flags ? ` (${flags})` : ""}: ${text}`, at: at.toISOString() }, ...answers];
  app.clock.advance(30_000);
  if (flags) {
    const sendsBefore = app.sendblue.sent.length;
    app.clock.advance(60_000);
    await app.nudger.tick(app.clock.now());
    out.push(...app.sendblue.sent.slice(sendsBefore).map((s) => ({ from: "zoh" as const, text: s.content, at: s.at.toISOString(), started: true })));
  }
  return out;
}

/** The tester's dated step log as the console coach sees it, for the grader (console feature). */
async function readStepLog(app: EvalApp): Promise<string | undefined> {
  const tester = await getTesterByPhone(app.db, app.phone);
  if (!tester) return undefined;
  const today = serviceDate(app.clock.now(), tester);
  const plan = await loadCurrentPlan(app.db, tester, today);
  return plan ? stepLog(app.db, tester, plan, today) : undefined;
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
  consoleCoach?: ConsoleCoach;
  /** The feature grades memory: run the overnight pass and read back what it wrote. */
  memory?: boolean;
  /** Show the grader what ZOH saved during the run. */
  saved?: boolean;
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
  // Seeded memory reaches further back: start their context before the oldest of it.
  const oldest = memoryDays(seed);
  const contextStart = oldest ? new Date(Math.min(storedStart.getTime(), now.getTime() - (oldest + 1) * DAY_MS)) : storedStart;
  const [tester] = await app.db
    .insert(schema.testers)
    .values({
      phone: app.phone,
      name: seed.name,
      goalSlug: seed.goal,
      phase: seed.plan ? "active" : seed.phase,
      timeZone,
      timeZoneStatus: status,
      consentAt: contextStart,
      contextStartedAt: contextStart,
      styleNotes: (seed.memory?.pages ?? [])
        .flatMap((p) => (p.kind === "preferences" ? p.facts.filter((f) => f.section === "stated").map((f) => f.text) : []))
        .join("; "),
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
  const earlierPlans = seed.memory?.earlier_plans ?? [];
  if (seed.plan) {
    const p = seed.plan;
    for (const [i, e] of earlierPlans.entries()) {
      await app.db.insert(schema.plans).values({
        testerId: tester!.id,
        goalSlug: seed.goal,
        status: "locked",
        version: i + 1,
        step: e.step,
        place: p.place,
        stepTime: p.time,
        days: p.days,
        proof: p.proof,
        reason: p.reason,
        startDate: localDate(now, timeZone, -e.days_ago),
        commitment: "I'm in",
        lockedAt: new Date(now.getTime() - e.days_ago * DAY_MS),
      });
    }
    const [plan] = await app.db.insert(schema.plans).values({
      testerId: tester!.id,
      goalSlug: seed.goal,
      status: "locked",
      version: earlierPlans.length + 1,
      setupStep: p.setup_step,
      step: p.step,
      destination: p.destination,
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
        .values({
          testerId: tester!.id,
          date: localDate(now, timeZone, -d.days_ago),
          planId: plan!.id,
          status: d.status,
          step: d.step ?? null,
          note: d.note ?? null,
          proofSeen: d.proof_seen ?? null,
          movedTime: d.moved_time ?? null,
        });
    }
    await seedNextSteps(app, tester!, seed, earlierPlans.length + 2, now);
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
  if (seed.memory) await seedMemory(app, tester!, seed.memory, now);
  return context;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The seeded goal as their focus, maintenance goals (a plan each, the streak they carried and their
 * check-ins) and next steps as the founders left them. Plan versions for maintenance goals start at `version`.
 */
async function seedNextSteps(app: EvalApp, tester: schema.Tester, seed: Seed, version: number, now: Date): Promise<void> {
  const { timeZone } = tester;
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);
  await app.db.insert(schema.testerGoals).values({ testerId: tester.id, goalSlug: seed.goal, role: "focus", roleSince: daysAgo(seed.plan?.started_days_ago ?? 0) });
  for (const [i, m] of seed.maintenance.entries()) {
    const start = m.since_days_ago + m.streak_days + 1;
    const [plan] = await app.db
      .insert(schema.plans)
      .values({
        testerId: tester.id,
        goalSlug: m.goal,
        status: "locked",
        version: version + i,
        step: m.step,
        stepTime: m.time,
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        proof: "photo",
        reason: "Their earlier focus.",
        startDate: localDate(now, timeZone, -start),
        commitment: "I'm in",
        lockedAt: daysAgo(start + 1),
      })
      .returning();
    for (let d = 0; d < m.streak_days; d++) {
      const date = localDate(now, timeZone, -(m.since_days_ago + 1 + d));
      await app.db.insert(schema.stepDays).values({ testerId: tester.id, date, planId: plan!.id, status: "done" });
    }
    await app.db.insert(schema.testerGoals).values({
      testerId: tester.id,
      goalSlug: m.goal,
      role: "maintenance",
      nudges: false,
      proof: false,
      checkinsPerWeek: 2,
      roleSince: daysAgo(m.since_days_ago),
    });
    for (const c of m.checkins) {
      await app.db.insert(schema.maintenanceCheckins).values({
        testerId: tester.id,
        goalSlug: m.goal,
        date: localDate(now, timeZone, -c.days_ago),
        answer: c.answer,
        answeredAt: c.answer ? daysAgo(c.days_ago) : null,
      });
    }
  }
  for (const s of seed.suggestions) {
    await app.db.insert(schema.suggestions).values({
      testerId: tester.id,
      goalSlug: seed.goal,
      kind: s.kind,
      raisedBy: s.raised_by,
      proposal: s.proposal,
      reasoning: s.reasoning,
      newGoalSlug: s.new_goal,
      decision: s.decision,
      decidedBy: s.decision === "waiting" ? null : "Yanni",
      decidedKind: s.decided_kind,
      decidedProposal: s.decided_proposal,
      outcome: s.outcome,
    });
  }
}

/** How many days back a seed's memory reaches (0 without one). */
function memoryDays(seed: Seed): number {
  const m = seed.memory;
  if (!m) return 0;
  return Math.max(
    0,
    ...m.pages.flatMap((p) => p.facts.map((f) => f.days_ago)),
    ...m.daily.map((d) => d.days_ago),
    ...m.earlier_plans.map((e) => e.days_ago),
    ...m.earlier_goals.map((g) => g.days_ago),
  );
}

/** Files a seed's memory the way the overnight pass would have, dated on the eval clock. */
async function seedMemory(app: EvalApp, tester: schema.Tester, memory: NonNullable<Seed["memory"]>, now: Date): Promise<void> {
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);
  const goals = [...memory.earlier_goals.map((g) => g.goal), tester.goalSlug];
  for (const [i, g] of memory.earlier_goals.entries()) {
    await app.db
      .insert(schema.flags)
      .values({ testerId: tester.id, kind: "goal_switch", detail: `${g.goal} → ${goals[i + 1]}: ${g.reason}`, createdAt: daysAgo(g.days_ago) });
  }
  const { self, preferences } = await ensureCorePages(app.db, tester, daysAgo(memoryDays({ memory } as Seed) + 1));
  const goalPages = await ensureGoalPages(app.db, tester, now);
  const current = goalPages.find((p) => p.goalSlug === tester.goalSlug);
  for (const p of memory.pages) {
    const page =
      p.kind === "self" ? self
      : p.kind === "preferences" ? preferences
      : p.kind === "goal" ? current
      : await createPage(app.db, tester.id, { kind: p.kind, title: p.title ?? "(untitled)", summary: p.summary ?? "" }, daysAgo(Math.min(...p.facts.map((f) => f.days_ago))));
    if (!page) continue;
    if (p.kind === "person" || p.kind === "subject") {
      await link(app.db, tester.id, self.id, page.id, "related");
      if (p.related_to_goal && current) await link(app.db, tester.id, page.id, current.id, "related");
    }
    for (const f of p.facts) {
      await addFact(app.db, page, { text: f.text, sourceMessageId: null, section: f.section ?? "", day: localDate(daysAgo(f.days_ago), tester.timeZone) }, daysAgo(f.days_ago));
    }
  }
  for (const d of memory.daily) {
    const at = daysAgo(d.days_ago - 1);
    await createPage(app.db, tester.id, { kind: "daily", date: localDate(daysAgo(d.days_ago), tester.timeZone), title: d.title, summary: d.summary, body: d.body }, at);
  }
  // Memory is filed through yesterday, so the run's overnight pass (if any) only files the run's own day.
  await app.db.update(schema.testers).set({ memoryThrough: localDate(now, tester.timeZone, -1) }).where(eq(schema.testers.id, tester.id));
}

/** Runs one conversation end to end against a fresh app and reads back what was saved. */
export async function runConversation(plan: ConversationPlan, tester: Tester, opts: RunOptions): Promise<ConversationResult> {
  const phone = fakeNumber(plan.areaCode, opts.index);
  const clock = new EvalClock(zonedDate(EVAL_DAY, plan.startTime, plan.timeZone));
  const app = await startEvalApp({ config: evalConfig(opts.env, phone), phone, clock, replier: opts.replier, consoleCoach: opts.consoleCoach, memory: opts.memory });
  const context = plan.seed ? await seedTester(app, plan.seed) : [];
  // What ZOH knew going in, so the grader judges a fact it later forgot against memory as it was.
  const memoryBefore = opts.memory ? await readMemory(app) : undefined;
  const record = plan.regression?.testerLines.some((l) => CONSOLE_LINE.test(l.trim())) ? await readStepLog(app) : undefined;
  const savedBefore = opts.saved ? await savedIds(app) : undefined;
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
      const founder = CONSOLE_LINE.exec(text.trim());
      if (founder) {
        transcript.push(...(await consoleSay(app, founder)));
        continue;
      }
      // The grader reads the line as written ("[photo ...: what it shows] caption"); ZOH gets the media.
      transcript.push({ from: "tester", text, at: clock.now().toISOString() });
      clock.advance(5_000);
      const media = parseMediaLine(text);
      transcript.push(...(await textZoh(app, media?.caption ?? text, `eval-${plan.key}-${turn}`, media?.mediaUrl)));
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
      ...(record ? { record } : {}),
      ...(savedBefore ? { saved: await readSaved(app, savedBefore) } : {}),
      ...(opts.memory ? { memory: `--- At the start of the conversation ---\n${memoryBefore}\n\n--- At the end ---\n${await readMemory(app)}` } : {}),
      savedState,
      messageCount: row?.n ?? 0,
      appErrors: [...new Set([...(row?.errors ?? []), ...app.backgroundErrors])],
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

/** Ids of the tester's flags, pauses and plans, so the run's new ones can be told apart (rows carry the real clock). */
async function savedIds(app: EvalApp): Promise<Set<string>> {
  const tester = await getTesterByPhone(app.db, app.phone);
  if (!tester) return new Set();
  const rows = [
    ...(await app.db.select({ id: schema.flags.id }).from(schema.flags).where(eq(schema.flags.testerId, tester.id))),
    ...(await app.db.select({ id: schema.pauses.id }).from(schema.pauses).where(eq(schema.pauses.testerId, tester.id))),
    ...(await app.db.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.testerId, tester.id))),
  ];
  return new Set(rows.map((r) => r.id));
}

/** Flags, pauses and plan versions ZOH saved during the run, and the style it ended on, one line each. */
export async function readSaved(app: EvalApp, before: Set<string>): Promise<string> {
  const tester = await getTesterByPhone(app.db, app.phone);
  if (!tester) return "(no tester)";
  const fresh = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !before.has(r.id));
  const flagged = fresh(await app.db.select().from(schema.flags).where(eq(schema.flags.testerId, tester.id)));
  const paused = fresh(await app.db.select().from(schema.pauses).where(eq(schema.pauses.testerId, tester.id)));
  const versions = fresh(await app.db.select().from(schema.plans).where(and(eq(schema.plans.testerId, tester.id), eq(schema.plans.status, "locked"))));
  const style = `Style now: ${tester.pushiness}${tester.styleNotes ? `; notes: ${tester.styleNotes}` : ""}${tester.stoppedAt ? "; stopped" : ""}`;
  const lines = [
    ...flagged.map((f) => `Flag ${f.kind}: ${f.detail ?? ""}`),
    ...paused.map((x) => `Pause: ${x.reason ?? "no reason"}${x.until ? `, back on ${x.until}` : ""}`),
    ...versions.map((x) => `New plan version ${x.version}${x.changeKind ? ` (${x.changeKind})` : ""}: ${x.step}, ${x.days.join(" ")} at ${x.stepTime}${x.endsOn ? `, until ${x.endsOn}` : ""}`),
  ];
  return [...(lines.length ? lines : ["Nothing flagged, paused or changed."]), style].join("\n");
}

/** The tester's memory as the coach would read it: every page, core pages first, daily docs last. */
export async function readMemory(app: EvalApp): Promise<string> {
  const tester = await getTesterByPhone(app.db, app.phone);
  if (!tester) return "(no tester)";
  const order = ["self", "preferences", "goal", "person", "subject", "daily"];
  const pages = (await getPages(app.db, tester.id)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  // ZOH also sees its step-day record (streak, misses) in every reply; show it so counts can be checked.
  const days = await app.db
    .select()
    .from(schema.stepDays)
    .where(eq(schema.stepDays.testerId, tester.id))
    .orderBy(desc(schema.stepDays.date));
  const record = `Step days on record, newest first: ${days.map((d) => `${d.date} ${d.status ?? "open"}`).join(", ") || "none"}`;
  if (pages.length === 0) return `(no memory pages)\n${record}`;
  return [...(await Promise.all(pages.map((p) => renderPage(app.db, tester, p)))), record].join("\n\n");
}

/** JSON-friendly, with the (fake) number masked like everywhere else. */
function plainRow(row: Record<string, unknown>, phone: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v === phone ? maskNumber(phone) : v]),
  );
}
