import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { recentConversation } from "../src/db/messages.js";
import { flags, goals, messages, planInputs, testers } from "../src/db/schema.js";
import { guessTimeZone } from "../src/testers/area-codes.js";
import { isOptOutText, isResetText, OPT_OUT_CONFIRMATION } from "../src/testers/commands.js";
import { getTesterByPhone, updateTester } from "../src/testers/testers.js";
import { DEV, ME, STRANGER, WESTERN, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

const OPT_OUTS = ["stop", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "opt out", "optout"];

async function text(t: TestApp, from: string, content: string) {
  const res = await postWebhook(t, inboundEvent({ content, from_number: from, number: from }));
  expect(res.statusCode).toBe(200);
  await t.queue.idle();
}

async function tester(t: TestApp, phone: string) {
  const row = await getTesterByPhone(t.db, phone);
  if (!row) throw new Error("no tester row");
  return row;
}

describe("testers", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("creates a tester on the first text, with consent time, Eastern time zone and 10 pm to 9 am quiet hours", async () => {
    await text(t, ME, "Start");
    const row = await tester(t, ME);
    const [inbound] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(row).toMatchObject({
      phone: ME,
      name: null,
      phase: "onboarding",
      goalSlug: null,
      timeZone: "America/New_York",
      timeZoneStatus: "assumed_eastern",
      quietHoursStart: "22:00",
      quietHoursEnd: "09:00",
      pushiness: "pushy",
      isTestUser: false,
      stoppedAt: null,
    });
    expect(row.consentAt).toEqual(inbound!.createdAt);
    expect(row.contextStartedAt).toEqual(inbound!.createdAt);

    // A second text doesn't create another row or move consent.
    await text(t, ME, "hello again");
    expect(await t.db.select().from(testers)).toHaveLength(1);
    expect((await tester(t, ME)).consentAt).toEqual(row.consentAt);
  });

  it("marks a non-Eastern number needs_city with a best-guess zone", async () => {
    await text(t, WESTERN, "Start");
    expect(await tester(t, WESTERN)).toMatchObject({ timeZone: "America/Denver", timeZoneStatus: "needs_city" });
  });

  it("marks DEV_NUMBERS testers as test users", async () => {
    await text(t, DEV, "Start");
    expect((await tester(t, DEV)).isTestUser).toBe(true);
  });

  it("still gives numbers outside ALLOWED_NUMBERS no reply and no tester row", async () => {
    await text(t, STRANGER, "stop");
    await text(t, STRANGER, "hi");
    expect(t.sendblue.calls).toHaveLength(0);
    expect(await t.db.select().from(testers)).toHaveLength(0);
  });

  describe("opt-outs", () => {
    const variants = OPT_OUTS.flatMap((w) => [w, w.toUpperCase(), `${w[0]!.toUpperCase()}${w.slice(1)}.`, `  ${w}!! `]);
    for (const word of [...variants, "STOP!", "Unsubscribe.", "Opt-Out"]) {
      it(`"${word}" stops the tester with exactly one confirmation and no Claude`, async () => {
        await text(t, ME, word);
        expect((await tester(t, ME)).stoppedAt).toBeInstanceOf(Date);
        expect(t.sendblue.calls).toEqual([expect.objectContaining({ kind: "send", number: ME, content: OPT_OUT_CONFIRMATION })]);
        expect(t.replier.received).toHaveLength(0);
        const out = await t.db.select().from(messages).where(eq(messages.direction, "outbound"));
        expect(out).toEqual([expect.objectContaining({ content: OPT_OUT_CONFIRMATION })]);
      });
    }

    for (const sentence of ["please don't stop texting me", "stop by the gym later"]) {
      it(`"${sentence}" is not an opt-out`, async () => {
        await text(t, ME, sentence);
        expect((await tester(t, ME)).stoppedAt).toBeNull();
        expect(t.replier.received).toHaveLength(1);
        expect(t.sendblue.sends[0]?.content).toBe("Hey! Thanks for the message.");
      });
    }

    it("un-stops a stopped tester who texts again and gives them a normal reply", async () => {
      await text(t, ME, "stop");
      await text(t, ME, "hey");
      expect((await tester(t, ME)).stoppedAt).toBeNull();
      expect(t.replier.received).toHaveLength(1);
      expect(t.replier.received[0]?.at(-1)).toMatchObject({ role: "user", text: "hey" });
      expect(t.sendblue.sends.map((s) => s.content)).toEqual([OPT_OUT_CONFIRMATION, "Hey! Thanks for the message."]);
    });
  });

  describe("reset", () => {
    it("from a dev number clears the profile, keeps old messages and flags, and hides them from Claude", async () => {
      await text(t, DEV, "hi, I'm Stamati");
      await text(t, DEV, "stop");
      const before = await tester(t, DEV);
      await updateTester(t.db, before.id, {
        name: "Stamati",
        phase: "planning",
        goalSlug: "exercise",
        timeZone: "America/Chicago",
        timeZoneStatus: "confirmed",
        quietHoursStart: "23:00",
        quietHoursEnd: "07:00",
        pushiness: "chill",
        styleNotes: "fewer emojis",
      });
      await t.db.insert(planInputs).values({ testerId: before.id, goalSlug: "exercise", what: "dumbbells", when: "7:30" });
      await t.db.insert(flags).values({ testerId: before.id, kind: "off_list_goal", detail: "learn guitar" });

      await text(t, DEV, "RESET");
      const after = await tester(t, DEV);
      const resetMessage = (await t.db.select().from(messages).where(eq(messages.content, "RESET")))[0]!;
      expect(after).toMatchObject({
        id: before.id,
        name: null,
        phase: "onboarding",
        goalSlug: null,
        timeZone: "America/New_York",
        timeZoneStatus: "assumed_eastern",
        quietHoursStart: "22:00",
        quietHoursEnd: "09:00",
        pushiness: "pushy",
        styleNotes: "",
        stoppedAt: null,
        isTestUser: true,
        consentAt: before.consentAt,
        contextStartedAt: resetMessage.createdAt,
      });
      expect(await t.db.select().from(planInputs)).toHaveLength(0);
      expect(await t.db.select().from(flags)).toHaveLength(1);

      // The reset text goes to Claude as if it were a brand-new tester's first text.
      expect(t.replier.received.at(-1)).toEqual([{ role: "user", text: "RESET" }]);

      await text(t, DEV, "hey");
      expect(t.replier.received.at(-1)).toEqual([
        { role: "user", text: "RESET" },
        { role: "assistant", text: "Hey! Thanks for the message." },
        { role: "user", text: "hey" },
      ]);
      // Everything is still in the database: 4 inbound texts, 4 replies.
      expect(await t.db.select().from(messages)).toHaveLength(8);
    });

    it("from a non-dev allowed number is passed to Claude like any text and changes nothing", async () => {
      await text(t, ME, "hi");
      const before = await tester(t, ME);
      await updateTester(t.db, before.id, { name: "Yanni", goalSlug: "reading", styleNotes: "no emojis" });
      await t.db.insert(planInputs).values({ testerId: before.id, goalSlug: "reading", what: "novels" });

      await text(t, ME, "reset");
      expect(await tester(t, ME)).toMatchObject({
        name: "Yanni",
        goalSlug: "reading",
        styleNotes: "no emojis",
        contextStartedAt: before.contextStartedAt,
      });
      expect(await t.db.select().from(planInputs)).toHaveLength(1);
      expect(t.replier.received.at(-1)?.map((turn) => turn.text)).toEqual(["hi", "Hey! Thanks for the message.", "reset"]);
    });
  });
});

describe("goals seed", () => {
  it("has the seven starting goals in order, with their plan questions", async () => {
    const { db } = await makeDb();
    const rows = await db.select().from(goals).orderBy(asc(goals.sortOrder));
    expect(rows.map((g) => [g.slug, g.title])).toEqual([
      ["reading", "Daily reading"],
      ["exercise", "Daily exercise"],
      ["nutrition", "Daily nutrition"],
      ["reflection", "Daily reflection and planning"],
      ["deep_work", "Daily deep work target"],
      ["bedtime", "Same bedtime every night"],
      ["something_else", "Something else"],
    ]);
    const questions = Object.fromEntries(
      rows.map((g) => [g.slug, g.planQuestions.map((q) => `${q.key}${q.required ? "" : "?"}`).join(" ")]),
    );
    expect(questions).toEqual({
      reading: "what where? when how_long",
      exercise: "what where when how_long tracks_with",
      nutrition: "what when? tracks_with",
      reflection: "what where? when how_long",
      deep_work: "what where? when how_long tracks_with",
      bedtime: "what when tracks_with",
      something_else: "what where when how_long",
    });
    for (const g of rows) expect(g.description.length).toBeGreaterThan(0);
  });
});

describe("recentConversation since", () => {
  it("leaves out messages from before the given time and keeps the limit", async () => {
    const { db } = await makeDb();
    const at = (s: string) => new Date(`2026-10-27T12:00:${s}Z`);
    for (const [i, s] of ["00", "10", "20", "30", "40"].entries()) {
      await db.insert(messages).values({ direction: "inbound", contactNumber: ME, content: `m${i}`, createdAt: at(s) });
    }
    const contents = async (limit: number, since?: Date) =>
      (await recentConversation(db, ME, limit, since)).map((m) => m.content);
    expect(await contents(10)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(await contents(10, at("20"))).toEqual(["m2", "m3", "m4"]);
    expect(await contents(2, at("20"))).toEqual(["m3", "m4"]);
  });
});

describe("commands and time zones", () => {
  it("recognizes only whole-text opt-outs", () => {
    for (const w of OPT_OUTS) expect(isOptOutText(w)).toBe(true);
    expect(isOptOutText("STOP 🛑")).toBe(true);
    expect(isOptOutText("stop it")).toBe(false);
    expect(isOptOutText("")).toBe(false);
    expect(isOptOutText(null)).toBe(false);
  });

  it("recognizes reset in any case, and only on its own", () => {
    expect(isResetText("Reset")).toBe(true);
    expect(isResetText(" RESET ")).toBe(true);
    expect(isResetText("reset please")).toBe(false);
  });

  it("guesses time zones from area codes", () => {
    expect(guessTimeZone("+19085550100")).toEqual({ timeZone: "America/New_York", status: "assumed_eastern" });
    expect(guessTimeZone("+12125550123")).toEqual({ timeZone: "America/New_York", status: "assumed_eastern" });
    expect(guessTimeZone("+13125550123")).toEqual({ timeZone: "America/Chicago", status: "needs_city" });
    expect(guessTimeZone("+14155550123")).toEqual({ timeZone: "America/Los_Angeles", status: "needs_city" });
    expect(guessTimeZone("+16025550123")).toEqual({ timeZone: "America/Phoenix", status: "needs_city" });
    // Split across zones: best guess, but still ask.
    expect(guessTimeZone("+18505550123")).toEqual({ timeZone: "America/New_York", status: "needs_city" });
    // Unknown or non-US: Eastern guess, ask.
    expect(guessTimeZone("+447700900123")).toEqual({ timeZone: "America/New_York", status: "needs_city" });
  });

  it("parses DEV_NUMBERS like ALLOWED_NUMBERS", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x", DEV_NUMBERS: " +1 (908) 555-0100, 9085550101 ," });
    expect(c.devNumbers).toEqual(["+19085550100", "+19085550101"]);
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).devNumbers).toEqual([]);
  });
});
