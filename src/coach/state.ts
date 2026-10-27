import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  DEFAULT_QUIET_HOURS,
  flags,
  goals,
  planInputs,
  type Goal,
  type PlanInput,
  type PlanQuestion,
  type PlanQuestionKey,
  type Tester,
} from "../db/schema.js";

/** Plan input columns by question key. */
export const PLAN_FIELDS = {
  what: "what",
  where: "where",
  when: "when",
  how_long: "howLong",
  tracks_with: "tracksWith",
} as const satisfies Record<PlanQuestionKey, keyof PlanInput>;

export const PLAN_KEYS = Object.keys(PLAN_FIELDS) as PlanQuestionKey[];

/** Everything the coach knows about one tester right now; rebuilt for every Claude round. */
export interface CoachState {
  tester: Tester;
  goals: Goal[];
  goal?: Goal;
  inputs?: PlanInput;
  /** Description of an accepted "something else" goal. */
  goalDescription?: string;
  /** Off-list goals ZOH declined. */
  declinedGoals: string[];
  /** Applicable questions not answered yet. */
  openRequired: PlanQuestion[];
  openOptional: PlanQuestion[];
  /** No first reply has been sent since the tester's context started. */
  isFirstText: boolean;
  /** Onboarding finished during this reply: it must be the recap turn. */
  justFinished: boolean;
  now: Date;
}

export async function loadCoachState(
  db: Db,
  tester: Tester,
  opts: { now: Date; isFirstText: boolean; justFinished?: boolean },
): Promise<CoachState> {
  const allGoals = await db.select().from(goals).orderBy(asc(goals.sortOrder));
  const goal = allGoals.find((g) => g.slug === tester.goalSlug);
  const inputs = goal
    ? (
        await db
          .select()
          .from(planInputs)
          .where(and(eq(planInputs.testerId, tester.id), eq(planInputs.goalSlug, goal.slug)))
          .limit(1)
      )[0]
    : undefined;
  const declined = await db
    .select()
    .from(flags)
    .where(and(eq(flags.testerId, tester.id), eq(flags.kind, "off_list_goal")))
    .orderBy(asc(flags.createdAt));
  const open = goal ? openQuestions(goal, inputs) : [];
  const description = inputs?.extraNotes.goal_description;
  return {
    tester,
    goals: allGoals,
    goal,
    inputs,
    goalDescription: typeof description === "string" ? description : undefined,
    // Flags outlive a reset; only this context's requests matter here.
    declinedGoals: declined.filter((f) => f.createdAt >= tester.contextStartedAt).map((f) => f.detail ?? ""),
    openRequired: open.filter((q) => q.required),
    openOptional: open.filter((q) => !q.required),
    isFirstText: opts.isFirstText,
    justFinished: opts.justFinished ?? false,
    now: opts.now,
  };
}

/** The goal's questions that have no saved answer yet. Questions a goal doesn't list never apply. */
export function openQuestions(goal: Goal, inputs: PlanInput | undefined): PlanQuestion[] {
  return goal.planQuestions.filter((q) => !answered(inputs, q.key));
}

export function answered(inputs: PlanInput | undefined, key: PlanQuestionKey): boolean {
  const value = inputs?.[PLAN_FIELDS[key]];
  return typeof value === "string" && value.trim().length > 0;
}

/** Onboarding is done when a goal is chosen and every required question for it is answered. */
export function onboardingComplete(state: Pick<CoachState, "goal" | "openRequired">): boolean {
  return state.goal !== undefined && state.openRequired.length === 0;
}

/** "Tue 11:04 PM" in the tester's zone. */
export function localTime(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
}

export function isDefaultQuietHours(t: Tester): boolean {
  return t.quietHoursStart === DEFAULT_QUIET_HOURS.start && t.quietHoursEnd === DEFAULT_QUIET_HOURS.end;
}
