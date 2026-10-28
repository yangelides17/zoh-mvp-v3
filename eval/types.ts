import { z } from "zod";

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
  /** How earlier step days went (needs a plan): e.g. { "days_ago": 1, "status": "missed" }. */
  step_days: z
    .array(z.object({ days_ago: z.number().int().min(1).max(30), status: z.enum(["done", "done_reduced", "missed"]) }))
    .default([]),
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
   */
  testerLines: z.array(z.string().min(1)).min(1),
  whatWentWrong: z.string(),
  shouldHaveHappened: z.string(),
  areaCode: z.string().regex(/^\d{3}$/).default("212"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:30"),
  timeZone: z.string().default("America/New_York"),
  persona: z.enum(PERSONAS).optional(),
  seed: seedSchema.optional(),
});
export type RegressionCase = z.infer<typeof caseSchema>;

export interface TranscriptLine {
  from: "tester" | "zoh";
  text: string;
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
