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
import { appDeps } from "../src/wiring.js";
import { EVAL_DAY, EvalClock, zonedDate } from "./clock.js";
import type { ConversationPlan, ConversationResult, TokenUsage, TranscriptLine } from "./types.js";

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
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    CLAUDE_MODEL: env.CLAUDE_MODEL,
    CLAUDE_MAX_TOKENS: env.CLAUDE_MAX_TOKENS,
    CLAUDE_HISTORY_LIMIT: env.CLAUDE_HISTORY_LIMIT,
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
  close(): Promise<void>;
}

/** The production app, built through src/wiring.ts, on a fresh in-memory database. */
export async function startEvalApp(opts: {
  config: Config;
  phone: string;
  clock: EvalClock;
  /** Tests pass a fake coach; the eval leaves this out and gets the real one from wiring. */
  replier?: Replier;
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
  return {
    built,
    db: db as unknown as Db,
    client,
    sendblue,
    clock: opts.clock,
    phone: opts.phone,
    async close() {
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
}

/** Runs one conversation end to end against a fresh app and reads back what was saved. */
export async function runConversation(plan: ConversationPlan, tester: Tester, opts: RunOptions): Promise<ConversationResult> {
  const phone = fakeNumber(plan.areaCode, opts.index);
  const clock = new EvalClock(zonedDate(EVAL_DAY, plan.startTime, plan.timeZone));
  const app = await startEvalApp({ config: evalConfig(opts.env, phone), phone, clock, replier: opts.replier });
  const transcript: TranscriptLine[] = [];
  let endedBy: ConversationResult["endedBy"] = "turn-cap";
  let error: string | undefined;
  try {
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      const text = await tester.next(transcript);
      if (text === null) {
        endedBy = tester.endReason;
        break;
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
      transcript,
      endedBy,
      error,
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

/** JSON-friendly, with the (fake) number masked like everywhere else. */
function plainRow(row: Record<string, unknown>, phone: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v === phone ? maskNumber(phone) : v]),
  );
}
