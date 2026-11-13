import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { consoleMessages, PLAN_ADJUST, SUGGESTION_KINDS, suggestions, type PlanChanges, type Suggestion } from "../db/schema.js";
import { raiseAlert } from "./alerts.js";

/**
 * The founders' side of next steps (spec: GitHub issue "Founder console", rule 4, and "Shared":
 * Suggestions). Every approve / change / reject is stored with who and why; nothing is ever deleted.
 */

export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export type Decision =
  | { decision: "approved"; reason?: string }
  | { decision: "changed"; kind: SuggestionKind; proposal: string; reason?: string }
  | { decision: "rejected"; reason?: string };

export class SuggestionError extends Error {}

/** Records a founder's decision on a waiting suggestion, and marks its "waiting" alert seen. */
export async function decideSuggestion(
  db: Db,
  opts: { testerId: string; suggestionId: string; by: string; at: Date } & Decision,
): Promise<Suggestion> {
  const [current] = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.id, opts.suggestionId), eq(suggestions.testerId, opts.testerId)));
  if (!current) throw new SuggestionError("No such suggestion for this tester");
  if (current.decision !== "waiting") throw new SuggestionError(`Already ${current.decision}${current.decidedBy ? ` by ${current.decidedBy}` : ""}`);
  const changed = opts.decision === "changed" ? { decidedKind: opts.kind, decidedProposal: opts.proposal.trim() } : {};
  const [row] = await db
    .update(suggestions)
    .set({
      decision: opts.decision,
      decidedBy: opts.by,
      decisionReason: opts.reason?.trim() || null,
      ...changed,
      decidedAt: opts.at,
      updatedAt: opts.at,
    })
    // Two founders deciding at once: only the first counts.
    .where(and(eq(suggestions.id, current.id), eq(suggestions.decision, "waiting")))
    .returning();
  if (!row) throw new SuggestionError("Someone else just decided it");
  await db
    .update(consoleMessages)
    .set({ seenAt: opts.at, seenBy: opts.by })
    .where(and(eq(consoleMessages.suggestionId, row.id), eq(consoleMessages.kind, "alert"), isNull(consoleMessages.seenAt)));
  return row;
}

/**
 * A founder's own next step, or (#155) a change to the tester's plan (adjust, with its fields). Raised by
 * the founders, it's decided as it's made: approved by whoever confirmed it.
 */
export async function addFounderSuggestion(
  db: Db,
  opts: {
    testerId: string;
    goalSlug: string;
    kind: SuggestionKind | typeof PLAN_ADJUST;
    proposal: string;
    reasoning?: string;
    newGoalSlug?: string;
    planChanges?: PlanChanges;
    by: string;
    at: Date;
  },
): Promise<Suggestion> {
  if (opts.kind === "new_focus" && !opts.newGoalSlug) throw new SuggestionError("A new focus needs the goal to move to");
  if (opts.kind === PLAN_ADJUST && !opts.planChanges) throw new SuggestionError("A plan change needs what changes");
  const [row] = await db
    .insert(suggestions)
    .values({
      testerId: opts.testerId,
      goalSlug: opts.goalSlug,
      kind: opts.kind,
      raisedBy: "founder",
      raisedByName: opts.by,
      proposal: opts.proposal.trim(),
      reasoning: opts.reasoning?.trim() || null,
      newGoalSlug: opts.kind === "new_focus" ? opts.newGoalSlug : null,
      planChanges: opts.kind === PLAN_ADJUST ? opts.planChanges : null,
      decision: "approved",
      decidedBy: opts.by,
      decidedAt: opts.at,
      createdAt: opts.at,
      updatedAt: opts.at,
    })
    .returning();
  return row!;
}

/** Every suggestion for a tester, newest first (the console's history). */
export async function listSuggestions(db: Db, testerId: string): Promise<Suggestion[]> {
  return db.select().from(suggestions).where(eq(suggestions.testerId, testerId)).orderBy(desc(suggestions.createdAt));
}

/**
 * #155: takes back an approved next step that hasn't played out (the founders changed their mind, or
 * the tester texted stop). Undefined when it was already settled.
 */
export async function withdrawSuggestion(db: Db, opts: { testerId: string; suggestionId: string; by: string; at: Date; reason?: string }): Promise<Suggestion | undefined> {
  const [row] = await db
    .update(suggestions)
    .set({ decision: "withdrawn", decidedBy: opts.by, decisionReason: opts.reason ?? null, decidedAt: opts.at, updatedAt: opts.at })
    .where(
      and(
        eq(suggestions.id, opts.suggestionId),
        eq(suggestions.testerId, opts.testerId),
        inArray(suggestions.decision, ["approved", "changed"]),
        or(isNull(suggestions.outcome), eq(suggestions.outcome, "delivered")),
      ),
    )
    .returning();
  return row;
}

/** #155: the founders hear the tester's answer to a next step they approved or proposed. */
export const ANSWER_TOPIC = "next_step_answer";
export async function alertAnswer(
  db: Db,
  opts: { suggestion: Suggestion; name: string | null; answer: "agreed" | "declined"; note?: string; at: Date },
): Promise<void> {
  const who = opts.name ?? "They";
  const what = decided(opts.suggestion).proposal;
  const body = opts.answer === "declined" ? `${who} said no: ${what}` : opts.note ? `${who} agreed, changed: ${opts.note}` : `${who} agreed: ${what}`;
  await raiseAlert(db, { testerId: opts.suggestion.testerId, topic: ANSWER_TOPIC, key: `answer:${opts.suggestion.id}`, body, suggestionId: opts.suggestion.id, at: opts.at });
}

/** What the founders settled on: the changed kind and wording when they changed it. */
export function decided(s: Suggestion): { kind: Suggestion["kind"]; proposal: string } {
  return { kind: s.decidedKind ?? s.kind, proposal: s.decidedProposal ?? s.proposal };
}

/**
 * The only suggestions the texting coach may act on: approved or changed and not yet delivered,
 * oldest first. Waiting and rejected ones never reach it.
 */
export async function suggestionsForCoach(db: Db, testerId: string): Promise<Suggestion[]> {
  return db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.testerId, testerId), inArray(suggestions.decision, ["approved", "changed"]), isNull(suggestions.outcome)))
    .orderBy(asc(suggestions.decidedAt));
}
