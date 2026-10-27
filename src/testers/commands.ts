import type { Db } from "../db/client.js";
import type { Tester } from "../db/schema.js";
import { updateTester } from "./testers.js";

/** Feature 4, edge cases: the exact reply to "stop" and any other opt-out. */
export const OPT_OUT_CONFIRMATION = "Thank you very much. Noted. We will stop sending you messages.";

const OPT_OUT_WORDS = new Set(["stop", "stop all", "unsubscribe", "cancel", "end", "quit", "opt out", "optout"]);

/** Lowercase, punctuation and emoji dropped, whitespace collapsed: "Opt-Out!" → "opt out". */
export function normalizeCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True only when the whole text is an opt-out word ("STOP!"), never when it's inside a sentence. */
export function isOptOutText(text: string | null | undefined): boolean {
  return text ? OPT_OUT_WORDS.has(normalizeCommand(text)) : false;
}

/** Dev accounts only: the whole text is "reset", any case. */
export function isResetText(text: string | null | undefined): boolean {
  return text?.trim().toLowerCase() === "reset";
}

/**
 * Marks the tester as opted out. The caller sends OPT_OUT_CONFIRMATION and nothing else.
 * Also for the coach (T2) when it hears a looser phrasing ("leave me alone").
 * Keeps the first stop time if they were already stopped.
 */
export async function optOut(db: Db, tester: Tester, at: Date): Promise<Tester> {
  if (tester.stoppedAt) return tester;
  return updateTester(db, tester.id, { stoppedAt: at });
}
