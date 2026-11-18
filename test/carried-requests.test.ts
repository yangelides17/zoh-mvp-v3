import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createCoach } from "../src/coach/coach.js";
import { addRequest, requestRef } from "../src/console/requests.js";
import { consoleMessages, messages, type ConsoleMessage } from "../src/db/schema.js";
import { ReplyLines } from "../src/pipeline/conversation.js";
import { getOrCreateTester } from "../src/testers/testers.js";
import { FakeClaudeModel, ME, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

// #169 (the plan's part 0): a team request a reply carries counts only once that reply is sent. Dropped drafts hand it
// on, and a reply that doesn't go out hands it back.

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

async function post(content: string) {
  const res = await postWebhook(t, inboundEvent({ content }));
  expect(res.statusCode).toBe(200);
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

/** After makeApp: the tester and a natural request due now. */
async function request(): Promise<ConsoleMessage> {
  const db = t.db;
  const tester = await getOrCreateTester(db, ME, { firstTextAt: new Date(Date.now() - 86_400_000), isTestUser: false });
  return addRequest(db, { testerId: tester.id, author: "Yanni", body: "Ask what's made mornings hardest", exact: false, sendNow: false, at: new Date(Date.now() - 60_000) });
}

async function row(id: string): Promise<ConsoleMessage> {
  const [r] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, id));
  return r!;
}

async function replies() {
  return t.db.select().from(messages).where(and(eq(messages.contactNumber, ME), eq(messages.direction, "outbound")));
}

describe("a team request carried in a reply (#169 part 0)", () => {
  it("closes once the reply is sent, linked to that reply, with a Done line", async () => {
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }) });
    const r = await request();
    model.script({ tools: [{ name: "mark_request_done", input: { request: requestRef(r.id) } }] }, "Quick one: what's made mornings hardest this week?");
    await post("morning!");
    await t.queue.idle();

    const [reply] = await replies();
    expect(reply!.content).toBe("Quick one: what's made mornings hardest this week?");
    expect(await row(r.id)).toMatchObject({ requestStatus: "done", messageId: reply!.id });
    const lines = await t.db.select().from(consoleMessages).where(and(eq(consoleMessages.testerId, r.testerId), eq(consoleMessages.kind, "coach")));
    expect(lines.map((l) => l.body).join("\n")).toMatch(/Done \(in a reply, .+\): Ask what's made mornings hardest/);
  });

  it("a draft that claimed it is dropped (they texted again): the redraft still carries it, and it closes with the sent reply", async () => {
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }), lines: new ReplyLines({ holdMs: 5000, graceMs: 300 }) });
    const r = await request();
    model.script(
      { tools: [{ name: "mark_request_done", input: { request: requestRef(r.id) } }] },
      "Quick one: what's made mornings hardest?",
      "Ha, fair. Quick one though: what's made mornings hardest?",
    );
    await post("morning!");
    await until(() => model.requests.length === 2);
    await sleep(30);
    // Claimed, not done: nothing has gone out yet.
    expect((await row(r.id)).requestStatus).toBe("sending");
    await post("also I overslept lol");
    await until(() => sent().length === 1, 4000);
    await t.queue.idle();

    // The redraft was told it carries the request, though it didn't mark it again.
    expect(JSON.stringify(model.requests[2]!.system)).toContain(`the team's request [${requestRef(r.id)}] (you marked it done)`);
    const [reply] = await replies();
    expect(reply!.content).toBe("Ha, fair. Quick one though: what's made mornings hardest?");
    expect(await row(r.id)).toMatchObject({ requestStatus: "done", messageId: reply!.id });
  });

  it('"stop" before the reply goes out hands it back: never marked done', async () => {
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }), lines: new ReplyLines({ holdMs: 5000, graceMs: 300 }) });
    const r = await request();
    model.script({ tools: [{ name: "mark_request_done", input: { request: requestRef(r.id) } }] }, "Quick one: what's made mornings hardest?");
    await post("morning!");
    await until(() => model.requests.length === 2);
    await sleep(30);
    await post("stop");
    await t.queue.idle();

    expect(sent()).not.toContain("Quick one: what's made mornings hardest?");
    const after = await row(r.id);
    expect(after.requestStatus).not.toBe("done");
    expect(after.requestStatus).not.toBe("sending");
  });

  it("a reply that fails to send hands it back to pending", async () => {
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }) });
    const r = await request();
    t.sendblue.failSend = true;
    model.script({ tools: [{ name: "mark_request_done", input: { request: requestRef(r.id) } }] }, "Quick one: what's made mornings hardest?");
    await post("morning!");
    await t.queue.idle();

    expect(await row(r.id)).toMatchObject({ requestStatus: "pending", messageId: null });
  });

  it("a reply Sendblue accepted but that couldn't be stored still counts as sent: carried once, no 'didn't send' alert", async () => {
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }) });
    const r = await request();
    // Storing any outbound text fails (a database blip right after Sendblue took it).
    await t.db.execute(
      sql.raw(`CREATE FUNCTION no_outbound() RETURNS trigger AS $$ BEGIN
        IF NEW.direction = 'outbound' THEN RAISE EXCEPTION 'database blip'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`),
    );
    await t.db.execute(sql.raw("CREATE TRIGGER no_outbound BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION no_outbound()"));
    model.script({ tools: [{ name: "mark_request_done", input: { request: requestRef(r.id) } }] }, "Quick one: what's made mornings hardest?");
    try {
      await post("morning!");
      await t.queue.idle();
    } finally {
      // The test database is shared by the file: never leave it failing for the next test.
      await t.db.execute(sql.raw("DROP TRIGGER no_outbound ON messages"));
      await t.db.execute(sql.raw("DROP FUNCTION no_outbound"));
    }

    expect(sent()).toEqual(["Quick one: what's made mornings hardest?"]);
    expect(await row(r.id)).toMatchObject({ requestStatus: "done", messageId: null });
    const failures = await t.db.select().from(consoleMessages).where(and(eq(consoleMessages.testerId, r.testerId), eq(consoleMessages.topic, "failure")));
    expect(failures).toHaveLength(0);
  });
});
