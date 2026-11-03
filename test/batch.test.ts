import { Writable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createCoach } from "../src/coach/coach.js";
import { messages, type Message } from "../src/db/schema.js";
import { ReplyLines } from "../src/pipeline/conversation.js";
import { OPT_OUT_CONFIRMATION } from "../src/testers/commands.js";
import { getTesterByPhone } from "../src/testers/testers.js";
import { FakeClaudeModel, LINE, ME, SECRET, STRANGER, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

// #16: one reply to back-to-back texts; a ready reply waits while they type.

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

/** Posts a text without waiting for its reply. */
async function post(content: string, extra: Record<string, unknown> = {}) {
  const res = await postWebhook(t, inboundEvent({ content, ...extra }));
  expect(res.statusCode).toBe(200);
}

/** A Sendblue typing signal for ME. */
async function typing(isTyping: boolean, number = ME) {
  const res = await t.app.inject({
    method: "POST",
    url: "/webhooks/sendblue/typing",
    headers: { "sb-signing-secret": SECRET },
    payload: { number, is_typing: isTyping, from_number: LINE, timestamp: new Date().toISOString() },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sent = () => t.sendblue.sends.map((s) => s.content);

async function inboundRows(): Promise<Message[]> {
  const rows = await t.db.select().from(messages).where(and(eq(messages.contactNumber, ME), eq(messages.direction, "inbound")));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function outboundRows(): Promise<Message[]> {
  return t.db.select().from(messages).where(and(eq(messages.contactNumber, ME), eq(messages.direction, "outbound")));
}

/** Every tester line the coach was shown in a reply, in order. */
const userTexts = (i: number) => t.replier.inputs[i]!.turns.filter((x) => x.role === "user").map((x) => x.text);

describe("one reply to back-to-back texts", () => {
  it("a second text while the first reply is being written gets one reply that covers both", async () => {
    const lines = new ReplyLines();
    t = await makeApp({ lines });
    const draft = t.replier.pause();
    await post("ok so");
    await draft.reached;
    await post("I'm in");
    // The webhook answers at once and handles the text just after: let the draft go once it has landed.
    await until(() => lines.line(ME).interrupted);
    draft.release();
    await t.queue.idle();

    expect(sent()).toHaveLength(1);
    expect(t.replier.inputs).toHaveLength(2);
    expect(userTexts(1)).toEqual(["ok so", "I'm in"]);
    const [first, second] = await inboundRows();
    const [reply] = await outboundRows();
    expect(reply!.inReplyTo).toBe(second!.id);
    expect(first).toMatchObject({ status: "REPLIED" });
    expect(first!.timings).toMatchObject({ answered_with: second!.id });
    expect(second!.timings).toMatchObject({ drafts_dropped: 1, texts_answered: 2 });
  });

  it("a text after the reply went out gets its own reply, which has read the first", async () => {
    t = await makeApp();
    await post("ok so");
    await t.queue.idle();
    await post("I'm in");
    await t.queue.idle();
    expect(sent()).toHaveLength(2);
    expect(t.replier.inputs[1]!.turns.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
  });

  it("a photo and its caption a moment apart get one reply that sees the photo", async () => {
    t = await makeApp();
    await post("", { media_url: "https://cdn.example/whoop.jpg" });
    await post("Not bad!");
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    const turns = t.replier.inputs.at(-1)!.turns;
    expect(turns.find((x) => x.image)).toMatchObject({ role: "user", text: "[Sent a photo]" });
    expect(turns.at(-1)).toMatchObject({ text: "Not bad!" });
  });

  it('"stop" in the middle of a burst sends only the confirmation', async () => {
    const lines = new ReplyLines();
    t = await makeApp({ lines });
    const draft = t.replier.pause();
    await post("hey");
    await draft.reached;
    await post("stop");
    await until(() => lines.line(ME).cancelled);
    draft.release();
    await t.queue.idle();
    expect(sent()).toEqual([OPT_OUT_CONFIRMATION]);
    const [hey] = await inboundRows();
    expect(hey).toMatchObject({ status: "REPLY_DROPPED" });
  });

  it('"stop" right after a text that was still waiting: that text gets no reply either', async () => {
    const lines = new ReplyLines();
    t = await makeApp({ lines });
    const draft = t.replier.pause();
    await post("hey");
    await draft.reached;
    await post("wait");
    await until(() => lines.line(ME).pending.length === 1);
    await post("stop");
    await until(() => lines.line(ME).cancelled);
    draft.release();
    await t.queue.idle();
    expect(sent()).toEqual([OPT_OUT_CONFIRMATION]);
    const [hey, wait] = await inboundRows();
    expect(hey).toMatchObject({ status: "REPLY_DROPPED" });
    expect(wait).toMatchObject({ status: "REPLY_DROPPED" });
  });
});

describe("what a dropped draft did is kept and handed on (real coach)", () => {
  it("its finished action stays saved, the redraft is told it and its unsent words, and takes its own action", async () => {
    const { db } = await makeDb();
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db, model }) });
    model.script(
      // Draft 1: saves the name, writes a line, then its next call is cut off by the second text.
      { tools: [{ name: "save_name", input: { name: "Sam" } }], text: "Nice to meet you, Sam!" },
      // Draft 2: its own action from the second text, then the reply.
      { tools: [{ name: "choose_goal", input: { slug: "reading" } }] },
      "Sam, reading it is. When in your day could 10 minutes of it fit?",
    );
    const cut = (() => {
      // The second Claude call of draft 1 waits, so the second text lands mid-draft.
      let n = 0;
      const create = model.create.bind(model);
      const pause = { current: undefined as ReturnType<FakeClaudeModel["pause"]> | undefined };
      model.create = async (req) => {
        n += 1;
        if (n === 2) pause.current = model.pause();
        return create(req);
      };
      return () => pause.current;
    })();
    await post("I'm Sam");
    await until(() => cut() !== undefined);
    await cut()!.reached;
    await post("I want to read more");
    await t.queue.idle();

    expect(sent()).toEqual(["Sam, reading it is. When in your day could 10 minutes of it fit?"]);
    const tester = await getTesterByPhone(t.db, ME);
    expect(tester).toMatchObject({ name: "Sam", goalSlug: "reading" });
    // The redraft's first call (the third) is told what draft 1 did and wrote; save_name isn't run twice.
    const redraft = JSON.stringify(model.requests[2]!.messages.at(-1));
    expect(redraft).toContain("never sent");
    expect(redraft).toContain("save_name");
    expect(redraft).toContain("Nice to meet you, Sam!");
    expect(JSON.stringify(model.requests[2]!.messages)).toContain("I want to read more");
    const calls = model.requests.flatMap((r) => r.messages).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(calls.filter((b) => b.type === "tool_use" && b.name === "save_name")).toHaveLength(1);
  });
});

describe("holding a ready reply while they type", () => {
  it("no typing signal: no wait", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000 }) });
    await post("hey");
    await t.queue.idle();
    const [hey] = await inboundRows();
    expect(hey!.timings).not.toHaveProperty("hold_ms");
    expect(sent()).toHaveLength(1);
  });

  it("they stop typing: the held reply goes out", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000 }) });
    await typing(true);
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await sleep(30);
    expect(sent()).toHaveLength(0);
    await typing(false);
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    const [text] = await inboundRows();
    expect(text!.timings).toMatchObject({ hold_ended: "stopped" });
  });

  it("they text during the hold: one reply covering both", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000 }) });
    await typing(true);
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await sleep(30);
    await post("I'm in");
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    expect(userTexts(1)).toEqual(["ok so", "I'm in"]);
    // The redraft hears the held draft's unsent words.
    expect(t.replier.inputs[1]!.dropped).toMatchObject({ text: "Hey! Thanks for the message." });
    const [first] = await inboundRows();
    expect(first!.timings).toMatchObject({ hold_ended: "text" });
  });

  it("still typing at the cap: the reply goes out anyway", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 100 }) });
    await typing(true);
    await post("ok so");
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    const [text] = await inboundRows();
    expect(text!.timings).toMatchObject({ hold_ended: "cap" });
    expect(Number(text!.timings!.hold_ms)).toBeGreaterThanOrEqual(100);
  });

  it("a stale typing signal doesn't hold the reply", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, freshMs: 20 }) });
    await typing(true);
    await sleep(40);
    await post("hey");
    await t.queue.idle();
    const [hey] = await inboundRows();
    expect(hey!.timings).not.toHaveProperty("hold_ms");
  });

  it("a hold of 0 seconds turns it off", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 0 }) });
    await typing(true);
    await post("hey");
    await t.queue.idle();
    const [hey] = await inboundRows();
    expect(hey!.timings).not.toHaveProperty("hold_ms");
  });
});

describe("typing signals", () => {
  it("are logged with a masked number, and numbers this app doesn't answer are ignored", async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
        done();
      },
    });
    t = await makeApp({ logger: { level: "info", stream } });
    expect(await typing(true)).toMatchObject({ ok: true, typing: true });
    expect(await typing(true, STRANGER)).toMatchObject({ ignored: "not allowed" });
    const logged = lines.filter((l) => l.msg === "Typing signal");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ contact: "********0100", isTyping: true });
    expect(logged[0]).toHaveProperty("lagMs");
    expect(JSON.stringify(lines)).not.toContain(ME);
  });

  it("sent to the message URL are handled the same way", async () => {
    t = await makeApp();
    const res = await postWebhook(t, { number: ME, is_typing: true, from_number: LINE });
    expect(res.json()).toMatchObject({ ok: true, typing: true });
  });

  it("need the webhook secret", async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: "POST", url: "/webhooks/sendblue/typing", payload: { number: ME, is_typing: true } });
    expect(res.statusCode).toBe(401);
  });
});

describe("a short grace before a ready reply goes out (#132)", () => {
  const GRACE = 150;

  it("no typing and no text: sent after the grace, not before, with one grace", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: GRACE }) });
    await post("hey");
    await until(() => t.replier.inputs.length === 1);
    await sleep(GRACE / 3);
    expect(sent()).toHaveLength(0);
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    const [hey] = await inboundRows();
    expect(hey!.timings).toMatchObject({ graces: 1, grace_ended: "sent" });
    expect(Number(hey!.timings!.grace_ms)).toBeGreaterThanOrEqual(GRACE);
    expect(hey!.timings).not.toHaveProperty("hold_ms");
  });

  it("typing during the grace holds the reply; when they stop, one more grace, then it goes out", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: GRACE }) });
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await sleep(20);
    await typing(true);
    await sleep(GRACE + 30);
    expect(sent()).toHaveLength(0);
    await typing(false);
    await sleep(GRACE / 3);
    expect(sent()).toHaveLength(0);
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    const [text] = await inboundRows();
    expect(text!.timings).toMatchObject({ graces: 2, holds: 1, hold_ended: "stopped", grace_ended: "sent" });
  });

  it("a text during the grace: one reply covering both, the first draft never sent", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: GRACE }) });
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await sleep(20);
    await post("I'm in");
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    expect(userTexts(1)).toEqual(["ok so", "I'm in"]);
    expect(t.replier.inputs[1]!.dropped).toMatchObject({ text: "Hey! Thanks for the message." });
    const [first] = await inboundRows();
    expect(first!.timings).toMatchObject({ grace_ended: "text" });
  });

  it("a text during a hold that followed the grace: one reply covering both", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: GRACE }) });
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await typing(true);
    await sleep(30);
    await post("I'm in");
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    expect(userTexts(1)).toEqual(["ok so", "I'm in"]);
    const [first] = await inboundRows();
    expect(first!.timings).toMatchObject({ hold_ended: "text" });
  });

  it("a text during the grace after they stopped typing: one reply covering both", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: GRACE }) });
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await typing(true);
    await sleep(30);
    await typing(false);
    await sleep(20);
    await post("I'm in");
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    expect(userTexts(1)).toEqual(["ok so", "I'm in"]);
    const [first] = await inboundRows();
    expect(first!.timings).toMatchObject({ hold_ended: "stopped", grace_ended: "text" });
  });

  it("a hold that reaches the cap sends at once, with no further grace", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 100, graceMs: GRACE }) });
    await post("ok so");
    await until(() => t.replier.inputs.length === 1);
    await typing(true);
    await t.queue.idle();
    expect(sent()).toHaveLength(1);
    const [text] = await inboundRows();
    expect(text!.timings).toMatchObject({ graces: 1, holds: 1, hold_ended: "cap" });
  });

  it('"stop" during the grace: only the confirmation goes out', async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: 5000 }) });
    await post("hey");
    await until(() => t.replier.inputs.length === 1);
    await post("stop");
    await t.queue.idle();
    expect(sent()).toEqual([OPT_OUT_CONFIRMATION]);
    const [hey] = await inboundRows();
    expect(hey).toMatchObject({ status: "REPLY_DROPPED" });
  });

  it("commands get no grace", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: 5000 }) });
    const start = Date.now();
    await post("stop");
    await t.queue.idle();
    expect(sent()).toEqual([OPT_OUT_CONFIRMATION]);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("a finished draft dropped during the grace hands on what it did, and the redraft doesn't redo it (real coach)", async () => {
    const { db } = await makeDb();
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db, model }), lines: new ReplyLines({ holdMs: 5000, graceMs: 300 }) });
    model.script(
      // Draft 1 finishes: saves the name and writes its reply, then waits out the grace.
      { tools: [{ name: "save_name", input: { name: "Sam" } }] },
      "Nice to meet you, Sam!",
      // Draft 2, after the second text lands in the grace.
      { tools: [{ name: "choose_goal", input: { slug: "reading" } }] },
      "Sam, reading it is. When in your day could 10 minutes of it fit?",
    );
    await post("I'm Sam");
    await until(() => model.requests.length === 2);
    await sleep(30);
    await post("I want to read more");
    await until(() => sent().length === 1, 4000);

    expect(sent()).toEqual(["Sam, reading it is. When in your day could 10 minutes of it fit?"]);
    expect(await getTesterByPhone(t.db, ME)).toMatchObject({ name: "Sam", goalSlug: "reading" });
    const redraft = JSON.stringify(model.requests[2]!.messages.at(-1));
    expect(redraft).toContain("never sent");
    expect(redraft).toContain("save_name");
    expect(redraft).toContain("Nice to meet you, Sam!");
    const calls = model.requests.flatMap((r) => r.messages).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(calls.filter((b) => b.type === "tool_use" && b.name === "save_name")).toHaveLength(1);
  });

  it("a grace of 0 turns it off", async () => {
    t = await makeApp({ lines: new ReplyLines({ holdMs: 5000, graceMs: 0 }) });
    await post("hey");
    await t.queue.idle();
    const [hey] = await inboundRows();
    expect(hey!.timings).not.toHaveProperty("graces");
    expect(sent()).toHaveLength(1);
  });

  it("each grace is logged with a masked number and app timestamps", async () => {
    const logged: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        for (const l of String(chunk).split("\n").filter(Boolean)) logged.push(JSON.parse(l) as Record<string, unknown>);
        done();
      },
    });
    t = await makeApp({ logger: { level: "info", stream }, lines: new ReplyLines({ holdMs: 5000, graceMs: 30 }) });
    await post("hey");
    await t.queue.idle();
    const grace = logged.filter((l) => l.msg === "Reply grace");
    expect(grace).toHaveLength(1);
    expect(grace[0]).toMatchObject({ contact: "********0100", ended: "sent" });
    expect(grace[0]).toHaveProperty("startedAt");
    expect(grace[0]).toHaveProperty("endedAt");
    expect(JSON.stringify(logged)).not.toContain(ME);
  });
});
