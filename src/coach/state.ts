import { and, asc, desc, eq, gte, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  DEFAULT_QUIET_HOURS,
  REQUEST_DELIVERIES,
  flags,
  goals,
  messages,
  planInputs,
  plans,
  stepDays,
  suggestions,
  WEEKDAYS,
  type ConsoleMessage,
  type Goal,
  type MaintenanceCheckin,
  type Pause,
  type Plan,
  type Suggestion,
  type TesterGoal,
  type PlanInput,
  type PlanQuestion,
  type PlanQuestionKey,
  type StepDay,
  type Tester,
  type Weekday,
} from "../db/schema.js";
import { notesForCoach, pendingRequests, REPLY_CARRIES, requestsDoneAt } from "../console/requests.js";
import { mediaKind } from "../media/storage.js";
import { addDays, serviceDate, type NudgeCarry, type NudgeMoment } from "../nudges/schedule.js";
import { summarizeDays, type DaySummary } from "../nudges/streak.js";
import { activePause } from "../testers/pauses.js";
import { DEFAULT_GOAL_CAP, goalStreaks, loadCheckins, loadGoalDays, loadTesterGoals, type GoalStreak } from "../testers/goals.js";

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
  /** The plan ZOH is proposing, not locked yet. */
  draft?: Plan;
  /** The latest locked plan for their current goal (a temporary one only until its end date). */
  plan?: Plan;
  /** Their local day (`serviceDate`): what "today" means for their step. */
  today: string;
  /** What's recorded for today's step: its step (#76), done, a moved time, "on it". */
  todayRow?: StepDay;
  /** Tomorrow's row, when its step was agreed the night before. */
  tomorrowRow?: StepDay;
  /** Closed step days before today, newest first (the last two weeks). */
  recentDays: StepDay[];
  /** Streak and in-a-row counts for the focus goal, today included once it's closed. */
  days: DaySummary;
  /** Photos, screenshots and voice notes they sent: today, and in their texts since ZOH's last one. */
  proof: ProofSeen;
  /** Set when ZOH is starting a text itself rather than replying. */
  nudgeMoment?: NudgeMoment;
  /** What that text also carries: an approved next step or a maintenance check-in. */
  carry?: NudgeCarry;
  /** Focus plus maintenance goals a tester can have at once (`GOAL_CAP`). */
  goalCap: number;
  /** Every goal they have, with its role (focus, maintenance, dropped). */
  testerGoals: TesterGoal[];
  /** Each live goal's streak (active phase only). */
  streaks: GoalStreak[];
  /** Next steps since their context started, oldest first: the coach only ever sees approved ones. */
  suggestions: Suggestion[];
  /** Maintenance check-ins since their context started, oldest first. */
  checkins: MaintenanceCheckin[];
  /** Each maintenance goal's step, from its last locked plan: what a check-in asks about. */
  maintenanceSteps: Record<string, string>;
  /** Answers saved for goals they switched away from, to reuse where they fit. */
  earlierAnswers: PlanInput[];
  /** The founders' notes from the console: context, never quoted (spec "Founder console", rule 3). */
  teamNotes: ConsoleMessage[];
  /** The break they asked for, while it's on (spec "Commands and safety"). */
  pause?: Pause;
  /** The founders' requests to carry in ZOH's words, due now, oldest first. */
  teamRequests: ConsoleMessage[];
  /** Requests marked done in this reply: this text must still carry them. */
  teamRequestsDone: ConsoleMessage[];
  /** Their latest text: what lock_plan checks the commitment against. */
  lastTesterText: string;
  /** No first reply has been sent since the tester's context started. */
  isFirstText: boolean;
  /** Onboarding finished during this reply: it must be the recap turn. */
  justFinished: boolean;
  now: Date;
}

export async function loadCoachState(
  db: Db,
  tester: Tester,
  opts: {
    now: Date;
    isFirstText: boolean;
    justFinished?: boolean;
    lastTesterText?: string;
    nudgeMoment?: NudgeMoment;
    carry?: NudgeCarry;
    goalCap?: number;
  },
): Promise<CoachState> {
  const today = serviceDate(opts.now, tester);
  const testerGoalRows = await loadTesterGoals(db, tester.id);
  const since = gte(suggestions.createdAt, tester.contextStartedAt);
  const suggestionRows = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.testerId, tester.id), since))
    .orderBy(asc(suggestions.createdAt));
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
  const testerPlans = await db.select().from(plans).where(eq(plans.testerId, tester.id)).orderBy(desc(plans.version));
  const earlierAnswers = goal
    ? await db
        .select()
        .from(planInputs)
        .where(and(eq(planInputs.testerId, tester.id), ne(planInputs.goalSlug, goal.slug)))
    : [];
  const [todayRow] = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, today)))
    .limit(1);
  const [tomorrowRow] = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, addDays(today, 1))))
    .limit(1);
  const recentDays = await loadRecentDays(db, tester, today);
  const proof = await loadProof(db, tester, today, opts.now);
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
    draft: testerPlans.find((p) => p.status === "draft"),
    plan: goal ? currentPlan(testerPlans, goal.slug, today) : undefined,
    today,
    todayRow,
    tomorrowRow,
    recentDays,
    days: goal ? await loadDaySummary(db, tester.id, goal.slug, today) : summarizeDays([], []),
    proof,
    nudgeMoment: opts.nudgeMoment,
    carry: opts.carry,
    goalCap: opts.goalCap ?? DEFAULT_GOAL_CAP,
    testerGoals: testerGoalRows,
    streaks: tester.phase === "active" ? await goalStreaks(db, tester, testerGoalRows, today) : [],
    suggestions: suggestionRows,
    checkins: await loadCheckins(db, tester.id),
    maintenanceSteps: Object.fromEntries(
      testerGoalRows.flatMap((g) => {
        // testerPlans is newest version first.
        const last = g.role === "maintenance" ? testerPlans.find((p) => p.status === "locked" && p.goalSlug === g.goalSlug) : undefined;
        return last ? [[g.goalSlug, last.step]] : [];
      }),
    ),
    earlierAnswers,
    teamNotes: await notesForCoach(db, tester, opts.now),
    pause: await activePause(db, tester.id),
    // A reply carries natural requests and due manual nudges; a text ZOH starts only the one it was given (the carry).
    teamRequests: await pendingRequests(db, tester.id, opts.now, opts.nudgeMoment ? REQUEST_DELIVERIES : REPLY_CARRIES),
    teamRequestsDone: opts.nudgeMoment ? [] : await requestsDoneAt(db, tester.id, opts.now),
    lastTesterText: opts.lastTesterText ?? "",
    isFirstText: opts.isFirstText,
    justFinished: opts.justFinished ?? false,
    now: opts.now,
  };
}

/** Their closed step days before `date`, newest first: the last two weeks. */
export async function loadRecentDays(db: Db, tester: Tester, date: string): Promise<StepDay[]> {
  const rows = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), lt(stepDays.date, date), isNotNull(stepDays.status)))
    .orderBy(desc(stepDays.date))
    .limit(14);
  return rows;
}

/** A day's step (#76): its own when the coach set one, otherwise the plan's step, length and proof. */
export function dayStep(
  plan: Pick<Plan, "step" | "minutes" | "proof" | "proofNote">,
  row?: Pick<StepDay, "step" | "stepMinutes" | "stepProof">,
): { step: string; minutes: number | null; proof: string; own: boolean } {
  return {
    step: row?.step ?? plan.step,
    minutes: row?.stepMinutes ?? plan.minutes,
    proof: row?.stepProof ?? `${plan.proof}${plan.proofNote ? ` (${plan.proofNote})` : ""}`,
    own: Boolean(row?.step),
  };
}

/** The streak and in-a-row counts for one goal, from all its closed step days through `date`. */
export async function loadDaySummary(db: Db, testerId: string, goalSlug: string, date: string): Promise<DaySummary> {
  const { days, plans: goalPlans } = await loadGoalDays(db, testerId, goalSlug, date);
  return summarizeDays(days.reverse(), goalPlans);
}

export interface ProofSeen {
  /** Sent during their local day today. */
  today: number;
  /** Sent since ZOH's last text: where proof for yesterday has to be. */
  latest: number;
}

/**
 * Counts the photos, screenshots and voice notes they sent in the last two days that fall on their
 * local day today, and those since ZOH's last text. Videos and files don't count: ZOH can't see them.
 */
export async function loadProof(db: Db, tester: Tester, today: string, now: Date): Promise<ProofSeen> {
  // When a text happened: Sendblue's sent time, else when it was stored (as memory's `sentTime`; not
  // imported from there, since memory's store imports the coach's tools, which import this file).
  const sentTime = sql<Date>`coalesce(${messages.sentAt}, ${messages.createdAt})`;
  const messageTime = (m: { sentAt: Date | null; createdAt: Date }) => m.sentAt ?? m.createdAt;
  const window = and(
    eq(messages.contactNumber, tester.phone),
    gte(messages.createdAt, tester.contextStartedAt),
    gte(sentTime, new Date(now.getTime() - 2 * 86_400_000)),
    // A few minutes' slack: Sendblue's clock can run a little ahead of ours, and the photo they just sent must count.
    lte(sentTime, new Date(now.getTime() + 5 * 60_000)),
  );
  const inbound = await db
    .select({ sentAt: messages.sentAt, createdAt: messages.createdAt, mediaUrl: messages.mediaUrl, mediaContentType: messages.mediaContentType })
    .from(messages)
    .where(and(window, eq(messages.direction, "inbound"), isNotNull(messages.mediaUrl)));
  const [lastOut] = await db
    .select({ at: sentTime })
    .from(messages)
    .where(and(window, eq(messages.direction, "outbound")))
    .orderBy(desc(sentTime))
    .limit(1);
  const proof = inbound.filter((m) => ["image", "audio"].includes(mediaKind(m.mediaContentType ?? undefined, m.mediaUrl!)));
  const lastOutAt = lastOut ? new Date(lastOut.at).getTime() : undefined;
  return {
    today: proof.filter((m) => serviceDate(messageTime(m), tester) === today).length,
    latest: proof.filter((m) => lastOutAt === undefined || messageTime(m).getTime() > lastOutAt).length,
  };
}

/**
 * The plan that applies on a local date: the newest locked version for the goal, skipping a
 * temporary lighter one whose end date has passed (the version before it applies again).
 */
export function currentPlan(testerPlans: Plan[], goalSlug: string, date: string): Plan | undefined {
  return testerPlans
    .filter((p) => p.status === "locked" && p.goalSlug === goalSlug)
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    .find((p) => !p.endsOn || p.endsOn >= date);
}

/** The latest locked plan for the tester's current goal on a local date (see `currentPlan`). */
export async function loadCurrentPlan(db: Db, tester: Tester, date: string): Promise<Plan | undefined> {
  if (!tester.goalSlug) return undefined;
  const rows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, tester.goalSlug), eq(plans.status, "locked")))
    .orderBy(desc(plans.version));
  return currentPlan(rows, tester.goalSlug, date);
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

/** "HH:MM" as minutes after midnight. */
function minutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
}

/** Whether a local "HH:MM" falls inside the tester's quiet hours, which may run past midnight. */
export function insideQuietHours(time: string, t: Pick<Tester, "quietHoursStart" | "quietHoursEnd">): boolean {
  const at = minutes(time);
  const start = minutes(t.quietHoursStart);
  const end = minutes(t.quietHoursEnd);
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** The tester's local calendar date ("YYYY-MM-DD"), plus a number of days. */
export function localDate(now: Date, timeZone: string, addDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + addDays);
  return date.toISOString().slice(0, 10);
}

/** "every day", or "Mon, Wed, Fri" in week order. */
export function describeDays(days: readonly Weekday[]): string {
  if (days.length === WEEKDAYS.length) return "every day";
  return WEEKDAYS.filter((d) => days.includes(d))
    .map((d) => d[0]!.toUpperCase() + d.slice(1))
    .join(", ");
}
