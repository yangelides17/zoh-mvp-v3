import { z } from "zod";
import type { Weekday } from "../src/db/schema.js";

export const PERSONAS = ["terse", "chatty", "joking", "confused", "all-at-once", "resistant"] as const;
export type Persona = (typeof PERSONAS)[number];

/** Facts the simulated tester answers from. Never shown to ZOH or the grader. */
export const hiddenFacts = z.object({
  name: z.string(),
  goal: z.string(),
  schedule: z.string(),
  timeAvailable: z.string(),
  equipment: z.string().optional(),
  experience: z.string().optional(),
  tracksWith: z.string().optional(),
  city: z.string().optional(),
  other: z.string().optional(),
});
export type HiddenFacts = z.infer<typeof hiddenFacts>;

/**
 * Where a conversation starts, when not from a brand-new tester: a tester already partway in, with
 * their saved answers and the conversation so far (shown to the simulator and grader as context,
 * not graded). With a plan, the tester has locked it and is "active".
 */
export const seedSchema = z.object({
  name: z.string(),
  goal: z.string(),
  phase: z.enum(["onboarding", "planning", "active"]),
  answers: z.object({
    what: z.string().optional(),
    where: z.string().optional(),
    when: z.string().optional(),
    how_long: z.string().optional(),
    tracks_with: z.string().optional(),
  }),
  history: z.array(z.object({ from: z.enum(["tester", "zoh"]), text: z.string().min(1) })).min(1),
  /** How long before the run's first line the seeded conversation ended (default: a minute before). */
  history_hours_ago: z.number().min(0).max(72).default(0),
  plan: z
    .object({
      setup_step: z.string().optional(),
      step: z.string(),
      /** Where they're headed (#76), when they named somewhere. */
      destination: z.string().optional(),
      place: z.string().optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/),
      days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(3),
      proof: z.enum(["photo", "screenshot", "voice"]),
      proof_note: z.string().optional(),
      reason: z.string(),
      /** How long the step takes, in minutes. */
      minutes: z.number().int().min(0).max(600).optional(),
      /** Day 1 this many days before the run's day (0: day 1 is today). */
      started_days_ago: z.number().int().min(0).max(30).default(0),
    })
    .optional(),
  /**
   * How earlier step days went (needs a plan): e.g. { "days_ago": 1, "status": "missed" }; optionally
   * that day's own step (#76), what they said about it, what the proof showed and their reflection (#77).
   */
  step_days: z
    .array(
      z.object({
        days_ago: z.number().int().min(1).max(30),
        status: z.enum(["done", "done_reduced", "missed"]),
        step: z.string().optional(),
        note: z.string().optional(),
        proof_seen: z.string().optional(),
        reflection: z.string().optional(),
        /** A time moved for that day only, local "HH:MM". */
        moved_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      }),
    )
    .default([]),
  /** Today's step, set ahead (#77, needs a plan): agreed this many hours before the run's start, if at all. */
  today_step: z.object({ step: z.string(), agreed_hours_ago: z.number().min(0).max(48).optional() }).optional(),
  /** Lessons from earlier steps (#77, needs a plan), e.g. { "days_ago": 3, "text": "...", "evidence": "explained" }. */
  takeaways: z
    .array(z.object({ days_ago: z.number().int().min(0).max(14), text: z.string(), evidence: z.enum(["explained", "applied", "recalled"]) }))
    .default([]),
  /**
   * Maintenance goals (next-step feature, needs a plan): goals kept up in the background, each with
   * its last plan, the streak it had as focus when it became maintenance, and check-ins since.
   */
  maintenance: z
    .array(
      z.object({
        goal: z.string(),
        step: z.string(),
        time: z.string().regex(/^\d{2}:\d{2}$/),
        /** Became maintenance this many days ago, with a streak of `streak_days` every-day steps ending then. */
        since_days_ago: z.number().int().min(0).max(60),
        streak_days: z.number().int().min(0).max(60).default(0),
        checkins: z.array(z.object({ days_ago: z.number().int().min(0).max(60), answer: z.enum(["kept_up", "mostly", "stopped"]).nullable() })).default([]),
      }),
    )
    .default([]),
  /** Next steps on the seeded goal as the founders left them (next-step feature). */
  suggestions: z
    .array(
      z.object({
        kind: z.enum(["deepen", "upgrade", "new_focus"]),
        raised_by: z.enum(["coach", "tester", "founder"]).default("coach"),
        proposal: z.string(),
        reasoning: z.string().optional(),
        new_goal: z.string().optional(),
        decision: z.enum(["waiting", "approved", "changed", "rejected"]),
        decided_kind: z.enum(["deepen", "upgrade", "new_focus"]).optional(),
        decided_proposal: z.string().optional(),
        outcome: z.enum(["delivered", "agreed", "declined"]).optional(),
      }),
    )
    .default([]),
  /**
   * Coach memory from before the run (memory feature): what the overnight pass would have filed
   * over earlier weeks. Facts carry no source text; "days_ago" sets when each was learned.
   */
  memory: z
    .object({
      pages: z
        .array(
          z.object({
            kind: z.enum(["self", "preferences", "goal", "person", "subject"]),
            /** Person and subject pages only (self, preferences and the goal page have fixed titles). */
            title: z.string().optional(),
            summary: z.string().optional(),
            facts: z.array(z.object({ text: z.string(), section: z.enum(["stated", "learned", "voice", "observation"]).optional(), days_ago: z.number().int().min(0).max(60) })),
            /** Linked as related to the current goal page. */
            related_to_goal: z.boolean().default(false),
          }),
        )
        .default([]),
      daily: z.array(z.object({ days_ago: z.number().int().min(1).max(60), title: z.string(), summary: z.string(), body: z.string() })).default([]),
      /** Locked plan versions before the seeded plan, oldest first. */
      earlier_plans: z.array(z.object({ step: z.string(), days_ago: z.number().int().min(1).max(60) })).default([]),
      /** Goals they had before the seeded one, oldest first; each switched to the next (the last to the seeded goal). */
      earlier_goals: z.array(z.object({ goal: z.string(), reason: z.string(), days_ago: z.number().int().min(1).max(60) })).default([]),
    })
    .optional(),
});
export type Seed = z.infer<typeof seedSchema>;

/** A simulated conversation: a tester the simulator plays against the real coach. */
export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  persona: z.enum(PERSONAS),
  /** Goal slug from the page's starting list, or "something-else". */
  goal: z.string(),
  /** What the tester wants out of the conversation, in their words. */
  intent: z.string(),
  facts: hiddenFacts,
  /** Area code of the tester's number, e.g. "212". Eastern unless the scenario says otherwise. */
  areaCode: z.string().regex(/^\d{3}$/),
  /** Local time of the first text, "HH:MM" in the tester's time zone. */
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  timeZone: z.string(),
  /** Exact first text, when the page's example fixes it. Otherwise the simulator writes it. */
  opening: z.string().optional(),
  /** Extra stage directions for the simulator (e.g. "midway, text: no emojis pls"). */
  directions: z.array(z.string()).default([]),
  /** Where this scenario comes from (page example, persona coverage...). Report only. */
  source: z.string(),
  maxTurns: z.number().int().positive().optional(),
  seed: seedSchema.optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;

/** A regression case: scripted tester lines, fresh ZOH replies, and what should have happened. */
export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** When and how it went wrong (grader run, Yanni live, a beta tester). */
  origin: z.string(),
  /**
   * The tester's texts, in order. A line "advance to HH:MM" is not a text: the clock moves to that local
   * time (the next one), running the nudge tick each minute, and ZOH's own texts join the transcript.
   * A line "console Yanni: ..." is a founder's message in the console chat (add "(exact)" or
   * "(exact, now)" after the name for "send exactly this" and "send now"); ZOH's console answer joins
   * the transcript, marked as console.
   */
  testerLines: z.array(z.string().min(1)).min(1),
  whatWentWrong: z.string(),
  shouldHaveHappened: z.string(),
  areaCode: z.string().regex(/^\d{3}$/).default("212"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:30"),
  /** The weekday the run starts, in the eval's week (Monday, unless a case needs another day: #78's Sunday). */
  startDay: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).optional(),
  timeZone: z.string().default("America/New_York"),
  persona: z.enum(PERSONAS).optional(),
  seed: seedSchema.optional(),
});
export type RegressionCase = z.infer<typeof caseSchema>;

export interface TranscriptLine {
  /** "founder": a founder's line in the console chat (console feature); never seen by the tester. */
  from: "tester" | "zoh" | "founder";
  text: string;
  /** ZOH answering the founders in the console chat, not a text to the tester. */
  console?: boolean;
  /** ISO time on the injected clock. */
  at: string;
  /** A text ZOH started itself (a nudge), not a reply. */
  started?: boolean;
}

/** One conversation to run: a scenario (simulated tester) or a case (scripted lines). */
export interface ConversationPlan {
  /** Unique within a run, e.g. "alex-gym" or "alex-gym#2". */
  key: string;
  kind: "scenario" | "case";
  id: string;
  title: string;
  persona: Persona | "scripted";
  areaCode: string;
  startTime: string;
  /** Weekday of the run's first line in the eval's week; Monday when not given. */
  startDay?: Weekday;
  timeZone: string;
  scenario?: Scenario;
  regression?: RegressionCase;
  seed?: Seed;
}

export interface ConversationResult {
  plan: ConversationPlan;
  phone: string;
  /** The seeded conversation before this run's first text; context only, never graded. */
  context: TranscriptLine[];
  transcript: TranscriptLine[];
  endedBy: "simulator" | "turn-cap" | "script" | "error";
  error?: string;
  /** The tester's memory pages after the run (memory feature only), as the coach reads them. */
  memory?: string;
  /** The tester's dated step log at the start (console feature): what ZOH could see, so the grader can check its facts. */
  record?: string;
  /** What ZOH saved during the run (features with `saved`): flags, pauses, plan versions, style. */
  saved?: string;
  /** Rows in the database that belong to this tester, other than messages. */
  savedState: Record<string, unknown[]>;
  messageCount: number;
  /** Errors the app recorded on messages (e.g. a failed Claude call that fell back to "Got it"). */
  appErrors: string[];
  usage: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
}

// ---- Grader output ----

export const checkSchema = z.object({
  rule: z.string(),
  pass: z.boolean(),
  /** True when the grader thinks it could reasonably go either way. */
  borderline: z.boolean(),
  reason: z.string(),
});
export type Check = z.infer<typeof checkSchema>;

export const gradeSchema = z.object({
  texts: z.array(
    z.object({
      /** 1-based index among ZOH's texts in this conversation. */
      zohText: z.number().int().positive(),
      checks: z.array(checkSchema),
    }),
  ),
  conversation: z.array(checkSchema),
  summary: z.string(),
});
export type Grade = z.infer<typeof gradeSchema>;

export interface GradedConversation extends ConversationResult {
  grade?: Grade;
  gradeError?: string;
}
