import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { messages } from "../src/db/schema.js";
import { devCommandOffReply } from "../src/testers/commands.js";
import { getTesterByPhone, updateTester } from "../src/testers/testers.js";
import { DEV, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

/** Dev accounts' "reset" and "jump" are off on production unless DEV_COMMANDS turns them on. */

let t: TestApp;
let open = false;
afterEach(async () => {
  if (open) await t.close();
  open = false;
});

async function text(content: string) {
  const res = await postWebhook(t, inboundEvent({ content, number: DEV, from_number: DEV }));
  await t.queue.idle();
  return res;
}

const sent = () => t.sendblue.calls.filter((c) => c.kind === "send").map((c) => c.content);

describe("DEV_COMMANDS", () => {
  it("is off on production and on on staging when unset; on/off overrides either", () => {
    const base = { DATABASE_URL: "postgres://x" };
    expect(loadConfig(base).devCommands).toBe(false);
    expect(loadConfig({ ...base, DEV_COMMANDS: "" }).devCommands).toBe(false);
    expect(loadConfig({ ...base, APP_ENV: "staging" }).devCommands).toBe(true);
    expect(loadConfig({ ...base, DEV_COMMANDS: "on" }).devCommands).toBe(true);
    expect(loadConfig({ ...base, DEV_COMMANDS: " ON " }).devCommands).toBe(true);
    expect(loadConfig({ ...base, APP_ENV: "staging", DEV_COMMANDS: "off" }).devCommands).toBe(false);
    expect(() => loadConfig({ ...base, DEV_COMMANDS: "maybe" })).toThrow();
  });

  it("switched off, reset wipes nothing and answers with a fixed line, not the coach", async () => {
    t = await makeApp({ devCommands: false });
    open = true;
    await text("hi");
    const before = (await getTesterByPhone(t.db, DEV))!;
    await updateTester(t.db, before.id, { name: "Yanni", phase: "active", goalSlug: "reading" });
    const coachCalls = t.replier.received.length;

    await text("RESET");

    expect(await getTesterByPhone(t.db, DEV)).toMatchObject({ name: "Yanni", phase: "active", goalSlug: "reading" });
    expect(t.replier.received.length).toBe(coachCalls);
    expect(sent().at(-1)).toBe(devCommandOffReply("reset", "production"));
    expect(sent().at(-1)).toContain('Text "env staging" to use it there.');
    // Both the command and the reply are kept, like any command.
    expect((await t.db.select().from(messages).where(eq(messages.content, "RESET"))).length).toBe(1);
  });

  it("switched off, jump moves no clock and answers with the same kind of line", async () => {
    t = await makeApp({ devCommands: false, jumps: true });
    open = true;
    await text("hi");
    const coachCalls = t.replier.received.length;

    const res = await text("jump 2d");

    expect(res.json()).not.toMatchObject({ jump: true });
    expect((await getTesterByPhone(t.db, DEV))!.clockOffsetMs).toBe(0);
    expect(t.replier.received.length).toBe(coachCalls);
    expect(sent().at(-1)).toBe(devCommandOffReply("jump", "production"));
  });

  it("switched on, reset still starts a dev account fresh", async () => {
    t = await makeApp({ devCommands: true });
    open = true;
    await text("hi");
    const before = (await getTesterByPhone(t.db, DEV))!;
    await updateTester(t.db, before.id, { name: "Yanni", phase: "active", goalSlug: "reading" });

    await text("reset");

    expect(await getTesterByPhone(t.db, DEV)).toMatchObject({ name: null, phase: "onboarding", goalSlug: null });
  });

  it("the off line on staging doesn't point to staging", () => {
    expect(devCommandOffReply("reset", "staging")).toBe('"reset" is off on staging, so nothing changed.');
  });
});
