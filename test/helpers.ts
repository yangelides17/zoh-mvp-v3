import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp, type AppDeps } from "../src/app.js";
import type { Replier, Turn } from "../src/claude/replier.js";
import type { Db } from "../src/db/client.js";
import { migrationsFolder } from "../src/db/paths.js";
import * as schema from "../src/db/schema.js";
import type { MediaFetcher, MediaStore } from "../src/media/storage.js";
import type { SendblueClient } from "../src/sendblue/client.js";
import type { Transcriber } from "../src/transcription/speaches.js";

export const SECRET = "test-webhook-secret";
export const ME = "+19085782266";
export const LINE = "+19177412162";
export const STRANGER = "+15555550123";

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
  await handle.client.exec("TRUNCATE messages CASCADE");
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

export class FakeReplier implements Replier {
  received: Turn[][] = [];
  fail = false;
  async reply(turns: Turn[]) {
    this.received.push(turns);
    if (this.fail) throw new Error("Claude unavailable");
    return "Hey! Thanks for the message.";
  }
  async check() {}
}

export class FakeMedia implements MediaStore {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string) {
    this.objects.set(key, { bytes, contentType });
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

export const fakeFetchMedia: MediaFetcher = async (url) => {
  if (url.endsWith(".caf")) return { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/x-caf" };
  if (url.endsWith(".jpg")) return { bytes: new Uint8Array([4, 5, 6]), contentType: "image/jpeg" };
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
      allowedNumbers: [ME],
      historyLimit: 12,
      typingIndicator: true,
      sendblue,
      replier,
      media,
      transcriber,
      fetchMedia: fakeFetchMedia,
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
