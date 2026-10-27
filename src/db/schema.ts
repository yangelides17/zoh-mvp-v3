import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Every text in and out, what onboarding knows about each tester, and the plans they agree.
 * Steps and the coach's memory get designed later.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    /** The person's number (E.164). */
    contactNumber: text("contact_number").notNull(),
    /** Our Sendblue line (E.164). */
    lineNumber: text("line_number"),
    content: text("content"),
    /** Sendblue's CDN link; it expires after 30 days. */
    mediaUrl: text("media_url"),
    /** Our private copy in the bucket. */
    mediaKey: text("media_key"),
    mediaContentType: text("media_content_type"),
    /** Voice-note transcript from Speaches. */
    transcript: text("transcript"),
    /** Sendblue's message handle: dedupes webhook retries and links status updates. */
    sendblueHandle: text("sendblue_handle").unique(),
    service: text("service"),
    status: text("status"),
    error: text("error"),
    inReplyTo: uuid("in_reply_to").references((): AnyPgColumn => messages.id),
    /** When Sendblue says the message was sent/received. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Per-stage timestamps and durations for latency tracking. */
    timings: jsonb("timings").$type<Record<string, string | number>>().notNull().default({}),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_contact_created_idx").on(t.contactNumber, t.createdAt),
    check("messages_direction_check", sql`${t.direction} in ('inbound', 'outbound')`),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/** Onboarding questions, then agreeing the plan, then a locked plan. */
export const TESTER_PHASES = ["onboarding", "planning", "active"] as const;
export const TIME_ZONE_STATUSES = ["assumed_eastern", "needs_city", "confirmed"] as const;
export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "09:00" } as const;
export const DEFAULT_PUSHINESS = "pushy";

/** One row per person who texts from an allowed number. */
export const testers = pgTable(
  "testers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** E.164. */
    phone: text("phone").notNull().unique(),
    name: text("name"),
    phase: text("phase", { enum: TESTER_PHASES }).notNull().default("onboarding"),
    goalSlug: text("goal_slug").references(() => goals.slug),
    /** IANA zone, e.g. America/New_York. */
    timeZone: text("time_zone").notNull(),
    timeZoneStatus: text("time_zone_status", { enum: TIME_ZONE_STATUSES }).notNull(),
    /** Local "HH:MM". ZOH never starts a text between start and end. */
    quietHoursStart: text("quiet_hours_start").notNull().default(DEFAULT_QUIET_HOURS.start),
    quietHoursEnd: text("quiet_hours_end").notNull().default(DEFAULT_QUIET_HOURS.end),
    pushiness: text("pushiness").notNull().default(DEFAULT_PUSHINESS),
    /** What they've asked of the coach's style ("fewer emojis"). */
    styleNotes: text("style_notes").notNull().default(""),
    /** Dev accounts (DEV_NUMBERS): can text "reset". */
    isTestUser: boolean("is_test_user").notNull().default(false),
    /** Their first text. */
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    /** Set when they opt out; cleared when they text again. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    /** The coach never sees messages from before this (moved by "reset"). */
    contextStartedAt: timestamp("context_started_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("testers_phase_check", sql`${t.phase} in ('onboarding', 'planning', 'active')`),
    check("testers_time_zone_status_check", sql`${t.timeZoneStatus} in ('assumed_eastern', 'needs_city', 'confirmed')`),
  ],
);

export type PlanQuestionKey = "what" | "where" | "when" | "how_long" | "tracks_with";
/** A plan question that applies to a goal. Questions not listed don't apply. */
export interface PlanQuestion {
  key: PlanQuestionKey;
  /** Onboarding isn't done until every required question is answered. */
  required: boolean;
  /** What the question means for this goal, when it isn't the obvious reading. */
  note?: string;
}

/** The starting goals; seeded by the migration. */
export const goals = pgTable("goals", {
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  sortOrder: integer("sort_order").notNull(),
  planQuestions: jsonb("plan_questions").$type<PlanQuestion[]>().notNull(),
});

/** What onboarding has learned for one tester and goal; feature 5 turns it into the plan. */
export const planInputs = pgTable(
  "plan_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    goalSlug: text("goal_slug")
      .notNull()
      .references(() => goals.slug),
    what: text("what"),
    where: text("where"),
    when: text("when"),
    howLong: text("how_long"),
    tracksWith: text("tracks_with"),
    extraNotes: jsonb("extra_notes").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("plan_inputs_tester_goal_unique").on(t.testerId, t.goalSlug)],
);

export const PLAN_STATUSES = ["draft", "locked"] as const;
export const PROOF_METHODS = ["photo", "screenshot", "voice"] as const;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** A plan can't lock with fewer step days than this (spec: "Plan agreement"). */
export const MIN_DAYS_PER_WEEK = 3;

/**
 * A tester's plan. At most one draft (what ZOH is proposing) per tester; locked versions are never
 * changed or deleted: a change after lock is a new version. The latest locked one is the plan.
 */
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    goalSlug: text("goal_slug")
      .notNull()
      .references(() => goals.slug),
    status: text("status", { enum: PLAN_STATUSES }).notNull(),
    /** Locked versions count up from 1 per tester; null for a draft. */
    version: integer("version"),
    /** A one-time step for day 1, when one helps ("dumbbells next to your bed"). */
    setupStep: text("setup_step"),
    /** What they do, specific enough to just do it. */
    step: text("step").notNull(),
    place: text("place"),
    /** Local "HH:MM". */
    stepTime: text("step_time").notNull(),
    days: jsonb("days").$type<Weekday[]>().notNull(),
    proof: text("proof", { enum: PROOF_METHODS }).notNull(),
    /** Which photo, screenshot or voice note ("Whoop strain screenshot"). */
    proofNote: text("proof_note"),
    reason: text("reason").notNull(),
    /** Their local day 1, set on lock. */
    startDate: date("start_date", { mode: "string" }),
    /** Their words when they committed. */
    commitment: text("commitment"),
    /** Every locked version waits for a founder look. Nobody is notified yet. */
    needsReview: boolean("needs_review").notNull().default(false),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("plans_tester_version_unique").on(t.testerId, t.version),
    index("plans_tester_idx").on(t.testerId),
    check("plans_status_check", sql`${t.status} in ('draft', 'locked')`),
    check("plans_proof_check", sql`${t.proof} in ('photo', 'screenshot', 'voice')`),
  ],
);

/** Things for the founders to look at later (e.g. an off-list goal). Saved only; nobody is notified. */
export const flags = pgTable(
  "flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("flags_tester_idx").on(t.testerId)],
);

export type Tester = typeof testers.$inferSelect;
export type NewTester = typeof testers.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type PlanInput = typeof planInputs.$inferSelect;
export type Flag = typeof flags.$inferSelect;
export type Plan = typeof plans.$inferSelect;
