import { and, desc, eq } from "drizzle-orm";
import { listGuidance } from "../coaching/guidance.js";
import { coachingHistory } from "../coaching/history.js";
import type { Db } from "../db/client.js";
import { plans, type CoachingChange, type CoachingGuidance, type ConsoleMessage, type MemoryFact, type Plan, type Tester } from "../db/schema.js";
import { corePage, ensureCorePages, factsOf } from "../memory/store.js";
import { NOTE_DAYS, notesForCoach } from "./requests.js";

/** #158: everything that shapes how ZOH coaches one tester, on one card. */
export interface CoachingCard {
  guidance: CoachingGuidance[];
  /** Their style requests (stated preferences): texted ones, or filed from what they said about themselves. */
  style: { fact: MemoryFact; texted: boolean }[];
  learned: MemoryFact[];
  /** The founders' notes the coach reads right now, and when each drops off at the latest. */
  notes: { note: ConsoleMessage; dropsOff: Date }[];
  /** Their saved plan (the newest locked version of their focus goal). */
  plan?: Plan;
  quiet: { start: string; end: string; chosen: boolean };
  history: CoachingChange[];
}

export async function coachingCard(db: Db, tester: Tester, now: Date): Promise<CoachingCard> {
  // Style notes saved before memory existed become removable stated preferences.
  let preferences = await corePage(db, tester.id, "preferences");
  if (!preferences && tester.styleNotes.trim()) preferences = (await ensureCorePages(db, tester, now)).preferences;
  const facts = preferences ? await factsOf(db, [preferences.id]) : [];
  const texted = new Set(tester.styleNotes.split(";").map((n) => n.trim().toLowerCase()).filter(Boolean));
  const [plan] = tester.goalSlug
    ? await db
        .select()
        .from(plans)
        .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, tester.goalSlug), eq(plans.status, "locked")))
        .orderBy(desc(plans.version))
        .limit(1)
    : [];
  return {
    guidance: await listGuidance(db, tester.id),
    style: facts.filter((f) => f.section === "stated").map((fact) => ({ fact, texted: texted.has(fact.text.trim().toLowerCase()) })),
    learned: facts.filter((f) => f.section === "learned"),
    notes: (await notesForCoach(db, tester, now)).map((note) => ({ note, dropsOff: new Date(note.createdAt.getTime() + NOTE_DAYS * 86_400_000) })),
    plan,
    quiet: { start: tester.quietHoursStart, end: tester.quietHoursEnd, chosen: tester.quietHoursChosen },
    history: await coachingHistory(db, tester.id),
  };
}
