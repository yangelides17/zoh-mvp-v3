import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach } from "../src/coach/coach.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { insideQuietHours, loadCoachState, localDate } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { flags, planInputs, plans, type Tester } from "../src/db/schema.js";
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
      "Plan shown to them, not locked yet: setup: dumbbells next to your bed tonight; step: 20 min dumbbells",
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
    await t.db.update(planInputs).set({ tracksWith: null }).where(eq(planInputs.testerId, row.id));
    expect(await run("propose_plan", GYM)).toMatchObject({ ok: false, error: "Ask these first: tracks_with" });
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
    expect(buildStateBlock(await state())).toContain("Locked plan (version 1, day 1 2026-10-27)");
  });

  it("starts tomorrow when asked, by the tester's local date", async () => {
    await run("propose_plan", GYM);
    // 11:30 pm Oct 27 in New York is already Oct 28 in UTC.
    const late = new Date("2026-10-28T03:30:00Z");
    await run("lock_plan", { commitment: "let's do it", start: "tomorrow" }, "fine, let's do it", late);
    expect((await allPlans())[0]!.startDate).toBe("2026-10-28");
    expect(localDate(late, "America/New_York")).toBe("2026-10-27");
    expect(localDate(late, "America/Los_Angeles", 1)).toBe("2026-10-28");
  });

  it("works end to end: the coach locks on the tester's text", async () => {
    await run("propose_plan", GYM);
    model.script({ tools: [{ name: "lock_plan", input: { commitment: "I'm in", start: "today" } }] }, "LET'S GO 🔒");
    await text(ME, "I'm in");
    expect((await tester()).phase).toBe("active");
    expect(t.sendblue.sends.at(-1)!.content).toBe("LET'S GO 🔒");
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

  it("flags a step time inside quiet hours, and a change agreed during planning is saved", async () => {
    await run("propose_plan", { ...GYM, time: "23:30" });
    expect(buildStateBlock(await state())).toContain("The step time 23:30 is inside their quiet hours. If you haven't offered yet, offer once");
    expect(await run("set_quiet_hours", { start: "00:00", end: "09:00" })).toMatchObject({ ok: true });
    expect(await tester()).toMatchObject({ phase: "planning", quietHoursStart: "00:00", quietHoursEnd: "09:00" });
    expect(buildStateBlock(await state())).not.toContain("inside their quiet hours");
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
