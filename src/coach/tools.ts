import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  flags,
  MIN_DAYS_PER_WEEK,
  planInputs,
  plans,
  PROOF_METHODS,
  WEEKDAYS,
  type Plan,
  type PlanInput,
  type Tester,
} from "../db/schema.js";
import { optOut } from "../testers/commands.js";
import { updateTester } from "../testers/testers.js";
import { describeDays, localDate, PLAN_FIELDS, PLAN_KEYS, type CoachState } from "./state.js";

export const OFF_LIST_GOAL_FLAG = "off_list_goal";
export const GOAL_SWITCH_FLAG = "goal_switch";

const text = (max: number) => z.string().trim().min(1).max(max);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour "HH:MM"');

/** Plan fields; every one optional, merged onto the draft (or the locked plan, for change_plan). */
const planFields = {
  setup_step: z.string().trim().max(200).optional(),
  step: text(300).optional(),
  place: z.string().trim().max(120).optional(),
  time: clock.optional(),
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
  proof: z.enum(PROOF_METHODS).optional(),
  proof_note: z.string().trim().max(120).optional(),
  reason: text(200).optional(),
};

const schemas = {
  save_name: z.object({ name: text(60) }).strict(),
  choose_goal: z
    .object({
      slug: text(40),
      description: text(200).optional(),
      accepted: z.boolean().optional(),
    })
    .strict(),
  save_plan_inputs: z
    .object(Object.fromEntries(PLAN_KEYS.map((k) => [k, text(300).optional()])) as Record<
      (typeof PLAN_KEYS)[number],
      z.ZodOptional<z.ZodString>
    >)
    .strict(),
  set_time_zone: z.object({ city: text(80), time_zone: text(60) }).strict(),
  set_quiet_hours: z.object({ start: clock, end: clock }).strict(),
  save_style_note: z.object({ note: text(120) }).strict(),
  opt_out: z.object({}).strict(),
  propose_plan: z.object(planFields).strict(),
  lock_plan: z.object({ commitment: text(200), start: z.enum(["today", "tomorrow"]) }).strict(),
  change_plan: z.object(planFields).strict(),
  switch_goal: z.object({ slug: text(40), reason: text(300) }).strict(),
};

export type ToolName = keyof typeof schemas;

/** What the model sees. Descriptions are part of the instructions: keep them short. */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "save_name",
    description: "Save the tester's first name, whenever they mention it.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "choose_goal",
    description:
      'Save the goal they picked, by slug from the state block. For "something_else", give a short description and whether you accept it (close to a listed goal and you can coach and check it daily). A declined one is saved for the founders and no goal is set.',
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        description: { type: "string", description: "something_else only: what they want, in a few words" },
        accepted: { type: "boolean", description: "something_else only" },
      },
      required: ["slug"],
    },
  },
  {
    name: "save_plan_inputs",
    description:
      'Save one or more plan answers for their goal, in their words (short). Only keys their goal uses. Pass everything they said at once, but only answers concrete enough to plan: "when" needs a time of day ("7:30", "after dinner"), not just "night" or "mornings".',
    input_schema: {
      type: "object",
      properties: {
        what: { type: "string" },
        where: { type: "string" },
        when: { type: "string" },
        how_long: { type: "string" },
        tracks_with: { type: "string", description: 'An app, wearable, journal…, or "doesn\'t track it"' },
      },
    },
  },
  {
    name: "set_time_zone",
    description: "Only when the state says their time zone is possibly outside Eastern and they tell you their city: save it and its IANA time zone (e.g. America/Denver).",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" }, time_zone: { type: "string" } },
      required: ["city", "time_zone"],
    },
  },
  {
    name: "set_quiet_hours",
    description: 'When they ask, or accept your offer to move them around their step time: when ZOH must not start texts, local 24-hour "HH:MM".',
    input_schema: {
      type: "object",
      properties: { start: { type: "string" }, end: { type: "string" } },
      required: ["start", "end"],
    },
  },
  {
    name: "save_style_note",
    description: 'Save a request about how you coach or text ("no emojis", "chill out").',
    input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  {
    name: "opt_out",
    description: 'They want ZOH to stop texting them ("leave me alone", "I\'m done with this"). Stops them; the app sends the confirmation.',
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_plan",
    description:
      "Save the plan you're showing them as the draft. The first time, give every field; for a revision, only the fields that change (an empty setup_step removes it).",
    input_schema: { type: "object", properties: planProperties() },
  },
  {
    name: "lock_plan",
    description:
      'Lock the draft once they clearly commit. commitment: their words from their latest text, exactly as written ("I\'m in"). start: day 1 today or tomorrow.',
    input_schema: {
      type: "object",
      properties: { commitment: { type: "string" }, start: { type: "string", enum: ["today", "tomorrow"] } },
      required: ["commitment", "start"],
    },
  },
  {
    name: "change_plan",
    description: "After the plan is locked: save a change they asked for as a new version. Only the fields that change.",
    input_schema: { type: "object", properties: planProperties() },
  },
  {
    name: "switch_goal",
    description: "Switch them to another starting goal, by slug, only for a real reason; reason in their words.",
    input_schema: {
      type: "object",
      properties: { slug: { type: "string" }, reason: { type: "string" } },
      required: ["slug", "reason"],
    },
  },
];

function planProperties(): Record<string, unknown> {
  return {
    setup_step: { type: "string", description: "One-time step for day 1, only when it helps" },
    step: { type: "string", description: "What they do and how much, specific enough to just do it" },
    place: { type: "string" },
    time: { type: "string", description: 'Local 24-hour "HH:MM"' },
    days: { type: "array", items: { type: "string", enum: [...WEEKDAYS] }, description: `At least ${MIN_DAYS_PER_WEEK}` },
    proof: { type: "string", enum: [...PROOF_METHODS] },
    proof_note: { type: "string", description: 'Which one ("Whoop strain screenshot")' },
    reason: { type: "string", description: "One line on why this plan" },
  };
}

export type ToolResult = { ok: true; message: string; tester: Tester; optedOut?: boolean } | { ok: false; error: string };

/**
 * Validates and runs one tool call against the current state. Never throws for bad input:
 * the model gets the error back and can fix its call.
 */
export async function runTool(db: Db, state: CoachState, name: string, rawInput: unknown, at: Date): Promise<ToolResult> {
  if (!(name in schemas)) return { ok: false, error: `Unknown tool "${name}"` };
  const parsed = schemas[name as ToolName].safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  const input = parsed.data;
  const tester = state.tester;

  switch (name as ToolName) {
    case "save_name": {
      const { name: first } = input as z.infer<typeof schemas.save_name>;
      return saved(await updateTester(db, tester.id, { name: first }), `Name saved: ${first}`);
    }

    case "choose_goal": {
      const { slug, description, accepted } = input as z.infer<typeof schemas.choose_goal>;
      if (tester.phase !== "onboarding") return { ok: false, error: "The goal is set; changing it comes with the plan." };
      const goal = state.goals.find((g) => g.slug === slug);
      if (!goal) return { ok: false, error: `Unknown goal "${slug}". Use one of: ${state.goals.map((g) => g.slug).join(", ")}` };
      if (slug === "something_else") {
        if (!description || accepted === undefined) {
          return { ok: false, error: "something_else needs a description and accepted (true or false)" };
        }
        if (!accepted) {
          await db.insert(flags).values({ testerId: tester.id, kind: OFF_LIST_GOAL_FLAG, detail: description });
          return saved(tester, `Declined and saved for the founders: ${description}. No goal set.`);
        }
      } else if (description !== undefined || accepted !== undefined) {
        return { ok: false, error: "description and accepted are only for something_else" };
      }
      await upsertPlanInputs(db, tester.id, slug, {}, description ? { goal_description: description } : undefined);
      return saved(await updateTester(db, tester.id, { goalSlug: slug }), `Goal saved: ${goal.title}`);
    }

    case "save_plan_inputs": {
      const answers = input as z.infer<typeof schemas.save_plan_inputs>;
      const keys = PLAN_KEYS.filter((k) => answers[k] !== undefined);
      if (!state.goal) return { ok: false, error: "Choose a goal first." };
      if (keys.length === 0) return { ok: false, error: "Give at least one answer." };
      const applicable = state.goal.planQuestions.map((q) => q.key);
      const wrong = keys.filter((k) => !applicable.includes(k));
      if (wrong.length) {
        return { ok: false, error: `${wrong.join(", ")} doesn't apply to ${state.goal.title}. It uses: ${applicable.join(", ")}` };
      }
      const values: Partial<PlanInput> = {};
      for (const k of keys) values[PLAN_FIELDS[k]] = answers[k];
      await upsertPlanInputs(db, tester.id, state.goal.slug, values);
      return saved(tester, `Saved: ${keys.map((k) => `${k} = ${answers[k]}`).join("; ")}`);
    }

    case "set_time_zone": {
      const { city, time_zone } = input as z.infer<typeof schemas.set_time_zone>;
      if (tester.timeZoneStatus !== "needs_city") {
        return { ok: false, error: "Their time zone is already known; don't change it." };
      }
      if (!isTimeZone(time_zone)) return { ok: false, error: `"${time_zone}" isn't an IANA time zone like America/Denver` };
      const updated = await updateTester(db, tester.id, { timeZone: time_zone, timeZoneStatus: "confirmed" });
      return saved(updated, `Time zone saved: ${time_zone} (${city})`);
    }

    case "set_quiet_hours": {
      const { start, end } = input as z.infer<typeof schemas.set_quiet_hours>;
      if (start === end) return { ok: false, error: "start and end can't be the same" };
      return saved(await updateTester(db, tester.id, { quietHoursStart: start, quietHoursEnd: end }), `Quiet hours: ${start} to ${end}`);
    }

    case "save_style_note": {
      const { note } = input as z.infer<typeof schemas.save_style_note>;
      const notes = tester.styleNotes ? `${tester.styleNotes}; ${note}` : note;
      return saved(await updateTester(db, tester.id, { styleNotes: notes }), `Style note saved: ${note}`);
    }

    case "opt_out": {
      const updated = await optOut(db, tester, at);
      return { ok: true, message: "Stopped.", tester: updated, optedOut: true };
    }

    case "propose_plan": {
      if (tester.phase === "active") return { ok: false, error: "Their plan is locked: use change_plan." };
      if (tester.phase !== "planning" || !state.goal) return { ok: false, error: "Finish the onboarding questions first." };
      if (state.openRequired.length) {
        return { ok: false, error: `Ask these first: ${state.openRequired.map((q) => q.key).join(", ")}` };
      }
      const draft = state.draft?.goalSlug === state.goal.slug ? state.draft : undefined;
      const merged = mergePlan(draft, input as PlanFieldsInput);
      if (typeof merged === "string") return { ok: false, error: merged };
      if (draft) {
        await db.update(plans).set({ ...merged, updatedAt: at }).where(eq(plans.id, draft.id));
      } else {
        await db.delete(plans).where(and(eq(plans.testerId, tester.id), eq(plans.status, "draft")));
        await db.insert(plans).values({ testerId: tester.id, goalSlug: state.goal.slug, status: "draft", ...merged });
      }
      return saved(tester, `Draft saved: ${describePlan(merged)}`);
    }

    case "lock_plan": {
      const { commitment, start } = input as z.infer<typeof schemas.lock_plan>;
      if (tester.phase !== "planning") return { ok: false, error: "Only a plan being agreed can be locked." };
      const draft = state.draft;
      if (!draft || draft.goalSlug !== state.goal?.slug) return { ok: false, error: "No plan to lock: show them one with propose_plan first." };
      if (draft.days.length < MIN_DAYS_PER_WEEK) return { ok: false, error: `A plan needs at least ${MIN_DAYS_PER_WEEK} days a week.` };
      if (!saidIt(commitment, state.lastTesterText)) {
        return { ok: false, error: "That isn't in their latest text. Lock only on a clear yes from them, quoting their words exactly." };
      }
      const version = await nextVersion(db, tester.id);
      const startDate = localDate(at, tester.timeZone, start === "today" ? 0 : 1);
      await db
        .update(plans)
        .set({ status: "locked", version, startDate, commitment, needsReview: true, lockedAt: at, updatedAt: at })
        .where(eq(plans.id, draft.id));
      const updated = await updateTester(db, tester.id, { phase: "active" });
      return saved(updated, `Locked (version ${version}). Day 1 is ${start} (${startDate}).`);
    }

    case "change_plan": {
      if (tester.phase !== "active" || !state.plan) return { ok: false, error: "No locked plan yet: use propose_plan." };
      const merged = mergePlan(state.plan, input as PlanFieldsInput);
      if (typeof merged === "string") return { ok: false, error: merged };
      const version = await nextVersion(db, tester.id);
      const { startDate, commitment } = state.plan;
      await db.insert(plans).values({
        testerId: tester.id,
        goalSlug: state.plan.goalSlug,
        status: "locked",
        version,
        ...merged,
        startDate,
        commitment,
        needsReview: true,
        lockedAt: at,
      });
      return saved(tester, `Changed (version ${version}): ${describePlan(merged)}`);
    }

    case "switch_goal": {
      const { slug, reason } = input as z.infer<typeof schemas.switch_goal>;
      if (tester.phase === "onboarding") return { ok: false, error: "During onboarding, use choose_goal." };
      const goal = state.goals.find((g) => g.slug === slug && g.slug !== "something_else");
      if (!goal) {
        const listed = state.goals.filter((g) => g.slug !== "something_else").map((g) => g.slug);
        return { ok: false, error: `Switch only to a starting goal: ${listed.join(", ")}` };
      }
      if (slug === tester.goalSlug) return { ok: false, error: "That's already their goal." };
      await db.insert(flags).values({ testerId: tester.id, kind: GOAL_SWITCH_FLAG, detail: `${tester.goalSlug} → ${slug}: ${reason}` });
      await db.delete(plans).where(and(eq(plans.testerId, tester.id), eq(plans.status, "draft")));
      await db.insert(planInputs).values({ testerId: tester.id, goalSlug: slug }).onConflictDoNothing();
      const updated = await updateTester(db, tester.id, { goalSlug: slug, phase: "planning" });
      return saved(updated, `Switched to ${goal.title}, saved for the founders with the reason.`);
    }
  }
}

type PlanFieldsInput = z.infer<typeof schemas.propose_plan>;
type PlanValues = Pick<Plan, "setupStep" | "step" | "place" | "stepTime" | "days" | "proof" | "proofNote" | "reason">;

/** The input merged onto a base plan, or what's still missing or wrong. */
function mergePlan(base: Plan | undefined, input: PlanFieldsInput): PlanValues | string {
  // An empty string clears an optional field; leaving it out keeps the base's.
  const optional = (value: string | undefined, fallback: string | null | undefined) =>
    value === undefined ? (fallback ?? null) : value || null;
  const merged = {
    setupStep: optional(input.setup_step, base?.setupStep),
    step: input.step ?? base?.step,
    place: optional(input.place, base?.place),
    stepTime: input.time ?? base?.stepTime,
    days: input.days ? WEEKDAYS.filter((d) => input.days!.includes(d)) : base?.days,
    proof: input.proof ?? base?.proof,
    proofNote: optional(input.proof_note, base?.proofNote),
    reason: input.reason ?? base?.reason,
  };
  const missing = (["step", "stepTime", "days", "proof", "reason"] as const).filter((k) => merged[k] === undefined);
  if (missing.length) return `Missing: ${missing.map((k) => (k === "stepTime" ? "time" : k)).join(", ")}`;
  if (merged.days!.length < MIN_DAYS_PER_WEEK) {
    return `A plan needs at least ${MIN_DAYS_PER_WEEK} days a week; tell them, and agree on ${MIN_DAYS_PER_WEEK} or more.`;
  }
  return merged as PlanValues;
}

/** One line for tool results and the state block. */
export function describePlan(p: PlanValues): string {
  return [
    p.setupStep && `setup: ${p.setupStep}`,
    `step: ${p.step}`,
    p.place && `where: ${p.place}`,
    `at ${p.stepTime}, ${describeDays(p.days)}`,
    `proof: ${p.proof}${p.proofNote ? ` (${p.proofNote})` : ""}`,
    `reason: ${p.reason}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Whether their words appear in their latest text, ignoring case, punctuation and spacing. */
function saidIt(words: string, latest: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const said = norm(words);
  return said.length > 0 && norm(latest).includes(said);
}

async function nextVersion(db: Db, testerId: string): Promise<number> {
  const [row] = await db.select({ v: max(plans.version) }).from(plans).where(eq(plans.testerId, testerId));
  return (row?.v ?? 0) + 1;
}

function saved(tester: Tester, message: string): ToolResult {
  return { ok: true, message, tester };
}

async function upsertPlanInputs(
  db: Db,
  testerId: string,
  goalSlug: string,
  values: Partial<PlanInput>,
  extraNotes?: Record<string, unknown>,
): Promise<void> {
  const set = { ...values, ...(extraNotes ? { extraNotes } : {}), updatedAt: new Date() };
  await db
    .insert(planInputs)
    .values({ testerId, goalSlug, ...set })
    .onConflictDoUpdate({ target: [planInputs.testerId, planInputs.goalSlug], set });
}

function isTimeZone(zone: string): boolean {
  if (!zone.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
