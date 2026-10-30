import { insideQuietHours, localDate } from "../coach/state.js";
import { WEEKDAYS, type Plan, type StepDay, type Tester, type Weekday } from "../db/schema.js";

/**
 * When ZOH starts a text on its own (spec: GitHub issue "Nudge scheduler"). Everything here is
 * pure: the scheduler loads saved state, asks `dueNudge` what (if anything) is due right now, and
 * `daysToClose` which step days have ended with nothing done. Tests drive both with a fake clock.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Before the plan is locked: the first nudge this long after ZOH's last unanswered text. */
export const STALL_FIRST_AFTER_MS = 3 * HOUR;
/** Before the plan is locked: this many local days of silence pause ZOH's own texts. */
export const STALL_SILENT_DAYS = 3;
/** The tester's text is this fresh and not answered yet: a reply is being written, so wait. */
export const REPLY_IN_PROGRESS_MS = 2 * MINUTE;
/** The kickoff can go out this long after quiet hours end (e.g. after a restart). */
export const KICKOFF_WINDOW_MS = 3 * HOUR;
/** The check-in goes this long before step time. */
export const CHECKIN_LEAD_MS = 10 * MINUTE;
/** A step time this close to the kickoff makes kickoff and check-in one text. */
export const MERGE_WITHIN_MS = HOUR;
/** The follow-up goes this long after the step should be finished. */
export const FOLLOWUP_AFTER_MS = 30 * MINUTE;
/** How long a step takes when the plan doesn't say. */
export const DEFAULT_STEP_MINUTES = 60;

/** Nudges ZOH may send in a row without a reply, per level; never more than 3 (voice page). */
export const CAP_BY_LEVEL: Record<string, number> = { pushy: 3, steady: 2, gentle: 1 };
const DEFAULT_CAP = 3;

/** What the coach is asked to write; the NUDGES block in the prompt defines each one. */
export const NUDGE_MOMENTS = [
  "kickoff",
  "kickoff_checkin",
  "rest_day",
  "checkin",
  "followup",
  "stall",
  "after_miss",
  "one_a_day",
  "day_three",
  /** A manual nudge: a text the founders asked ZOH to send on its own (spec #10). */
  "team",
] as const;
export type NudgeMoment = (typeof NUDGE_MOMENTS)[number];

/** Step-day kickoffs: the moments that can carry an approved next step or a maintenance check-in. */
export const CARRYING_MOMENTS: readonly NudgeMoment[] = ["kickoff", "kickoff_checkin"];

/** What a kickoff carries besides the step, in place of its question (spec #9, rules 2 and 7; spec #10, 4). */
export type NudgeCarry = { suggestionId: string } | { checkinGoal: string } | { requestId: string };

/** Morning kickoffs the coach may skip when today's conversation already covered them (#42). */
export const SKIPPABLE_MOMENTS: readonly NudgeMoment[] = ["kickoff", "kickoff_checkin", "after_miss"];

/** Morning texts that can carry a founder's request: the kickoffs, and the rest-day text. */
export const REQUEST_CARRYING_MOMENTS: readonly NudgeMoment[] = ["kickoff", "kickoff_checkin", "rest_day"];

export interface NudgeInput {
  now: Date;
  tester: Pick<
    Tester,
    "timeZone" | "quietHoursStart" | "quietHoursEnd" | "phase" | "pushiness" | "stoppedAt" | "autoTextsPausedAt"
  >;
  /** The latest locked plan for their current goal. */
  plan?: Pick<Plan, "stepTime" | "days" | "startDate" | "minutes" | "lockedAt">;
  /** Their step-day row for the service date (`serviceDate`), if any. */
  today?: Pick<StepDay, "status" | "movedTime" | "onItAt"> & Partial<Pick<StepDay, "proofPendingAt" | "stepMinutes">>;
  /** Nudge kinds already claimed for the service date. */
  claimedToday: string[];
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  /** When their latest pause ended: going quiet counts from then, not from before the break. */
  pauseEndedAt?: Date;
  /** Nudges ZOH sent since the later of their last text and the service date's local midnight (replies don't count). */
  nudgesSinceReply: number;
  /** Stall nudges since their last text. */
  stallsSinceReply: number;
  /** Missed step days in a row before the service date (the slip ladder). */
  missesInARow?: number;
  /** When the latest day-3 check-in went out. */
  lastDayThreeAt?: Date;
  /** Slip-ladder daily texts ZOH sent since their last text (#41). */
  dailiesSinceReply?: number;
}

export interface DueNudge {
  /** Unique per tester and service date: the slot. */
  kind: string;
  moment: NudgeMoment;
  /** The service date (their local day). */
  date: string;
}

export type NudgeDecision =
  | { action: "none"; reason: string }
  | { action: "send"; nudge: DueNudge }
  /** Silent too long (before lock, or after the day-3 check-in): pause ZOH's texts and flag it. */
  | { action: "pause"; date: string };

/** After this many misses in a row, one text a day at their usual time (voice page, "When they start to slip"). */
export const ONE_A_DAY_AFTER_MISSES = 2;
/** The miss that makes the day's text the honest day-3 check-in. */
export const DAY_THREE_MISSES = 3;

/** Decides, from saved state alone, whether ZOH should start a text right now. */
export function dueNudge(input: NudgeInput): NudgeDecision {
  const { now, tester } = input;
  if (tester.stoppedAt) return none("stopped");
  if (tester.autoTextsPausedAt) return none("paused");
  if (insideQuietHours(localClock(now, tester.timeZone), tester)) return none("quiet hours");
  const { lastInboundAt: lastIn, lastOutboundAt: lastOut } = input;
  const theirsIsLatest = lastIn !== undefined && (lastOut === undefined || lastIn > lastOut);
  if (theirsIsLatest && now.getTime() - lastIn.getTime() < REPLY_IN_PROGRESS_MS) return none("reply in progress");

  const date = serviceDate(now, tester);
  if (tester.phase === "active") return activeDay(input, date);
  return stalled(input, date, theirsIsLatest);
}

/** Before the plan is locked: one nudge 3 hours after ZOH's last unanswered text, then one a day, then pause. */
function stalled(input: NudgeInput, date: string, theirsIsLatest: boolean): NudgeDecision {
  const { now, tester, lastInboundAt, lastOutboundAt } = input;
  if (!lastOutboundAt || theirsIsLatest) return none("nothing unanswered");
  if (input.stallsSinceReply === 0 && now.getTime() < lastOutboundAt.getTime() + STALL_FIRST_AFTER_MS) return none("waiting");
  if (input.claimedToday.includes("stall")) return none("already nudged today");
  const lastHeard = lastInboundAt ?? lastOutboundAt;
  const silentSince = localDate(input.pauseEndedAt && input.pauseEndedAt > lastHeard ? input.pauseEndedAt : lastHeard, tester.timeZone);
  if (daysBetween(silentSince, date) >= STALL_SILENT_DAYS) return { action: "pause", date };
  return { action: "send", nudge: { kind: "stall", moment: "stall", date } };
}

interface Slot {
  kind: string;
  moment: NudgeMoment;
  from: number;
  until: number;
}

/** After lock: the day's slots in order, and the first one open right now. */
function activeDay(input: NudgeInput, date: string): NudgeDecision {
  const { now, tester, plan, today } = input;
  if (!plan) return none("no plan");
  if (!plan.startDate || plan.startDate > date) return none("day 1 not yet");
  if (today?.status) return none(`today is ${today.status}`);
  const cap = CAP_BY_LEVEL[tester.pushiness] ?? DEFAULT_CAP;
  if (input.nudgesSinceReply >= cap) return none("unanswered cap");

  const level = tester.pushiness in CAP_BY_LEVEL ? tester.pushiness : "pushy";
  const day = dayBounds(date, tester);
  const lockedAt = plan.lockedAt?.getTime() ?? 0;
  const lockedToday = plan.lockedAt !== null && serviceDate(plan.lockedAt, tester) === date;
  const slots: Slot[] = [];
  const misses = input.missesInARow ?? 0;

  if (isStepDay(plan, date, today) && misses >= ONE_A_DAY_AFTER_MISSES) {
    // Slipping: one text a day at their usual time, in place of kickoff, check-in and follow-up.
    const stepAt = stepInstant(date, today?.movedTime ?? plan.stepTime, tester);
    const from = Math.max(stepAt - CHECKIN_LEAD_MS, day.start);
    const at = now.getTime();
    if (input.claimedToday.includes("daily") || at < from || at >= day.end) return none("no slot open");
    // No reply since the day-3 check-in, through the next step day's slot: stop and flag.
    const { lastDayThreeAt: dayThree, lastInboundAt } = input;
    const answered = dayThree !== undefined && lastInboundAt !== undefined && lastInboundAt > dayThree;
    if (misses > DAY_THREE_MISSES && dayThree && !answered) return { action: "pause", date };
    // Answered, then quiet again: the ladder repeats from their reply (#41), two daily texts and then the check-in.
    const again = answered && (input.dailiesSinceReply ?? 0) >= DAY_THREE_MISSES - 1;
    return { action: "send", nudge: { kind: "daily", moment: misses === DAY_THREE_MISSES || again ? "day_three" : "one_a_day", date } };
  }

  if (!isStepDay(plan, date, today)) {
    if (!lockedToday) slots.push({ kind: "kickoff", moment: "rest_day", from: day.start, until: day.start + KICKOFF_WINDOW_MS });
  } else {
    const time = today?.movedTime ?? plan.stepTime;
    const stepAt = stepInstant(date, time, tester);
    const checkinAt = stepAt - CHECKIN_LEAD_MS;
    // A step soon after quiet hours end: one text does both.
    const merged = !lockedToday && stepAt > day.start && stepAt - day.start <= MERGE_WITHIN_MS;
    if (!lockedToday) {
      const until = merged ? stepAt : checkinAt > day.start ? Math.min(day.start + KICKOFF_WINDOW_MS, checkinAt) : day.start + KICKOFF_WINDOW_MS;
      // The day after a miss matters most: the kickoff pushes harder.
      const moment = misses === 1 ? "after_miss" : merged ? "kickoff_checkin" : "kickoff";
      slots.push({ kind: "kickoff", moment, from: day.start, until });
    }
    // A time moved for today gets its own check-in and follow-up, even if the original ones went out.
    const suffix = today?.movedTime ? `@${today.movedTime}` : "";
    // Unclear proof being sorted out in the conversation: no "did you do it?" over the top of it.
    const proofPending = Boolean(today?.proofPendingAt);
    if (level === "pushy" && !merged && !today?.onItAt && !proofPending) {
      slots.push({ kind: `checkin${suffix}`, moment: "checkin", from: checkinAt, until: stepAt });
    }
    if (level !== "gentle" && !proofPending) {
      // Today's own length when its step runs shorter or longer than the plan's (#76).
      const doneBy = stepAt + (today?.stepMinutes ?? plan.minutes ?? DEFAULT_STEP_MINUTES) * MINUTE + FOLLOWUP_AFTER_MS;
      slots.push({ kind: `followup${suffix}`, moment: "followup", from: doneBy, until: day.end });
    }
  }

  const at = now.getTime();
  for (const slot of slots) {
    if (input.claimedToday.includes(slot.kind)) continue;
    // Nothing that was due before the plan (or this version of it) was locked.
    if (slot.from < lockedAt) continue;
    if (at >= slot.from && at < slot.until) return { action: "send", nudge: { kind: slot.kind, moment: slot.moment, date } };
  }
  return none("no slot open");
}

/**
 * Step days that have ended (quiet hours started) with nothing marked done: they become misses.
 * Looks at yesterday and today, so a restart over midnight still closes yesterday.
 */
export function daysToClose(input: {
  now: Date;
  tester: Pick<Tester, "timeZone" | "quietHoursStart" | "quietHoursEnd">;
  plan: Pick<Plan, "days" | "startDate" | "lockedAt">;
  /** Rows for those days, by date. */
  rows: Record<string, Pick<StepDay, "status" | "movedTime"> | undefined>;
}): string[] {
  const { now, tester, plan } = input;
  const today = serviceDate(now, tester);
  const out: string[] = [];
  for (const date of [addDays(today, -1), today]) {
    if (!isStepDay(plan, date, input.rows[date]) || input.rows[date]?.status) continue;
    const end = dayBounds(date, tester).end;
    if (now.getTime() < end) continue;
    // Locked after that day had already ended: it was never theirs to miss.
    if (plan.lockedAt && plan.lockedAt.getTime() >= end) continue;
    out.push(date);
  }
  return out;
}

// ---- Their local day ----

/**
 * Whether the plan has a step on this local date. Day 1 always does once it has a time set for it
 * ("do it tonight" on a day that isn't one of their usual days).
 */
export function isStepDay(
  plan: Pick<Plan, "days" | "startDate">,
  date: string,
  row?: Pick<StepDay, "movedTime"> | undefined,
): boolean {
  if (plan.startDate === null || plan.startDate > date) return false;
  return plan.days.includes(weekdayOf(date)) || (date === plan.startDate && Boolean(row?.movedTime));
}

/** "mon"…"sun" for a "YYYY-MM-DD". */
export function weekdayOf(date: string): Weekday {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return WEEKDAYS[(day + 6) % 7]!;
}

/** "YYYY-MM-DD" plus a number of days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
}

/** Local "HH:MM" (24-hour). */
export function localClock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/**
 * The local day a moment belongs to: the calendar date, except between midnight and quiet hours
 * when they start after midnight (quiet hours 00:30 to 08:00: 00:15 is still yesterday's evening).
 */
export function serviceDate(at: Date, t: Pick<Tester, "timeZone" | "quietHoursStart">): string {
  const date = localDate(at, t.timeZone);
  return t.quietHoursStart < "12:00" && localClock(at, t.timeZone) < t.quietHoursStart ? addDays(date, -1) : date;
}

/** A local day's waking window: from the end of quiet hours to their start (that night, or after midnight). */
export function dayBounds(date: string, t: Pick<Tester, "timeZone" | "quietHoursStart" | "quietHoursEnd">): { start: number; end: number } {
  const start = zonedTime(date, t.quietHoursEnd, t.timeZone).getTime();
  const endDate = t.quietHoursStart >= "12:00" ? date : addDays(date, 1);
  return { start, end: zonedTime(endDate, t.quietHoursStart, t.timeZone).getTime() };
}

/** The step's instant on a local day; a time after midnight (a late bedtime) belongs to that night. */
export function stepInstant(date: string, time: string, t: Pick<Tester, "timeZone" | "quietHoursStart" | "quietHoursEnd">): number {
  const day = dayBounds(date, t);
  const same = zonedTime(date, time, t.timeZone).getTime();
  if (same >= day.start) return same;
  const next = zonedTime(addDays(date, 1), time, t.timeZone).getTime();
  return next < day.end ? next : same;
}

/** The instant that is `hhmm` on local `date` in `timeZone`. */
export function zonedTime(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset even across a DST change.
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function none(reason: string): NudgeDecision {
  return { action: "none", reason };
}
