import type { Plan, StepDay, Tester } from "../src/db/schema.js";
import type { CoachState } from "../src/coach/state.js";
import type { WeekLookback } from "../src/coach/week.js";

/**
 * Coach states built as plain objects (no database), for the status sheet (#199) and which instructions load (#200).
 * Only the fields the sheet and the loader read; the casts keep the rest of each row out of the way.
 */

export const TZ = "America/New_York";
export const at = (iso: string) => new Date(iso);

export const tester = (o: Partial<Tester> = {}) =>
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

export const plan = (o: Partial<Plan> = {}) =>
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

export const day = (o: Partial<StepDay>) => ({ date: "2026-11-10", status: null, ...o }) as unknown as StepDay;

export const week = (o: Partial<WeekLookback> = {}): WeekLookback => ({
  from: "2026-11-09",
  to: "2026-11-15",
  days: [day({ date: "2026-11-09", status: "done" }), day({ date: "2026-11-10", status: "missed" })],
  learnings: { understood: [], explained: [] },
  recapped: false,
  recappedNow: false,
  ...o,
});

export const note = (id: string, body: string) => ({ id, body, createdAt: at("2026-11-10T14:00:00Z") }) as unknown as CoachState["teamNotes"][number];

/** Tuesday Nov 10, 2026, 10 am in New York: an active tester on a step day, nothing happened yet. */
export function state(o: Partial<CoachState> = {}): CoachState {
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
    teamQuestions: [],
    lastTesterText: "",
    lastZohText: "",
    isFirstText: false,
    justFinished: false,
    now: at("2026-11-10T15:00:00Z"),
    ...o,
  };
}
