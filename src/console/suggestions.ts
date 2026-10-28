import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { consoleMessages, SUGGESTION_KINDS, suggestions, type Suggestion } from "../db/schema.js";

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
  if (current.decision !== "waiting") throw new SuggestionError(`Already ${current.decision}`);
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

/** A founder's own next step. Raised by the founders, it's decided as it's made: approved by whoever wrote it. */
export async function addFounderSuggestion(
  db: Db,
  opts: { testerId: string; goalSlug: string; kind: SuggestionKind; proposal: string; reasoning?: string; newGoalSlug?: string; by: string; at: Date },
): Promise<Suggestion> {
  if (opts.kind === "new_focus" && !opts.newGoalSlug) throw new SuggestionError("A new focus needs the goal to move to");
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

/** What the founders settled on: the changed kind and wording when they changed it. */
export function decided(s: Suggestion): { kind: SuggestionKind; proposal: string } {
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
