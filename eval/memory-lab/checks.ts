/**
 * Free structure checks on memory snapshots (#147). Run after every night; no Claude calls.
 */

import type { MemorySnapshot } from "./snapshot.js";

export interface ChurnStats {
  created: number;
  replaced: number;
  removed: number;
}

export interface CheckResult {
  /** Facts whose sourceMessageId is in the forgotten set but the fact still exists. */
  forgetLeaks: number;
  /** Same text on the same pageId. */
  duplicates: number;
  /** Changes since the previous snapshot. */
  churn: ChurnStats;
  /** Character count of the rendered memory block text. */
  blockSize: number;
}

/** Run free structure checks on a snapshot, optionally comparing to a previous one. */
export function runChecks(current: MemorySnapshot, rendered: string, previous?: MemorySnapshot): CheckResult {
  // Forget leaks: a fact whose sourceMessageId is in the forgotten set
  const forgottenMsgIds = new Set(current.forgotten.map((f) => f.messageId));
  const forgetLeaks = current.facts.filter(
    (f) => f.sourceMessageId && forgottenMsgIds.has(f.sourceMessageId),
  ).length;

  // Duplicates: same text on the same page
  const seen = new Set<string>();
  let duplicates = 0;
  for (const f of current.facts) {
    const key = `${f.pageId}::${f.text}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  // Churn: compare current vs previous
  let churn: ChurnStats = { created: 0, replaced: 0, removed: 0 };
  if (previous) {
    const prevFactIds = new Set(previous.facts.map((f) => f.id));
    const currFactIds = new Set(current.facts.map((f) => f.id));
    const prevPageIds = new Set(previous.pages.map((p) => p.id));
    const currPageIds = new Set(current.pages.map((p) => p.id));

    const createdFacts = current.facts.filter((f) => !prevFactIds.has(f.id)).length;
    const removedFacts = previous.facts.filter((f) => !currFactIds.has(f.id)).length;
    const createdPages = current.pages.filter((p) => !prevPageIds.has(p.id)).length;
    const removedPages = previous.pages.filter((p) => !currPageIds.has(p.id)).length;

    // "Replaced" = facts that existed before but were updated (same id, different text)
    const prevFactTexts = new Map(previous.facts.map((f) => [f.id, f.text]));
    const replaced = current.facts.filter((f) => {
      const prev = prevFactTexts.get(f.id);
      return prev !== undefined && prev !== f.text;
    }).length;

    churn = {
      created: createdFacts + createdPages,
      replaced,
      removed: removedFacts + removedPages,
    };
  }

  return { forgetLeaks, duplicates, churn, blockSize: rendered.length };
}
