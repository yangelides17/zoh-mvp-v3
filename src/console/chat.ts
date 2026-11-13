import type { AppEnv } from "../testers/env.js";
import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { toClaudeMessages, type ClaudeModel, type Turn } from "../claude/replier.js";
import { COACH_HISTORY_CAP } from "../coach/coach.js";
import { buildStateBlock } from "../coach/prompt.js";
import { loadCoachState, localTime } from "../coach/state.js";
import { loadVoiceDoc } from "../coach/voice.js";
import type { Db } from "../db/client.js";
import {
  consoleMessages,
  MIN_DAYS_PER_WEEK,
  nudges,
  PLAN_ADJUST,
  plans,
  PROOF_METHODS,
  stepDays,
  SUGGESTION_KINDS,
  testers,
  WEEKDAYS,
  type ConsoleMessage,
  type Message,
  type Plan,
  type PlanChanges,
  type RequestDelivery,
  type StepDayStatus,
  type Tester,
} from "../db/schema.js";
import { awaitingAnswer as raisedAwaiting, findSuggestion, readyToRaise, suggestionRef } from "../coach/next-steps.js";
import { mediaKind } from "../media/storage.js";
import { MEMORY_TOOL_DEFINITIONS, runMemoryTool, type LookupBudget } from "../memory/coach-tools.js";
import { coachHistory, memoryBlock, usesMemory } from "../memory/context.js";
import { messageTime } from "../memory/store.js";
import { addDays, dayBounds, isStepDay, KICKOFF_WINDOW_MS, localClock, quietNow, quietOn, serviceDate, zonedTime, type QuietClock } from "../nudges/schedule.js";
import { withDaySteps } from "../nudges/quiet.js";
import { activePause } from "../testers/pauses.js";
import { goalTitles } from "./data.js";
import { addRequest, addThreadLine, APP_AUTHOR, awaitingAnswer, cancelRequest, COACH_AUTHOR, findRequest, founderTime, openRequests, requestRef } from "./requests.js";
import { cancelDraft, createDraft, draftRef, findDraft, openDrafts } from "./drafts.js";
import { addFounderSuggestion, decideSuggestion, listSuggestions, SuggestionError, withdrawSuggestion, type Decision } from "./suggestions.js";

/**
 * The console chat's coach (spec: GitHub issue "Founder console", 4): the same model, voice page,
 * memory and state as the texting coach, answering the founders about one tester. Everything it can
 * do is a capability below (rule 6): pausing, scheduling or plan edits later are one more entry.
 */

/** Claude calls per answer; the last can't use tools. */
export const CONSOLE_MAX_ROUNDS = 4;
/** Thread lines it reads back, newest kept. */
export const THREAD_SHOWN = 60;
export const CONSOLE_MAX_TOKENS = 2000;

export const CONSOLE_INSTRUCTIONS = `You are ZOH, the texting coach, in the founders' console. The founders (Yanni and Stamati) are asking you about one tester, giving context, or asking you to reach them. You're their go-between with the tester. The tester never sees this chat. Below: your voice page (how you text testers), then what you see when you text this tester: state, memory, recent texts, the team's open requests and your open drafts.

Answering the founders:
- Plain and short: a line or two (a few for a real question). No markdown.
- About the tester: only what the record below shows (texts, step log, memory; open_pages and search_memory for more). If it isn't there, say you don't know. Never guess. Count misses and streaks from the state, never estimate them.
- Anything you'd do for them is a draft: your tool puts a card on their screen saying exactly what will happen, and nothing happens until a founder clicks Do it or tells you yes (then confirm_draft, the newest draft unless they name one). Say in a line what it'll do; never say it's done until confirm_draft says so. They want it different: a new draft with replaces = the old one's id.
- Context for how to coach them ("traveling next week, go easy"): save_note.
- Something to bring to the tester in your words (a suggestion, a link, a question): plan_request. When it goes is the founders' call: "naturally" or nothing said rides your next fitting text; "with the morning text" waits for it; "now", "asap" or a time ("tonight at 7") is its own text (own_text): never in quiet hours, counts toward 3 unanswered, dropped if it can't go out that day. Something tied to a time NEXT CHANCE can't reach in time: say so and offer its own text.
- Their own words sent as written ("send her exactly…", "text him: …"): send_text, copied exactly, never reworded or judged; even_in_quiet_hours only if they say to send it now anyway.
- A request in your words that breaks your voice (insults, shame, guilt, pressure, a lie, telling them the founders said it): don't draft it. Say why in a line and offer a version that fits.
- A different time, place, days, proof or length for their plan: propose_plan_change. You'll ask the tester; it changes only on their yes.
- A next step they want (deepen, upgrade, a new focus): suggest_next_step once the goal and kind are clear (ask in a line if not).
- Deciding a next step waiting for them ("reject it", "approve that"): decide_suggestion.
- "Cancel that": cancel. Already raised with the tester: take_back.
- They've stopped: answer questions, but nothing can be sent.`;

/** What one capability gets: the tester, who's asking, and the clock. */
export interface CapabilityContext {
  db: Db;
  tester: Tester;
  /** The founder whose message this answers, or who clicked Do it. */
  founder: string;
  now: Date;
  /** Requests still pending, for cancel. */
  open: ConsoleMessage[];
  budget: LookupBudget;
}

/** What a capability would do (#155): a line for the draft card, and the doing, run only once a founder confirms. */
export interface Prepared {
  summary: string;
  apply(): Promise<string>;
}

export interface Capability {
  tool: Anthropic.Tool;
  /** Checks the input against things as they stand now; throw a `CapabilityError` to hand the model (or the card) why not. */
  prepare(ctx: CapabilityContext, input: unknown): Promise<Prepared>;
}

export class CapabilityError extends Error {}

const text = (max: number) => z.string().trim().min(1).max(max);
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new CapabilityError(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  return parsed.data;
};
const localStamp = z.string().regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/, 'use "YYYY-MM-DD HH:MM"');
const stopped = (t: Tester, what = "nothing can be sent to them") => {
  if (t.stoppedAt) throw new CapabilityError(`They texted stop: ${what}. Tell the founders.`);
};
/** A time the founders named that has passed by the time it's confirmed (#155): never sent late. */
const notPast = (when: Date | undefined, now: Date) => {
  if (when && when.getTime() < now.getTime() - 60_000) throw new CapabilityError("That time has passed. Ask the founders for a new one.");
};
const theirs = (d: Date, t: Tester) => `${localTime(d, t.timeZone)} their time`;
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const nameOf = (t: Tester) => t.name ?? "them";

/** Everything the console coach can do: each one is drafted, and happens only once a founder confirms it (#155). */
export const CAPABILITIES: Record<string, Capability> = {
  save_note: {
    tool: {
      name: "save_note",
      description: "Draft a note of the founders' context about this tester (travel, an injury, \"go easy this week\"). Once confirmed, the texting coach reads it from then on and never quotes it.",
      input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    },
    async prepare(ctx, input) {
      const { note } = parse(z.object({ note: text(500) }).strict(), input);
      return {
        summary: `Save a note for ZOH (it reads it from now on, never quotes it): "${note}"`,
        apply: async () => {
          await addThreadLine(ctx.db, { testerId: ctx.tester.id, kind: "note", author: ctx.founder, body: note, at: ctx.now });
          return "Note saved.";
        },
      };
    },
  },
  plan_request: {
    tool: {
      name: "plan_request",
      description:
        'Draft something to bring to the tester in your own words: what to do, specific enough for the texting coach (a suggestion, a link as is, a question). when, as agreed with the founders: naturally (default: the morning text or your next reply), morning (only the morning text), own_text (its own text, a manual nudge; at: when, or now). at: their local "YYYY-MM-DD HH:MM" (own_text: when it goes; otherwise not before then). too_late_after: their local time after which it\'s dropped instead of sent late.',
      input_schema: {
        type: "object",
        properties: {
          what: { type: "string" },
          when: { type: "string", enum: ["naturally", "morning", "own_text"] },
          at: { type: "string" },
          too_late_after: { type: "string" },
        },
        required: ["what"],
      },
    },
    async prepare(ctx, input) {
      const { what, when = "naturally", at, too_late_after } = parse(
        z.object({ what: text(1000), when: z.enum(["naturally", "morning", "own_text"]).optional(), at: localStamp.optional(), too_late_after: localStamp.optional() }).strict(),
        input,
      );
      const t = ctx.tester;
      stopped(t);
      const delivery = when === "naturally" ? "natural" : when;
      if (delivery === "morning" && t.phase !== "active") throw new CapabilityError(`They're in ${t.phase}: no morning texts yet. Use naturally (your next reply) or own_text.`);
      const asked = at ? zoned(at, t.timeZone) : undefined;
      notPast(asked, ctx.now);
      const dueAt = delivery === "own_text" ? new Date(Math.max(asked?.getTime() ?? 0, ctx.now.getTime())) : asked;
      // #48: quiet hours that day, fitted around its step.
      const clock = await withDaySteps(ctx.db, t, ctx.now);
      if (delivery === "own_text" && quietNow(dueAt!, clock)) {
        const q = quietOn(serviceDate(dueAt!, clock), clock);
        throw new CapabilityError(
          `That's inside their quiet hours (${q.start} to ${q.end} their time): your own texts never go then. Offer ${localClock(new Date(nextMorning(dueAt!, clock)), t.timeZone)} their time, or send_text with even_in_quiet_hours if the founders want their own words sent now.`,
        );
      }
      // Its own text is about that day: by default, too late once their day ends (quiet hours start).
      const expiresAt = too_late_after ? zoned(too_late_after, t.timeZone) : delivery === "own_text" ? new Date(dayBounds(serviceDate(dueAt!, clock), clock).end) : undefined;
      if (expiresAt && expiresAt <= (dueAt ?? ctx.now)) throw new CapabilityError("too_late_after has to be after it can go out.");
      const until = expiresAt ? ` Dropped if it can't go out by ${theirs(expiresAt, t)}.` : "";
      const where =
        delivery === "own_text"
          ? `as its own text, ${dueAt!.getTime() <= ctx.now.getTime() + 60_000 ? "within a minute of Do it" : `at ${theirs(dueAt!, t)}`}`
          : `${delivery === "morning" ? "with the morning text" : "in its next text to them that fits"}${dueAt ? `, not before ${theirs(dueAt, t)}` : ""}`;
      return {
        summary: `ZOH brings this up with ${nameOf(t)} in its own words, ${where}: ${what}.${until}`,
        apply: async () => {
          const row = await addRequest(ctx.db, { testerId: t.id, author: ctx.founder, body: what, exact: false, sendNow: false, dueAt, delivery, expiresAt, at: ctx.now });
          return `Queued [${requestRef(row.id)}] ${where}.`;
        },
      };
    },
  },
  send_text: {
    tool: {
      name: "send_text",
      description:
        'Draft a text in the founders\' exact words, sent as ZOH word for word (copy their words exactly; never reword them). at: their local "YYYY-MM-DD HH:MM" (default: right away). even_in_quiet_hours: only when the founders say to send it now even though it\'s late or early for them. Never past a stop or 3 unanswered texts; dropped at the end of that day if it couldn\'t go out.',
      input_schema: {
        type: "object",
        properties: { words: { type: "string" }, at: { type: "string" }, even_in_quiet_hours: { type: "boolean" } },
        required: ["words"],
      },
    },
    async prepare(ctx, input) {
      const { words, at, even_in_quiet_hours = false } = parse(z.object({ words: text(1000), at: localStamp.optional(), even_in_quiet_hours: z.boolean().optional() }).strict(), input);
      const t = ctx.tester;
      stopped(t);
      const asked = at ? zoned(at, t.timeZone) : undefined;
      notPast(asked, ctx.now);
      const due = asked && asked > ctx.now ? asked : ctx.now;
      const clock = await withDaySteps(ctx.db, t, ctx.now);
      const quiet = quietNow(due, clock);
      // It goes when it's due, or when their quiet hours end; too late once that day ends.
      const first = quiet && !even_in_quiet_hours ? new Date(nextMorning(due, clock)) : due;
      const expiresAt = new Date(Math.max(dayBounds(serviceDate(first, clock), clock).end, first.getTime() + 3_600_000));
      const when =
        first.getTime() <= ctx.now.getTime() + 60_000
          ? `within a minute of Do it${quiet ? " (even in their quiet hours)" : ""}`
          : `${quiet && !even_in_quiet_hours ? "when their quiet hours end, " : ""}at ${theirs(first, t)}`;
      return {
        summary: `Text ${nameOf(t)} word for word, as ZOH, ${when}: "${words}"`,
        apply: async () => {
          const row = await addRequest(ctx.db, { testerId: t.id, author: ctx.founder, body: words, exact: true, sendNow: even_in_quiet_hours, dueAt: asked && asked > ctx.now ? asked : undefined, expiresAt, at: ctx.now });
          return `Queued word for word [${requestRef(row.id)}], ${when}, unless ZOH already has 3 texts they haven't answered.`;
        },
      };
    },
  },
  suggest_next_step: {
    tool: {
      name: "suggest_next_step",
      description:
        "Draft a next step the founders decided on for this tester (#63). Once confirmed it's approved by that founder; the texting coach brings it up as its own idea when it fits. goal: the goal it builds on (its name or slug). kind: deepen (more of the same habit; the streak carries on), upgrade (a harder or different version, incl. a different step; a new streak), new_focus (move the focus to another goal, named in new_goal). proposal: what to propose, in plain words. reasoning: their why, if they gave one. Only once the goal and kind are clear: ask the founders first if not. A different time, place, days, proof or length: propose_plan_change.",
      input_schema: {
        type: "object",
        properties: {
          goal: { type: "string" },
          kind: { type: "string", enum: [...SUGGESTION_KINDS] },
          proposal: { type: "string" },
          reasoning: { type: "string" },
          new_goal: { type: "string" },
        },
        required: ["goal", "kind", "proposal"],
      },
    },
    async prepare(ctx, input) {
      const { goal, kind, proposal, reasoning, new_goal } = parse(
        z.object({ goal: text(80), kind: z.enum(SUGGESTION_KINDS), proposal: text(1000), reasoning: text(500).optional(), new_goal: text(80).optional() }).strict(),
        input,
      );
      stopped(ctx.tester, "a next step can't reach them");
      const titles = await goalTitles(ctx.db);
      const find = (name: string) => {
        const wanted = name.trim().toLowerCase();
        return [...titles.values()].find((g) => g.slug.toLowerCase() === wanted || g.title.toLowerCase() === wanted);
      };
      const known = () => [...titles.values()].map((g) => `${g.slug} (${g.title})`).join(", ");
      const base = find(goal);
      if (!base) throw new CapabilityError(`No goal "${goal}". Goals: ${known()}.`);
      const next = new_goal ? find(new_goal) : undefined;
      if (kind === "new_focus" && !next) throw new CapabilityError(`A new focus needs new_goal, the goal to move to. Goals: ${known()}.`);
      return {
        summary: `File a next step for ${nameOf(ctx.tester)} (${kind.replace("_", " ")} on ${base.title}${next ? ` → ${next.title}` : ""}): "${proposal}". ZOH raises it as its own idea when it fits, and asks first.`,
        apply: async () => {
          const s = await addFounderSuggestion(ctx.db, { testerId: ctx.tester.id, goalSlug: base.slug, kind, proposal, reasoning, newGoalSlug: next?.slug, by: ctx.founder, at: ctx.now });
          return `Filed [${suggestionRef(s.id)}], approved by ${ctx.founder}.`;
        },
      };
    },
  },
  propose_plan_change: {
    tool: {
      name: "propose_plan_change",
      description:
        'Draft a change to the tester\'s plan for ZOH to ask them about: only what changes. time: their local 24-hour "HH:MM". days: step days (mon..sun). proof: photo, screenshot or voice (proof_note: which one). minutes: how long. why: the founders\' reason, if given. Nothing changes until the tester says yes; they can tweak it. A different step (more, harder, another activity): suggest_next_step.',
      input_schema: {
        type: "object",
        properties: {
          time: { type: "string" },
          place: { type: "string" },
          days: { type: "array", items: { type: "string", enum: [...WEEKDAYS] } },
          proof: { type: "string", enum: [...PROOF_METHODS] },
          proof_note: { type: "string" },
          minutes: { type: "integer" },
          why: { type: "string" },
        },
      },
    },
    async prepare(ctx, input) {
      const p = parse(
        z
          .object({
            time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour "HH:MM"').optional(),
            place: text(120).optional(),
            days: z.array(z.enum(WEEKDAYS)).min(MIN_DAYS_PER_WEEK, `at least ${MIN_DAYS_PER_WEEK} days`).optional(),
            proof: z.enum(PROOF_METHODS).optional(),
            proof_note: text(120).optional(),
            minutes: z.number().int().min(1).max(600).optional(),
            why: text(500).optional(),
          })
          .strict(),
        input,
      );
      const t = ctx.tester;
      stopped(t, "a plan change can't reach them");
      const [plan] = await ctx.db
        .select()
        .from(plans)
        .where(and(eq(plans.testerId, t.id), eq(plans.goalSlug, t.goalSlug ?? ""), eq(plans.status, "locked")))
        .orderBy(desc(plans.version))
        .limit(1);
      if (t.phase !== "active" || !plan) throw new CapabilityError("They have no locked plan yet: there's nothing to change. Tell the founders.");
      const changes: PlanChanges = {
        ...(p.time !== undefined ? { stepTime: p.time } : {}),
        ...(p.place !== undefined ? { place: p.place } : {}),
        ...(p.days !== undefined ? { days: p.days } : {}),
        ...(p.proof !== undefined ? { proof: p.proof } : {}),
        ...(p.proof_note !== undefined ? { proofNote: p.proof_note } : {}),
        ...(p.minutes !== undefined ? { minutes: p.minutes } : {}),
      };
      const keys = (Object.keys(changes) as (keyof PlanChanges)[]).filter((k) => JSON.stringify(changes[k]) !== JSON.stringify(plan[k]));
      if (!keys.length) throw new CapabilityError("That's their plan already: nothing would change.");
      const proposal = describeChanges(changes);
      const now = describeChanges(Object.fromEntries(keys.map((k) => [k, plan[k]])) as PlanChanges);
      return {
        summary: `Propose to ${nameOf(t)}: ${proposal} (now: ${now}). ZOH asks them first; nothing changes until they say yes, and they can tweak it.`,
        apply: async () => {
          const s = await addFounderSuggestion(ctx.db, { testerId: t.id, goalSlug: plan.goalSlug, kind: PLAN_ADJUST, proposal, reasoning: p.why, planChanges: changes, by: ctx.founder, at: ctx.now });
          return `Proposed [${suggestionRef(s.id)}]: ZOH raises it when it fits.`;
        },
      };
    },
  },
  decide_suggestion: {
    tool: {
      name: "decide_suggestion",
      description:
        "Draft the founders' decision on a next step waiting for them (by its id): approve, reject, or change (kind and proposal: what they want instead). reason: their why, if given. The same as the card's buttons, once confirmed.",
      input_schema: {
        type: "object",
        properties: {
          suggestion: { type: "string" },
          decision: { type: "string", enum: ["approve", "reject", "change"] },
          kind: { type: "string", enum: [...SUGGESTION_KINDS] },
          proposal: { type: "string" },
          reason: { type: "string" },
        },
        required: ["suggestion", "decision"],
      },
    },
    async prepare(ctx, input) {
      const d = parse(
        z
          .object({
            suggestion: text(40),
            decision: z.enum(["approve", "reject", "change"]),
            kind: z.enum(SUGGESTION_KINDS).optional(),
            proposal: text(1000).optional(),
            reason: text(500).optional(),
          })
          .strict(),
        input,
      );
      const s = findSuggestion(await listSuggestions(ctx.db, ctx.tester.id), d.suggestion);
      if (!s) throw new CapabilityError(`No next step ${d.suggestion} for this tester.`);
      if (s.decision !== "waiting") throw new CapabilityError(`Already ${s.decision}${s.decidedBy ? ` by ${s.decidedBy}` : ""}: nothing to decide.`);
      if (d.decision === "change" && (!d.kind || !d.proposal)) throw new CapabilityError("A change needs kind and proposal: what they want instead.");
      const why = d.reason ? ` (why: ${d.reason})` : "";
      const summary =
        d.decision === "approve"
          ? `Approve: ${s.proposal}${why}. ZOH raises it as its own idea.`
          : d.decision === "reject"
            ? `Reject: ${s.proposal}${why}. It never reaches ${nameOf(ctx.tester)}.`
            : `Change it to ${d.kind!.replace("_", " ")}: "${d.proposal}"${why}. ZOH raises that instead.`;
      return {
        summary,
        apply: async () => {
          const decision: Decision =
            d.decision === "approve"
              ? { decision: "approved", reason: d.reason }
              : d.decision === "reject"
                ? { decision: "rejected", reason: d.reason }
                : { decision: "changed", kind: d.kind!, proposal: d.proposal!, reason: d.reason };
          try {
            await decideSuggestion(ctx.db, { testerId: ctx.tester.id, suggestionId: s.id, by: ctx.founder, at: ctx.now, ...decision });
          } catch (err) {
            if (err instanceof SuggestionError) throw new CapabilityError(err.message);
            throw err;
          }
          return `${decision.decision[0]!.toUpperCase()}${decision.decision.slice(1)} by ${ctx.founder}.`;
        },
      };
    },
  },
  cancel: {
    tool: {
      name: "cancel",
      description: "Draft cancelling something not played out yet, by its id: an open request (OPEN REQUESTS) or a next step the founders approved that ZOH hasn't raised yet.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    async prepare(ctx, input) {
      const { id } = parse(z.object({ id: text(40) }).strict(), input);
      const request = findRequest(ctx.open, id);
      if (request) {
        return {
          summary: `Cancel: ${short(request.body)}. It won't go out.`,
          apply: async () => {
            if (!(await cancelRequest(ctx.db, { testerId: ctx.tester.id, requestId: request.id, at: ctx.now }))) throw new CapabilityError("It's no longer pending (it went out, or is going out now).");
            return `Cancelled [${requestRef(request.id)}].`;
          },
        };
      }
      const s = findSuggestion(await listSuggestions(ctx.db, ctx.tester.id), id);
      if (!s) throw new CapabilityError(`Nothing open with id ${id}.`);
      if (s.decision === "waiting") throw new CapabilityError("That one waits for the founders: decide_suggestion reject.");
      if (raisedAwaiting(s)) throw new CapabilityError("ZOH already raised it with them: use take_back, so they're told it's off.");
      if (!readyToRaise(s)) throw new CapabilityError(`It already played out (${s.outcome ?? s.decision}).`);
      return {
        summary: `Cancel: ${short(s.proposal)}. ZOH won't raise it.`,
        apply: async () => {
          if (!(await withdrawSuggestion(ctx.db, { testerId: ctx.tester.id, suggestionId: s.id, by: ctx.founder, at: ctx.now }))) throw new CapabilityError("It already played out.");
          return `Cancelled [${suggestionRef(s.id)}].`;
        },
      };
    },
  },
  take_back: {
    tool: {
      name: "take_back",
      description: "Draft taking back a next step or plan change ZOH already raised with them (by its id): it's withdrawn, and ZOH tells them in its next text, in its own words. say: what the founders want it to tell them (\"let's keep your evenings as they are\").",
      input_schema: { type: "object", properties: { suggestion: { type: "string" }, say: { type: "string" } }, required: ["suggestion"] },
    },
    async prepare(ctx, input) {
      const { suggestion, say } = parse(z.object({ suggestion: text(40), say: text(500).optional() }).strict(), input);
      stopped(ctx.tester);
      const s = findSuggestion(await listSuggestions(ctx.db, ctx.tester.id), suggestion);
      if (!s || !raisedAwaiting(s)) throw new CapabilityError(`No raised next step ${suggestion} waiting on their answer${s && readyToRaise(s) ? ": it isn't raised yet, so cancel it" : ""}.`);
      const tell = say ?? "never mind that idea for now";
      return {
        summary: `Take back: ${short(s.proposal)}. ZOH tells ${nameOf(ctx.tester)} in its next text, in its own words: ${tell}.`,
        apply: async () => {
          if (!(await withdrawSuggestion(ctx.db, { testerId: ctx.tester.id, suggestionId: s.id, by: ctx.founder, at: ctx.now }))) throw new CapabilityError("They already answered it.");
          await addRequest(ctx.db, { testerId: ctx.tester.id, author: ctx.founder, body: `Take back the idea you raised (${s.proposal}): ${tell}`, exact: false, sendNow: false, at: ctx.now });
          return "Taken back; ZOH tells them in its next text.";
        },
      };
    },
  },
};

/** A founder's plan change in plain words: "step at 7:30 am at the gym, on mon, wed, fri, proof by screenshot". */
function describeChanges(c: PlanChanges): string {
  const parts = [
    c.stepTime && `at ${ampm(c.stepTime)}`,
    c.place && `at ${c.place}`,
    c.days && `on ${c.days.join(", ")}`,
    c.minutes && `for ${c.minutes} min`,
    c.proof && `proof by ${c.proof}${c.proofNote ? ` (${c.proofNote})` : ""}`,
    !c.proof && c.proofNote && `proof: ${c.proofNote}`,
  ].filter(Boolean);
  return `step ${parts.join(", ")}`;
}

/** "07:30" → "7:30 am". */
function ampm(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * #155: does a draft, once a founder confirms it (Do it, or a typed yes). Exactly once: the draft flips
 * to confirmed and the capability runs in one transaction, re-checked against things as they are now.
 */
export async function confirmDraft(
  db: Db,
  opts: { testerId: string; draftId: string; founder: string; now: Date },
): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .update(consoleMessages)
      .set({ draftStatus: "confirmed" })
      .where(and(eq(consoleMessages.id, opts.draftId), eq(consoleMessages.testerId, opts.testerId), eq(consoleMessages.kind, "draft"), eq(consoleMessages.draftStatus, "draft")))
      .returning();
    if (!draft) {
      const [row] = await tx.select().from(consoleMessages).where(and(eq(consoleMessages.id, opts.draftId), eq(consoleMessages.testerId, opts.testerId)));
      return { ok: false as const, error: row?.draftStatus ? `Already ${row.draftStatus}${row.draftResult ? `: ${row.draftResult}` : ""}` : "No such draft" };
    }
    const capability = CAPABILITIES[draft.draftAction ?? ""];
    const [tester] = await tx.select().from(testers).where(eq(testers.id, opts.testerId));
    const fail = async (why: string) => {
      await tx.update(consoleMessages).set({ draftStatus: "failed", draftResult: why }).where(eq(consoleMessages.id, draft.id));
      return { ok: false as const, error: why };
    };
    if (!capability || !tester) return fail("It can't be done any more.");
    // A transaction has the same query API as the database (drizzle's PgTransaction); the cast only hides its rollback().
    const txDb = tx as unknown as Db;
    const ctx: CapabilityContext = { db: txDb, tester, founder: opts.founder, now: opts.now, open: await openRequests(txDb, tester.id), budget: { lookups: 0, searches: 0 } };
    try {
      const result = await (await capability.prepare(ctx, draft.draftInput)).apply();
      const done = `${result} (${opts.founder}, ${founderTime(opts.now)})`;
      await tx.update(consoleMessages).set({ draftResult: done }).where(eq(consoleMessages.id, draft.id));
      return { ok: true as const, result: done };
    } catch (err) {
      if (err instanceof CapabilityError) return fail(err.message);
      throw err;
    }
  });
}

/** Memory lookups, read-only: the console never saves preferences or forgets for a tester. */
const LOOKUPS = ["open_pages", "search_memory"];

export interface ConsoleCoach {
  /**
   * Answers the founders' latest message in a tester's thread, if it isn't answered yet, and
   * stores the answer there. One at a time per tester, so both founders' messages go in order.
   */
  answer(testerId: string, now: Date): Promise<ConsoleMessage | undefined>;
}

export interface ConsoleCoachOptions {
  db: Db;
  model: ClaudeModel;
  voice?: string;
  goalCap?: number;
}

export function createConsoleCoach(opts: ConsoleCoachOptions): ConsoleCoach {
  const { db, model, goalCap } = opts;
  const fixed = `${CONSOLE_INSTRUCTIONS}\n\nVOICE PAGE (how you text testers)\n${opts.voice ?? loadVoiceDoc()}`;
  const chains = new Map<string, Promise<unknown>>();

  async function answer(testerId: string, now: Date): Promise<ConsoleMessage | undefined> {
    const [tester] = await db.select().from(testers).where(eq(testers.id, testerId));
    if (!tester) return undefined;
    const thread = (await db.select().from(consoleMessages).where(eq(consoleMessages.testerId, testerId)).orderBy(asc(consoleMessages.createdAt))).slice(-THREAD_SHOWN);
    const lastFounder = awaitingAnswer(thread);
    if (!lastFounder) return undefined;

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const memory = usesMemory(tester) ? await memoryBlock(db, tester) : undefined;
    const tools = [
      ...Object.values(CAPABILITIES).map((c) => withReplaces(c.tool)),
      CONFIRM_TOOL,
      ...(memory ? MEMORY_TOOL_DEFINITIONS.filter((t) => LOOKUPS.includes(t.name)) : []),
    ];
    const messages = toClaudeMessages(thread.map(threadTurn));
    let fallback = "";
    for (let round = 1; round <= CONSOLE_MAX_ROUNDS; round++) {
      const last = round === CONSOLE_MAX_ROUNDS;
      const context = await recordBlock(db, tester, now, goalCap);
      const response = await model.create({
        system: [
          { type: "text", text: fixed, cache_control: { type: "ephemeral" } },
          ...(memory ? [{ type: "text" as const, text: memory }] : []),
          { type: "text", text: context },
        ],
        messages,
        tools,
        toolChoice: last ? "none" : "auto",
      });
      const reply = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const calls = response.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0 || last) {
        const body = reply || fallback || "Sorry, I couldn't answer that just now. Try again?";
        // After any draft this answer made (stamped `now`), so the card sits above the words about it.
        return addThreadLine(db, { testerId, kind: "coach", author: COACH_AUTHOR, body, at: new Date(Math.max(now.getTime() + 1, lastFounder.createdAt.getTime() + 1)) });
      }
      if (reply) fallback = reply;
      const ctx: CapabilityContext = { db, tester, founder: lastFounder.author ?? "Founder", now, open: await openRequests(db, testerId), budget };
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        results.push({ type: "tool_result", tool_use_id: call.id, ...(await runCapability(ctx, call.name, call.input, lastFounder.createdAt)) });
      }
      messages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
      messages.push({ role: "user", content: results });
    }
    return undefined;
  }

  return {
    answer(testerId, now) {
      const next = (chains.get(testerId) ?? Promise.resolve()).then(() => answer(testerId, now));
      const settled = next.catch(() => undefined);
      chains.set(testerId, settled);
      void settled.then(() => {
        if (chains.get(testerId) === settled) chains.delete(testerId);
      });
      return next;
    },
  };
}

/**
 * A founder's message from the chat box, for the console coach to answer (`needsAnswer`). #155: there's
 * no "send exactly this" box any more: their own words go out through a send_text draft.
 */
export async function postFounderMessage(
  db: Db,
  opts: {
    tester: Tester;
    founder: string;
    body: string;
    now: Date;
    /** Staging and production (#82): set when the other app owns this number, which this app never texts. */
    elsewhere?: AppEnv;
  },
): Promise<{ needsAnswer: boolean }> {
  const { tester, founder, body, now } = opts;
  await addThreadLine(db, { testerId: tester.id, kind: "founder", author: founder, body, at: now });
  if (!opts.elsewhere) return { needsAnswer: true };
  await addThreadLine(db, {
    testerId: tester.id,
    kind: "coach",
    author: APP_AUTHOR,
    body: `This number is on ${opts.elsewhere} right now, so this console can't text them. Use the ${opts.elsewhere} console, or have them text "env ${opts.elsewhere === "staging" ? "production" : "staging"}" first.`,
    at: new Date(now.getTime() + 1),
  });
  return { needsAnswer: false };
}

/** #155: every capability can replace a draft the founders asked to change (its id). */
function withReplaces(tool: Anthropic.Tool): Anthropic.Tool {
  const schema = tool.input_schema as { properties?: Record<string, unknown> };
  return {
    ...tool,
    input_schema: { ...tool.input_schema, properties: { ...schema.properties, replaces: { type: "string", description: "The id of an open draft this one replaces (the founders asked to change it)" } } },
  };
}

const CONFIRM_TOOL: Anthropic.Tool = {
  name: "confirm_draft",
  description: "Do a draft the founders just told you yes to (\"yes\", \"do it\", \"go ahead\"): the newest open draft, or the one by its id. Only on their clear yes, never on your own.",
  input_schema: { type: "object", properties: { draft: { type: "string" } } },
};

/**
 * Runs a lookup, drafts a capability (#155: nothing happens until a founder confirms), or confirms a
 * draft on the founder's typed yes. `askedAt`: the founder line this answers.
 */
async function runCapability(ctx: CapabilityContext, name: string, input: unknown, askedAt: Date): Promise<{ content: string; is_error?: boolean }> {
  try {
    if (LOOKUPS.includes(name)) {
      const result = await runMemoryTool(ctx.db, ctx.tester, name, input, { at: ctx.now, budget: ctx.budget });
      return result.ok ? { content: result.message } : { content: result.error, is_error: true };
    }
    if (name === CONFIRM_TOOL.name) return { content: await confirmTyped(ctx, input, askedAt) };
    const capability = CAPABILITIES[name];
    if (!capability) return { content: `Unknown tool "${name}"`, is_error: true };
    const { replaces, ...rest } = (input ?? {}) as Record<string, unknown>;
    const prepared = await capability.prepare(ctx, rest);
    if (typeof replaces === "string") {
      const old = await findDraft(ctx.db, ctx.tester.id, replaces);
      if (old && old.draftStatus !== "draft") throw new CapabilityError(`That draft was already ${old.draftStatus}${old.draftResult ? ` (${old.draftResult})` : ""}: tell the founders; offer a new one only if they still want it.`);
      if (old) await cancelDraft(ctx.db, { testerId: ctx.tester.id, draftId: old.id, by: ctx.founder });
    }
    const draft = await createDraft(ctx.db, { testerId: ctx.tester.id, author: ctx.founder, action: name, input: rest, summary: prepared.summary, at: ctx.now });
    return {
      content: `Draft [${draftRef(draft.id)}] is on their screen: "${prepared.summary}" Nothing has happened yet: it happens when a founder clicks Do it, or tells you yes (then confirm_draft). Tell them in a line what it'll do; never say it's done.`,
    };
  } catch (err) {
    if (err instanceof CapabilityError) return { content: err.message, is_error: true };
    throw err;
  }
}

/** A typed yes (#155): only for a draft made before the founder's latest line, so it can't confirm itself. */
async function confirmTyped(ctx: CapabilityContext, input: unknown, askedAt: Date): Promise<string> {
  const { draft: ref } = parse(z.object({ draft: text(40).optional() }).strict(), input);
  const open = await openDrafts(ctx.db, ctx.tester.id);
  const draft = ref ? await findDraft(ctx.db, ctx.tester.id, ref) : open.at(-1);
  if (!draft) throw new CapabilityError("No open draft to do.");
  if (draft.draftStatus !== "draft") throw new CapabilityError(`That draft was already ${draft.draftStatus}${draft.draftResult ? ` (${draft.draftResult})` : ""}.`);
  if (draft.createdAt >= askedAt) throw new CapabilityError("Not yet: a draft is done only once they say so, after seeing it. Tell them what it'll do and wait for their yes.");
  const done = await confirmDraft(ctx.db, { testerId: ctx.tester.id, draftId: draft.id, founder: ctx.founder, now: ctx.now });
  if (!done.ok) throw new CapabilityError(`Couldn't do it: ${done.error}. Tell the founders.`);
  return `Done: ${done.result} Tell them in a line.`;
}

/** A thread line as the console coach reads it: the founders and the record speak as "user", its own answers as "assistant". */
function threadTurn(m: ConsoleMessage): Turn {
  const at = founderTime(m.createdAt);
  switch (m.kind) {
    case "coach":
      // "Done" and "couldn't send" lines are the app's, not answers: the coach reads them as the record.
      return m.author === APP_AUTHOR ? { role: "user", text: `[${at}, app] ${m.body}` } : { role: "assistant", text: m.body };
    case "founder":
      return { role: "user", text: `${m.author ?? "Founder"} (${at}): ${m.body}` };
    case "note":
      return { role: "user", text: `[${at}, note saved for ${m.author ?? "the team"}] ${m.body}` };
    case "request":
      return { role: "user", text: `[${at}, request ${requestRef(m.id)} from ${m.author ?? "the team"}${m.exact ? ", word for word" : ""}, ${m.requestStatus}] ${m.body}` };
    case "alert":
      return { role: "user", text: `[${at}, alert: ${m.topic ?? "alert"}] ${m.body}${m.why ? ` (why: ${m.why})` : ""}` };
    case "summary":
      return { role: "user", text: `[${at}, weekly summary] ${m.body}` };
    case "draft":
      return { role: "user", text: `[${at}, your draft ${draftRef(m.id)} for ${m.author ?? "the team"}, ${m.draftStatus}${m.draftResult ? `: ${m.draftResult}` : ""}] ${m.body}` };
  }
}

/** What the console coach sees about the tester right now: the texting coach's state, recent texts, open requests and when ZOH can next reach them. */
async function recordBlock(db: Db, tester: Tester, now: Date, goalCap?: number): Promise<string> {
  const state = await loadCoachState(db, tester, { now, isFirstText: false, goalCap });
  const texts = await coachHistory(db, tester, now, COACH_HISTORY_CAP);
  const open = await openRequests(db, tester.id);
  // The record is rebuilt every round: a request this answer just queued is named as such, not as an earlier one.
  const requests = open.map(
    (r) =>
      `- [${requestRef(r.id)}] ${r.createdAt.getTime() === now.getTime() ? "you just queued it in this answer" : `from ${r.author ?? "the team"}`}${r.exact ? ", word for word" : `, ${DELIVERY_LABELS[r.delivery]}`}${r.dueAt ? `${r.delivery === "own_text" ? ", at" : ", not before"} ${localTime(r.dueAt, tester.timeZone)}` : ""}${r.expiresAt ? `, dropped after ${localTime(r.expiresAt, tester.timeZone)}` : ""}: ${r.body}`,
  );
  return [
    `THE TESTER (as the texting coach sees them; its instructions there are for texting, not for you)\n${buildStateBlock(state)}`,
    `RECENT TEXTS (oldest first, their local time)\n${texts.map((m) => textLine(m, tester)).join("\n") || "(none yet)"}`,
    ...(state.plan ? [`STEP LOG (their focus goal, one line per local day; count from this, never work dates out yourself)\n${await stepLog(db, tester, state.plan, state.today)}`] : []),
    `OPEN REQUESTS\n${requests.join("\n") || "(none)"}`,
    `YOUR OPEN DRAFTS (waiting for a founder's Do it or yes; newest last)\n${(await openDrafts(db, tester.id)).map((d) => `- [${draftRef(d.id)}] for ${d.author ?? "the team"}: ${d.body}`).join("\n") || "(none)"}`,
    `NEXT CHANCE to reach them: ${await nextChance(db, tester, now)}`,
    `Now: ${founderTime(now)} Eastern (founders), ${localTime(now, tester.timeZone)} their time.`,
  ].join("\n\n");
}

export const DELIVERY_LABELS: Record<RequestDelivery, string> = { natural: "naturally", morning: "with the morning text", own_text: "its own text" };

/** Days shown before and after today in the console's step log. */
export const STEP_LOG_PAST_DAYS = 14;
export const STEP_LOG_NEXT_DAYS = 7;

/**
 * The focus goal's days, oldest first: the last two weeks with how each went, today, and the
 * next week's step days. Dated with weekdays so the console coach reads counts and "tomorrow"
 * off the page (eval: it miscounted streaks and step days when it worked them out itself).
 */
export async function stepLog(db: Db, tester: Tester, plan: Plan, today: string): Promise<string> {
  const from = addDays(today, -STEP_LOG_PAST_DAYS);
  const rows = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), gte(stepDays.date, from), lte(stepDays.date, today)));
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const label = (date: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
  const lines: string[] = [];
  for (let i = -STEP_LOG_PAST_DAYS; i <= STEP_LOG_NEXT_DAYS; i++) {
    const date = addDays(today, i);
    const row = byDate.get(date);
    const step = isStepDay(plan, date, row);
    let status: string;
    if (plan.startDate && date < plan.startDate) {
      if (i > 0) continue;
      status = row?.status ? STEP_STATUS[row.status] : "before this plan";
    } else if (row?.status) status = STEP_STATUS[row.status];
    else if (!step) status = "rest day";
    else if (i < 0) status = "step day, nothing recorded";
    else if (i === 0) status = "step day, not done yet";
    else status = "step day";
    const time = step && i >= 0 ? ` at ${row?.movedTime ?? plan.stepTime}` : "";
    // #88: how hard the step was vs. the one before, when recorded.
    const own = row?.step ? `, step${row.stepKind ? ` (${row.stepKind})` : ""}: ${row.step}` : "";
    lines.push(`${label(date)}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : i === -1 ? " (yesterday)" : ""}: ${status}${time}${own}${row?.note ? ` (${row.note})` : ""}`);
  }
  return lines.join("\n");
}

const STEP_STATUS: Record<StepDayStatus, string> = { done: "done", done_reduced: "done (smaller version)", missed: "missed" };

function textLine(m: Message, tester: Tester): string {
  const who = m.direction === "inbound" ? "Them" : "ZOH";
  const parts: string[] = [];
  if (m.mediaUrl) {
    const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl);
    parts.push(kind === "audio" ? `[voice note${m.transcript ? `: ${m.transcript}` : ""}]` : kind === "image" ? `[photo${m.description ? `: ${m.description}` : ""}]` : `[${kind}]`);
  }
  if (m.content?.trim()) parts.push(m.content.trim());
  return `${localTime(messageTime(m), tester.timeZone)} ${who}: ${parts.join(" ")}`;
}

/**
 * When a request can next reach the tester, for the console coach's "what and when": the morning
 * text (once the plan is locked), or the reply to their next text, whichever comes first.
 */
export async function nextChance(db: Db, tester: Tester, now: Date): Promise<string> {
  if (tester.stoppedAt) return "never: they texted stop, so nothing is sent.";
  const pause = await activePause(db, tester.id);
  if (pause) {
    const until = pause.until ? `until the morning of ${pause.until}` : "until they say they're back";
    return `in your reply to their next text: they asked for a break, so ZOH starts no texts ${until}.`;
  }
  const reply = "or sooner, in your reply, if they text first";
  if (tester.phase !== "active") return `in your reply to their next text (they're in ${tester.phase}: no morning texts yet).`;
  const clock = await withDaySteps(db, tester, now);
  const today = serviceDate(now, clock);
  const [claimed] = await db
    .select({ id: nudges.id })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.date, today), eq(nudges.kind, "kickoff")));
  const start = dayBounds(today, clock).start;
  const quiet = quietNow(now, clock);
  if (!claimed && !quiet && now.getTime() >= start && now.getTime() < start + KICKOFF_WINDOW_MS) return `this morning's text, in the next few minutes, ${reply}.`;
  return `the morning text, ${localTime(new Date(nextMorning(now, clock)), tester.timeZone)} their time, ${reply}.`;
}

/** When their next day starts (its quiet hours end): today's if that's still ahead, otherwise tomorrow's. */
function nextMorning(at: Date, clock: QuietClock): number {
  const today = serviceDate(at, clock);
  const start = dayBounds(today, clock).start;
  return at.getTime() < start ? start : dayBounds(addDays(today, 1), clock).start;
}

/** Their local "YYYY-MM-DD HH:MM" as an instant. */
function zoned(local: string, timeZone: string): Date {
  const [date, time] = local.split(" ") as [string, string];
  return zonedTime(date, time, timeZone);
}
