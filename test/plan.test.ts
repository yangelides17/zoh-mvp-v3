import { asc, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach, onlySaveConfirmation } from "../src/coach/coach.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { insideQuietHours, loadCoachState, localDate } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { insertOutbound } from "../src/db/messages.js";
import { flags, messages, planInputs, plans, stepDays, type Tester } from "../src/db/schema.js";
import { OPT_OUT_CONFIRMATION } from "../src/testers/commands.js";
import { getTesterByPhone, updateTester } from "../src/testers/testers.js";
import { DEV, FakeClaudeModel, ME, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

let t: TestApp;
let model: FakeClaudeModel;
/** 11:00 am in New York. */
const at = new Date("2026-10-27T15:00:00Z");

async function text(from: string, content: string) {
  const res = await postWebhook(t, inboundEvent({ content, from_number: from, number: from }));
  expect(res.statusCode).toBe(200);
  await t.queue.idle();
}

async function tester(phone = ME): Promise<Tester> {
  const row = await getTesterByPhone(t.db, phone);
  if (!row) throw new Error("no tester row");
  return row;
}

async function state(lastTesterText = "", phone = ME, now = at) {
  return loadCoachState(t.db, await tester(phone), { now, isFirstText: false, lastTesterText });
}

const run = async (name: string, input: unknown, lastTesterText = "", now = at) =>
  runTool(t.db, await state(lastTesterText, ME, now), name, input, now);

const allPlans = async () => t.db.select().from(plans).orderBy(asc(plans.version));

const GYM = {
  setup_step: "dumbbells next to your bed tonight",
  step: "20 min dumbbells: 3 rounds of rows, presses, goblet squats",
  place: "home",
  time: "07:30",
  days: ["mon", "wed", "fri"],
  proof: "screenshot",
  proof_note: "watch workout summary",
  reason: "Three mornings a week gets you back in it without wrecking your mornings.",
};

/** A tester who just finished onboarding for exercise (dev number, so "reset" works too). */
async function onboarded(phone = ME) {
  await text(phone, "Start");
  const row = await tester(phone);
  await updateTester(t.db, row.id, { name: "Alex", goalSlug: "exercise", phase: "planning" });
  await t.db.insert(planInputs).values({
    testerId: row.id,
    goalSlug: "exercise",
    what: "dumbbells",
    where: "home",
    when: "7:30 am",
    howLong: "20 min",
    tracksWith: "Apple Watch",
  });
}

beforeEach(async () => {
  const { db } = await makeDb();
  model = new FakeClaudeModel();
  t = await makeApp({ replier: createCoach({ db, model }) });
});
afterEach(async () => {
  await t.close();
});

describe("proposing a plan", () => {
  beforeEach(() => onboarded());

  it("saves a draft, and a revision changes only the fields given", async () => {
    expect(await run("propose_plan", GYM)).toMatchObject({ ok: true });
    expect(await run("propose_plan", { time: "07:00" })).toMatchObject({ ok: true });
    const [draft, ...rest] = await allPlans();
    expect(rest).toHaveLength(0);
    expect(draft).toMatchObject({
      status: "draft",
      version: null,
      goalSlug: "exercise",
      setupStep: GYM.setup_step,
      step: GYM.step,
      place: "home",
      stepTime: "07:00",
      days: ["mon", "wed", "fri"],
      proof: "screenshot",
      proofNote: GYM.proof_note,
      reason: GYM.reason,
      needsReview: false,
    });
    expect(buildStateBlock(await state())).toContain(
      "Plan saved but not sent yet: show it in this reply: setup: dumbbells next to your bed tonight; step: 20 min dumbbells",
    );
    expect(buildStateBlock(await state())).toContain("at 07:00, Mon, Wed, Fri");
  });

  it("needs every required field the first time, and an exact time", async () => {
    expect(await run("propose_plan", { step: "20 min dumbbells" })).toMatchObject({ ok: false, error: "Missing: time, days, proof, reason" });
    expect(await run("propose_plan", { ...GYM, time: "evenings" })).toMatchObject({ ok: false });
    expect(await allPlans()).toHaveLength(0);
  });

  it("is refused during onboarding and while required questions are open", async () => {
    const row = await tester();
    await updateTester(t.db, row.id, { phase: "onboarding" });
    expect(await run("propose_plan", GYM)).toMatchObject({ ok: false, error: "Finish the onboarding questions first." });
    await updateTester(t.db, row.id, { phase: "planning" });
    await t.db.update(planInputs).set({ where: null }).where(eq(planInputs.testerId, row.id));
    expect(await run("propose_plan", GYM)).toMatchObject({ ok: false, error: "Ask these first: where" });
  });
});

describe("whether the plan was shown (#37)", () => {
  beforeEach(async () => {
    await onboarded();
    model.requests = [];
  });

  const PLAN_TEXT = "That's everything I need, here's your plan:\n• 20 min dumbbells at 7:30 am\n• Mon, Wed, Fri\n• a watch screenshot\nWhat do you think?";
  const sent = async (content: string, createdAt?: Date) =>
    insertOutbound(t.db, { contactNumber: ME, content, ...(createdAt ? { createdAt } : {}) });
  const shown = async (now = at) => (await state("", ME, now)).draftShown;
  /** The test database's clock is millisecond-grained: a revision in a later reply is always a moment later. */
  const later = () => new Promise((r) => setTimeout(r, 5));

  it("reads not shown when no text went out after it, or the text didn't carry the plan", async () => {
    await run("propose_plan", GYM);
    expect(await shown()).toBe(false);
    await sent("Love it. One more thing first: which days work best?");
    expect(await shown()).toBe(false);
    expect(buildStateBlock(await state())).toContain("Plan saved but not sent yet: show it in this reply");
  });

  it("a failed send doesn't count", async () => {
    await run("propose_plan", GYM);
    await insertOutbound(t.db, { contactNumber: ME, content: PLAN_TEXT, status: "SEND_FAILED" });
    expect(await shown()).toBe(false);
  });

  it("reads shown once a text with the • plan goes out; a revision or replacement resets it until sent", async () => {
    await run("propose_plan", GYM);
    await sent(PLAN_TEXT);
    expect(await shown()).toBe(true);
    expect(buildStateBlock(await state())).toContain("Plan shown to them, not locked yet: setup:");

    await later();
    await run("propose_plan", { time: "07:00" });
    expect(await shown()).toBe(false);
    await sent(PLAN_TEXT.replace("7:30", "7"));
    expect(await shown()).toBe(true);

    // A replacement: a switch drops the draft, the new goal's plan starts unseen.
    await t.db.delete(plans).where(eq(plans.status, "draft"));
    await later();
    await run("propose_plan", GYM);
    expect(await shown()).toBe(false);
  });

  it("works on a test-mode clock that has jumped ahead", async () => {
    const row = await tester();
    const offset = 3 * 86_400_000;
    await updateTester(t.db, row.id, { clockOffsetMs: offset });
    const ahead = new Date(Date.now() + offset);
    await run("propose_plan", GYM, "", ahead);
    await sent(PLAN_TEXT, new Date(ahead.getTime() + 60_000));
    expect(await shown(ahead)).toBe(true);
    const revisedAt = new Date(ahead.getTime() + 120_000);
    await run("propose_plan", { time: "07:00" }, "", revisedAt);
    expect(await shown(revisedAt)).toBe(false);
    await sent(PLAN_TEXT, new Date(ahead.getTime() + 180_000));
    expect(await shown(revisedAt)).toBe(true);
  });

  it("the retry after an empty reply is told the plan wasn't sent, and its plan text counts as shown", async () => {
    model.script({ tools: [{ name: "propose_plan", input: GYM }] }, "", "", PLAN_TEXT);
    await text(ME, "sounds good, what's the plan?");
    // The fourth call is the pipeline's retry, after the first attempt saved the draft and sent nothing.
    expect(model.requests).toHaveLength(4);
    expect(model.stateOf(3)).toContain("Plan saved but not sent yet: show it in this reply");
    expect(model.stateOf(3)).not.toContain("Plan shown to them");
    expect(await shown()).toBe(true);
  });
});

describe("a reply that only confirms a save (#37)", () => {
  beforeEach(async () => {
    await onboarded();
    model.requests = [];
  });

  it("gets one more round to write the real reply", async () => {
    model.script({ tools: [{ name: "propose_plan", input: GYM }] }, "Saved.", "Here's your plan:\n• 20 min dumbbells\n• Mon, Wed, Fri\nWhat do you think?");
    await text(ME, "ok let's do it");
    expect(model.requests).toHaveLength(3);
    const note = JSON.stringify(model.requests[2]!.messages.at(-1));
    expect(note).toContain("only a save confirmation");
    const [out] = await t.db.select().from(messages).where(eq(messages.direction, "outbound")).orderBy(desc(messages.createdAt)).limit(1);
    expect(out!.content).toContain("Here's your plan");
  });

  it("only once, and never without a save first or for a real reply", async () => {
    model.script({ tools: [{ name: "save_plan_inputs", input: { when: "7 am" } }] }, "Saved.", "I've saved all of that.");
    await text(ME, "7 am works");
    expect(model.requests).toHaveLength(3);
    expect(onlySaveConfirmation("Saved.")).toBe(true);
    expect(onlySaveConfirmation("I’ve saved all of that.")).toBe(true);
    expect(onlySaveConfirmation("Saved. What time works best?")).toBe(false);
    expect(onlySaveConfirmation("Locked in! Day 1 is today at 7:30 pm, let's go!")).toBe(false);
    expect(onlySaveConfirmation("Noted, go get it!")).toBe(false);

    model.requests = [];
    model.script("Saved.");
    await text(ME, "cool");
    expect(model.requests).toHaveLength(1);
  });
});

describe("locking", () => {
  beforeEach(() => onboarded());

  it("is refused with no draft", async () => {
    expect(await run("lock_plan", { commitment: "I'm in", start: "today" }, "I'm in")).toMatchObject({
      ok: false,
      error: expect.stringContaining("No plan to lock"),
    });
  });

  it("is refused when the commitment isn't in their latest text", async () => {
    await run("propose_plan", GYM);
    expect(await run("lock_plan", { commitment: "I'm in", start: "today" }, "ok")).toMatchObject({
      ok: false,
      error: expect.stringContaining("isn't in their latest text"),
    });
    expect((await tester()).phase).toBe("planning");
    expect((await allPlans())[0]!.status).toBe("draft");
  });

  it("locks on their words: every field, version 1, today's local date, flagged for review, phase active", async () => {
    await run("propose_plan", GYM);
    const result = await run("lock_plan", { commitment: "i’m IN", start: "today" }, "Yes. I'm in, let's go!!");
    expect(result).toMatchObject({ ok: true });
    expect(await allPlans()).toEqual([
      expect.objectContaining({
        status: "locked",
        version: 1,
        setupStep: GYM.setup_step,
        step: GYM.step,
        place: "home",
        stepTime: "07:30",
        days: ["mon", "wed", "fri"],
        proof: "screenshot",
        startDate: "2026-10-27",
        commitment: "i’m IN",
        needsReview: true,
        lockedAt: at,
      }),
    ]);
    expect((await tester()).phase).toBe("active");
    expect(buildStateBlock(await state())).toContain("Locked plan (version 1, day 1 2026-10-27;");
    // Day 1 is the plan's step, the "first" kind (#88), and locking is their yes to it (#92).
    expect(await t.db.select().from(stepDays)).toMatchObject([{ date: "2026-10-27", step: GYM.step, stepKind: "first", agreedAt: at }]);
  });

  it("starts tomorrow when asked, by the tester's local date", async () => {
    await run("propose_plan", GYM);
    // 11:30 pm Oct 27 in New York is already Oct 28 in UTC.
    const late = new Date("2026-10-28T03:30:00Z");
    await run("lock_plan", { commitment: "let's do it", start: "tomorrow" }, "fine, let's do it", late);
    expect((await allPlans())[0]!.startDate).toBe("2026-10-28");
    expect(localDate(late, "America/New_York")).toBe("2026-10-27");
    expect(localDate(late, "America/Los_Angeles", 1)).toBe("2026-10-28");
    // #92: the lock is a yes ahead, so day 1's kickoff checks they're still in rather than asking fresh.
    expect(await t.db.select().from(stepDays)).toMatchObject([{ date: "2026-10-28", agreedAt: late }]);
    const morning = buildStateBlock(await state("", ME, new Date("2026-10-28T13:00:00Z")));
    expect(morning).toContain("They said yes to today's step ahead of time (");
    expect(morning).toContain("its one question checks they're still in, in words that show they already said yes");
  });

  it("works end to end: the coach locks on the tester's text", async () => {
    await run("propose_plan", GYM);
    model.script({ tools: [{ name: "lock_plan", input: { commitment: "I'm in", start: "today" } }] }, "LET'S GO 🔒");
    await text(ME, "I'm in");
    expect((await tester()).phase).toBe("active");
    expect(t.sendblue.sends.at(-1)!.content).toBe("LET'S GO 🔒");
  });

  it("checks every text since ZOH's last reply, not just the newest", async () => {
    await run("propose_plan", GYM);
    model.script({ tools: [{ name: "lock_plan", input: { commitment: "I'm in", start: "today" } }] }, "LET'S GO 🔒");
    const coach = createCoach({ db: t.db, model });
    const turns = [
      { role: "assistant" as const, text: "This is yours now. You in?" },
      { role: "user" as const, text: "I'm in" },
      { role: "user" as const, text: "🔥🔥" },
    ];
    expect(await coach.reply({ tester: await tester(), turns, now: at })).toBe("LET'S GO 🔒");
    expect((await tester()).phase).toBe("active");
  });
});

describe("at least 3 days a week", () => {
  beforeEach(() => onboarded());

  it("is enforced by propose_plan, change_plan and lock_plan", async () => {
    expect(await run("propose_plan", { ...GYM, days: ["mon", "thu"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("at least 3 days a week"),
    });
    await run("propose_plan", GYM);
    // A draft that somehow has two days still can't lock.
    await t.db.update(plans).set({ days: ["mon", "thu"] });
    expect(await run("lock_plan", { commitment: "I'm in", start: "today" }, "I'm in")).toMatchObject({
      ok: false,
      error: "A plan needs at least 3 days a week.",
    });
    await t.db.update(plans).set({ days: ["mon", "wed", "fri"] });
    await run("lock_plan", { commitment: "I'm in", start: "today" }, "I'm in");
    expect(await run("change_plan", { days: ["sat", "sun"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("at least 3 days a week"),
    });
    expect(await allPlans()).toHaveLength(1);
  });
});

describe("changing a locked plan", () => {
  beforeEach(async () => {
    await onboarded();
    await run("propose_plan", GYM);
    await run("lock_plan", { commitment: "I'm in", start: "today" }, "I'm in");
  });

  it("creates a new flagged version and keeps the old one as it was", async () => {
    expect(await run("change_plan", { time: "08:00" })).toMatchObject({ ok: true });
    const [v1, v2] = await allPlans();
    expect(v1).toMatchObject({ version: 1, stepTime: "07:30", needsReview: true });
    expect(v2).toMatchObject({
      version: 2,
      status: "locked",
      stepTime: "08:00",
      step: GYM.step,
      days: ["mon", "wed", "fri"],
      startDate: "2026-10-27",
      commitment: "I'm in",
      needsReview: true,
    });
    expect(buildStateBlock(await state())).toContain("Locked plan (version 2");
  });

  it("is only for locked plans, and propose_plan is refused once locked", async () => {
    expect(await run("propose_plan", { time: "08:00" })).toMatchObject({ ok: false, error: "Their plan is locked: use change_plan." });
    const row = await tester();
    await updateTester(t.db, row.id, { phase: "planning" });
    expect(await run("change_plan", { time: "08:00" })).toMatchObject({ ok: false });
  });
});

describe("switching goals", () => {
  beforeEach(async () => {
    await onboarded();
    await run("propose_plan", GYM);
    await run("lock_plan", { commitment: "I'm in", start: "today" }, "I'm in");
  });

  it("is refused without a reason, to the same goal, or off the starting list", async () => {
    expect(await run("switch_goal", { slug: "reading" })).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    expect(await run("switch_goal", { slug: "reading", reason: " " })).toMatchObject({ ok: false });
    expect(await run("switch_goal", { slug: "exercise", reason: "hurt my back" })).toMatchObject({ ok: false });
    expect(await run("switch_goal", { slug: "something_else", reason: "hurt my back" })).toMatchObject({ ok: false });
    expect((await tester()).goalSlug).toBe("exercise");
  });

  it("saves the reason, opens only the new goal's questions, and ends in a new locked plan", async () => {
    const result = await run("switch_goal", { slug: "reading", reason: "hurt my back, doctor says no lifting for a month" });
    expect(result).toMatchObject({ ok: true });
    expect(await tester()).toMatchObject({ goalSlug: "reading", phase: "planning" });
    expect(await t.db.select().from(flags)).toEqual([
      expect.objectContaining({ kind: "goal_switch", detail: "exercise → reading: hurt my back, doctor says no lifting for a month" }),
    ]);

    const s = await state();
    expect(s.openRequired.map((q) => q.key)).toEqual(["what", "when", "how_long"]);
    expect(s.plan).toBeUndefined();
    const block = buildStateBlock(s);
    expect(block).toContain("Answers from an earlier goal (reuse with save_plan_inputs only where they fit): exercise: what = dumbbells");
    expect(block).toContain("Plan: not proposed yet");

    expect(await run("propose_plan", GYM)).toMatchObject({ ok: false, error: "Ask these first: what, when, how_long" });
    await run("save_plan_inputs", { what: "Atomic Habits", when: "7:30 am", how_long: "20 min" });
    await run("propose_plan", { ...GYM, setup_step: "", step: "20 pages of Atomic Habits", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    await run("lock_plan", { commitment: "let's do it", start: "tomorrow" }, "ok let's do it");

    const [v1, v2] = await allPlans();
    expect(v1).toMatchObject({ version: 1, goalSlug: "exercise", status: "locked" });
    expect(v2).toMatchObject({ version: 2, goalSlug: "reading", status: "locked", setupStep: null, startDate: "2026-10-28" });
    expect((await tester()).phase).toBe("active");
    expect((await state()).plan?.id).toBe(v2!.id);
    expect(buildStateBlock(await state())).toContain("at 07:30, every day");
  });

  it("drops an unlocked draft when switching before the plan is locked", async () => {
    const row = await tester();
    await t.db.delete(plans);
    await updateTester(t.db, row.id, { phase: "planning" });
    await run("propose_plan", GYM);
    await run("switch_goal", { slug: "deep_work", reason: "I realized focus at work is what I actually need" });
    expect(await allPlans()).toHaveLength(0);
  });
});

describe("quiet hours", () => {
  beforeEach(() => onboarded());

  it("knows when a time is inside them, across midnight or not", () => {
    const defaults = { quietHoursStart: "22:00", quietHoursEnd: "09:00" };
    expect(insideQuietHours("23:30", defaults)).toBe(true);
    expect(insideQuietHours("08:59", defaults)).toBe(true);
    expect(insideQuietHours("09:00", defaults)).toBe(false);
    expect(insideQuietHours("21:59", defaults)).toBe(false);
    const sameDay = { quietHoursStart: "01:00", quietHoursEnd: "07:00" };
    expect(insideQuietHours("03:00", sameDay)).toBe(true);
    expect(insideQuietHours("23:30", sameDay)).toBe(false);
  });

  it("a step time inside default quiet hours gets a few words and no offer (#48); hours they set are saved as theirs", async () => {
    const proposed = await run("propose_plan", { ...GYM, time: "23:30" });
    expect(proposed).toMatchObject({ ok: true, message: expect.stringContaining("with no question about it") });
    expect(buildStateBlock(await state())).toContain("The step time 23:30 is inside their default quiet hours, which move to fit it");
    expect(buildStateBlock(await state())).not.toContain("ask once");
    expect(await run("set_quiet_hours", { start: "00:00", end: "09:00" })).toMatchObject({ ok: true });
    expect(await tester()).toMatchObject({ phase: "planning", quietHoursStart: "00:00", quietHoursEnd: "09:00", quietHoursChosen: true });
    expect(buildStateBlock(await state())).not.toContain("inside their default quiet hours");
  });
});

describe("stop and reset during plan agreement", () => {
  it('"stop" stops them with one confirmation and never reaches the coach', async () => {
    await onboarded();
    await run("propose_plan", GYM);
    const calls = model.requests.length;
    await text(ME, "stop");
    expect((await tester()).stoppedAt).not.toBeNull();
    expect(t.sendblue.sends.at(-1)!.content).toBe(OPT_OUT_CONFIRMATION);
    expect(model.requests).toHaveLength(calls);
  });

  it('"reset" removes drafts and locked plans', async () => {
    await onboarded(DEV);
    const s = await loadCoachState(t.db, await tester(DEV), { now: at, isFirstText: false, lastTesterText: "I'm in" });
    await runTool(t.db, s, "propose_plan", GYM, at);
    const s2 = await loadCoachState(t.db, await tester(DEV), { now: at, isFirstText: false, lastTesterText: "I'm in" });
    await runTool(t.db, s2, "lock_plan", { commitment: "I'm in", start: "today" }, at);
    const s3 = await loadCoachState(t.db, await tester(DEV), { now: at, isFirstText: false });
    await runTool(t.db, s3, "change_plan", { time: "08:00" }, at);
    expect(await allPlans()).toHaveLength(2);

    await text(DEV, "reset");
    expect(await allPlans()).toHaveLength(0);
    expect(await tester(DEV)).toMatchObject({ phase: "onboarding", goalSlug: null });
  });
});
