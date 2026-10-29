import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  CHANGE_KINDS,
  CHECKIN_ANSWERS,
  maintenanceCheckins,
  MIN_DAYS_PER_WEEK,
  planInputs,
  plans,
  PROOF_METHODS,
  stepDays,
  SUGGESTION_KINDS,
  suggestions,
  WEEKDAYS,
  type NewStepDay,
  type Plan,
  type PlanInput,
  type Suggestion,
  type Tester,
} from "../db/schema.js";
import { alertFeedback, raiseAlert, saveFlag } from "../console/alerts.js";
import { endPause, startPause } from "../testers/pauses.js";
import { closeRequest, doneLine, findRequest } from "../console/requests.js";
import { optOut } from "../testers/commands.js";
import { goalMetrics, setFocusGoal } from "../testers/goals.js";
import {
  approvedKind,
  approvedProposal,
  awaitingAnswer,
  DECLINE_QUIET_DAYS,
  findSuggestion,
  MILESTONES,
  readyToRaise,
  stillOpen,
  stoppedTwice,
  suggestionRef,
} from "./next-steps.js";
import { updateTester } from "../testers/testers.js";
import { addDays, isStepDay } from "../nudges/schedule.js";
import { describeDays, loadDaySummary, localDate, PLAN_FIELDS, PLAN_KEYS, type CoachState } from "./state.js";

export const OFF_LIST_GOAL_FLAG = "off_list_goal";
export const GOAL_SWITCH_FLAG = "goal_switch";
export const PROOF_PATTERN_FLAG = "proof_pattern";

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
  minutes: z.number().int().min(0).max(600).optional(),
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
  opt_out: z.object({}).strict(),
  pause_texts: z
    .object({ reason: text(200), back_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use "YYYY-MM-DD"').optional() })
    .strict(),
  resume_texts: z.object({}).strict(),
  send_feedback: z.object({ feedback: text(1000) }).strict(),
  propose_plan: z.object(planFields).strict(),
  lock_plan: z.object({ commitment: text(200), start: z.enum(["today", "tomorrow"]) }).strict(),
  change_plan: z
    .object({
      ...planFields,
      kind: z.enum(CHANGE_KINDS).optional(),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use "YYYY-MM-DD"').optional(),
      asked: text(300).optional(),
      suggestion: text(40).optional(),
    })
    .strict(),
  switch_goal: z.object({ slug: text(40), reason: text(300), suggestion: text(40).optional() }).strict(),
  suggest_next_step: z
    .object({
      kind: z.enum(SUGGESTION_KINDS),
      asked_by: z.enum(["coach", "tester"]),
      proposal: text(300),
      reasoning: text(500),
      new_goal: text(40).optional(),
      unsure: text(300).optional(),
    })
    .strict(),
  record_next_step: z.object({ suggestion: text(40), outcome: z.enum(["delivered", "declined"]) }).strict(),
  record_checkin: z.object({ goal: text(40), answer: z.enum([...CHECKIN_ANSWERS, "asked"]) }).strict(),
  mark_step_done: z
    .object({
      how: z.enum(["full", "reduced"]),
      proof: z.enum(["clear", "plausible"]),
      seen: text(200),
      note: z.string().trim().max(200).optional(),
      day: z.enum(["today", "yesterday"]).optional(),
      dated: text(60).optional(),
    })
    .strict(),
  proof_unclear: z.object({ verdict: z.enum(["unclear", "doesnt_match"]), seen: text(200) }).strict(),
  mark_missed: z.object({ note: z.string().trim().max(200).optional() }).strict(),
  flag_proof_pattern: z.object({ reason: text(300) }).strict(),
  mark_on_it: z.object({}).strict(),
  move_today: z.object({ time: clock }).strict(),
  mark_request_done: z.object({ request: text(40) }).strict(),
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
    name: "opt_out",
    description: 'They want ZOH to stop texting them ("leave me alone", "I\'m done with this"). Stops them; the app sends the confirmation.',
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pause_texts",
    description:
      "Pause every text you'd start (kickoffs, nudges), once they've given a real reason or insisted after your one push back. reason: why, in a few words. back_on: their local date they'll be back, only if they said.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" }, back_on: { type: "string", description: '"YYYY-MM-DD"' } },
      required: ["reason"],
    },
  },
  {
    name: "resume_texts",
    description: 'They\'re back from a pause ("I\'m back", "let\'s go again"): your texts start again.',
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_feedback",
    description: "Passes feedback meant for the team to the founders, in their words.",
    input_schema: { type: "object", properties: { feedback: { type: "string" } }, required: ["feedback"] },
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
    description:
      "After the plan is locked: save a change they asked for as a new version. Only the fields that change. until: only for a lighter plan for a short stretch (a trip, a rough week): its last day; then the plan before it comes back.",
    input_schema: {
      type: "object",
      properties: {
        ...planProperties(),
        kind: {
          type: "string",
          enum: [...CHANGE_KINDS],
          description: "deepen: same activity, more of it (streak goes on). upgrade: a different or harder activity (a new streak starts). other (default): time, days, proof, lighter",
        },
        until: { type: "string", description: 'Last day, "YYYY-MM-DD"' },
        asked: { type: "string", description: "deepen or upgrade they asked for: their words from their latest text, exactly" },
        suggestion: { type: "string", description: "An approved next step they just agreed to: its id from the state (its kind applies)" },
      },
    },
  },
  {
    name: "switch_goal",
    description:
      "Switch them to another starting goal, by slug, only for a real reason; reason in their words. With suggestion (an approved new focus they agreed to), the old goal stays as maintenance.",
    input_schema: {
      type: "object",
      properties: { slug: { type: "string" }, reason: { type: "string" }, suggestion: { type: "string", description: "Its id from the state" } },
      required: ["slug", "reason"],
    },
  },
  {
    name: "suggest_next_step",
    description:
      "For the team, never said to them: a next step on their focus goal. asked_by coach: you think they're ready for more. asked_by tester: they asked for a new goal on top (new_focus, new_goal = its slug). deepen: more of the same; upgrade: a different or harder activity. unsure: what you can't tell (deepen or upgrade, change or add); the team decides.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...SUGGESTION_KINDS] },
        asked_by: { type: "string", enum: ["coach", "tester"] },
        proposal: { type: "string", description: "What the step would be, specific (\"15 pages a night\")" },
        reasoning: { type: "string", description: "Why now (coach), or their words (tester)" },
        new_goal: { type: "string", description: "new_focus only: the goal's slug" },
        unsure: { type: "string" },
      },
      required: ["kind", "asked_by", "proposal", "reasoning"],
    },
  },
  {
    name: "record_next_step",
    description:
      "An approved next step from the state: delivered once you raise it with them; declined when they say no (nothing changes, not raised again for a week). A yes goes through change_plan or switch_goal with its id.",
    input_schema: {
      type: "object",
      properties: { suggestion: { type: "string" }, outcome: { type: "string", enum: ["delivered", "declined"] } },
      required: ["suggestion", "outcome"],
    },
  },
  {
    name: "record_checkin",
    description:
      'A maintenance goal (by slug): their answer to "still keeping up?" (kept_up; mostly = a day or two missed; stopped), or asked when the state says to ask it on its own and you do.',
    input_schema: {
      type: "object",
      properties: { goal: { type: "string" }, answer: { type: "string", enum: [...CHECKIN_ANSWERS, "asked"] } },
      required: ["goal", "answer"],
    },
  },
  {
    name: "mark_step_done",
    description:
      "The step is done and their photo, screenshot or voice note shows it: never on their word alone. how: full, or reduced for a smaller version. proof: clear, or plausible (fits, can't be 100% sure). seen: what the proof shows, in a line. note: what they did, in a few words. day: yesterday only for proof clearly dated yesterday (dated: the date you see on it). Your texts stop for today.",
    input_schema: {
      type: "object",
      properties: {
        how: { type: "string", enum: ["full", "reduced"] },
        proof: { type: "string", enum: ["clear", "plausible"] },
        seen: { type: "string" },
        note: { type: "string" },
        day: { type: "string", enum: ["today", "yesterday"] },
        dated: { type: "string" },
      },
      required: ["how", "proof", "seen"],
    },
  },
  {
    name: "proof_unclear",
    description:
      "Their proof doesn't show the step yet: unclear (can't tell, blurry, doesn't mention it) or doesnt_match (shows something else). seen: what it shows, in a line. Holds your check-ins while you sort it out.",
    input_schema: {
      type: "object",
      properties: { verdict: { type: "string", enum: ["unclear", "doesnt_match"] }, seen: { type: "string" } },
      required: ["verdict", "seen"],
    },
  },
  {
    name: "mark_missed",
    description:
      "Today's step won't have proof (\"did it but forgot the pic\" and nothing else they can send): today is a miss. Proof later today still turns it into done.",
    input_schema: { type: "object", properties: { note: { type: "string" } } },
  },
  {
    name: "flag_proof_pattern",
    description:
      "For the founders, rarely: they keep sending unclear or mismatched proof over several days and it looks like gaming the system. reason: what keeps happening. Saved only; nobody is told.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
  {
    name: "mark_on_it",
    description:
      'They are doing today\'s step now or about to ("heading to the gym now"). Not for chatting or answering a question. Skips today\'s check-in.',
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "move_today",
    description:
      'They\'ll do today\'s step at another time, today only (also a one-off day-1 time right after lock_plan). Local 24-hour "HH:MM".',
    input_schema: { type: "object", properties: { time: { type: "string" } }, required: ["time"] },
  },
  {
    name: "mark_request_done",
    description: "A FROM THE TEAM request (by its id) that this text carries. Call it in the reply that does it, never before.",
    input_schema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
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
    minutes: { type: "integer", description: "How long the step takes, in minutes" },
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
          await saveFlag(db, tester.id, OFF_LIST_GOAL_FLAG, description);
          return saved(tester, `Declined and saved for the founders: ${description}. No goal set.`);
        }
      } else if (description !== undefined || accepted !== undefined) {
        return { ok: false, error: "description and accepted are only for something_else" };
      }
      await upsertPlanInputs(db, tester.id, slug, {}, description ? { goal_description: description } : undefined);
      await setFocusGoal(db, tester.id, slug, at, "remove");
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

    case "opt_out": {
      const updated = await optOut(db, tester, at, "asked the coach to stop");
      return { ok: true, message: "Stopped.", tester: updated, optedOut: true };
    }

    case "pause_texts": {
      const { reason, back_on } = input as z.infer<typeof schemas.pause_texts>;
      if (back_on && back_on <= state.today) return { ok: false, error: `back_on must be after today (${state.today}).` };
      const { pause, created } = await startPause(db, tester, { at, until: back_on, reason });
      if (!created) return saved(tester, `They're already paused (since ${localDate(pause.startedAt, tester.timeZone)}): say so in one line. Nothing changed.`);
      const until = back_on ? `until the morning of ${back_on}` : "until they say they're back";
      return saved(tester, `Paused ${until}: you start no texts, and still answer anything they send. Confirm in one line.`);
    }

    case "resume_texts": {
      const ended = await endPause(db, tester.id, { at, by: "tester" });
      if (!ended) return { ok: false, error: "They aren't paused." };
      return saved(tester, "Pause lifted: your texts start again. Pick up where you left off.");
    }

    case "send_feedback": {
      const { feedback } = input as z.infer<typeof schemas.send_feedback>;
      await alertFeedback(db, tester.id, feedback, at);
      return saved(tester, "Passed to the team word for word. Acknowledge it in your own words, thank them, and say the team's on it; promise no change.");
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
      await alertPlanReview(db, tester, draft.id, version, at);
      const updated = await updateTester(db, tester.id, { phase: "active" });
      const oneOff = start === "today" ? " For a one-off time today, also call move_today." : "";
      return saved(updated, `Locked (version ${version}). Day 1 is ${start} (${startDate}).${oneOff}`);
    }

    case "change_plan": {
      if (tester.phase !== "active" || !state.plan) return { ok: false, error: "No locked plan yet: use propose_plan." };
      const { until, asked, suggestion: ref, ...rest } = input as z.infer<typeof schemas.change_plan>;
      const { kind: given, ...fields } = rest;
      let kind = given ?? "other";
      let approved: Suggestion | undefined;
      if (ref !== undefined) {
        approved = findSuggestion(state.suggestions, ref);
        if (!approved || !(readyToRaise(approved) || awaitingAnswer(approved))) {
          return { ok: false, error: `No approved next step ${ref} waiting on their answer. Never raise or make a next step the team hasn't approved.` };
        }
        const approvedAs = approvedKind(approved);
        if (approvedAs === "new_focus") return { ok: false, error: "That's a new focus: use switch_goal with it." };
        if (given !== undefined && given !== approvedAs) return { ok: false, error: `It was approved as ${approvedAs}.` };
        kind = approvedAs;
      } else if (kind !== "other" && (!asked || !saidIt(asked, state.lastTesterText))) {
        return {
          ok: false,
          error:
            "A deepen or upgrade is made right away only when they ask for it: asked = their words from their latest text, exactly. One you think of goes to the team with suggest_next_step, never to them.",
        };
      }
      if (until !== undefined && until <= state.today) return { ok: false, error: `until must be after today (${state.today}).` };
      if (until !== undefined && kind !== "other") return { ok: false, error: "A temporary lighter plan is kind other." };
      const merged = mergePlan(state.plan, fields);
      if (typeof merged === "string") return { ok: false, error: merged };
      const version = await nextVersion(db, tester.id);
      const { startDate, commitment } = state.plan;
      const [changed] = await db.insert(plans).values({
        testerId: tester.id,
        goalSlug: state.plan.goalSlug,
        status: "locked",
        version,
        ...merged,
        startDate,
        commitment,
        endsOn: until ?? null,
        changeKind: kind,
        needsReview: true,
        lockedAt: at,
      }).returning({ id: plans.id });
      await alertPlanReview(db, tester, changed!.id, version, at);
      if (approved) {
        await db
          .update(suggestions)
          .set({ outcome: "agreed", deliveredAt: approved.deliveredAt ?? at, outcomeAt: at, planId: changed!.id, updatedAt: at })
          .where(eq(suggestions.id, approved.id));
      } else if (kind !== "other") {
        // Their own ask, made right away (spec case 5): recorded like every next step, for the team.
        await db.insert(suggestions).values({
          testerId: tester.id,
          goalSlug: state.plan.goalSlug,
          kind,
          raisedBy: "tester",
          proposal: describePlan(merged),
          reasoning: asked,
          decision: "approved",
          decidedBy: "zoh",
          decisionReason: "They asked; made right away, the new version flagged for review.",
          decidedAt: at,
          outcome: "agreed",
          outcomeAt: at,
          planId: changed!.id,
          createdAt: at,
        });
      }
      const lasts = until ? ` Temporary: through ${until}, then the plan before it comes back.` : "";
      const fresh = kind === "upgrade" ? " A new streak starts with it." : "";
      return saved(tester, `Changed (version ${version}, ${kind}): ${describePlan(merged)}.${lasts}${fresh}`);
    }

    case "switch_goal": {
      const { slug, reason, suggestion: ref } = input as z.infer<typeof schemas.switch_goal>;
      if (tester.phase === "onboarding") return { ok: false, error: "During onboarding, use choose_goal." };
      const goal = state.goals.find((g) => g.slug === slug && g.slug !== "something_else");
      if (!goal) {
        const listed = state.goals.filter((g) => g.slug !== "something_else").map((g) => g.slug);
        return { ok: false, error: `Switch only to a starting goal: ${listed.join(", ")}` };
      }
      if (slug === tester.goalSlug) return { ok: false, error: "That's already their goal." };
      if (ref !== undefined) {
        // An approved new focus they agreed to (spec rule 5): the old focus stays as maintenance.
        const approved = findSuggestion(state.suggestions, ref);
        if (!approved || !(readyToRaise(approved) || awaitingAnswer(approved)) || approvedKind(approved) !== "new_focus" || approved.newGoalSlug !== slug) {
          return { ok: false, error: `No approved new focus ${ref} for ${slug}. A new goal on top needs the team's OK first: suggest_next_step.` };
        }
        if (!fitsGoalCap(state, slug)) {
          return { ok: false, error: `At the goal cap (${state.goalCap}): the team has to drop a goal first. Don't raise it yet.` };
        }
        await db.delete(plans).where(and(eq(plans.testerId, tester.id), eq(plans.status, "draft")));
        await db.insert(planInputs).values({ testerId: tester.id, goalSlug: slug }).onConflictDoNothing();
        await setFocusGoal(db, tester.id, slug, at, "maintenance");
        await db
          .update(suggestions)
          .set({ outcome: "agreed", deliveredAt: approved.deliveredAt ?? at, outcomeAt: at, updatedAt: at })
          .where(eq(suggestions.id, approved.id));
        const updated = await updateTester(db, tester.id, { goalSlug: slug, phase: "planning" });
        const old = state.goal?.title ?? tester.goalSlug;
        return saved(updated, `${goal.title} is their focus now; ${old} carries on as maintenance (no nudges or proof, a light check-in now and then). Now agree its plan.`);
      }
      await saveFlag(db, tester.id, GOAL_SWITCH_FLAG, `${tester.goalSlug} → ${slug}: ${reason}`);
      await db.delete(plans).where(and(eq(plans.testerId, tester.id), eq(plans.status, "draft")));
      await db.insert(planInputs).values({ testerId: tester.id, goalSlug: slug }).onConflictDoNothing();
      await setFocusGoal(db, tester.id, slug, at, "dropped");
      const updated = await updateTester(db, tester.id, { goalSlug: slug, phase: "planning" });
      return saved(updated, `Switched to ${goal.title}, saved for the founders with the reason.`);
    }

    case "suggest_next_step": {
      const { kind, asked_by, proposal, reasoning, new_goal, unsure } = input as z.infer<typeof schemas.suggest_next_step>;
      if (tester.phase !== "active" || !state.plan) return { ok: false, error: "Next steps come once their plan is locked." };
      if (kind === "new_focus") {
        const listed = state.goals.filter((g) => g.slug !== "something_else" && g.slug !== tester.goalSlug).map((g) => g.slug);
        if (!new_goal || !listed.includes(new_goal)) return { ok: false, error: `new_focus needs new_goal, one of: ${listed.join(", ")}` };
      } else if (new_goal !== undefined) {
        return { ok: false, error: "new_goal is only for new_focus" };
      } else if (asked_by === "tester" && !unsure) {
        return { ok: false, error: "They asked to deepen or upgrade: make it right away with change_plan (that kind, asked = their words)." };
      }
      const goalSlug = state.plan.goalSlug;
      const same = (s: Suggestion) => s.goalSlug === goalSlug && s.kind === kind && (s.newGoalSlug ?? undefined) === new_goal;
      const open = state.suggestions.find((s) => same(s) && stillOpen(s));
      if (open) {
        return saved(tester, `Already with the team since ${localDate(open.createdAt, tester.timeZone)}: nothing new saved. If they ask, you're still thinking on it; promise nothing.`);
      }
      const declined = state.suggestions.findLast((s) => same(s) && s.outcome === "declined");
      const declinedOn = declined?.outcomeAt ? localDate(declined.outcomeAt, tester.timeZone) : undefined;
      if (asked_by === "coach" && declinedOn && addDays(declinedOn, DECLINE_QUIET_DAYS) > state.today) {
        return { ok: false, error: `They declined this on ${declinedOn}: not again before ${addDays(declinedOn, DECLINE_QUIET_DAYS)}.` };
      }
      const [row] = await db
        .insert(suggestions)
        .values({ testerId: tester.id, goalSlug, kind, raisedBy: asked_by, proposal, reasoning, newGoalSlug: new_goal ?? null, createdAt: at })
        .returning();
      const topic = asked_by === "tester" && kind === "new_focus" ? "new_goal_request" : "next_step";
      const who = asked_by === "tester" ? "They asked" : "ZOH suggests";
      await raiseAlert(db, { testerId: tester.id, topic, key: `suggestion:${row!.id}`, body: `${who} (${kind}): ${proposal}`, suggestionId: row!.id, at });
      if (unsure) {
        await raiseAlert(db, { testerId: tester.id, topic: "coach_unsure", key: `unsure:${row!.id}`, body: unsure, suggestionId: row!.id, at });
      }
      const say =
        asked_by === "tester"
          ? 'Tell them warmly you\'ll think on it ("Love that. Let me think on it."), and promise nothing.'
          : "Say nothing about it to them until the team approves it.";
      return saved(tester, `Saved for the team, waiting for their OK. ${say}`);
    }

    case "record_next_step": {
      const { suggestion: ref, outcome } = input as z.infer<typeof schemas.record_next_step>;
      const found = findSuggestion(state.suggestions, ref);
      if (!found || !(readyToRaise(found) || awaitingAnswer(found))) {
        return { ok: false, error: `No approved next step ${ref}. Never raise a next step the team hasn't approved.` };
      }
      if (outcome === "delivered") {
        await db.update(suggestions).set({ outcome: "delivered", deliveredAt: found.deliveredAt ?? at, updatedAt: at }).where(eq(suggestions.id, found.id));
        return saved(tester, "Noted as raised. Their yes: change_plan or switch_goal with it. Their no: record_next_step declined.");
      }
      await db
        .update(suggestions)
        .set({ outcome: "declined", deliveredAt: found.deliveredAt ?? at, outcomeAt: at, updatedAt: at })
        .where(eq(suggestions.id, found.id));
      return saved(tester, "Declined: nothing changes, and it isn't raised again for at least a week. Take it lightly.");
    }

    case "record_checkin": {
      const { goal: slug, answer } = input as z.infer<typeof schemas.record_checkin>;
      const goal = state.testerGoals.find((g) => g.goalSlug === slug && g.role === "maintenance");
      if (!goal) {
        const maintenance = state.testerGoals.filter((g) => g.role === "maintenance").map((g) => g.goalSlug);
        return { ok: false, error: maintenance.length ? `Not a maintenance goal. Theirs: ${maintenance.join(", ")}` : "They have no maintenance goals." };
      }
      const rows = state.checkins.filter((c) => c.goalSlug === slug);
      if (answer === "asked") {
        await db.insert(maintenanceCheckins).values({ testerId: tester.id, goalSlug: slug, date: state.today, createdAt: at });
        return saved(tester, "Noted as asked. Record their answer when it comes.");
      }
      // Their answer goes on the latest open ask from the past week, or stands on its own today.
      const open = rows.findLast((c) => c.answer === null && c.date > addDays(state.today, -7));
      if (open) {
        await db.update(maintenanceCheckins).set({ answer, answeredAt: at }).where(eq(maintenanceCheckins.id, open.id));
      } else {
        await db.insert(maintenanceCheckins).values({ testerId: tester.id, goalSlug: slug, date: state.today, answer, answeredAt: at, createdAt: at });
      }
      const after = await db
        .select()
        .from(maintenanceCheckins)
        .where(and(eq(maintenanceCheckins.testerId, tester.id), eq(maintenanceCheckins.goalSlug, slug)))
        .orderBy(asc(maintenanceCheckins.date), asc(maintenanceCheckins.createdAt));
      if (answer === "stopped" && stoppedTwice(after)) {
        const latest = after.findLast((c) => c.answer === "stopped")!;
        const title = state.goals.find((g) => g.slug === slug)?.title ?? slug;
        await raiseAlert(db, {
          testerId: tester.id,
          topic: "maintenance_stopped",
          key: `maintenance_stopped:${latest.id}`,
          body: `Said they stopped ${title} twice in a row: make it the focus again?`,
          at,
        });
      }
      const said = { kept_up: "kept up", mostly: "mostly kept up (counts as kept up)", stopped: "stopped" }[answer];
      return saved(tester, `Saved: ${said}.${answer === "stopped" ? " No push: the team decides what's next." : ""}`);
    }

    case "mark_step_done": {
      const { how, proof, seen, note, day, dated } = input as z.infer<typeof schemas.mark_step_done>;
      const plan = state.plan;
      if (tester.phase !== "active" || !plan) return { ok: false, error: "No locked plan yet." };
      const status = how === "full" ? "done" : "done_reduced";
      const values: DayValues = { status, note: note || null, proofVerdict: proof, proofSeen: seen, proofPendingAt: null };
      const marked = how === "full" ? "done" : "done, reduced";
      if (day === "yesterday") {
        const yesterday = addDays(state.today, -1);
        if (!dated) return { ok: false, error: "Yesterday needs dated: the date you can see on the proof." };
        if (state.proof.latest === 0) return { ok: false, error: "No photo, screenshot or voice note in their latest texts: nothing proves yesterday." };
        if (!isStepDay(plan, yesterday)) return { ok: false, error: "Yesterday wasn't a step day." };
        const [row] = await db
          .select()
          .from(stepDays)
          .where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, yesterday)));
        if (row?.status && row.status !== "missed") return { ok: false, error: `Yesterday is already ${row.status}.` };
        await saveDay(db, state, yesterday, { ...values, proofSeen: `${seen} (dated ${dated})` }, at);
        await alertMilestone(db, state, yesterday, at);
        return saved(tester, `Yesterday (${yesterday}) marked ${marked}. Today is unchanged. ${await streakNow(db, state)}`);
      }
      if (state.proof.today === 0) {
        return { ok: false, error: "No photo, screenshot or voice note from them today: words alone don't mark it done. Ask for the proof." };
      }
      await saveDay(db, state, state.today, values, at);
      await alertMilestone(db, state, state.today, at);
      return saved(tester, `Today (${state.today}) marked ${marked}. ${await streakNow(db, state)} No more texts from you today unless they write.`);
    }

    case "proof_unclear": {
      const { verdict, seen } = input as z.infer<typeof schemas.proof_unclear>;
      if (tester.phase !== "active" || !state.plan) return { ok: false, error: "No locked plan yet." };
      if (state.todayRow?.status && state.todayRow.status !== "missed") return { ok: false, error: `Today is already ${state.todayRow.status}.` };
      await saveDay(db, state, state.today, { proofVerdict: verdict, proofSeen: seen, proofPendingAt: at }, at);
      return saved(tester, "Noted. Today's check-ins are held while you sort out the proof.");
    }

    case "mark_missed": {
      const { note } = input as z.infer<typeof schemas.mark_missed>;
      const plan = state.plan;
      if (tester.phase !== "active" || !plan) return { ok: false, error: "No locked plan yet." };
      if (!isStepDay(plan, state.today, state.todayRow)) return { ok: false, error: "Today isn't a step day: nothing to miss." };
      if (state.todayRow?.status === "done" || state.todayRow?.status === "done_reduced") {
        return { ok: false, error: "Today is already done." };
      }
      await saveDay(db, state, state.today, { status: "missed", note: note || null, proofPendingAt: null }, at);
      await alertSecondMiss(db, tester.id, plan.goalSlug, state.today, at);
      return saved(tester, `Today (${state.today}) marked missed. Proof later today still makes it done.`);
    }

    case "flag_proof_pattern": {
      const { reason } = input as z.infer<typeof schemas.flag_proof_pattern>;
      await saveFlag(db, tester.id, PROOF_PATTERN_FLAG, reason);
      return saved(tester, "Saved for the founders. Say nothing about it to them.");
    }

    case "mark_on_it": {
      if (tester.phase !== "active" || !state.plan) return { ok: false, error: "No locked plan yet." };
      await saveToday(db, state, { onItAt: at }, at);
      return saved(tester, "Noted they're on it: today's check-in is skipped.");
    }

    case "move_today": {
      const { time } = input as z.infer<typeof schemas.move_today>;
      const plan = state.plan;
      if (tester.phase !== "active" || !plan) return { ok: false, error: "No locked plan yet." };
      if (!isStepDay(plan, state.today) && plan.startDate !== state.today) {
        return { ok: false, error: "Today isn't a step day: nothing to move." };
      }
      await saveToday(db, state, { movedTime: time }, at);
      return saved(tester, `Today's step moved to ${time} (today only; the plan keeps ${plan.stepTime}).`);
    }

    case "mark_request_done": {
      const { request: ref } = input as z.infer<typeof schemas.mark_request_done>;
      const found = findRequest(state.teamRequests, ref);
      if (!found) return { ok: false, error: `No open team request ${ref}.` };
      await closeRequest(db, { request: found, status: "done", at, line: doneLine(found.body, "in a reply", at) });
      return saved(tester, "Marked done. Nothing has been sent yet: your text to them now answers what they said and carries it.");
    }
  }
}

/** The streak after a day was marked, as a number to say as is (spec #46: today counted once). */
async function streakNow(db: Db, state: CoachState): Promise<string> {
  const { streak, streakThrough } = await loadDaySummary(db, state.tester.id, state.plan!.goalSlug, state.today);
  const today = streakThrough === state.today ? ", today included" : "";
  return `Streak now: ${streak} step day${streak === 1 ? "" : "s"}${today}.`;
}

/** Whether making `slug` the focus, with the old focus kept as maintenance, stays within the goal cap. */
export function fitsGoalCap(state: Pick<CoachState, "testerGoals" | "goalCap">, slug: string): boolean {
  const live = state.testerGoals.filter((g) => g.role === "focus" || g.role === "maintenance");
  return live.length + (live.some((g) => g.goalSlug === slug) ? 0 : 1) <= state.goalCap;
}

/** A focus streak that just reached a milestone raises one alert per run (rule 9: focus only). */
async function alertMilestone(db: Db, state: CoachState, date: string, at: Date): Promise<void> {
  const goalSlug = state.plan!.goalSlug;
  const { current } = await goalMetrics(db, state.tester.id, goalSlug, date);
  if (!current || current.to !== date || !(MILESTONES as readonly number[]).includes(current.length)) return;
  const title = state.goal?.title ?? goalSlug;
  await raiseAlert(db, {
    testerId: state.tester.id,
    topic: "milestone",
    key: `milestone:${state.tester.id}:${goalSlug}:${current.from}:${current.length}`,
    body: `${current.length} step days in a row on ${title}`,
    at,
  });
}

/** A focus step day closed as missed that makes two in a row: one alert for the founders. */
export async function alertSecondMiss(db: Db, testerId: string, goalSlug: string, date: string, at: Date): Promise<void> {
  const { missesInARow } = await loadDaySummary(db, testerId, goalSlug, date);
  if (missesInARow !== 2) return;
  await raiseAlert(db, { testerId, topic: "second_miss", key: `second_miss:${testerId}:${date}`, body: `Second missed step day in a row (${date})`, at });
}

/** Every locked version waits for a founder look: one console alert each. */
async function alertPlanReview(db: Db, tester: Tester, planId: string, version: number, at: Date): Promise<void> {
  await raiseAlert(db, { testerId: tester.id, topic: "plan_review", key: `plan_review:${planId}`, body: `Plan version ${version} to review`, planId, at });
}

type DayValues = Partial<Pick<NewStepDay, "status" | "note" | "movedTime" | "onItAt" | "proofVerdict" | "proofSeen" | "proofPendingAt">>;

/** Creates or updates the tester's row for today's step. */
function saveToday(db: Db, state: CoachState, values: DayValues, at: Date): Promise<void> {
  return saveDay(db, state, state.today, values, at);
}

/** Creates or updates the tester's row for one local day (today, or yesterday with dated proof). */
async function saveDay(db: Db, state: CoachState, date: string, values: DayValues, at: Date): Promise<void> {
  const set = { ...values, planId: state.plan?.id ?? null, updatedAt: at };
  await db
    .insert(stepDays)
    .values({ testerId: state.tester.id, date, ...set })
    .onConflictDoUpdate({ target: [stepDays.testerId, stepDays.date], set });
}

type PlanFieldsInput = z.infer<typeof schemas.propose_plan>;
type PlanValues = Pick<Plan, "setupStep" | "step" | "place" | "stepTime" | "days" | "proof" | "proofNote" | "reason" | "minutes">;

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
    minutes: input.minutes ?? base?.minutes ?? null,
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
    p.minutes != null && `takes ${p.minutes} min`,
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
