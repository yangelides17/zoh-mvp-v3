import { z } from "zod";
import { PROOF_METHODS, REQUEST_DELIVERIES, type Weekday } from "../src/db/schema.js";

/**
 * Which suite a case belongs to (#197). "regression": established behavior that should pass almost every
 * run; a drop gets flagged. "capability": a new feature's own cases; they start low and graduate into
 * regression once they pass every run. "replay": a real tester conversation, reported apart, never tuned against.
 */
export const SUITES = ["regression", "capability", "replay"] as const;
export type Suite = (typeof SUITES)[number];

export const PERSONAS =["terse", "chatty", "joking", "confused", "all-at-once", "resistant"] as const;
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
  history: z
    .array(
      z.object({
        from: z.enum(["tester", "zoh"]),
        text: z.string().min(1),
        /** #163: a document they sent with this text, kept as the pipeline keeps one (its words as the transcript). */
        document: z.object({ name: z.string().regex(/^[\w.-]+\.\w+$/), text: z.string().min(1) }).optional(),
      }),
    )
    .min(1),
  /** #48: quiet hours they chose themselves (local "HH:MM"); without it, the default ones, which fit around the step. */
  quiet_hours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
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
      proof: z.enum(PROOF_METHODS),
      proof_note: z.string().optional(),
      reason: z.string(),
      /** How long the step takes, in minutes. */
      minutes: z.number().int().min(0).max(600).optional(),
      /** Day 1 this many days before the run's day (0: day 1 is today). */
      started_days_ago: z.number().int().min(0).max(30).default(0),
      /**
       * #196: this plan is a temporary lighter one (change_plan with until), through this many days
       * after the run's day; `usual_step` is the version before it, which comes back after.
       */
      temporary: z.object({ ends_in_days: z.number().int().min(0).max(30), usual_step: z.string() }).optional(),
    })
    .optional(),
  /** #196: what the founders left in the console: notes (context) and requests ("morning" rides the kickoff); #158: guidance lines. */
  team: z
    .array(
      z.object({
        /** #168: "file": a founder's line with a file already read (`name`, `content_type`, `account`: what's in it). */
        kind: z.enum(["note", "request", "file", "guidance"]),
        body: z.string().min(1),
        hours_ago: z.number().min(0).max(72).default(1),
        delivery: z.enum(REQUEST_DELIVERIES).default("natural"),
        /** #169: a request that's a question; `asked_hours_ago`: ZOH already asked it then (put the asking in `history`). */
        question: z.boolean().default(false),
        asked_hours_ago: z.number().min(0).max(240).optional(),
        name: z.string().optional(),
        content_type: z.string().optional(),
        account: z.string().optional(),
      }),
    )
    .default([]),
  /** #196: a break in progress, started this many hours ago, until a local day this many days on (none: until they're back). */
  pause: z
    .object({ started_hours_ago: z.number().min(0).max(240), until_days: z.number().int().min(1).max(30).optional(), reason: z.string().optional() })
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
        /** #196: whether they said how it went when they marked it done (false: proof alone, #93's pickup). */
        how_it_went_said: z.boolean().optional(),
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
  /** #69: the seeded plan's "Plan version N to review" alert, unseen, as locking it raises in production. */
  plan_review_alert: z.boolean().default(false),
  /** Next steps on the seeded goal as the founders left them (next-step feature). */
  suggestions: z
    .array(
      z.object({
        kind: z.enum(["deepen", "upgrade", "new_focus", "adjust"]),
        raised_by: z.enum(["coach", "tester", "founder"]).default("coach"),
        /** adjust only (#155): the plan fields the founders proposed, as stored (stepTime "HH:MM", place, days...). */
        plan_changes: z
          .object({ stepTime: z.string().optional(), place: z.string().optional(), minutes: z.number().optional(), proof: z.enum(PROOF_METHODS).optional() })
          .optional(),
        /** How long ago ZOH raised it, for one waiting on their answer. */
        delivered_hours_ago: z.number().optional(),
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

/**
 * #230: a tester line that waits for the moment it answers. `say` is its wording; `when` is the moment in ZOH's
 * texts it fits, named by what ZOH does ("after ZOH asks what went wrong"). Until then the simulated tester
 * answers ZOH, without seeing the line. An anchored line (the default) may be changed as little as possible to
 * answer what ZOH asked, keeping `means` and `length`; a `fixed` one goes out word for word or not at all, and is
 * never skipped. `optional`: the line only applies if ZOH asks for it, so it's dropped when ZOH moves past it.
 * `expected`: its moment is what the case expects ZOH to reach (proposing tomorrow's step, say); if ZOH never gets
 * there, the run ends and is graded as ZOH's miss, not a case problem. `starts`: the tester's own move (texting
 * first, telling the next part of a story), sent as written without waiting.
 */
export const LINE_LENGTHS = ["thin", "short", "full"] as const;
export const caseLineSchema = z
  .object({
    say: z.string().min(1),
    means: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
    length: z.enum(LINE_LENGTHS).optional(),
    fixed: z.boolean().default(false),
    optional: z.boolean().default(false),
    expected: z.boolean().default(false),
    starts: z.boolean().default(false),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (!l.starts && !l.when) ctx.addIssue({ code: "custom", message: "a line that answers ZOH needs `when` (or `starts: true`)" });
    if (!l.starts && !l.fixed && !l.means) ctx.addIssue({ code: "custom", message: "an anchored line needs `means` (or `fixed: true`)" });
    if (l.optional && l.expected) ctx.addIssue({ code: "custom", message: "a line can't be both `optional` and `expected`" });
  });
export type CaseLine = z.infer<typeof caseLineSchema>;

/** A case line's text as written: the line itself, or an anchored line's wording. */
export function lineText(line: string | CaseLine): string {
  return typeof line === "string" ? line : line.say;
}

/** A regression case: scripted tester lines, fresh ZOH replies, and what should have happened. */
export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** When and how it went wrong (grader run, Yanni live, a beta tester). */
  origin: z.string(),
  /**
   * The tester's texts, in order. A line "advance to HH:MM" is not a text: the clock moves to that local
   * time (the next one), running the nudge tick each minute, and ZOH's own texts join the transcript.
   * A line "console Yanni: ..." is a founder's message in the console chat; ZOH's console answer and
   * any draft card it makes join the transcript, marked as console. "console Yanni (do it)" clicks Do it
   * on the newest open draft (#155). A line can also wait for its moment (#230, `caseLineSchema`).
   */
  testerLines: z.array(z.union([z.string().min(1), caseLineSchema])).min(1),
  /** #230: what's true about the tester, for the replies they send while a line waits. Never shown to ZOH or the grader. */
  facts: z.array(z.string().min(1)).optional(),
  whatWentWrong: z.string(),
  shouldHaveHappened: z.string(),
  areaCode: z.string().regex(/^\d{3}$/).default("212"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:30"),
  /** The weekday the run starts, in the eval's week (Monday, unless a case needs another day: #78's Sunday). */
  startDay: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).optional(),
  timeZone: z.string().default("America/New_York"),
  persona: z.enum(PERSONAS).optional(),
  seed: seedSchema.optional(),
  suite: z.enum(SUITES).default("regression"),
});
export type RegressionCase = z.infer<typeof caseSchema>;

export interface TranscriptLine {
  /**
   * "founder": a founder's line in the console chat (console feature); never seen by the tester. "lookup" (#162):
   * what ZOH searched, opened or watched for its next reply, for the grader; never seen by the tester.
   */
  from: "tester" | "zoh" | "founder" | "lookup";
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
  /** A case's suite; simulated scenarios, and reports from before #197, count as regression. */
  suite?: Suite;
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
  /**
   * "case-problem" (#230): a line never found its moment for a reason that isn't ZOH's to fix; the run is graded
   * but kept out of the scores. A line ZOH was expected to reach and didn't ends the run "by script", graded as usual.
   */
  endedBy: "simulator" | "turn-cap" | "script" | "error" | "case-problem";
  error?: string;
  /** #230: how a case's waiting lines went out, with each decision and its reason. */
  lines?: LineCounts;
  /** #230: ZOH's own status sheet at the start of a seeded conversation, so the grader knows what ZOH knew. */
  knew?: string;
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

/**
 * #230: waiting lines sent word for word, changed to fit, skipped (their point already made), passed (optional,
 * ZOH moved past them) and the extra replies sent while one waited. `missed`: a line ZOH was expected to reach and
 * didn't (graded as ZOH's miss); `problem`: a line that never fit for another reason (a case problem).
 */
export interface LineCounts {
  exact: number;
  adapted: number;
  waited: number;
  skipped: number;
  passed: number;
  missed?: string;
  problem?: string;
  log: LineDecision[];
}

/** #230: one simulator decision on a waiting line, with its one-sentence reason. Report only; never shown to ZOH or the grader. */
export interface LineDecision {
  line: number;
  say: string;
  decision: LineVerdict;
  reason: string;
}
export const LINE_VERDICTS = ["said", "fits", "close", "wait", "passed"] as const;
export type LineVerdict = (typeof LINE_VERDICTS)[number];

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
  /** #230: a case problem's grade, shown beside it but kept out of every score and comparison. */
  problemGrade?: Grade;
}
