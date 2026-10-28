import type { MaintenanceCheckin, Suggestion, TesterGoal } from "../db/schema.js";
import { addDays } from "../nudges/schedule.js";

/**
 * Next steps and maintenance check-ins (spec: GitHub issue "Step log and next step"). Pure: the
 * coach's tools, its state block and the nudge scheduler share these rules.
 */

/** A declined next step isn't raised again for this many days (spec edge case). */
export const DECLINE_QUIET_DAYS = 7;
/** Unanswered kickoff check-ins in a row before ZOH asks it on its own in its next reply (rule 7). */
export const UNANSWERED_BEFORE_OWN_ASK = 2;
/** Focus streaks that raise a milestone alert (rule 9: focus only). */
export const MILESTONES = [7, 14, 21, 30, 60, 90] as const;

/** How the coach and the tools name a suggestion: the first 8 characters of its id. */
export const suggestionRef = (id: string) => id.slice(0, 8);

export const findSuggestion = (list: Suggestion[], ref: string): Suggestion | undefined => {
  const wanted = ref.trim().toLowerCase();
  return wanted.length >= 8 ? list.find((s) => s.id.startsWith(wanted)) : undefined;
};

/** The kind and proposal the founders approved (they may have changed either). */
export const approvedKind = (s: Suggestion) => s.decidedKind ?? s.kind;
export const approvedProposal = (s: Suggestion) => s.decidedProposal ?? s.proposal;

const isApproved = (s: Suggestion) => s.decision === "approved" || s.decision === "changed";
/** Approved by the founders and not raised with the tester yet. */
export const readyToRaise = (s: Suggestion) => isApproved(s) && s.outcome === null;
/** Raised with the tester, waiting on their yes or no. */
export const awaitingAnswer = (s: Suggestion) => isApproved(s) && s.outcome === "delivered";
/** Not settled yet: waiting on the founders, or approved and not agreed or declined. */
export const stillOpen = (s: Suggestion) => s.decision === "waiting" || (isApproved(s) && (s.outcome === null || s.outcome === "delivered"));

type CheckinRow = Pick<MaintenanceCheckin, "goalSlug" | "date" | "answer" | "messageId">;

/**
 * The last two asks for a goal went unanswered, both carried by kickoffs: ZOH asks it on its own in
 * its next reply. An ask on its own has no kickoff text (`messageId` null), so once made it isn't owed again.
 * `rows`: one goal's check-ins, oldest first.
 */
export function checkinOwed(rows: CheckinRow[]): boolean {
  const lastTwo = rows.slice(-UNANSWERED_BEFORE_OWN_ASK);
  return lastTwo.length === UNANSWERED_BEFORE_OWN_ASK && lastTwo.every((r) => r.answer === null && r.messageId !== null);
}

/**
 * The maintenance goal whose check-in rides on today's kickoff, if any (rule 7): never the day after a
 * focus miss, at most one per kickoff, `checkinsPerWeek` a week spread out (with 2, at least 3 days
 * apart), none while one is owed as its own question. The goal asked longest ago goes first.
 * `checkins`: every check-in, oldest first.
 */
export function dueCheckin(opts: {
  today: string;
  goals: Pick<TesterGoal, "goalSlug" | "role" | "checkinsPerWeek">[];
  checkins: CheckinRow[];
  missedYesterday: boolean;
}): string | undefined {
  if (opts.missedYesterday) return undefined;
  const due: { slug: string; last: string }[] = [];
  for (const g of opts.goals) {
    if (g.role !== "maintenance" || g.checkinsPerWeek <= 0) continue;
    const rows = opts.checkins.filter((c) => c.goalSlug === g.goalSlug);
    if (checkinOwed(rows)) continue;
    const inLastWeek = rows.filter((r) => r.date > addDays(opts.today, -7));
    if (inLastWeek.length >= g.checkinsPerWeek) continue;
    const last = rows.at(-1)?.date ?? "";
    if (last && last > addDays(opts.today, -Math.floor(7 / g.checkinsPerWeek))) continue;
    due.push({ slug: g.goalSlug, last });
  }
  return due.sort((a, b) => a.last.localeCompare(b.last))[0]?.slug;
}

/** Two answers in a row were "stopped" (the alert for the founders, rule 7). `rows` oldest first. */
export function stoppedTwice(rows: CheckinRow[]): boolean {
  const answered = rows.filter((r) => r.answer !== null).slice(-2);
  return answered.length === 2 && answered.every((r) => r.answer === "stopped");
}
