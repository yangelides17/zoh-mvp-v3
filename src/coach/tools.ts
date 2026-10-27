import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { flags, planInputs, type PlanInput, type Tester } from "../db/schema.js";
import { optOut } from "../testers/commands.js";
import { updateTester } from "../testers/testers.js";
import { PLAN_FIELDS, PLAN_KEYS, type CoachState } from "./state.js";

export const OFF_LIST_GOAL_FLAG = "off_list_goal";

const text = (max: number) => z.string().trim().min(1).max(max);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour "HH:MM"');

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
      "Save one or more plan answers for their goal, in their words (short). Only keys their goal uses. Pass everything they said at once.",
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
    description: "Only when the state says needs_city: save their city and its IANA time zone (e.g. America/Denver).",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" }, time_zone: { type: "string" } },
      required: ["city", "time_zone"],
    },
  },
  {
    name: "set_quiet_hours",
    description: 'Only when they ask: when ZOH must not start texts, local 24-hour "HH:MM".',
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
];

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
  }
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
