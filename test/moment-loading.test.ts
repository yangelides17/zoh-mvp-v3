import { describe, expect, it } from "vitest";
import {
  FIXED_INSTRUCTIONS,
  FULL_VOICE_INTRO,
  fullVoiceInstructions,
  instructionsFor,
  MEMORY,
  moments,
  PARTS,
  partsFor,
  TEAM,
  TOOL_RULES,
  type Moment,
  type Part,
  type Reach,
} from "../src/coach/prompt.js";
import type { CoachState } from "../src/coach/state.js";
import { loadVoiceDoc, RULE_KEYS, splitVoicePage } from "../src/coach/voice.js";
import { at, day, note, plan, state, tester, week } from "./sheet-fixtures.js";

/**
 * #200: each reply (or text ZOH starts) loads the core plus every part that can apply to it; a part is left out only
 * when it can't. Built as plain states (Tuesday Nov 10, 10 am, a step day, unless a case says otherwise).
 */

const SUNDAY = { today: "2026-11-15", now: at("2026-11-15T22:00:00Z"), plan: plan({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }) };
/** Tuesday is a rest day on this plan. */
const REST_DAY = { plan: plan({ days: ["mon", "wed", "fri"] }) };
const DONE_WITH_PROOF = { todayRow: day({ status: "done" }), proof: { today: 1, zohTextsSince: 1 } as unknown as CoachState["proof"] };
const MAINTENANCE = { testerGoals: [{ goalSlug: "running", role: "maintenance" }] as unknown as CoachState["testerGoals"] };

interface Case {
  name: string;
  state: CoachState;
  reach?: Reach;
  loads: Part[];
  not?: Part[];
}

const CASES: Case[] = [
  { name: "a step-day reply before the step", state: state(), loads: ["planChange", "nudgeReplies", "todaysStep", "proof", "slip", "nextSteps"], not: ["plan", "nudges", "weekLookback", "nextStepsTeam"] },
  { name: "a first \"can't today\" (nothing in the state yet)", state: state({ lastTesterText: "can't today, slammed" }), loads: ["slip", "nudgeReplies", "todaysStep"] },
  { name: "proof just arrived, reflecting", state: state(DONE_WITH_PROOF), reach: { media: true }, loads: ["proof", "todaysStep", "nextSteps"], not: ["slip"] },
  { name: "proof plus a memory question (memory is in the core once locked)", state: state(DONE_WITH_PROOF), reach: { media: true }, loads: ["proof"] },
  { name: "a rest-day \"can I do it anyway?\"", state: state(REST_DAY), loads: ["todaysStep", "nudgeReplies", "planChange"], not: ["slip", "proof"] },
  { name: "a rest day, a photo arrives", state: state(REST_DAY), reach: { media: true }, loads: ["proof"] },
  {
    name: "a rest day after yesterday's untold step",
    state: state({ ...REST_DAY, recentDays: [day({ date: "2026-11-09", status: "done", howItWentSaid: false })] }),
    loads: ["proof"],
    not: ["slip"],
  },
  { name: "a rest day after a miss", state: state({ ...REST_DAY, days: { streak: 0, missesInARow: 1, reducedInARow: 0 } as unknown as CoachState["days"] }), loads: ["slip"] },
  { name: "two reduced days in a row", state: state({ ...REST_DAY, days: { streak: 3, missesInARow: 0, reducedInARow: 2 } as unknown as CoachState["days"] }), loads: ["slip"] },
  {
    name: "Sunday plus proof plus a pause",
    state: state({ ...SUNDAY, ...DONE_WITH_PROOF, week: week(), pause: { startedAt: at("2026-11-14T15:00:00Z"), reason: "trip", until: "2026-11-20" } as unknown as CoachState["pause"] }),
    reach: { media: true },
    loads: ["proof", "weekLookback", "todaysStep"],
  },
  { name: "Monday's reply owing last week's recap", state: state({ today: "2026-11-16", now: at("2026-11-16T15:00:00Z"), lastWeek: week() }), loads: ["weekLookback", "nudges"] },
  { name: "a maintenance goal", state: state(MAINTENANCE), loads: ["nextStepsTeam"] },
  { name: "a reply after a stop", state: state({ stopped: { since: at("2026-11-08T15:00:00Z"), asked: true } }), loads: ["planChange"] },
  { name: "a reply while paused", state: state({ pause: { startedAt: at("2026-11-08T15:00:00Z"), reason: null, until: null } as unknown as CoachState["pause"] }), loads: ["planChange"] },
  { name: "a reply before day 1", state: state({ plan: plan({ startDate: "2026-11-12" }) }), loads: ["planChange", "nextSteps"], not: ["todaysStep", "nudgeReplies", "proof", "slip"] },
  { name: "a team note in a reply (the team is in the core)", state: state({ teamNotes: [note("n1", "she's travelling")] }), loads: ["planChange"] },
  { name: "the kickoff", state: state({ nudgeMoment: "kickoff" }), loads: ["nudges", "todaysStep"], not: ["nudgeReplies", "planChange", "plan", "slip", "weekLookback", "nextStepsTeam"] },
  {
    name: "a team request riding a kickoff",
    state: state({ nudgeMoment: "kickoff", carry: { requestId: "r1" }, teamRequests: [note("r1", "send the article")] as unknown as CoachState["teamRequests"] }),
    loads: ["nudges", "todaysStep"],
    not: ["nudgeReplies"],
  },
  { name: "a kickoff carrying a maintenance check-in", state: state({ ...MAINTENANCE, nudgeMoment: "kickoff", carry: { checkinGoal: "running" } }), loads: ["nudges", "nextStepsTeam"] },
  { name: "the day-3 check-in", state: state({ nudgeMoment: "day_three" }), loads: ["nudges", "slip", "todaysStep"] },
  {
    name: "a reply to the day-3 check-in",
    state: state({ days: { streak: 0, missesInARow: 2, reducedInARow: 0 } as unknown as CoachState["days"] }),
    loads: ["slip", "planChange", "nextSteps"],
  },
  { name: "the kickoff after a miss", state: state({ nudgeMoment: "after_miss" }), loads: ["slip"] },
  { name: "the check-in (a takeaway may come back)", state: state({ nudgeMoment: "checkin" }), loads: ["proof", "todaysStep"] },
  { name: "a rest-day text", state: state({ ...REST_DAY, nudgeMoment: "rest_day" }), loads: ["nudges"], not: ["todaysStep", "proof", "slip", "nudgeReplies"] },
  { name: "the 6 pm Sunday recap", state: state({ ...SUNDAY, week: week(), nudgeMoment: "lookback" }), loads: ["nudges", "weekLookback"], not: ["nudgeReplies"] },
  {
    name: "a planning reply (and a goal switch leading into a new plan, once it's planning)",
    state: state({ tester: tester({ phase: "planning" }) }),
    loads: ["plan", "planChange"],
    not: ["nudges", "nudgeReplies", "todaysStep", "proof", "slip", "weekLookback", "nextSteps", "nextStepsTeam"],
  },
  { name: "a planning stall", state: state({ tester: tester({ phase: "planning" }), nudgeMoment: "stall" }), loads: ["plan", "planChange", "nudges"] },
];

/** The instructions a situation reads: onboarding's own prompt, or the core and its parts. */
function read(s: CoachState, reach?: Reach): string {
  if (s.tester.phase === "onboarding") return FIXED_INSTRUCTIONS;
  const { core, moments } = instructionsFor(s.tester.phase === "planning" ? "planning" : "active", partsFor(s, reach));
  return [core, moments].join("\n\n");
}

/** What each moment's guidance opens with, so it can be found in what loads. */
const GUIDANCE: Record<Moment, string> = {
  Onboarding: "ONBOARDING (phase",
  "Plan agreement": "PLAN AGREEMENT (phases",
  Nudges: "NUDGES (texts you start",
  "Today's step": "TODAY'S STEP (phase",
  Proof: "PROOF (phase",
  "When they start to slip": "## When they start to slip",
  "Sunday look-back": "WEEK LOOK-BACK (phase",
  "Next steps and maintenance": "- A next step the state lists as approved",
  "The team": "THE TEAM:",
  "Saving, style and requests": "SAVING, STYLE AND REQUESTS",
};

describe("which parts each reply loads (#200)", () => {
  it.each(CASES)("$name", ({ state: s, reach, loads, not = [] }) => {
    const parts = partsFor(s, reach);
    for (const p of loads) expect(parts, `loads ${p}`).toContain(p);
    for (const p of not) expect(parts, `leaves out ${p}`).not.toContain(p);
  });

  it("onboarding keeps its own prompt, which already holds plan agreement for a reply that finishes it", () => {
    const s = state({ tester: tester({ phase: "onboarding" }) });
    expect(partsFor(s)).toEqual([]);
    expect(read(s)).toBe(FIXED_INSTRUCTIONS);
    expect(FIXED_INSTRUCTIONS).toContain(GUIDANCE["Plan agreement"]);
  });

  it("every moment that applies has its guidance in what loads", () => {
    for (const { name, state: s, reach } of CASES) {
      const text = read(s, reach);
      for (const m of moments(s)) expect(text, `${m} in "${name}"`).toContain(GUIDANCE[m]);
    }
  });

  it("the core holds saving and style (pause, stop), the team, and memory once the plan is locked", () => {
    const active = instructionsFor("active", []).core;
    for (const always of [TOOL_RULES, TEAM, MEMORY]) expect(active).toContain(always);
    expect(instructionsFor("planning", []).core).not.toContain(MEMORY);
    // The core is the same for every reply in a phase, whatever loads after it, so its cache is shared.
    expect(instructionsFor("active", ["proof"]).core).toBe(active);
  });
});

describe("no reply reads more than before (#200)", () => {
  const before = fullVoiceInstructions();

  it("no situation's instructions are longer than everything loaded", () => {
    for (const { name, state: s, reach } of CASES) expect(read(s, reach).length, name).toBeLessThanOrEqual(before.length);
  });

  it("with every part loaded, it's the whole page and every rule section, nothing dropped", () => {
    const page = splitVoicePage(loadVoiceDoc());
    const lines = (text: string) => text.split("\n").filter(Boolean).sort();
    const whole = [FULL_VOICE_INTRO, `VOICE PAGE\n${page.voice}`, ...RULE_KEYS.map((k) => page.rules[k])].join("\n");
    expect(lines(before)).toEqual(lines(whole));
    expect(partsFor(state(), { media: true }).length).toBeLessThan(PARTS.length);
  });

  it("an ordinary reply and a text ZOH starts read clearly less", () => {
    expect(read(state({ ...DONE_WITH_PROOF })).length).toBeLessThan(before.length * 0.8);
    expect(read(state({ nudgeMoment: "kickoff" })).length).toBeLessThan(before.length * 0.7);
  });
});
