import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp, type AppDeps } from "../src/app.js";
import type {
  ClaudeModel,
  ModelBlock,
  ModelRequest,
  ModelResponse,
  NudgeRequest,
  Replier,
  ReplyInput,
  Turn,
} from "../src/claude/replier.js";
import type { Db } from "../src/db/client.js";
import { migrationsFolder } from "../src/db/paths.js";
import * as schema from "../src/db/schema.js";
import type { MediaFetcher, MediaStore } from "../src/media/storage.js";
import type { SendblueClient } from "../src/sendblue/client.js";
import type { Transcriber } from "../src/transcription/speaches.js";

export const SECRET = "test-webhook-secret";
export const ME = "+19085550100";
export const LINE = "+19177412162";
export const STRANGER = "+15555550123";
/** Stamati's number: a dev account in tests (ME is not, so "reset" from ME is ordinary). */
export const DEV = "+19085550101";
/** An allowed number outside Eastern Time (Denver). */
export const WESTERN = "+13035550123";

let shared: Promise<{ db: Db; client: PGlite }> | undefined;

/** One migrated in-memory Postgres per test file (starting PGlite takes seconds), emptied per test. */
export async function makeDb(): Promise<{ db: Db; client: PGlite }> {
  shared ??= (async () => {
    const client = new PGlite();
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, client };
  })();
  const handle = await shared;
  // Goals are seed data from the migration, so they stay.
  await handle.client.exec("TRUNCATE messages, testers, plan_inputs, flags, plans, step_days, nudges CASCADE");
  return handle;
}

export class FakeSendblue implements SendblueClient {
  calls: { kind: "typing" | "send"; number: string; content?: string; state?: string; at: number }[] = [];
  failSend = false;
  private n = 0;
  async sendMessage(input: { number: string; content?: string }) {
    this.calls.push({ kind: "send", number: input.number, content: input.content, at: performance.now() });
    if (this.failSend) throw new Error("Sendblue send failed (HTTP 500)");
    this.n += 1;
    return { messageHandle: `out-${this.n}`, status: "QUEUED", raw: { status: "QUEUED" } };
  }
  async sendTypingIndicator(number: string, state: "start" | "stop" = "start") {
    this.calls.push({ kind: "typing", number, state, at: performance.now() });
    return true;
  }
  get sends() {
    return this.calls.filter((c) => c.kind === "send");
  }
  get typings() {
    return this.calls.filter((c) => c.kind === "typing");
  }
}

/** Stands in for the whole coach: records the turns it was asked about. */
export class FakeReplier implements Replier {
  received: Turn[][] = [];
  inputs: ReplyInput[] = [];
  fail = false;
  /** Thrown one per call, in order, before any reply succeeds. */
  failures: Error[] = [];
  async reply(input: ReplyInput) {
    this.received.push(input.turns);
    this.inputs.push(input);
    if (this.fail) throw new Error("Claude unavailable");
    const next = this.failures.shift();
    if (next) throw next;
    return "Hey! Thanks for the message.";
  }
  /** Every nudge asked for, in order. */
  nudges: NudgeRequest[] = [];
  /** Thrown one per nudge call, in order, before any nudge succeeds. */
  nudgeFailures: Error[] = [];
  async nudge(input: NudgeRequest) {
    this.nudges.push(input);
    const next = this.nudgeFailures.shift();
    if (next) throw next;
    return `Yo, ${input.moment} text`;
  }
  async check() {}
}

/** Tokens every fake Claude call reports. */
export const FAKE_USAGE = { input: 1000, cacheRead: 4000, cacheWrite: 0, output: 50 } as const;

/** One scripted Claude response: plain text, or tool calls (with optional text alongside). */
export type FakeStep = string | { tools: { name: string; input: unknown }[]; text?: string } | Error;

/**
 * Stands in for Claude under the real coach (src/coach): returns scripted responses in order,
 * then a default text, and records every request (system prompt, messages, tools).
 */
export class FakeClaudeModel implements ClaudeModel {
  requests: ModelRequest[] = [];
  private steps: FakeStep[] = [];
  private ids = 0;
  constructor(public defaultText = "Hey! Thanks for the message.") {}
  /** Queue responses for the next Claude calls. */
  script(...steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }
  async create(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift() ?? this.defaultText;
    if (step instanceof Error) throw step;
    const usage = { ...FAKE_USAGE };
    if (typeof step === "string") return { content: [{ type: "text", text: step }], stopReason: "end_turn", usage };
    if (req.toolChoice === "none") return { content: [{ type: "text", text: step.text ?? this.defaultText }], stopReason: "end_turn", usage };
    const content: ModelBlock[] = [];
    if (step.text) content.push({ type: "text", text: step.text });
    for (const t of step.tools) content.push({ type: "tool_use", id: `toolu_${++this.ids}`, name: t.name, input: t.input });
    return { content, stopReason: "tool_use", usage };
  }
  async check() {}
  /** The state block (last system block, after the memory block when there is one) of a request. */
  stateOf(i = -1): string {
    return this.requests.at(i)?.system.at(-1)?.text ?? "";
  }
  /** The memory block of a request, when the tester's plan is locked. */
  memoryOf(i = -1): string | undefined {
    const system = this.requests.at(i)?.system ?? [];
    return system.length === 3 ? system[1]!.text : undefined;
  }
}

export class FakeMedia implements MediaStore {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string) {
    this.objects.set(key, { bytes, contentType });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async check() {}
}

export class FakeTranscriber implements Transcriber {
  calls = 0;
  async transcribe() {
    this.calls += 1;
    return "I went for a run this morning";
  }
  async check() {}
}

let photoBytes: Promise<Uint8Array> | undefined;
/** A real (tiny) PNG, so image conversion runs for real in tests. */
export function testPhoto(): Promise<Uint8Array> {
  photoBytes ??= sharp({ create: { width: 64, height: 48, channels: 3, background: "#e33" } })
    .png()
    .toBuffer()
    .then((b) => new Uint8Array(b));
  return photoBytes;
}

export const fakeFetchMedia: MediaFetcher = async (url) => {
  if (url.endsWith(".caf")) return { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/x-caf" };
  // iPhone photos often arrive mislabeled; ".jpg" here is really a PNG.
  if (url.endsWith(".jpg")) return { bytes: await testPhoto(), contentType: "image/jpeg" };
  if (url.endsWith("/unlabeled")) return { bytes: await testPhoto(), contentType: "application/octet-stream" };
  return { bytes: new Uint8Array([7]), contentType: "application/octet-stream" };
};

export interface TestApp extends Awaited<ReturnType<typeof buildApp>> {
  db: Db;
  sendblue: FakeSendblue;
  replier: FakeReplier;
  media: FakeMedia;
  transcriber: FakeTranscriber;
  close(): Promise<void>;
}

export async function makeApp(overrides: Partial<AppDeps["pipeline"]> & { webhookSecret?: string | null } = {}): Promise<TestApp> {
  const { db } = await makeDb();
  const sendblue = new FakeSendblue();
  const replier = new FakeReplier();
  const media = new FakeMedia();
  const transcriber = new FakeTranscriber();
  const { webhookSecret, ...pipelineOverrides } = overrides;
  const built = await buildApp({
    pipeline: {
      db,
      allowedNumbers: [ME, DEV, WESTERN],
      devNumbers: [DEV],
      typingIndicator: true,
      sendblue,
      replier,
      media,
      transcriber,
      fetchMedia: fakeFetchMedia,
      retryDelaysMs: [0, 0],
      ...pipelineOverrides,
    },
    webhookSecret: webhookSecret === null ? undefined : (webhookSecret ?? SECRET),
    missingSettings: () => [],
  });
  return {
    ...built,
    db,
    sendblue,
    replier,
    media,
    transcriber,
    async close() {
      await built.queue.idle();
      await built.app.close();
    },
  };
}

let handleCounter = 0;
export function inboundEvent(overrides: Record<string, unknown> = {}) {
  handleCounter += 1;
  return {
    accountEmail: "test",
    content: "Hello!",
    is_outbound: false,
    status: "RECEIVED",
    error_code: null,
    error_message: null,
    message_handle: `in-${handleCounter}-${Date.now()}`,
    date_sent: new Date().toISOString(),
    date_updated: new Date().toISOString(),
    from_number: ME,
    number: ME,
    to_number: LINE,
    sendblue_number: LINE,
    was_downgraded: false,
    plan: "dedicated",
    media_url: "",
    message_type: "message",
    group_id: "",
    participants: [ME, LINE],
    service: "iMessage",
    ...overrides,
  };
}

/** Pass secret: null to send no secret header. */
export async function postWebhook(t: TestApp, body: unknown, secret: string | null = SECRET) {
  return t.app.inject({
    method: "POST",
    url: "/webhooks/sendblue",
    headers: secret === null ? {} : { "sb-signing-secret": secret },
    payload: body as object,
  });
}
