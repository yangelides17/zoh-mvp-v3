import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messages } from "../src/db/schema.js";
import { FALLBACK_REPLY } from "../src/pipeline/inbound.js";
import { ME, STRANGER, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

async function allMessages(t: TestApp) {
  return t.db.select().from(messages).orderBy(messages.createdAt);
}

describe("POST /webhooks/sendblue", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("rejects a missing or wrong secret", async () => {
    expect((await postWebhook(t, inboundEvent(), null)).statusCode).toBe(401);
    expect((await postWebhook(t, inboundEvent(), "nope")).statusCode).toBe(401);
    await t.queue.idle();
    expect(await allMessages(t)).toHaveLength(0);
    expect(t.sendblue.calls).toHaveLength(0);
  });

  it("refuses webhooks until a secret is configured", async () => {
    const unconfigured = await makeApp({ webhookSecret: null });
    const res = await postWebhook(unconfigured, inboundEvent());
    expect(res.statusCode).toBe(503);
    await unconfigured.close();
  });

  it("stores the text, shows typing, replies with Claude and stores the reply", async () => {
    const res = await postWebhook(t, inboundEvent({ content: "Hi there" }));
    expect(res.statusCode).toBe(200);
    await t.queue.idle();

    const rows = await allMessages(t);
    expect(rows).toHaveLength(2);
    const [inbound, outbound] = rows;
    expect(inbound).toMatchObject({ direction: "inbound", contactNumber: ME, content: "Hi there", status: "REPLIED" });
    expect(outbound).toMatchObject({
      direction: "outbound",
      contactNumber: ME,
      content: "Hey! Thanks for the message.",
      inReplyTo: inbound!.id,
      sendblueHandle: "out-1",
    });

    // Typing bubble goes out before the reply.
    expect(t.sendblue.calls.map((c) => c.kind)).toEqual(["typing", "send"]);
    expect(t.replier.received[0]?.at(-1)).toMatchObject({ role: "user", text: "Hi there" });

    const timings = inbound!.timings;
    expect(timings.webhook_received_at).toBeTypeOf("string");
    expect(timings.typing_sent_at).toBeTypeOf("string");
    expect(timings.reply_sent_at).toBeTypeOf("string");
    expect(timings.claude_ms).toBeTypeOf("number");
  });

  it("processes a retried delivery only once", async () => {
    const event = inboundEvent();
    expect((await postWebhook(t, event)).statusCode).toBe(200);
    const second = await postWebhook(t, event);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true });
    await t.queue.idle();
    expect(t.sendblue.sends).toHaveLength(1);
    expect(await allMessages(t)).toHaveLength(2);
  });

  it("records status updates for our own messages and never replies to them", async () => {
    await postWebhook(t, inboundEvent());
    await t.queue.idle();
    const res = await postWebhook(
      t,
      inboundEvent({ is_outbound: true, message_handle: "out-1", status: "DELIVERED", number: ME, from_number: "+19177412162" }),
    );
    expect(res.json()).toMatchObject({ outbound: true, updated: 1 });
    await t.queue.idle();
    expect(t.sendblue.sends).toHaveLength(1);
    const [reply] = await t.db.select().from(messages).where(eq(messages.sendblueHandle, "out-1"));
    expect(reply?.status).toBe("DELIVERED");
  });

  it("stores but doesn't answer numbers outside the allowlist", async () => {
    await postWebhook(t, inboundEvent({ number: STRANGER, from_number: STRANGER }));
    await t.queue.idle();
    const rows = await allMessages(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contactNumber: STRANGER, status: "RECEIVED_NOT_ALLOWED" });
    expect(t.sendblue.calls).toHaveLength(0);
  });

  it("falls back to a fixed reply if Claude fails", async () => {
    t.replier.fail = true;
    await postWebhook(t, inboundEvent());
    await t.queue.idle();
    expect(t.sendblue.sends[0]?.content).toBe(FALLBACK_REPLY);
    const [inbound] = await allMessages(t);
    expect(inbound?.status).toBe("REPLIED_WITH_ERRORS");
    expect(inbound?.error).toContain("claude");
  });

  it("records a failed send without crashing", async () => {
    t.sendblue.failSend = true;
    await postWebhook(t, inboundEvent());
    await t.queue.idle();
    const rows = await allMessages(t);
    expect(rows[1]).toMatchObject({ direction: "outbound", status: "SEND_FAILED" });
    expect(t.sendblue.typings.map((c) => c.state)).toEqual(["start", "stop"]);
  });

  it("copies a photo to the bucket and shows it to Claude", async () => {
    const url = "https://cdn.sendblue.test/photos/IMG_0001.jpg";
    await postWebhook(t, inboundEvent({ content: "", media_url: url }));
    await t.queue.idle();
    const [inbound] = await allMessages(t);
    expect(inbound?.mediaKey).toMatch(/^media\/19085782266\/.+\.jpg$/);
    expect(inbound?.mediaContentType).toBe("image/jpeg");
    expect(t.media.objects.size).toBe(1);
    const lastTurn = t.replier.received[0]?.at(-1);
    expect(lastTurn?.image?.mediaType).toBe("image/jpeg");
    expect(lastTurn?.image?.data.length).toBeGreaterThan(100);
    expect(lastTurn?.text).toBe("[Sent a photo]");
    expect(inbound?.timings.image_format).toBe("png");
  });

  it("recognizes a photo even when the CDN doesn't label it as one", async () => {
    await postWebhook(t, inboundEvent({ content: "look", media_url: "https://cdn.sendblue.test/media/unlabeled" }));
    await t.queue.idle();
    const [inbound] = await allMessages(t);
    expect(inbound?.mediaContentType).toBe("image/png");
    const lastTurn = t.replier.received[0]?.at(-1);
    expect(lastTurn?.image).toBeDefined();
    expect(lastTurn?.text).toBe("[Sent a photo]\nlook");
  });

  it("transcribes a voice note and gives Claude the transcript", async () => {
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/audio/note.caf" }));
    await t.queue.idle();
    const [inbound] = await allMessages(t);
    expect(t.transcriber.calls).toBe(1);
    expect(inbound?.transcript).toBe("I went for a run this morning");
    expect(t.replier.received[0]?.at(-1)?.text).toContain("I went for a run this morning");
  });

  it("ignores group messages", async () => {
    const res = await postWebhook(t, inboundEvent({ group_id: "group-123" }));
    expect(res.json()).toMatchObject({ ignored: "group" });
    await t.queue.idle();
    expect(await allMessages(t)).toHaveLength(0);
  });

  it("accepts but ignores bodies it doesn't recognize", async () => {
    const res = await postWebhook(t, { hello: "world" });
    expect(res.statusCode).toBe(202);
  });

  it("gives Claude the earlier conversation", async () => {
    await postWebhook(t, inboundEvent({ content: "First message" }));
    await t.queue.idle();
    await postWebhook(t, inboundEvent({ content: "Second message" }));
    await t.queue.idle();
    const turns = t.replier.received[1]!;
    expect(turns.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[0]?.text).toBe("First message");
  });
});
