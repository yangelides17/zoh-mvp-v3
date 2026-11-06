/**
 * Synthetic tester loader (#142): reads fixture JSON files and writes testers, messages, goals,
 * plans, step days, takeaways, suggestions and flags into the database. Fixture testers carry a
 * `scenario` column so the app's schedulers, keeper, and console jobs skip them.
 */

import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  GOAL_ROLES,
  SUGGESTION_KINDS,
  SUGGESTION_SOURCES,
  SUGGESTION_DECISIONS,
  SUGGESTION_OUTCOMES,
  STEP_DAY_STATUSES,
  STEP_KINDS,
  PROOF_VERDICTS,
  PROOF_METHODS,
  CHANGE_KINDS,
  WEEKDAYS,
  messages,
  testers,
  testerGoals,
  plans,
  stepDays,
  takeaways,
  suggestions,
  type Tester,
  type Weekday,
} from "../db/schema.js";
import { saveFlag } from "../console/alerts.js";

// ---- Phone pattern: reserved 555-01xx range ----

const SYNTHETIC_PHONE = /^\+1\d{3}55501\d{2}$/;

/** Validates that a phone number is in the synthetic 555-01xx range. */
export function isSyntheticPhone(phone: string): boolean {
  return SYNTHETIC_PHONE.test(phone);
}

// ---- Fixture Zod schemas (strict: unknown fields rejected) ----

const dayField = z.number().int().min(1).max(60);
const timeField = z.string().regex(/^\d{2}:\d{2}$/);

const mediaSchema = z.object({
  kind: z.enum(["image", "audio"]),
  content_type: z.string(),
  description: z.string().optional(),
  transcript: z.string().optional(),
}).strict();

/** Standalone message schema (lives in fixture.messages[], not inside events). */
const messageSchema = z.object({
  day: dayField,
  time: timeField,
  from: z.enum(["tester", "zoh"]),
  text: z.string(),
  media: mediaSchema.optional(),
  tests: z.string().optional(),
}).strict();

export type FixtureMessage = z.infer<typeof messageSchema>;

const testerUpdateEvent = z.object({
  kind: z.literal("tester_update"),
  day: dayField,
  time: timeField,
  set: z.object({
    name: z.string().optional(),
    quiet_hours_start: z.string().optional(),
    quiet_hours_end: z.string().optional(),
    quiet_hours_chosen: z.boolean().optional(),
    time_zone: z.string().optional(),
    time_zone_status: z.enum(["assumed_eastern", "needs_city", "confirmed"]).optional(),
    pushiness: z.string().optional(),
    style_notes: z.string().optional(),
  }).strict(),
}).strict();

const phaseEvent = z.object({
  kind: z.literal("phase"),
  day: dayField,
  time: timeField,
  to: z.enum(["onboarding", "planning", "active"]),
}).strict();

const goalChosenEvent = z.object({
  kind: z.literal("goal_chosen"),
  day: dayField,
  time: timeField,
  goal: z.string(),
  role: z.enum(["focus", "maintenance"]),
  checkins_per_week: z.number().int().optional(),
}).strict();

const goalRoleEvent = z.object({
  kind: z.literal("goal_role"),
  day: dayField,
  time: timeField,
  goal: z.string(),
  role: z.enum(["focus", "maintenance", "dropped"]),
}).strict();

const goalSwitchEvent = z.object({
  kind: z.literal("goal_switch"),
  day: dayField,
  time: timeField,
  from: z.string(),
  to: z.string(),
  reason: z.string(),
}).strict();

const planLockedEvent = z.object({
  kind: z.literal("plan_locked"),
  day: dayField,
  time: timeField,
  plan: z.object({
    version: z.number().int().positive(),
    goal: z.string(),
    step: z.string(),
    step_time: z.string(),
    days: z.array(z.enum(WEEKDAYS as unknown as [string, ...string[]])),
    proof: z.enum(PROOF_METHODS as unknown as [string, ...string[]]),
    reason: z.string(),
    start_day: z.number().int().min(1).max(60),
    setup_step: z.string().optional(),
    destination: z.string().optional(),
    place: z.string().optional(),
    minutes: z.number().int().optional(),
    proof_note: z.string().optional(),
    commitment: z.string().optional(),
    change_kind: z.enum(CHANGE_KINDS as unknown as [string, ...string[]]).optional(),
    ends_on_day: z.number().int().min(1).max(60).optional(),
  }).strict(),
}).strict();

const stepDayEvent = z.object({
  kind: z.literal("step_day"),
  day: dayField,
  status: z.enum(STEP_DAY_STATUSES as unknown as [string, ...string[]]).optional(),
  step: z.string().optional(),
  step_kind: z.enum(STEP_KINDS as unknown as [string, ...string[]]).optional(),
  step_minutes: z.number().int().optional(),
  moved_time: z.string().optional(),
  agreed_at: z.string().optional(),
  on_it_at: z.string().optional(),
  note: z.string().optional(),
  proof_verdict: z.enum(PROOF_VERDICTS as unknown as [string, ...string[]]).optional(),
  proof_seen: z.string().optional(),
  reflection: z.string().optional(),
}).strict();

const takeawayEvent = z.object({
  kind: z.literal("takeaway"),
  day: dayField,
  time: timeField,
  goal: z.string(),
  text: z.string(),
  evidence: z.enum(["explained", "applied", "recalled"]),
}).strict();

/**
 * Suggestion event. The suggestion's own kind (deepen/upgrade/new_focus) is stored as
 * `suggestion_kind` to avoid collision with the Zod discriminator field `kind`.
 */
const suggestionEvent = z.object({
  kind: z.literal("suggestion"),
  day: dayField,
  time: timeField,
  goal: z.string(),
  suggestion_kind: z.enum(SUGGESTION_KINDS as unknown as [string, ...string[]]),
  raised_by: z.enum(SUGGESTION_SOURCES as unknown as [string, ...string[]]),
  proposal: z.string(),
  reasoning: z.string().optional(),
  new_goal: z.string().optional(),
  decision: z.enum(SUGGESTION_DECISIONS as unknown as [string, ...string[]]),
  decided_kind: z.enum(SUGGESTION_KINDS as unknown as [string, ...string[]]).optional(),
  decided_proposal: z.string().optional(),
  outcome: z.enum(SUGGESTION_OUTCOMES as unknown as [string, ...string[]]).optional(),
  decided_at: z.object({ day: dayField, time: timeField }).strict().optional(),
  delivered_at: z.object({ day: dayField, time: timeField }).strict().optional(),
  outcome_at: z.object({ day: dayField, time: timeField }).strict().optional(),
}).strict();

const wentQuietEvent = z.object({
  kind: z.literal("went_quiet"),
  day: dayField,
  time: timeField,
  body: z.string().optional(),
}).strict();

const eventSchema = z.discriminatedUnion("kind", [
  testerUpdateEvent,
  phaseEvent,
  goalChosenEvent,
  goalRoleEvent,
  goalSwitchEvent,
  planLockedEvent,
  stepDayEvent,
  takeawayEvent,
  suggestionEvent,
  wentQuietEvent,
]);

export type FixtureEvent = z.infer<typeof eventSchema>;

const testerSchema = z.object({
  phone: z.string().regex(SYNTHETIC_PHONE),
  time_zone: z.string(),
  time_zone_status: z.enum(["assumed_eastern", "needs_city", "confirmed"]),
  first_text: z.object({
    day: dayField,
    time: timeField,
  }).strict(),
}).strict();

const fixtureSchema = z.object({
  scenario: z.string().min(1),
  week: z.number().int().positive(),
  format: z.literal(1),
  notes: z.string().optional(),
  tester: testerSchema,
  events: z.array(eventSchema),
  messages: z.array(messageSchema),
}).strict();

export type Fixture = z.infer<typeof fixtureSchema>;

// ---- Loading ----

export interface LoadResult {
  scenario: string;
  phone: string;
  tables: Record<string, number>;
}

/**
 * Resolves a fixture day + time to a real timestamp from a Monday start date.
 * Day 1 in the fixture = startDate (a Monday).
 */
function resolveTime(startDate: Date, day: number, time: string, timeZone: string): Date {
  // day 1 = startDate. Work in UTC to avoid DST issues: add days, then parse at the right time.
  const date = new Date(startDate);
  date.setUTCDate(date.getUTCDate() + (day - 1));
  const dateStr = date.toISOString().slice(0, 10);
  // Parse "YYYY-MM-DDThh:mm" in the tester's time zone.
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  // Build a Date at the given local time in the given time zone.
  const [h, m] = time.split(":").map(Number) as [number, number];
  // Use a known approach: construct a time and adjust.
  const guess = new Date(`${dateStr}T${time}:00Z`);
  const parts = formatter.formatToParts(guess);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const localH = Number(get("hour"));
  const localM = Number(get("minute"));
  const localD = Number(get("day"));
  // How far off is the guess from the desired local time?
  const diffMs = ((h - localH) * 60 + (m - localM)) * 60_000;
  const adjusted = new Date(guess.getTime() + diffMs);
  // Verify the day is right (DST can shift it)
  const checkParts = formatter.formatToParts(adjusted);
  const checkD = Number(checkParts.find((p) => p.type === "day")?.value ?? "0");
  const wantD = Number(dateStr.slice(8, 10));
  if (checkD !== wantD) {
    // Day rolled over; add/subtract a day
    return new Date(adjusted.getTime() + (wantD - checkD) * 86400_000);
  }
  return adjusted;
}

/** Resolves a fixture day to a local date string YYYY-MM-DD from a Monday start date. */
function resolveDate(startDate: Date, day: number): string {
  const d = new Date(startDate);
  d.setUTCDate(d.getUTCDate() + (day - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Checks that no real tester exists (is_test_user = false AND scenario IS NULL).
 * Refuses to load synthetic testers into a production-like database.
 */
export async function checkNotProduction(db: Db): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(testers)
    .where(and(eq(testers.isTestUser, false), isNull(testers.scenario)));
  if (row && row.n > 0) {
    throw new Error(`Refusing to load synthetic testers: ${row.n} real tester(s) found (is_test_user = false AND scenario IS NULL)`);
  }
}

/**
 * A unified timeline entry: either a tracker event or a message, tagged with its source week's
 * start date and a sort key (day, time) for chronological ordering.
 */
type TimelineEntry =
  | { tag: "event"; event: FixtureEvent; day: number; time: string }
  | { tag: "message"; message: FixtureMessage; day: number; time: string };

/**
 * Loads one scenario (all weeks) into the database. Idempotent: deletes existing messages and
 * tester data for this scenario before reinserting.
 */
export async function loadScenario(
  db: Db,
  fixtures: Fixture[],
  startDate: Date,
): Promise<LoadResult> {
  if (fixtures.length === 0) throw new Error("No fixture files provided");
  // Validate start date is a Monday
  if (startDate.getUTCDay() !== 1) throw new Error(`Start date must be a Monday, got ${startDate.toISOString().slice(0, 10)}`);

  const scenario = fixtures[0]!.scenario;
  const phone = fixtures[0]!.tester.phone;
  for (const f of fixtures) {
    if (f.scenario !== scenario) throw new Error(`Scenario mismatch: expected "${scenario}", got "${f.scenario}"`);
    if (f.tester.phone !== phone) throw new Error(`Phone mismatch: expected "${phone}", got "${f.tester.phone}"`);
  }
  if (!isSyntheticPhone(phone)) throw new Error(`Phone ${phone} is not in the synthetic 555-01xx range`);

  // Sort by week number
  const sorted = [...fixtures].sort((a, b) => a.week - b.week);

  // Idempotent: delete messages by contact_number, then tester by scenario (cascade handles children)
  await db.delete(messages).where(eq(messages.contactNumber, phone));
  await db.delete(testers).where(eq(testers.scenario, scenario));

  // Merge events and messages into a combined timeline sorted by (day, time).
  // Days are absolute across all week files (1-28+), resolved from startDate directly.
  const timeline: TimelineEntry[] = [];
  for (const fixture of sorted) {
    for (const event of fixture.events) {
      // step_day events may lack a time field; default to "23:59" for sorting
      const time = "time" in event && typeof event.time === "string" ? event.time : "23:59";
      timeline.push({ tag: "event", event, day: event.day, time });
    }
    for (const msg of fixture.messages) {
      timeline.push({ tag: "message", message: msg, day: msg.day, time: msg.time });
    }
  }
  // Sort by (day, time) for chronological processing
  timeline.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));

  // Read timezone and first-text info from the first fixture's tester object
  const testerInfo = sorted[0]!.tester;
  const timeZone = testerInfo.time_zone;
  const timeZoneStatus = testerInfo.time_zone_status;
  const firstAt = resolveTime(startDate, testerInfo.first_text.day, testerInfo.first_text.time, timeZone);

  // Create the tester
  const [tester] = await db
    .insert(testers)
    .values({
      phone,
      scenario,
      timeZone,
      timeZoneStatus,
      consentAt: firstAt,
      contextStartedAt: firstAt,
      isTestUser: false,
    })
    .returning();
  if (!tester) throw new Error("Failed to create synthetic tester");

  const counts: Record<string, number> = { testers: 1 };
  const inc = (table: string) => { counts[table] = (counts[table] ?? 0) + 1; };

  // Track plan IDs for step_day references
  const plansByVersion = new Map<number, string>();
  let latestPlanId: string | undefined;

  // Process timeline in order
  for (const entry of timeline) {
    if (entry.tag === "message") {
      const msg = entry.message;
      const at = resolveTime(startDate, msg.day, msg.time, tester.timeZone);
      const mediaUrl = msg.media ? `synthetic://${scenario}/${msg.day}-${msg.time}` : undefined;
      await db.insert(messages).values({
        direction: msg.from === "tester" ? "inbound" : "outbound",
        contactNumber: phone,
        content: msg.text,
        mediaUrl: mediaUrl ?? null,
        mediaContentType: msg.media?.content_type ?? null,
        description: msg.media?.description ?? null,
        transcript: msg.media?.transcript ?? null,
        sentAt: at,
        createdAt: at,
      });
      inc("messages");
      // A tester message after went_quiet clears the pause, same as the real app
      if (msg.from === "tester" && tester.autoTextsPausedAt) {
        await db.update(testers).set({ autoTextsPausedAt: null }).where(eq(testers.id, tester.id));
        tester.autoTextsPausedAt = null;
      }
      continue;
    }

    // entry.tag === "event"
    const event = entry.event;

    switch (event.kind) {
      case "tester_update": {
        const patch: Record<string, unknown> = {};
        const s = event.set;
        if (s.name !== undefined) patch.name = s.name;
        if (s.quiet_hours_start !== undefined) patch.quietHoursStart = s.quiet_hours_start;
        if (s.quiet_hours_end !== undefined) patch.quietHoursEnd = s.quiet_hours_end;
        if (s.quiet_hours_chosen !== undefined) patch.quietHoursChosen = s.quiet_hours_chosen;
        if (s.time_zone !== undefined) patch.timeZone = s.time_zone;
        if (s.time_zone_status !== undefined) patch.timeZoneStatus = s.time_zone_status;
        if (s.pushiness !== undefined) patch.pushiness = s.pushiness;
        if (s.style_notes !== undefined) patch.styleNotes = s.style_notes;
        if (Object.keys(patch).length > 0) {
          await db.update(testers).set(patch).where(eq(testers.id, tester.id));
          // Keep our local copy current for resolveTime calls
          Object.assign(tester, patch);
        }
        break;
      }

      case "phase": {
        await db.update(testers).set({ phase: event.to }).where(eq(testers.id, tester.id));
        tester.phase = event.to;
        break;
      }

      case "goal_chosen": {
        await db.insert(testerGoals).values({
          testerId: tester.id,
          goalSlug: event.goal,
          role: event.role,
          checkinsPerWeek: event.checkins_per_week ?? (event.role === "maintenance" ? 2 : 0),
          nudges: event.role === "focus",
          proof: event.role === "focus",
        }).onConflictDoNothing();
        inc("tester_goals");
        // Focus sets the tester's goal_slug
        if (event.role === "focus") {
          await db.update(testers).set({ goalSlug: event.goal }).where(eq(testers.id, tester.id));
          tester.goalSlug = event.goal;
        }
        break;
      }

      case "goal_role": {
        await db
          .update(testerGoals)
          .set({ role: event.role })
          .where(and(eq(testerGoals.testerId, tester.id), eq(testerGoals.goalSlug, event.goal)));
        break;
      }

      case "goal_switch": {
        // Update old goal to dropped
        await db
          .update(testerGoals)
          .set({ role: "dropped" })
          .where(and(eq(testerGoals.testerId, tester.id), eq(testerGoals.goalSlug, event.from)));
        // Update tester's goal_slug to the new goal
        await db.update(testers).set({ goalSlug: event.to }).where(eq(testers.id, tester.id));
        tester.goalSlug = event.to;
        // Record the switch as a flag + console alert, same as the real app (coach/tools.ts)
        const at = resolveTime(startDate, event.day, event.time, tester.timeZone);
        await saveFlag(db, tester.id, "goal_switch", `${event.from} → ${event.to}: ${event.reason}`, at);
        inc("flags");
        inc("console_messages");
        break;
      }

      case "plan_locked": {
        const p = event.plan;
        const at = resolveTime(startDate, event.day, event.time, tester.timeZone);
        const startDateStr = resolveDate(startDate, p.start_day);
        const endsOn = p.ends_on_day ? resolveDate(startDate, p.ends_on_day) : undefined;
        const [plan] = await db
          .insert(plans)
          .values({
            testerId: tester.id,
            goalSlug: p.goal,
            status: "locked",
            version: p.version,
            step: p.step,
            setupStep: p.setup_step ?? null,
            destination: p.destination ?? null,
            place: p.place ?? null,
            stepTime: p.step_time,
            days: p.days as Weekday[],
            proof: p.proof as "photo" | "screenshot" | "voice",
            proofNote: p.proof_note ?? null,
            reason: p.reason,
            minutes: p.minutes ?? null,
            startDate: startDateStr,
            commitment: p.commitment ?? null,
            changeKind: (p.change_kind as "deepen" | "upgrade" | "other" | undefined) ?? null,
            endsOn: endsOn ?? null,
            needsReview: true,
            lockedAt: at,
            createdAt: at,
          })
          .returning();
        if (plan) {
          plansByVersion.set(p.version, plan.id);
          latestPlanId = plan.id;
        }
        inc("plans");
        break;
      }

      case "step_day": {
        const dateStr = resolveDate(startDate, event.day);
        const at = resolveTime(startDate, event.day, "23:59", tester.timeZone);
        await db.insert(stepDays).values({
          testerId: tester.id,
          date: dateStr,
          planId: latestPlanId ?? null,
          status: (event.status as "done" | "done_reduced" | "missed" | undefined) ?? null,
          step: event.step ?? null,
          stepKind: (event.step_kind as "first" | "same" | "easier" | "harder" | undefined) ?? null,
          stepMinutes: event.step_minutes ?? null,
          movedTime: event.moved_time ?? null,
          agreedAt: event.agreed_at ? resolveTime(startDate, event.day, event.agreed_at, tester.timeZone) : null,
          onItAt: event.on_it_at ? resolveTime(startDate, event.day, event.on_it_at, tester.timeZone) : null,
          note: event.note ?? null,
          proofVerdict: (event.proof_verdict as "clear" | "plausible" | "unclear" | "doesnt_match" | undefined) ?? null,
          proofSeen: event.proof_seen ?? null,
          reflection: event.reflection ?? null,
          createdAt: at,
        }).onConflictDoNothing();
        inc("step_days");
        break;
      }

      case "takeaway": {
        const at = resolveTime(startDate, event.day, event.time, tester.timeZone);
        const dateStr = resolveDate(startDate, event.day);
        await db.insert(takeaways).values({
          testerId: tester.id,
          goalSlug: event.goal,
          day: dateStr,
          text: event.text,
          evidence: event.evidence,
          createdAt: at,
        });
        inc("takeaways");
        break;
      }

      case "suggestion": {
        const at = resolveTime(startDate, event.day, event.time, tester.timeZone);
        await db.insert(suggestions).values({
          testerId: tester.id,
          goalSlug: event.goal,
          kind: event.suggestion_kind as "deepen" | "upgrade" | "new_focus",
          raisedBy: event.raised_by as "coach" | "tester" | "founder",
          proposal: event.proposal,
          reasoning: event.reasoning ?? null,
          newGoalSlug: event.new_goal ?? null,
          decision: event.decision as "waiting" | "approved" | "changed" | "rejected",
          decidedKind: (event.decided_kind as "deepen" | "upgrade" | "new_focus" | undefined) ?? null,
          decidedProposal: event.decided_proposal ?? null,
          outcome: (event.outcome as "delivered" | "agreed" | "declined" | undefined) ?? null,
          decidedAt: event.decided_at ? resolveTime(startDate, event.decided_at.day, event.decided_at.time, tester.timeZone) : null,
          deliveredAt: event.delivered_at ? resolveTime(startDate, event.delivered_at.day, event.delivered_at.time, tester.timeZone) : null,
          outcomeAt: event.outcome_at ? resolveTime(startDate, event.outcome_at.day, event.outcome_at.time, tester.timeZone) : null,
          createdAt: at,
        });
        inc("suggestions");
        break;
      }

      case "went_quiet": {
        const at = resolveTime(startDate, event.day, event.time, tester.timeZone);
        await db.update(testers).set({ autoTextsPausedAt: at }).where(eq(testers.id, tester.id));
        tester.autoTextsPausedAt = at;
        const body = event.body ?? `Went quiet on day ${event.day}; ZOH's own texts paused`;
        await saveFlag(db, tester.id, "went_quiet", body, at);
        inc("flags");
        inc("console_messages");
        break;
      }
    }
  }

  return { scenario, phone, tables: counts };
}

/**
 * Parses and validates a fixture JSON string. Throws on unknown fields or event kinds.
 * Rejects any format other than 1.
 */
export function parseFixture(json: string, filename: string): Fixture {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`Invalid JSON in ${filename}`);
  }
  const result = fixtureSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid fixture ${filename}:\n${issues}`);
  }
  // format === 1 is enforced by z.literal(1) in the schema, but be explicit
  if (result.data.format !== 1) {
    throw new Error(`Unsupported fixture format ${result.data.format} in ${filename} (expected 1)`);
  }
  return result.data;
}

/**
 * Collects all `tests` strings from fixture messages (fixture-only fields that should never
 * appear in any database column).
 */
export function collectTestStrings(fixtures: Fixture[]): string[] {
  const strings: string[] = [];
  for (const fixture of fixtures) {
    for (const msg of fixture.messages) {
      if (msg.tests) {
        strings.push(msg.tests);
      }
    }
  }
  return strings;
}
