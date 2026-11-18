import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { fileRef } from "../src/console/attachments.js";
import { createConsoleCoach } from "../src/console/chat.js";
import { threadChunk } from "../src/console/data.js";
import { itemHtml } from "../src/console/views/threads.js";
import { consoleMessages, messages, plans, testers, type ConsoleMessage, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { MAX_UPLOAD_BYTES } from "../src/sendblue/client.js";
import { DEV, FakeClaudeModel, FakeWatcher, LINE, ME, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

// #168: a founder attaches a file in the console chat (+ or drop); ZOH reads it before answering, drafts a
// word-for-word text with it, and on Do it the file goes to Sendblue and out with the text. Cards can be edited in
// place, and each shows where it stands (queued → sent → delivered).

const TZ = "America/New_York";
const SECRET = "console-test-secret";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const VIDEO_ACCOUNT = "A 2-minute hip stretch: kneel, shift forward, hold 30 seconds a side, then the pigeon pose at the end.";

let t: TestApp;
let model: FakeClaudeModel;
let watcher: FakeWatcher;
let now: Date;
let scheduler: NudgeScheduler;

beforeEach(async () => {
  now = at("2026-11-03", "12:00");
  model = new FakeClaudeModel("Got it.");
  watcher = new FakeWatcher();
  watcher.account = VIDEO_ACCOUNT;
  let coach: ReturnType<typeof createConsoleCoach> | undefined;
  t = await makeApp({
    console: { password: "pw", sessionSecret: SECRET, names: ["Yanni", "Stamati"] },
    now: () => now,
    consoleCoach: { answer: (id, when) => coach!.answer(id, when) },
  });
  coach = createConsoleCoach({ db: t.db, model, voice: "VOICE", media: t.media, sendblue: t.sendblue, watcher });
  scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME, DEV], lineNumber: LINE });
});
afterEach(async () => {
  await scheduler.stop();
  await t.close();
});

const cookie = () => `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(now, "Yanni"), SECRET))}`;
const post = (url: string, form: Record<string, string>) =>
  t.app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, payload: new URLSearchParams(form).toString() });

/** The chat form as the page sends it with a file attached (by + or a drop: the same file field). */
async function chatWithFile(tester: Tester, text: string, file: { name: string; type: string; bytes: Uint8Array }) {
  const boundary = "----zohtest";
  const head = (name: string, extra = "") => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n`;
  const payload = Buffer.concat([
    Buffer.from(`${head("text")}\r\n${text}\r\n`),
    Buffer.from(`${head("file", `; filename="${file.name}"`)}Content-Type: ${file.type}\r\n\r\n`),
    Buffer.from(file.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  now = new Date(now.getTime() + 60_000);
  const res = await t.app.inject({
    method: "POST",
    url: `/console/testers/${tester.id}/chat`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie: cookie() },
    payload,
  });
  await t.queue.idle();
  return res;
}

async function chat(tester: Tester, text: string) {
  now = new Date(now.getTime() + 60_000);
  const res = await post(`/console/testers/${tester.id}/chat`, { text });
  await t.queue.idle();
  return res;
}

async function seed(): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "reading",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-11-01", "10:00"),
      contextStartedAt: at("2026-11-01", "10:00"),
    })
    .returning();
  await t.db.insert(plans).values({
    testerId: tester!.id,
    goalSlug: "reading",
    status: "locked",
    version: 1,
    step: "10 pages of Dune",
    stepTime: "19:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    proof: "photo",
    reason: "Ten pages a night builds the habit.",
    minutes: 20,
    startDate: "2026-11-02",
    lockedAt: at("2026-11-01", "12:00"),
  });
  return tester!;
}

async function thread(testerId: string): Promise<ConsoleMessage[]> {
  return t.db.select().from(consoleMessages).where(eq(consoleMessages.testerId, testerId)).orderBy(asc(consoleMessages.createdAt));
}
const ofKind = async (testerId: string, kind: ConsoleMessage["kind"]) => (await thread(testerId)).filter((m) => m.kind === kind);

const VIDEO = { name: "stretch.mp4", type: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) };

/** A founder attaches the video and ZOH drafts a text with it (its line, about what the video shows). */
async function draftWithVideo(tester: Tester, words = "Found you a 2-minute hip stretch for after tonight's pages; the pigeon at the end is the good part") {
  // The file's line gets its id when stored, so the model's call names it once it's there.
  const draft = { name: "send_text", input: { words, file: "" } };
  model.script({ tools: [draft] }, "Drafted it.");
  const realCreate = model.create.bind(model);
  model.create = async (req) => {
    const [line] = (await ofKind(tester.id, "founder")).filter((m) => m.mediaKey);
    if (line) draft.input.file = fileRef(line);
    return realCreate(req);
  };
  await chatWithFile(tester, "send Sam this for tonight", VIDEO);
  return (await ofKind(tester.id, "draft")).at(-1)!;
}

describe("attaching a file in the console chat (#168)", () => {
  it("is stored on the founder's line, and the video is watched before ZOH answers", async () => {
    const tester = await seed();
    const res = await chatWithFile(tester, "send Sam this for tonight", VIDEO);
    expect(res.statusCode).toBe(303);

    const [line] = await ofKind(tester.id, "founder");
    expect(line).toMatchObject({ body: "send Sam this for tonight", mediaName: "stretch.mp4", mediaContentType: "video/mp4", mediaAccount: VIDEO_ACCOUNT, mediaPartial: false });
    expect(line!.mediaKey).toMatch(new RegExp(`^console/${tester.id}/.+\\.mp4$`));
    expect(t.media.objects.get(line!.mediaKey!)?.bytes).toEqual(VIDEO.bytes);
    // Watched for the founders' purpose, not as a tester's proof.
    expect(watcher.requests[0]!.question).toContain("coaching team will send this video");
    // The console coach reads what's in it.
    const seen = JSON.stringify(model.requests[0]!.messages);
    expect(seen).toContain(`[attached video \\"stretch.mp4\\", file ${fileRef(line!)}: ${VIDEO_ACCOUNT}]`);
  });

  it("a document is read in full for the console coach", async () => {
    const tester = await seed();
    await chatWithFile(tester, "", { name: "routine.txt", type: "text/plain", bytes: new TextEncoder().encode("Ten-minute mobility routine: cat-cow, hip circles, then a long hamstring hold.") });
    const [line] = await ofKind(tester.id, "founder");
    expect(line!.mediaAccount).toContain("Ten-minute mobility routine: cat-cow, hip circles");
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("hip circles");
  });

  it("a file over 100 MB is refused: nothing stored, no message", async () => {
    const tester = await seed();
    const res = await chatWithFile(tester, "this one", { name: "huge.mov", type: "video/quicktime", bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.body).toContain("over 100 MB");
    expect(t.media.objects.size).toBe(0);
    expect(await ofKind(tester.id, "founder")).toHaveLength(0);
  });
});

describe("sending a file (#168)", () => {
  it("Do it uploads it to Sendblue; the tick sends one text with it and the line; delivered sticks", async () => {
    const tester = await seed();
    const draft = await draftWithVideo(tester);
    expect(draft.body).toContain('with "stretch.mp4"');
    expect(t.sendblue.uploads).toHaveLength(0);

    now = new Date(now.getTime() + 60_000);
    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {})).statusCode).toBe(303);
    expect(t.sendblue.uploads).toEqual([{ name: "stretch.mp4", contentType: "video/mp4", bytes: VIDEO.bytes.length }]);
    const [request] = await ofKind(tester.id, "request");
    expect(request).toMatchObject({ exact: true, mediaName: "stretch.mp4", sendblueMediaUrl: "https://cdn.sendblue.test/1/stretch.mp4" });

    await scheduler.tick(new Date(now.getTime() + 60_000));
    const sends = t.sendblue.sends;
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ content: "Found you a 2-minute hip stretch for after tonight's pages; the pigeon at the end is the good part", mediaUrl: "https://cdn.sendblue.test/1/stretch.mp4" });
    const [out] = await t.db.select().from(messages).where(eq(messages.direction, "outbound"));
    expect(out).toMatchObject({ mediaKey: request!.mediaKey, mediaContentType: "video/mp4" });

    const card = async () => {
      const item = (await threadChunk(t.db, tester.id)).find((i) => i.id === request!.id)!;
      return itemHtml(item, { testerId: tester.id, titles: new Map(), now } as Parameters<typeof itemHtml>[1]);
    };
    expect(await card()).toContain(">sent<");
    await postWebhook(t, inboundEvent({ is_outbound: true, message_handle: out!.sendblueHandle, status: "DELIVERED", number: ME, from_number: LINE }));
    expect(await card()).toContain(">delivered<");
    // A late "sent" doesn't take it back.
    await postWebhook(t, inboundEvent({ is_outbound: true, message_handle: out!.sendblueHandle, status: "SENT", number: ME, from_number: LINE }));
    expect((await t.db.select().from(messages).where(eq(messages.id, out!.id)))[0]!.status).toBe("DELIVERED");
    expect(await card()).toContain(">delivered<");
  });

  it("an upload Sendblue refuses: the card says so and nothing is queued or sent", async () => {
    const tester = await seed();
    const draft = await draftWithVideo(tester);
    t.sendblue.failUpload = true;
    now = new Date(now.getTime() + 60_000);
    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {})).statusCode).toBe(409);
    const [after] = (await thread(tester.id)).filter((m) => m.id === draft.id);
    expect(after).toMatchObject({ draftStatus: "failed" });
    expect(after!.draftResult).toContain("Couldn't upload the file to Sendblue");
    expect(await ofKind(tester.id, "request")).toHaveLength(0);
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(t.sendblue.sends).toHaveLength(0);
  });
});

describe("links on a card in ZOH's words (#168)", () => {
  it("one it didn't open is refused; one it opened goes on the card, and Do it works", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "plan_request", input: { what: "Share https://example.com/guide with why it fits" } }] }, "Couldn't.");
    await chat(tester, "send Sam https://example.com/guide");
    expect(await ofKind(tester.id, "draft")).toHaveLength(0);
    const refusal = JSON.stringify(model.requests[1]!.messages);
    expect(refusal).toContain("Open it first");

    model.script(
      { web: [{ fetch: "https://example.com/guide", text: "A beginner's guide to reading habits." }], tools: [{ name: "plan_request", input: { what: "Share https://example.com/guide with why it fits" } }] },
      "Drafted.",
    );
    await chat(tester, "try again, open it");
    const [draft] = await ofKind(tester.id, "draft");
    expect(draft).toBeDefined();
    now = new Date(now.getTime() + 60_000);
    expect((await post(`/console/testers/${tester.id}/drafts/${draft!.id}/confirm`, {})).statusCode).toBe(303);
    expect(await ofKind(tester.id, "request")).toHaveLength(1);
  });
});

describe("editing a card before Do it (#168)", () => {
  it("the edited words are what goes out", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "send_text", input: { words: "Hey Sam" } }] }, "Drafted.");
    await chat(tester, "text Sam hey");
    const [draft] = await ofKind(tester.id, "draft");
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}?tab=console`, headers: { cookie: cookie() } });
    expect(page.body).toContain(`action="/console/testers/${tester.id}/drafts/${draft!.id}/edit"`);

    expect((await post(`/console/testers/${tester.id}/drafts/${draft!.id}/edit`, { text: "Hey Sam, how did the pages go?" })).statusCode).toBe(303);
    const [edited] = (await thread(tester.id)).filter((m) => m.id === draft!.id);
    expect(edited!.body).toContain('"Hey Sam, how did the pages go?"');
    now = new Date(now.getTime() + 60_000);
    await post(`/console/testers/${tester.id}/drafts/${draft!.id}/confirm`, {});
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Hey Sam, how did the pages go?"]);
  });

  it("only a text's or a request's words can be edited in place", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "save_note", input: { note: "Traveling next week" } }] }, "Drafted.");
    await chat(tester, "note: traveling next week");
    const [draft] = await ofKind(tester.id, "draft");
    expect((await post(`/console/testers/${tester.id}/drafts/${draft!.id}/edit`, { text: "something else" })).statusCode).toBe(409);
  });
});

describe("the chat box (#168)", () => {
  it("has + to attach, takes a dropped file, and sends on Enter (Shift+Enter is a new line)", async () => {
    const tester = await seed();
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}?tab=console`, headers: { cookie: cookie() } });
    expect(page.body).toContain('<form id="chat-form" method="post"');
    expect(page.body).toContain('enctype="multipart/form-data"');
    expect(page.body).toContain('<input type="file" id="chat-file" name="file" hidden>');
    expect(page.body).toContain('if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;');
    expect(page.body).toContain('chatArea.addEventListener("drop"');
  });
});
