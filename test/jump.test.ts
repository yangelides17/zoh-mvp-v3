import { and, eq, gt } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleMessages, flags, jumps, messages, nudges, plans, stepDays, testers, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { isJumpText, JUMP_USAGE, parseJump } from "../src/testers/commands.js";
import { getTester } from "../src/testers/testers.js";
import { DEV, ME, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

/** Test mode (spec: GitHub issue "Test mode", #14). */

const TZ = "America/New_York";
/** A Monday; quiet hours end at 9 am, start at 10 pm. */
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const HOUR = 60 * 60_000;

/** The real clock: still, so offsets come out exact. */
let real = at(MON, "08:00");
let t: TestApp;

beforeEach(async () => {
  real = at(MON, "08:00");
  t = await makeApp({ jumps: true, now: () => real });
});
afterEach(async () => {
  await t.close();
});

/** A tester with a locked reading plan (every day at 7 pm, 20 minutes, from Monday), locked Sunday noon. */
async function setup(o: { phone?: string; locked?: boolean; stopped?: boolean; pushiness?: string } = {}): Promise<Tester> {
  const phone = o.phone ?? DEV;
  const lockedAt = at(SUN, "12:00");
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone,
      name: "Sam",
      goalSlug: "reading",
      phase: o.locked === false ? "onboarding" : "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      pushiness: o.pushiness ?? "pushy",
      isTestUser: phone === DEV,
      consentAt: at(SUN, "10:00"),
      contextStartedAt: at(SUN, "10:00"),
      stoppedAt: o.stopped ? at(SUN, "13:00") : null,
    })
    .returning();
  if (o.locked !== false) {
    await t.db.insert(plans).values({
      testerId: tester!.id,
      goalSlug: "reading",
      status: "locked",
      version: 1,
      step: "10 pages of Dune",
      place: "the couch",
      stepTime: "19:00",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      proof: "photo",
      reason: "Ten pages a night builds the habit.",
      minutes: 20,
      startDate: MON,
      commitment: "I'm in",
      lockedAt,
    });
  }
  await say(tester!, "inbound", new Date(lockedAt.getTime() - 60_000), "I'm in");
  await say(tester!, "outbound", lockedAt, "LET'S GO");
  return tester!;
}

async function say(tester: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  await t.db.insert(messages).values({ direction, contactNumber: tester.phone, content, createdAt: when, sentAt: when });
}

/** Texts from a number and waits for everything it started (a jump, or the reply). */
async function text(content: string, from = DEV) {
  const res = await postWebhook(t, inboundEvent({ content, number: from, from_number: from }));
  expect(res.statusCode).toBe(200);
  await t.queue.idle();
  return res.json() as { jump?: boolean };
}

/** Sends to the tester since `before`: ZOH's texts and the log line. */
function sendsSince(before: number) {
  return t.sendblue.sends.slice(before).map((s) => s.content ?? "");
}

const fresh = async (tester: Tester) => (await getTester(t.db, tester.id))!;
const allMessages = (phone = DEV) => t.db.select().from(messages).where(eq(messages.contactNumber, phone));

describe("reading the command", () => {
  it("knows the jump forms and leaves ordinary sentences alone", () => {
    expect(parseJump("jump 3h")).toEqual({ kind: "by", ms: 3 * HOUR });
    expect(parseJump("Jump 2d")).toEqual({ kind: "by", ms: 48 * HOUR });
    expect(parseJump("jump 7:30am")).toEqual({ kind: "at", hhmm: "07:30" });
    expect(parseJump("jump 7 pm")).toEqual({ kind: "at", hhmm: "19:00" });
    expect(parseJump("jump 12am")).toEqual({ kind: "at", hhmm: "00:00" });
    expect(parseJump("jump 19:30")).toEqual({ kind: "at", hhmm: "19:30" });
    expect(parseJump("jump next")).toEqual({ kind: "next" });
    // Past 14 days, or a unit it doesn't know: the usage reminder.
    expect(parseJump("jump 15d")).toEqual({ kind: "invalid" });
    expect(parseJump("jump 3 weeks")).toEqual({ kind: "invalid" });
    expect(parseJump("jump")).toEqual({ kind: "invalid" });
    expect(isJumpText("jump 3 weeks")).toBe(true);
    expect(isJumpText("Jump rope done")).toBe(false);
    expect(isJumpText("I'll jump in later")).toBe(false);
  });
});

describe("jumping", () => {
  it("moves only the dev account's clock; from anyone else, a jump is an ordinary text", async () => {
    const dev = await setup();
    const me = await setup({ phone: ME });
    expect(await text("jump 3h")).toMatchObject({ jump: true });
    expect((await fresh(dev)).clockOffsetMs).toBe(3 * HOUR);
    expect((await fresh(me)).clockOffsetMs).toBe(0);

    const before = t.replier.inputs.length;
    expect(await text("jump 3h", ME)).not.toHaveProperty("jump");
    expect((await fresh(me)).clockOffsetMs).toBe(0);
    expect((await allMessages(ME)).map((m) => m.content)).toContain("jump 3h");
    expect(t.replier.inputs.length).toBe(before + 1);
  });

  it("never stores the jump text or the log line, and the coach never sees them", async () => {
    const dev = await setup();
    const before = (await allMessages()).length;
    await text("jump 0.5h");
    await text("jump 2h");
    expect((await allMessages()).length).toBe(before + 1); // only the 9 am kickoff
    expect((await allMessages()).some((m) => m.content?.startsWith("jump") || m.content?.startsWith("⏩"))).toBe(false);
    expect(t.replier.inputs).toHaveLength(0);
    expect(await t.db.select().from(jumps).where(eq(jumps.testerId, dev.id))).toHaveLength(2);
  });

  it("doesn't count as a reply: the stall timer carries on through it", async () => {
    const dev = await setup({ locked: false });
    // ZOH's last text (Sunday noon) is unanswered; the first stall nudge is due 3 hours after it.
    await text("jump 2h");
    expect(t.replier.nudges.map((n) => n.moment)).toEqual(["stall"]);
    // One stall a day: another jump the same day sends nothing more.
    await text("jump 2h");
    expect(t.replier.nudges.map((n) => n.moment)).toEqual(["stall"]);
    expect((await fresh(dev)).clockOffsetMs).toBe(4 * HOUR);
  });

  it("a duplicate webhook delivery jumps once", async () => {
    const dev = await setup();
    const event = inboundEvent({ content: "jump 1h", number: DEV, from_number: DEV });
    await postWebhook(t, event);
    await postWebhook(t, event);
    await t.queue.idle();
    expect((await fresh(dev)).clockOffsetMs).toBe(HOUR);
  });
});

describe("what happens on the way", () => {
  it("jump 1d with no replies: the day's nudges in order at their own times, then the day closes missed", async () => {
    const dev = await setup();
    const before = t.sendblue.sends.length;
    await text("jump 1d");
    expect(t.replier.nudges.map((n) => [n.moment, n.now.toISOString()])).toEqual([
      ["kickoff", at(MON, "09:00").toISOString()],
      ["checkin", at(MON, "18:50").toISOString()],
      ["followup", at(MON, "19:50").toISOString()],
    ]);
    const [monday] = await t.db.select().from(stepDays).where(and(eq(stepDays.testerId, dev.id), eq(stepDays.date, MON)));
    expect(monday?.status).toBe("missed");
    // Each nudge is a real text on the tester's clock, then one log line.
    const sent = await t.db.select().from(messages).where(and(eq(messages.contactNumber, DEV), eq(messages.direction, "outbound"), gt(messages.createdAt, at(MON, "08:00"))));
    expect(sent.map((m) => m.createdAt.toISOString()).sort()).toEqual([at(MON, "09:00"), at(MON, "18:50"), at(MON, "19:50")].map((d) => d.toISOString()));
    const out = sendsSince(before);
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(
      "⏩ Tue Nov 3, 8:00 am · sent: kickoff Mon 9:00 am, check-in Mon 6:50 pm, follow-up Mon 7:50 pm · Mon missed · next: after-miss kickoff 9:00 am (in 1h)",
    );
  });

  it("a silent jump reaches the point where ZOH stops texting on its own, never past the 3-a-day cap", async () => {
    const dev = await setup();
    const before = t.sendblue.sends.length;
    await text("jump 5d");
    const tester = await fresh(dev);
    expect(tester.autoTextsPausedAt).not.toBeNull();
    const perDay = new Map<string, number>();
    for (const n of await t.db.select().from(nudges).where(and(eq(nudges.testerId, dev.id), eq(nudges.status, "sent")))) {
      perDay.set(n.date, (perDay.get(n.date) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(3);
    expect(t.replier.nudges.map((n) => n.moment)).toContain("day_three");
    const log = sendsSince(before).at(-1)!;
    expect(log).toContain("ZOH's texts paused (went quiet)");
    expect(log).toContain("next: nothing coming");
    // The founders hear about it like for any tester.
    expect((await t.db.select().from(flags).where(eq(flags.testerId, dev.id))).map((f) => f.kind)).toContain("went_quiet");
  }, 60_000);

  it("jump next lands on ZOH's next text and sends exactly that one", async () => {
    const dev = await setup();
    const before = t.sendblue.sends.length;
    await text("jump next");
    expect(t.replier.nudges.map((n) => n.moment)).toEqual(["kickoff"]);
    expect((await fresh(dev)).clockOffsetMs).toBe(HOUR);
    const out = sendsSince(before);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("⏩ Mon Nov 2, 9:00 am · sent: kickoff 9:00 am · next: check-in 6:50 pm (in 9h50)");
  });

  it("jump to a time of day lands on the next one", async () => {
    const dev = await setup();
    await text("jump 7:30am");
    // 8 am now, so 7:30 am is tomorrow's.
    expect((await fresh(dev)).clockOffsetMs).toBe(at(TUE, "07:30").getTime() - real.getTime());
  });
});

describe("the log line", () => {
  it("one per jump, even when nothing is due", async () => {
    await setup();
    const before = t.sendblue.sends.length;
    await text("jump 0.5h");
    expect(sendsSince(before)).toEqual(["⏩ Mon Nov 2, 8:30 am · nothing due · next: kickoff 9:00 am (in 30 min)"]);
  });

  it("a text it doesn't understand gets the usage reminder, and the clock stays", async () => {
    const dev = await setup();
    const before = t.sendblue.sends.length;
    await text("jump 3 weeks");
    expect(sendsSince(before)).toEqual([JUMP_USAGE]);
    expect((await fresh(dev)).clockOffsetMs).toBe(0);
    expect((await allMessages()).some((m) => m.content === "jump 3 weeks")).toBe(false);
  });

  it("a stopped tester: the clock moves, nothing is sent, and the log says why", async () => {
    const dev = await setup({ stopped: true });
    const before = t.sendblue.sends.length;
    await text("jump 1d");
    expect(t.replier.nudges).toHaveLength(0);
    expect((await fresh(dev)).clockOffsetMs).toBe(24 * HOUR);
    expect(sendsSince(before)).toEqual(["⏩ Tue Nov 3, 8:00 am · nothing sent: they texted stop · next: nothing coming"]);
  });

  it("landing in quiet hours sends nothing; next names when they end", async () => {
    await setup();
    await text("jump 1d"); // Tuesday 8 am, before quiet hours end
    const before = t.sendblue.sends.length;
    const nudgesBefore = t.replier.nudges.length;
    await text("jump 0.5h");
    expect(t.replier.nudges.length).toBe(nudgesBefore);
    expect(sendsSince(before)).toEqual(["⏩ Tue Nov 3, 8:30 am · nothing due · next: after-miss kickoff 9:00 am (in 30 min)"]);
  });

  it("jump next with nothing coming says so and leaves the clock", async () => {
    const dev = await setup({ stopped: true });
    const before = t.sendblue.sends.length;
    await text("jump next");
    expect((await fresh(dev)).clockOffsetMs).toBe(0);
    expect(sendsSince(before)).toEqual(["⏩ Mon Nov 2, 8:00 am · nothing coming (they texted stop)"]);
  });
});

describe("after a jump", () => {
  it("their texts and ZOH's replies carry the tester's time, not the real one", async () => {
    const dev = await setup();
    await text("jump 1d");
    const landed = at(TUE, "08:00");
    real = new Date(real.getTime() + 2 * 60_000);
    await text("done");
    expect(t.replier.inputs.at(-1)!.now.toISOString()).toBe(new Date(landed.getTime() + 2 * 60_000).toISOString());
    const rows = await allMessages();
    const reply = rows.filter((m) => m.content === "done" || m.content === "Hey! Thanks for the message.");
    expect(reply).toHaveLength(2);
    for (const m of reply) {
      expect(m.createdAt.getTime()).toBeGreaterThanOrEqual(landed.getTime());
      expect(m.sentAt!.getTime()).toBeGreaterThanOrEqual(landed.getTime());
    }
    // Every row the jump and the reply wrote is on the tester's clock: nothing on the still real clock after 8 am Monday.
    const late = (d: Date | null) => d !== null && d.getTime() > real.getTime();
    const nudgeRows = await t.db.select().from(nudges).where(eq(nudges.testerId, dev.id));
    expect(nudgeRows.length).toBeGreaterThan(0);
    expect(nudgeRows.every((n) => late(n.createdAt))).toBe(true);
    const days = await t.db.select().from(stepDays).where(eq(stepDays.testerId, dev.id));
    expect(days.every((d) => late(d.updatedAt))).toBe(true);
    expect(rows.filter((m) => m.createdAt > at(SUN, "12:00")).every((m) => late(m.createdAt))).toBe(true);
  });

  it("reset puts them back on real time, with nothing left in the future", async () => {
    const dev = await setup();
    await text("jump 5d");
    await text("reset");
    const tester = await fresh(dev);
    expect(tester.clockOffsetMs).toBe(0);
    expect(tester.phase).toBe("onboarding");
    const future = (d: Date | null) => d !== null && d.getTime() > real.getTime() + 60_000;
    expect((await allMessages()).filter((m) => future(m.createdAt) || future(m.sentAt))).toEqual([]);
    expect((await t.db.select().from(flags).where(eq(flags.testerId, dev.id))).filter((f) => future(f.createdAt))).toEqual([]);
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.testerId, dev.id))).filter((c) => future(c.createdAt))).toEqual([]);
    // The fresh start's reply is on real time, and the history before it stays out of view.
    expect(t.replier.inputs.at(-1)!.now.getTime()).toBe(real.getTime());
    expect(t.replier.inputs.at(-1)!.turns.map((x) => x.text)).toEqual(["reset"]);
  }, 60_000);
});
