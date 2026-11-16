import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Plan, StepDay, Tester } from "../src/db/schema.js";
import type { CoachState } from "../src/coach/state.js";
import { buildStateBlock, FIXED_INSTRUCTIONS, fullVoiceInstructions, moments, MOMENTS, type Moment } from "../src/coach/prompt.js";
import { TOOL_DEFINITIONS } from "../src/coach/tools.js";
import { VOICE_DOC_PATH } from "../src/coach/voice.js";
import type { WeekLookback } from "../src/coach/week.js";

/**
 * #199: the status sheet states facts, never orders. Built here as plain objects (no database) for the situations
 * whose consequences the code guarantees, so each fact shows exactly when it applies; how to act on it lives in the
 * section its moment names, which every phase that can show it reads.
 */

const TZ = "America/New_York";
const at = (iso: string) => new Date(iso);

// Test fixtures: only the fields the sheet reads; the casts keep the rest of each row out of the way.
const tester = (o: Partial<Tester> = {}) =>
  ({
    id: "t1",
    phone: "+15555550100",
    name: "Sam",
    goalSlug: "reading",
    phase: "active",
    timeZone: TZ,
    timeZoneStatus: "assumed_eastern",
    quietHoursStart: "22:00",
    quietHoursEnd: "09:00",
    quietHoursChosen: false,
    quietHoursAskedFor: null,
    styleNotes: null,
    ...o,
  }) as unknown as Tester;

const plan = (o: Partial<Plan> = {}) =>
  ({
    id: "p1",
    goalSlug: "reading",
    status: "locked",
    version: 1,
    step: "10 pages of Dune",
    stepTime: "19:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat"],
    proof: "photo",
    reason: "Ten pages a night builds the habit.",
    minutes: 20,
    destination: null,
    commitment: "I'm in",
    startDate: "2026-11-02",
    endsOn: null,
    ...o,
  }) as unknown as Plan;

const day = (o: Partial<StepDay>) => ({ date: "2026-11-10", status: null, ...o }) as unknown as StepDay;

const week = (o: Partial<WeekLookback> = {}): WeekLookback => ({
  from: "2026-11-09",
  to: "2026-11-15",
  days: [day({ date: "2026-11-09", status: "done" }), day({ date: "2026-11-10", status: "missed" })],
  learnings: { understood: [], explained: [] },
  recapped: false,
  recappedNow: false,
  ...o,
});

const note = (id: string, body: string) => ({ id, body, createdAt: at("2026-11-10T14:00:00Z") }) as unknown as CoachState["teamNotes"][number];

/** Tuesday Nov 10, 2026, 10 am in New York: an active tester on a step day, nothing happened yet. */
function state(o: Partial<CoachState> = {}): CoachState {
  const t = o.tester ?? tester();
  return {
    tester: t,
    goals: [{ slug: "reading", title: "Read more", description: "reading", planQuestions: [] }] as unknown as CoachState["goals"],
    goal: { slug: "reading", title: "Read more", description: "reading", planQuestions: [] } as unknown as CoachState["goal"],
    declinedGoals: [],
    openRequired: [],
    openOptional: [],
    draftShown: false,
    plan: t.phase === "active" ? plan() : undefined,
    today: "2026-11-10",
    quietToday: { start: "22:00", end: "09:00" },
    recentDays: [],
    takeaways: [],
    days: { streak: 0, streakThrough: null, missesInARow: 0, reducedInARow: 0 } as unknown as CoachState["days"],
    proof: { today: 0, zohTextsSince: 0 } as unknown as CoachState["proof"],
    goalCap: 2,
    testerGoals: [],
    streaks: [],
    suggestions: [],
    checkins: [],
    maintenanceSteps: {},
    earlierAnswers: [],
    teamNotes: [],
    teamRequests: [],
    teamRequestsDone: [],
    lastTesterText: "",
    lastZohText: "",
    isFirstText: false,
    justFinished: false,
    now: at("2026-11-10T15:00:00Z"),
    ...o,
  };
}

const sheet = (o: Partial<CoachState> = {}) => buildStateBlock(state(o));
const carries = (s: string) => /This text carries \(not sent yet\):\n((?:- .*\n?)*)/.exec(s)?.[1] ?? "";

describe("the status sheet's code-guaranteed facts, each when it applies (#199)", () => {
  it("a first text during onboarding: first text, no name, no goal, and the exact goal lines", () => {
    const s = sheet({ tester: tester({ phase: "onboarding", name: null }), goal: undefined, isFirstText: true });
    expect(s).toContain("First text from this tester: yes");
    expect(s).toContain("Name: not given yet");
    expect(s).toContain("Goal: not chosen yet");
    expect(s).toContain("Goal list:\n• Read more\n• Not sure? Let's figure it out together");
    expect(s).toContain("Moments now: Onboarding");
  });

  it("onboarding just finished: said, and plan agreement is a moment now", () => {
    const s = sheet({ tester: tester({ phase: "onboarding" }), justFinished: true });
    expect(s).toContain("ONBOARDING JUST FINISHED with this text: every required answer is saved.");
    expect(moments(state({ tester: tester({ phase: "onboarding" }), justFinished: true }))).toEqual(["Onboarding", "Plan agreement"]);
  });

  it("#37: a plan saved but not shown is carried by this text; once shown, it isn't", () => {
    const planning = tester({ phase: "planning" });
    const notShown = sheet({ tester: planning, draft: plan({ status: "draft" }), draftShown: false });
    expect(carries(notShown)).toContain("- the plan, saved but not shown to them yet");
    expect(notShown).toContain("Plan saved, not shown to them yet: ");
    const shown = sheet({ tester: planning, draft: plan({ status: "draft" }), draftShown: true });
    expect(shown).not.toContain("This text carries");
    expect(shown).toContain("Plan shown to them, not locked yet: ");
  });

  it("#48: a step inside quiet hours they chose, until asked once; default ones just move", () => {
    const chosen = tester({ phase: "planning", quietHoursChosen: true, quietHoursStart: "21:00", quietHoursEnd: "07:00" });
    const draft = plan({ status: "draft", stepTime: "06:30" });
    expect(sheet({ tester: chosen, draft })).toContain("The step time 06:30 is inside the quiet hours they chose, so no text can reach them then; not asked about yet for this time.");
    expect(sheet({ tester: tester({ ...chosen, quietHoursAskedFor: "06:30" }), draft })).not.toContain("inside the quiet hours");
    const byDefault = tester({ phase: "planning", quietHoursStart: "22:00", quietHoursEnd: "09:00" });
    expect(sheet({ tester: byDefault, draft })).toContain("The step time 06:30 is inside their default quiet hours, which move to fit it.");
  });

  it("#42, #77: a yes today is settled; a yes from an earlier day is ahead", () => {
    expect(sheet({ todayRow: day({ agreedAt: at("2026-11-10T13:00:00Z") }) })).toContain("They said yes to it today (Tue 8:00 AM): settled.");
    expect(sheet({ todayRow: day({ agreedAt: at("2026-11-10T01:00:00Z") }) })).toContain("They said yes to it ahead of time, on an earlier day (Mon 8:00 PM).");
    expect(sheet()).not.toContain("They said yes");
  });

  it("#93: the count of texts since their proof, a long talk past the safety net, and yesterday's untold step", () => {
    const doneToday = { todayRow: day({ status: "done", howItWentSaid: true }), proof: { today: 1, zohTextsSince: 2 } as unknown as CoachState["proof"] };
    expect(sheet(doneToday)).toContain("This reply is your 3rd text since their proof today.");
    expect(sheet(doneToday)).not.toContain("long talk");
    const long = sheet({ ...doneToday, proof: { today: 1, zohTextsSince: 7 } as unknown as CoachState["proof"] });
    expect(long).toContain("This reply is your 8th text since their proof today. That's a long talk, past the usual length of a reflection.");
    const yesterday = { recentDays: [day({ date: "2026-11-09", status: "done", howItWentSaid: false })] };
    expect(sheet(yesterday)).toContain("Yesterday's step was done with no word yet on how it went.");
    expect(moments(state(yesterday))).toContain("Proof");
    // Never in a text ZOH starts.
    expect(sheet({ ...yesterday, nudgeMoment: "kickoff" })).not.toContain("Yesterday's step");
  });

  it("rule 7: two reduced days in a row show as a count, and slipping is a moment", () => {
    const s = state({ days: { streak: 3, streakThrough: "2026-11-09", missesInARow: 0, reducedInARow: 2 } as unknown as CoachState["days"], recentDays: [day({ date: "2026-11-09", status: "done_reduced" })] });
    expect(buildStateBlock(s)).toContain("Reduced in a row: 2.");
    expect(moments(s)).toContain("When they start to slip");
  });

  it("#78, #102: Sunday's recap, not given, in this text (the 6 pm one, recorded by the app), then given", () => {
    const sunday = { today: "2026-11-15", now: at("2026-11-15T22:00:00Z") };
    expect(sheet({ ...sunday, week: week() })).toContain("WEEK LOOK-BACK, Mon 2026-11-09 to today. Recap: not given yet.");
    expect(sheet({ ...sunday, week: week() })).toContain("This week: 1 done in full, 0 smaller, 1 missed, today included");
    const lookback = sheet({ ...sunday, week: week(), nudgeMoment: "lookback" });
    expect(carries(lookback)).toContain("- the week's recap (WEEK LOOK-BACK below; the app records it)");
    expect(lookback).toContain("Recap: in this text.");
    expect(carries(sheet({ ...sunday, week: week({ recapped: true, recappedNow: true }) }))).toContain("- the week's recap (WEEK LOOK-BACK below; recorded)");
    const given = sheet({ ...sunday, week: week({ recapped: true }) });
    expect(given).toContain("Recap: given today (in conversation or its own text).");
    expect(given).not.toContain("This text carries");
  });

  it("#110: Monday's owed recap, carried by a reply (ZOH records it) or the morning text (the app does)", () => {
    const monday = { today: "2026-11-16", now: at("2026-11-16T15:00:00Z"), lastWeek: week() };
    const reply = sheet(monday);
    expect(carries(reply)).toContain("- last week's recap, owed since Sunday (LAST WEEK'S LOOK-BACK below; you call record_week_recap)");
    expect(reply).toContain("LAST WEEK'S LOOK-BACK, Mon 2026-11-09 to Sun 2026-11-15. Recap: owed: they didn't answer Sunday's texts, so it waited for today.");
    expect(carries(sheet({ ...monday, nudgeMoment: "kickoff" }))).toContain("- last week's recap, owed since Sunday (LAST WEEK'S LOOK-BACK below; the app records it)");
    expect(sheet({ ...monday, lastWeek: week({ recapped: true }) })).toContain("Recap: given today.");
    expect(sheet({ ...monday, lastWeek: week({ recapped: true }) })).not.toContain("This text carries");
  });

  it("the team: notes, a request not done, a request carried by a text it starts, and one marked done in this reply", () => {
    const n = note("n1", "Traveling next week");
    const r = note("r1", "Share https://example.com/sleep");
    const threads = sheet({ teamNotes: [n], teamRequests: [r] });
    expect(threads).toMatch(/FROM THE TEAM, notes:\n- Nov 10: Traveling next week/);
    expect(threads).toMatch(/FROM THE TEAM, request \[\w+:?\w*\], not done yet: Share https:\/\/example.com\/sleep/);
    const carried = sheet({ teamRequests: [r], nudgeMoment: "kickoff", carry: { requestId: "r1" } as CoachState["carry"] });
    expect(carries(carried)).toMatch(/- the team's request \[.+\] \(the app records it\): Share https:\/\/example.com\/sleep/);
    expect(carried).not.toContain("not done yet");
    expect(carries(sheet({ teamRequestsDone: [r] }))).toMatch(/- the team's request \[.+\] \(you marked it done\): Share/);
  });

  it("paused and stopped: said as facts, with whether ZOH has asked about restarting", () => {
    const paused = sheet({ pause: { startedAt: at("2026-11-08T15:00:00Z"), reason: "travel", until: "2026-11-14" } as unknown as CoachState["pause"] });
    expect(paused).toContain("PAUSED: they asked for a break on 2026-11-08 (travel), back on 2026-11-14 (it lifts that morning). Nothing you'd start goes out.");
    const stopped = (asked: boolean) => sheet({ stopped: { since: at("2026-11-08T15:00:00Z"), asked } });
    expect(stopped(false)).toContain("STOPPED: they texted stop on 2026-11-08. Nothing you'd start goes out. Not asked yet if they want to restart.");
    expect(stopped(true)).toContain("You've asked if they want to restart.");
    expect(moments(state({ stopped: { since: at("2026-11-08T15:00:00Z"), asked: false } }))).toContain("Saving, style and requests");
  });

  it("a day 1 still ahead: nothing to do yet, and no step-day moments", () => {
    const s = state({ plan: plan({ startDate: "2026-11-11" }) });
    expect(buildStateBlock(s)).toContain("Today: Tue 2026-11-10. Day 1 is Wed 2026-11-11: nothing to do yet.");
    expect(moments(s)).not.toContain("Today's step");
  });
});

/** Which phases can show each moment, and the instructions each phase reads. */
const PHASES: Record<Moment, ("onboarding" | "planning" | "active")[]> = {
  Onboarding: ["onboarding"],
  "Plan agreement": ["onboarding", "planning"],
  Nudges: ["onboarding", "planning", "active"],
  "Today's step": ["active"],
  Proof: ["active"],
  "When they start to slip": ["active"],
  "Sunday look-back": ["active"],
  "Next steps and maintenance": ["active"],
  "The team": ["onboarding", "planning", "active"],
  "Saving, style and requests": ["onboarding", "planning", "active"],
};
const INSTRUCTIONS = { onboarding: FIXED_INSTRUCTIONS, planning: fullVoiceInstructions(), active: fullVoiceInstructions() };
const sees = (text: string, name: string) => text.toLowerCase().includes(name.toLowerCase());

describe("moments and their guidance (#199)", () => {
  const page = readFileSync(VOICE_DOC_PATH, "utf8");
  const headings = [...page.matchAll(/^#+ (.*?)(?:\s*<!--.*-->)?\s*$/gm)].map((m) => m[1]);

  it("names each moment by a page heading (onboarding by its own section), so #200 can load sections by them", () => {
    for (const m of MOMENTS) if (m !== "Onboarding") expect(headings, m).toContain(m);
    expect(FIXED_INSTRUCTIONS).toContain("ONBOARDING (phase");
  });

  it("puts each moment's guidance in the instructions of every phase where it can appear", () => {
    for (const m of MOMENTS) for (const phase of PHASES[m]) expect(sees(INSTRUCTIONS[phase], m), `${m} in ${phase}`).toBe(true);
  });

  it("names more than one moment at once when more than one applies", () => {
    const busy = state({
      today: "2026-11-15",
      week: week(),
      todayRow: day({ status: "done" }),
      proof: { today: 1, zohTextsSince: 1 } as unknown as CoachState["proof"],
      teamNotes: [note("n1", "x")],
      plan: plan({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }),
    });
    expect(moments(busy)).toEqual(["Today's step", "Proof", "Sunday look-back", "The team"]);
    expect(buildStateBlock(busy)).toContain("Moments now: Today's step; Proof; Sunday look-back; The team");
  });
});

describe("labels in sync (#199)", () => {
  // Every sheet label the page, the coach's notes or a tool description points to.
  const LABELS = ["This text carries", "WEEK LOOK-BACK", "LAST WEEK'S LOOK-BACK", "NUDGE MOMENT", "FROM THE TEAM", "STOPPED", "PAUSED"];
  const quoting = [fullVoiceInstructions(), FIXED_INSTRUCTIONS, readFileSync("src/coach/coach.ts", "utf8"), JSON.stringify(TOOL_DEFINITIONS)].join("\n");
  const sheets = [
    sheet({ teamNotes: [note("n1", "x")], teamRequestsDone: [note("r1", "y")], nudgeMoment: "kickoff", today: "2026-11-15", week: week() }),
    sheet({ today: "2026-11-16", lastWeek: week(), pause: { startedAt: at("2026-11-08T15:00:00Z"), reason: null, until: null } as unknown as CoachState["pause"] }),
    sheet({ stopped: { since: at("2026-11-08T15:00:00Z"), asked: false } }),
  ].join("\n");

  it("each label quoted anywhere appears on a sheet built for some situation", () => {
    for (const l of LABELS) {
      expect(quoting.includes(l) || l === "PAUSED" || l === "STOPPED", `${l} is quoted`).toBe(true);
      expect(sheets, l).toContain(l);
    }
  });

  it("nothing still points to a label the sheet dropped", () => {
    for (const old of ["THIS TEXT ALSO", "Onboarding is NOT finished", "Plan saved but not sent yet"]) expect(quoting, old).not.toContain(old);
  });
});
