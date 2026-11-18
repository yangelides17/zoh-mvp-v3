import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { coachingChanges, coachingGuidance, memoryFacts, memoryForgotten, type CoachingGuidance, type MemoryFact, type Tester } from "../db/schema.js";
import { raiseAlert } from "../console/alerts.js";
import { removeFact } from "../memory/store.js";
import { updateTester } from "../testers/testers.js";
import { findGuidance, GUIDANCE_MAX_CHARS, GUIDANCE_MAX_LINES, listGuidance } from "./guidance.js";
import { logCoachingChange } from "./history.js";

/** Why a founder's change can't be made, said plainly on the card or to the console chat. */
export class CoachingError extends Error {}

function cleanLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) throw new CoachingError("A guidance line can't be empty.");
  if (line.length > GUIDANCE_MAX_CHARS) throw new CoachingError(`Keep a guidance line to ${GUIDANCE_MAX_CHARS} characters (this one is ${line.length}).`);
  return line;
}

export async function addGuidance(db: Db, tester: Pick<Tester, "id">, text: string, by: string, at: Date): Promise<CoachingGuidance> {
  const line = cleanLine(text);
  if ((await listGuidance(db, tester.id)).length >= GUIDANCE_MAX_LINES) {
    throw new CoachingError(`They already have ${GUIDANCE_MAX_LINES} guidance lines: edit or remove one first.`);
  }
  const [row] = await db.insert(coachingGuidance).values({ testerId: tester.id, text: line, author: by, createdAt: at, updatedAt: at }).returning();
  if (!row) throw new Error("addGuidance returned no row");
  await logCoachingChange(db, { testerId: tester.id, area: "guidance", action: "add", to: line, by, at });
  return row;
}

/** A founder's edit; it also settles a clash with their own request (the founder has seen it). */
export async function editGuidance(db: Db, tester: Pick<Tester, "id">, id: string, text: string, by: string, at: Date): Promise<CoachingGuidance> {
  const line = cleanLine(text);
  const before = await findGuidance(db, tester.id, id);
  if (!before) throw new CoachingError("That guidance line is gone.");
  const [row] = await db
    .update(coachingGuidance)
    .set({ text: line, author: by, overriddenBy: null, overriddenAt: null, updatedAt: at })
    .where(eq(coachingGuidance.id, before.id))
    .returning();
  if (!row) throw new CoachingError("That guidance line is gone.");
  if (line !== before.text) await logCoachingChange(db, { testerId: tester.id, area: "guidance", action: "edit", from: before.text, to: line, by, at });
  return row;
}

export async function removeGuidance(db: Db, tester: Pick<Tester, "id">, id: string, by: string, at: Date): Promise<void> {
  const before = await findGuidance(db, tester.id, id);
  if (!before) return;
  await db.delete(coachingGuidance).where(eq(coachingGuidance.id, before.id));
  await logCoachingChange(db, { testerId: tester.id, area: "guidance", action: "remove", from: before.text, by, at });
}

/**
 * Their own request overrides a guidance line (ZOH saw the clash while saving it): the line is marked,
 * the coach reads it as overridden, and the founders get an alert to update it.
 */
export async function markOverridden(db: Db, tester: Pick<Tester, "id" | "name">, ref: string, request: string, at: Date): Promise<CoachingGuidance | undefined> {
  const line = await findGuidance(db, tester.id, ref);
  if (!line) return undefined;
  await db.update(coachingGuidance).set({ overriddenBy: request, overriddenAt: at }).where(eq(coachingGuidance.id, line.id));
  await raiseAlert(db, {
    testerId: tester.id,
    topic: "guidance_clash",
    key: `guidance_clash:${line.id}:${at.getTime()}`,
    body: `${tester.name ?? "They"} asked "${request}", which overrides the team's guidance "${line.text}". ZOH follows their request; update or remove the line on the Coaching card.`,
    at,
  });
  return line;
}

/** Their "no emojis" kept on the tester (the copy onboarding and planning read) goes with its memory fact. */
export async function dropStyleNote(db: Db, tester: Tester, text: string): Promise<Tester> {
  const notes = tester.styleNotes.split(";").map((n) => n.trim()).filter(Boolean);
  const kept = notes.filter((n) => n.toLowerCase() !== text.trim().toLowerCase());
  if (kept.length === notes.length) return tester;
  return updateTester(db, tester.id, { styleNotes: kept.join("; ") });
}

/**
 * A founder removes one of their style requests (a stated preference): gone from memory and from the
 * tester's copy. Its text is marked forgotten only if tonight's memory pass hasn't filed that day yet,
 * so it isn't filed again; a filed day is never re-read, and hiding its texts would cost the whole day.
 */
export async function removeStatedPreference(db: Db, tester: Tester, fact: MemoryFact, by: string, at: Date): Promise<Tester> {
  if (fact.testerId !== tester.id || fact.section !== "stated") throw new CoachingError("That isn't one of their style requests.");
  await removeFact(db, fact, at, by);
  const unfiled = !fact.day || !tester.memoryThrough || fact.day > tester.memoryThrough;
  if (fact.sourceMessageId && unfiled) {
    await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: fact.sourceMessageId }).onConflictDoNothing();
  }
  return dropStyleNote(db, tester, fact.text);
}

/**
 * A founder deletes a learned preference ZOH got wrong: it goes with the observations behind it, so it can
 * only be learned again from new evidence (3 more on 3 new days), never from the same old texts.
 */
export async function deleteLearnedPreference(db: Db, tester: Pick<Tester, "id">, fact: MemoryFact, by: string, at: Date): Promise<void> {
  if (fact.testerId !== tester.id || fact.section !== "learned") throw new CoachingError("That isn't a learned preference.");
  await removeFact(db, fact, at, by);
  if (fact.label) {
    await db
      .delete(memoryFacts)
      .where(and(eq(memoryFacts.testerId, tester.id), eq(memoryFacts.section, "observation"), eq(memoryFacts.label, fact.label)));
  }
}

/** "Forget everything" and a dev "reset": guidance goes, and the history keeps no old wording, only that it was cleared. */
export async function clearCoaching(db: Db, testerId: string, why: string, at: Date): Promise<void> {
  await db.delete(coachingGuidance).where(eq(coachingGuidance.testerId, testerId));
  await db.delete(coachingChanges).where(eq(coachingChanges.testerId, testerId));
  await logCoachingChange(db, { testerId, area: "guidance", action: "clear", to: why, by: "tester", at });
}
