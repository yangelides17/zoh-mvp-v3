import { sql } from "drizzle-orm";
import {
  bigint,
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
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Every text in and out, what onboarding knows about each tester, the plans they agree, each
 * day's step, the texts ZOH starts and the coach's memory (pages of cited facts).
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
    /** When our bucket copy was deleted (voice-note audio after 30 days); the transcript stays. */
    mediaDeletedAt: timestamp("media_deleted_at", { withTimezone: true }),
    /** One line on what a photo or video shows, written as it arrives (coach memory). */
    description: text("description"),
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
    /** Set when ZOH stops its own texts after days of silence (a `went_quiet` flag); cleared when they text. */
    autoTextsPausedAt: timestamp("auto_texts_paused_at", { withTimezone: true }),
    /** The coach never sees messages from before this (moved by "reset"). */
    contextStartedAt: timestamp("context_started_at", { withTimezone: true }).notNull(),
    /** The last local day the overnight memory pass has written; null until its first run. */
    memoryThrough: date("memory_through", { mode: "string" }),
    /** Set by "forget everything": memory never reads or searches texts from before this. */
    memorySince: timestamp("memory_since", { withTimezone: true }),
    /** Test mode (#14): how far a dev account's clock is ahead of real time, moved by "jump"; 0 for everyone else. */
    clockOffsetMs: bigint("clock_offset_ms", { mode: "number" }).notNull().default(0),
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

export const GOAL_ROLES = ["focus", "maintenance", "dropped"] as const;
export type GoalRole = (typeof GOAL_ROLES)[number];

/**
 * Every goal a tester has (spec: GitHub issues "Step log and next step" and "Founder console"). The
 * focus goal has nudges, proof and the streak; maintenance goals get light check-ins; a dropped goal
 * was replaced and its streak is frozen. `testers.goal_slug` stays the focus goal.
 */
export const testerGoals = pgTable(
  "tester_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    goalSlug: text("goal_slug")
      .notNull()
      .references(() => goals.slug),
    role: text("role", { enum: GOAL_ROLES }).notNull(),
    nudges: boolean("nudges").notNull().default(true),
    proof: boolean("proof").notNull().default(true),
    /** Maintenance check-ins a week; 0 for the focus goal. */
    checkinsPerWeek: integer("checkins_per_week").notNull().default(0),
    /** When it took its current role. */
    roleSince: timestamp("role_since", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tester_goals_tester_goal_unique").on(t.testerId, t.goalSlug),
    uniqueIndex("tester_goals_one_focus_idx").on(t.testerId).where(sql`${t.role} = 'focus'`),
    check("tester_goals_role_check", sql`${t.role} in ('focus', 'maintenance', 'dropped')`),
  ],
);

export const PLAN_STATUSES = ["draft", "locked"] as const;
/** How a version after lock differs: deepen keeps the streak, upgrade starts a new one, other keeps it. */
export const CHANGE_KINDS = ["deepen", "upgrade", "other"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
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
    /** How long the step takes, in minutes (when the follow-up goes out); null if unknown. */
    minutes: integer("minutes"),
    /** Their local day 1, set on lock. */
    startDate: date("start_date", { mode: "string" }),
    /** Their words when they committed. */
    commitment: text("commitment"),
    /** A temporary lighter plan's last local day; after it, the version before applies again. */
    endsOn: date("ends_on", { mode: "string" }),
    /** Versions after the first: how it differs from the one before. Null for a goal's first lock. */
    changeKind: text("change_kind", { enum: CHANGE_KINDS }),
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
    check("plans_change_kind_check", sql`${t.changeKind} in ('deepen', 'upgrade', 'other')`),
  ],
);

export const CHECKIN_ANSWERS = ["kept_up", "mostly", "stopped"] as const;
export type CheckinAnswer = (typeof CHECKIN_ANSWERS)[number];

/** A maintenance goal's light self-reported question, folded into a kickoff; the answer, once they give one. */
export const maintenanceCheckins = pgTable(
  "maintenance_checkins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    goalSlug: text("goal_slug")
      .notNull()
      .references(() => goals.slug),
    /** Their local date it was asked. */
    date: date("date", { mode: "string" }).notNull(),
    /** The text that asked it. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Null until they answer; "mostly" still counts as kept up. */
    answer: text("answer", { enum: CHECKIN_ANSWERS }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("maintenance_checkins_tester_goal_idx").on(t.testerId, t.goalSlug, t.date),
    check("maintenance_checkins_answer_check", sql`${t.answer} in ('kept_up', 'mostly', 'stopped')`),
  ],
);

export const SUGGESTION_KINDS = ["deepen", "upgrade", "new_focus"] as const;
export const SUGGESTION_SOURCES = ["coach", "tester", "founder"] as const;
export const SUGGESTION_DECISIONS = ["waiting", "approved", "changed", "rejected"] as const;
export const SUGGESTION_OUTCOMES = ["delivered", "agreed", "declined"] as const;

/**
 * One record per next step: who raised it, what and why, the founders' decision and what happened
 * after. Never deleted: it's the coach's future training material.
 */
export const suggestions = pgTable(
  "suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    /** The goal it builds on. */
    goalSlug: text("goal_slug")
      .notNull()
      .references(() => goals.slug),
    kind: text("kind", { enum: SUGGESTION_KINDS }).notNull(),
    raisedBy: text("raised_by", { enum: SUGGESTION_SOURCES }).notNull(),
    /** A founder's name, when a founder raised it. */
    raisedByName: text("raised_by_name"),
    proposal: text("proposal").notNull(),
    /** The coach's reasoning (or the tester's words, for their own request). */
    reasoning: text("reasoning"),
    /** new_focus only: the goal they'd move to. */
    newGoalSlug: text("new_goal_slug").references(() => goals.slug),
    decision: text("decision", { enum: SUGGESTION_DECISIONS }).notNull().default("waiting"),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
    /** What was approved, when the founders changed it. */
    decidedKind: text("decided_kind", { enum: SUGGESTION_KINDS }),
    decidedProposal: text("decided_proposal"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    outcome: text("outcome", { enum: SUGGESTION_OUTCOMES }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    /** The plan version it made. */
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("suggestions_tester_idx").on(t.testerId, t.createdAt),
    check("suggestions_kind_check", sql`${t.kind} in ('deepen', 'upgrade', 'new_focus')`),
    check("suggestions_raised_by_check", sql`${t.raisedBy} in ('coach', 'tester', 'founder')`),
    check("suggestions_decision_check", sql`${t.decision} in ('waiting', 'approved', 'changed', 'rejected')`),
    check("suggestions_decided_kind_check", sql`${t.decidedKind} in ('deepen', 'upgrade', 'new_focus')`),
    check("suggestions_outcome_check", sql`${t.outcome} in ('delivered', 'agreed', 'declined')`),
  ],
);

export const CONSOLE_KINDS = ["founder", "coach", "alert", "summary", "note", "request"] as const;
export type ConsoleKind = (typeof CONSOLE_KINDS)[number];
export const REQUEST_STATUSES = ["pending", "sent", "done", "cancelled"] as const;
/**
 * When a request in ZOH's words reaches the tester: naturally (the morning text or ZOH's next reply),
 * only with the morning text, or as its own text at a set time (a manual nudge).
 */
export const REQUEST_DELIVERIES = ["natural", "morning", "own_text"] as const;
export type RequestDelivery = (typeof REQUEST_DELIVERIES)[number];

/**
 * One console thread per tester (spec: GitHub issue "Founder console"): the founders' messages, the
 * console coach's replies, alerts, weekly summaries, notes for the coach and requests to reach the tester.
 */
export const consoleMessages = pgTable(
  "console_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CONSOLE_KINDS }).notNull(),
    /** A founder's name, "zoh" for the coach, null for alerts and summaries. */
    author: text("author"),
    body: text("body").notNull(),
    /** Alerts: what kind of event (a flag kind, milestone, second_miss…). */
    topic: text("topic"),
    /** Alerts: one per event, so each fires once. */
    eventKey: text("event_key").unique(),
    /** Alerts: the one-line why, written in the background. */
    why: text("why"),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    suggestionId: uuid("suggestion_id").references(() => suggestions.id, { onDelete: "set null" }),
    /** Requests: where they stand. */
    requestStatus: text("request_status", { enum: REQUEST_STATUSES }),
    /** Requests: send the body word for word, not in ZOH's words. */
    exact: boolean("exact").notNull().default(false),
    /** Requests: skip quiet hours (and only that). */
    sendNow: boolean("send_now").notNull().default(false),
    /** Requests: not before this (for its own text: when it goes). */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Requests in ZOH's words: where they ride (see REQUEST_DELIVERIES). */
    delivery: text("delivery", { enum: REQUEST_DELIVERIES }).notNull().default("natural"),
    /** Requests: still pending after this, it's dropped with a note in the thread instead of sent late. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    /** Requests: the text to the tester that carried it. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    seenBy: text("seen_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("console_messages_tester_created_idx").on(t.testerId, t.createdAt),
    check("console_messages_kind_check", sql`${t.kind} in ('founder', 'coach', 'alert', 'summary', 'note', 'request')`),
    check("console_messages_request_status_check", sql`${t.requestStatus} in ('pending', 'sent', 'done', 'cancelled')`),
    check("console_messages_delivery_check", sql`${t.delivery} in ('natural', 'morning', 'own_text')`),
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

export const PAUSE_END_REASONS = ["tester", "end_date", "stop", "reset"] as const;
export type PauseEndReason = (typeof PAUSE_END_REASONS)[number];

/**
 * A break the tester asked for (spec: GitHub issue "Commands and safety"): ZOH starts no texts while
 * one is open, and a step day that ends inside it is never closed as missed. At most one open per tester.
 */
export const pauses = pgTable(
  "pauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Their local date they said they'd be back: the pause lifts when that day's quiet hours end. */
    until: date("until", { mode: "string" }),
    /** Why they wanted the break, in a few words. */
    reason: text("reason"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by", { enum: PAUSE_END_REASONS }),
  },
  (t) => [
    index("pauses_tester_idx").on(t.testerId),
    uniqueIndex("pauses_one_open_idx").on(t.testerId).where(sql`${t.endedAt} is null`),
    check("pauses_ended_by_check", sql`${t.endedBy} in ('tester', 'end_date', 'stop', 'reset')`),
  ],
);

export const STEP_DAY_STATUSES = ["done", "done_reduced", "missed"] as const;
/** The coach's read of the day's proof: clear or plausible counts; unclear or doesnt_match doesn't (yet). */
export const PROOF_VERDICTS = ["clear", "plausible", "unclear", "doesnt_match"] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];
export type StepDayStatus = (typeof STEP_DAY_STATUSES)[number];

/**
 * One row per tester and local day that has something to record: the step done (full or reduced)
 * or missed, a time moved for today only, or when they said they were on it.
 */
export const stepDays = pgTable(
  "step_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    /** Their local date. */
    date: date("date", { mode: "string" }).notNull(),
    /** The plan version that applied that day. */
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    status: text("status", { enum: STEP_DAY_STATUSES }),
    /** Local "HH:MM" for this day only. */
    movedTime: text("moved_time"),
    /** When they said they were doing it or about to: skips that day's check-in. */
    onItAt: timestamp("on_it_at", { withTimezone: true }),
    /** What they did, in a few words. */
    note: text("note"),
    /** The coach's verdict on the latest proof for this day. */
    proofVerdict: text("proof_verdict", { enum: PROOF_VERDICTS }),
    /** What the coach saw or heard in that proof, in a line. */
    proofSeen: text("proof_seen"),
    /** Set while unclear proof is being sorted out: holds the day's check-in and follow-up. */
    proofPendingAt: timestamp("proof_pending_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("step_days_tester_date_unique").on(t.testerId, t.date),
    check("step_days_status_check", sql`${t.status} in ('done', 'done_reduced', 'missed')`),
    check("step_days_proof_verdict_check", sql`${t.proofVerdict} in ('clear', 'plausible', 'unclear', 'doesnt_match')`),
  ],
);

/** "skipped": the coach found the morning's conversation already covered the kickoff (#42); nothing was sent. */
export const NUDGE_STATUSES = ["claimed", "sent", "failed", "skipped"] as const;

/**
 * Texts ZOH starts on its own. A row is claimed before the text is written, so a slot goes out
 * at most once per tester, local date and kind, across ticks and restarts.
 */
export const nudges = pgTable(
  "nudges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    /** Their local date. */
    date: date("date", { mode: "string" }).notNull(),
    /** The slot: kickoff, checkin, followup, stall… */
    kind: text("kind").notNull(),
    /** What the coach was asked to write (kickoff, rest_day, checkin…). */
    moment: text("moment").notNull(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    status: text("status", { enum: NUDGE_STATUSES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("nudges_tester_date_kind_unique").on(t.testerId, t.date, t.kind),
    check("nudges_status_check", sql`${t.status} in ('claimed', 'sent', 'failed', 'skipped')`),
  ],
);

export const MEMORY_PAGE_KINDS = ["self", "preferences", "goal", "person", "subject", "daily"] as const;
export type MemoryPageKind = (typeof MEMORY_PAGE_KINDS)[number];
export const MEMORY_LINK_KINDS = ["related", "leads_to"] as const;
export type MemoryLinkKind = (typeof MEMORY_LINK_KINDS)[number];

/**
 * Coach memory (spec: GitHub issue "Coach memory"): one small wiki per tester. Their own page,
 * preferences, a page per goal, people and subjects in their life, and one daily doc per day they
 * texted. Facts live in `memory_facts`; a daily doc's text is its body.
 */
export const memoryPages = pgTable(
  "memory_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MEMORY_PAGE_KINDS }).notNull(),
    /** Descriptive enough to make sense on its own in the index. */
    title: text("title").notNull(),
    /** One line saying who or what this is. */
    summary: text("summary").notNull().default(""),
    /** A daily doc's text; empty on other pages. */
    body: text("body").notNull().default(""),
    /** Goal pages only. */
    goalSlug: text("goal_slug").references(() => goals.slug),
    /** "past" for a goal they've moved on from. */
    status: text("status", { enum: ["active", "past"] }).notNull().default("active"),
    /** Daily docs only: their local date. */
    date: date("date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_pages_tester_updated_idx").on(t.testerId, t.updatedAt),
    uniqueIndex("memory_pages_one_daily_idx").on(t.testerId, t.date).where(sql`${t.kind} = 'daily'`),
    uniqueIndex("memory_pages_one_core_idx").on(t.testerId, t.kind).where(sql`${t.kind} in ('self', 'preferences')`),
    uniqueIndex("memory_pages_one_goal_idx").on(t.testerId, t.goalSlug).where(sql`${t.kind} = 'goal'`),
    check("memory_pages_kind_check", sql`${t.kind} in ('self', 'preferences', 'goal', 'person', 'subject', 'daily')`),
    check("memory_pages_status_check", sql`${t.status} in ('active', 'past')`),
  ],
);

/**
 * One fact on a page, pointing to the text it came from. On the preferences page, `section` says
 * whether it's stated, learned or an observation, and `label` groups observations of one pattern.
 */
export const memoryFacts = pgTable(
  "memory_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => memoryPages.id, { onDelete: "cascade" }),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    section: text("section").notNull().default(""),
    label: text("label"),
    text: text("text").notNull(),
    /** The text it came from; null only for facts carried over from before memory (style notes). */
    sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** The tester's local day it was learned. */
    day: date("day", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("memory_facts_page_idx").on(t.pageId), index("memory_facts_tester_idx").on(t.testerId)],
);

/** "related" links read both ways; "leads_to" is a path (goal → next goal) walked forward or back. */
export const memoryLinks = pgTable(
  "memory_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    fromPageId: uuid("from_page_id")
      .notNull()
      .references(() => memoryPages.id, { onDelete: "cascade" }),
    toPageId: uuid("to_page_id")
      .notNull()
      .references(() => memoryPages.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MEMORY_LINK_KINDS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memory_links_unique").on(t.fromPageId, t.toPageId, t.kind),
    index("memory_links_tester_idx").on(t.testerId),
    check("memory_links_kind_check", sql`${t.kind} in ('related', 'leads_to')`),
  ],
);

/** Texts behind a forgotten fact: memory search skips them from then on. */
export const memoryForgotten = pgTable(
  "memory_forgotten",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testerId: uuid("tester_id")
      .notNull()
      .references(() => testers.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("memory_forgotten_unique").on(t.testerId, t.messageId)],
);

/**
 * Test mode (#14): each "jump" a dev account texted. The jump text is never a message (a ghost);
 * this is its record, and its Sendblue handle keeps a retried webhook from jumping twice.
 */
export const jumps = pgTable("jumps", {
  id: uuid("id").primaryKey().defaultRandom(),
  testerId: uuid("tester_id")
    .notNull()
    .references(() => testers.id, { onDelete: "cascade" }),
  /** What they texted, e.g. "jump 3h". */
  text: text("text").notNull(),
  sendblueHandle: text("sendblue_handle").notNull().unique(),
  /** The tester's clock before and after the jump; null until it has run. */
  fromAt: timestamp("from_at", { withTimezone: true }),
  toAt: timestamp("to_at", { withTimezone: true }),
  /** The log line sent back. */
  log: text("log"),
  /** Real time. */
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tester = typeof testers.$inferSelect;
export type NewTester = typeof testers.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type PlanInput = typeof planInputs.$inferSelect;
export type Flag = typeof flags.$inferSelect;
export type Pause = typeof pauses.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type StepDay = typeof stepDays.$inferSelect;
export type NewStepDay = typeof stepDays.$inferInsert;
export type Nudge = typeof nudges.$inferSelect;
export type MemoryPage = typeof memoryPages.$inferSelect;
export type MemoryFact = typeof memoryFacts.$inferSelect;
export type MemoryLink = typeof memoryLinks.$inferSelect;
export type TesterGoal = typeof testerGoals.$inferSelect;
export type MaintenanceCheckin = typeof maintenanceCheckins.$inferSelect;
export type Suggestion = typeof suggestions.$inferSelect;
export type ConsoleMessage = typeof consoleMessages.$inferSelect;
export type Jump = typeof jumps.$inferSelect;
