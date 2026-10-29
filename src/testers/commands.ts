import type { Db } from "../db/client.js";
import type { Tester } from "../db/schema.js";
import { alertStop } from "../console/alerts.js";
import { endPause } from "./pauses.js";
import { updateTester } from "./testers.js";

/** Feature 4, edge cases: the exact reply to "stop" and any other opt-out. */
export const OPT_OUT_CONFIRMATION = "Thank you very much. Noted. We will stop sending you messages.";

/** Sendblue's own opt-out words are among these ("revoke" too), so its block list and ours agree. */
const OPT_OUT_WORDS = new Set(["stop", "stop all", "unsubscribe", "cancel", "end", "quit", "revoke", "opt out", "optout"]);

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
 * Marks the tester as opted out, closes any pause (stop wins) and raises one alert for the founders.
 * The caller sends OPT_OUT_CONFIRMATION and nothing else. Also for the coach (T2) when it hears a
 * looser phrasing ("leave me alone"). Keeps the first stop time if they were already stopped.
 */
export async function optOut(db: Db, tester: Tester, at: Date, how = "texted stop"): Promise<Tester> {
  if (tester.stoppedAt) return tester;
  const stopped = await updateTester(db, tester.id, { stoppedAt: at });
  await endPause(db, tester.id, { at, by: "stop" });
  await alertStop(db, tester.id, at, how);
  return stopped;
}

/** Test mode (#14): what a dev account's "jump" asks for. */
export type JumpTarget =
  | { kind: "by"; ms: number }
  /** The next time it's this local "HH:MM". */
  | { kind: "at"; hhmm: string }
  /** Wherever ZOH next texts. */
  | { kind: "next" }
  | { kind: "invalid" };

/** The longest jump (spec #14, rule 5). */
export const MAX_JUMP_MS = 14 * 24 * 60 * 60_000;

export const JUMP_USAGE = "⏩ Try: jump 3h, jump 2d, jump 7:30am or jump next (up to 14 days).";

/**
 * Dev accounts only: "jump", or "jump" then one target ("next" or something starting with a digit).
 * "Jump rope done" stays an ordinary text.
 */
export function isJumpText(text: string | null | undefined): boolean {
  return /^jump(\s+(next|\d.*))?$/.test(text?.trim().toLowerCase() ?? "");
}

/** "jump 3h", "jump 2d", "jump 7:30am", "jump 19:30", "jump next". Anything else, or past 14 days, is invalid. */
export function parseJump(text: string): JumpTarget {
  const arg = text.trim().toLowerCase().replace(/^jump\s*/, "");
  if (arg === "next") return { kind: "next" };
  const by = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|d|day|days)$/.exec(arg);
  if (by) {
    const ms = Number(by[1]) * (by[2]!.startsWith("d") ? 24 : 1) * 60 * 60_000;
    return ms > 0 && ms <= MAX_JUMP_MS ? { kind: "by", ms } : { kind: "invalid" };
  }
  const twelve = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(arg);
  if (twelve) {
    const h = Number(twelve[1]);
    const m = Number(twelve[2] ?? 0);
    if (h < 1 || h > 12 || m > 59) return { kind: "invalid" };
    return { kind: "at", hhmm: `${pad((h % 12) + (twelve[3] === "pm" ? 12 : 0))}:${pad(m)}` };
  }
  const day = /^(\d{1,2}):(\d{2})$/.exec(arg);
  if (day && Number(day[1]) < 24 && Number(day[2]) < 60) return { kind: "at", hhmm: `${pad(Number(day[1]))}:${day[2]}` };
  return { kind: "invalid" };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
