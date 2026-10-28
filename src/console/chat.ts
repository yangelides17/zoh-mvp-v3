import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { toClaudeMessages, type ClaudeModel, type Turn } from "../claude/replier.js";
import { COACH_HISTORY_CAP } from "../coach/coach.js";
import { buildStateBlock } from "../coach/prompt.js";
import { insideQuietHours, loadCoachState, localTime } from "../coach/state.js";
import { loadVoiceDoc } from "../coach/voice.js";
import type { Db } from "../db/client.js";
import { consoleMessages, nudges, stepDays, testers, type ConsoleMessage, type Message, type Plan, type RequestDelivery, type StepDayStatus, type Tester } from "../db/schema.js";
import { mediaKind } from "../media/storage.js";
import { MEMORY_TOOL_DEFINITIONS, runMemoryTool, type LookupBudget } from "../memory/coach-tools.js";
import { coachHistory, memoryBlock, usesMemory } from "../memory/context.js";
import { messageTime } from "../memory/store.js";
import { addDays, dayBounds, isStepDay, KICKOFF_WINDOW_MS, localClock, serviceDate, zonedTime } from "../nudges/schedule.js";
import { addRequest, addThreadLine, APP_AUTHOR, awaitingAnswer, cancelRequest, COACH_AUTHOR, findRequest, founderTime, openRequests, requestRef } from "./requests.js";

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

export const CONSOLE_INSTRUCTIONS = `You are ZOH, the texting coach, in the founders' console. The founders (Yanni and Stamati) are asking you about one tester, giving context, or asking you to reach them. The tester never sees this chat. Below: your voice page (how you text testers), then what you see when you text this tester: state, memory, recent texts, and the team's open requests.

Answering the founders:
- Plain and short: a line or two (a few for a real question). No markdown.
- About the tester: only what the record below shows (texts, step log, memory; open_pages and search_memory for more). If it isn't there, say you don't know. Never guess.
- Context for how to coach them ("traveling next week, go easy"): save_note in plain words, then confirm in a line.
- Something to bring to the tester (a suggestion, a link, a question): plan_request, then confirm in one or two sentences: what you'll do and when, from NEXT CHANCE below ("Got it. I'll bring up a protein target in tomorrow's morning text, as my idea. I'll tell you how she takes it."). Links go in as is.
- When it goes is the founders' call: "naturally" or nothing said rides your next fitting text; "with the morning text" waits for it; "now", "asap" or a time ("tonight at 7") is its own text (own_text), under the usual rules: never in quiet hours, counts toward 3 unanswered, dropped with a note if it can't go out that day. Something tied to a time ("tonight's run") that NEXT CHANCE can't reach in time: say so and offer its own text. Confirm the actual day and time.
- Only what the record shows about their days, too: count misses and streaks from the state, never estimate them.
- A request that breaks your voice (insults, shame, guilt, pressure, a lie, telling them the founders said it): don't queue it. Say why in a line and offer a version that fits; queue that once they agree.
- "Cancel that": cancel_request.
- Only if they ask for their own words sent as written: they tick "Send exactly this" under the chat box.
- They've stopped: answer questions, but nothing can be sent.`;

/** What one capability gets: the tester, who's asking, and the clock. */
export interface CapabilityContext {
  db: Db;
  tester: Tester;
  /** The founder whose message this answers. */
  founder: string;
  now: Date;
  /** Requests still pending, for cancel. */
  open: ConsoleMessage[];
  budget: LookupBudget;
}

export interface Capability {
  tool: Anthropic.Tool;
  /** The result for the model; throw a `CapabilityError` to hand it an error instead. */
  run(ctx: CapabilityContext, input: unknown): Promise<string>;
}

export class CapabilityError extends Error {}

const text = (max: number) => z.string().trim().min(1).max(max);
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new CapabilityError(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  return parsed.data;
};

/** Everything the console coach can do. */
export const CAPABILITIES: Record<string, Capability> = {
  save_note: {
    tool: {
      name: "save_note",
      description: "Save the founders' context about this tester (travel, an injury, \"go easy this week\"). The texting coach reads it from now on and never quotes it.",
      input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    },
    async run(ctx, input) {
      const { note } = parse(z.object({ note: text(500) }).strict(), input);
      await addThreadLine(ctx.db, { testerId: ctx.tester.id, kind: "note", author: ctx.founder, body: note, at: ctx.now });
      return "Note saved: the texting coach reads it from now on (never quoted).";
    },
  },
  plan_request: {
    tool: {
      name: "plan_request",
      description:
        'Something to bring to the tester in your own words: what to do, specific enough for the texting coach (a suggestion, a link as is, a question). when, as agreed with the founders: naturally (default: the morning text or your next reply), morning (only the morning text), own_text (its own text, a manual nudge; at: when, or now). at: their local "YYYY-MM-DD HH:MM" (own_text: when it goes; otherwise not before then). too_late_after: their local time after which it\'s dropped instead of sent late.',
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
    async run(ctx, input) {
      const local = z.string().regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/, 'use "YYYY-MM-DD HH:MM"');
      const { what, when = "naturally", at, too_late_after } = parse(
        z.object({ what: text(1000), when: z.enum(["naturally", "morning", "own_text"]).optional(), at: local.optional(), too_late_after: local.optional() }).strict(),
        input,
      );
      const t = ctx.tester;
      if (t.stoppedAt) throw new CapabilityError("They texted stop: nothing can be sent to them. Tell the founders.");
      const delivery = when === "naturally" ? "natural" : when;
      if (delivery === "morning" && t.phase !== "active") throw new CapabilityError(`They're in ${t.phase}: no morning texts yet. Use naturally (your next reply) or own_text.`);
      const asked = at ? zoned(at, t.timeZone) : undefined;
      const dueAt = delivery === "own_text" ? new Date(Math.max(asked?.getTime() ?? 0, ctx.now.getTime())) : asked;
      if (delivery === "own_text" && insideQuietHours(localClock(dueAt!, t.timeZone), t)) {
        throw new CapabilityError(
          `That's inside their quiet hours (${t.quietHoursStart} to ${t.quietHoursEnd} their time): your own texts never go then. Offer ${t.quietHoursEnd} their time, or the founders' "Send exactly this" with "send now".`,
        );
      }
      // Its own text is about that day: by default, too late once their day ends (quiet hours start).
      const expiresAt = too_late_after ? zoned(too_late_after, t.timeZone) : delivery === "own_text" ? new Date(dayBounds(serviceDate(dueAt!, t), t).end) : undefined;
      if (expiresAt && expiresAt <= (dueAt ?? ctx.now)) throw new CapabilityError("too_late_after has to be after it can go out.");
      const row = await addRequest(ctx.db, { testerId: t.id, author: ctx.founder, body: what, exact: false, sendNow: false, dueAt, delivery, expiresAt, at: ctx.now });
      const theirs = (d: Date) => `${localTime(d, t.timeZone)} their time`;
      const until = expiresAt ? ` If it can't go out by ${theirs(expiresAt)} (quiet hours, 3 unanswered texts, a stop), it's dropped and the thread says so.` : "";
      const where =
        delivery === "own_text"
          ? `its own text, ${dueAt!.getTime() <= ctx.now.getTime() ? "within a minute (or in your reply if they're texting right now)" : `at ${theirs(dueAt!)}`}.`
          : `${delivery === "morning" ? "with the morning text" : "in your next text to them that fits"}${dueAt ? `, not before ${theirs(dueAt)}` : ""} (see NEXT CHANCE).`;
      return `Queued [${requestRef(row.id)}]: ${where}${until} The thread shows "Done" when it has. Tell the founders the actual time.`;
    },
  },
  cancel_request: {
    tool: {
      name: "cancel_request",
      description: "Cancel an open request (by its id from OPEN REQUESTS) the founders no longer want sent.",
      input_schema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
    },
    async run(ctx, input) {
      const { request } = parse(z.object({ request: text(40) }).strict(), input);
      const found = findRequest(ctx.open, request);
      if (!found) throw new CapabilityError(`No open request ${request}.`);
      await cancelRequest(ctx.db, { testerId: ctx.tester.id, requestId: found.id, at: ctx.now });
      return `Cancelled [${requestRef(found.id)}]: it won't be sent.`;
    },
  },
};

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
      ...Object.values(CAPABILITIES).map((c) => c.tool),
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
        return addThreadLine(db, { testerId, kind: "coach", author: COACH_AUTHOR, body, at: new Date(Math.max(now.getTime(), lastFounder.createdAt.getTime() + 1)) });
      }
      if (reply) fallback = reply;
      const ctx: CapabilityContext = { db, tester, founder: lastFounder.author ?? "Founder", now, open: await openRequests(db, testerId), budget };
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        results.push({ type: "tool_result", tool_use_id: call.id, ...(await runCapability(ctx, call.name, call.input)) });
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
 * A founder's message from the chat box. "Send exactly this" is queued word for word, with the
 * app's own confirmation (no Claude call: the words are theirs); anything else waits for the
 * console coach's answer (`needsAnswer`).
 */
export async function postFounderMessage(
  db: Db,
  opts: { tester: Tester; founder: string; body: string; exact: boolean; sendNow: boolean; now: Date },
): Promise<{ needsAnswer: boolean }> {
  const { tester, founder, body, now } = opts;
  if (!opts.exact) {
    await addThreadLine(db, { testerId: tester.id, kind: "founder", author: founder, body, at: now });
    return { needsAnswer: true };
  }
  const at = new Date(now.getTime() + 1);
  if (tester.stoppedAt) {
    await addRequest(db, { testerId: tester.id, author: founder, body, exact: true, sendNow: opts.sendNow, at: now, status: "cancelled" });
    await addThreadLine(db, { testerId: tester.id, kind: "coach", author: APP_AUTHOR, body: "They texted stop, so this won't be sent.", at });
    return { needsAnswer: false };
  }
  await addRequest(db, { testerId: tester.id, author: founder, body, exact: true, sendNow: opts.sendNow, at: now });
  const quiet = insideQuietHours(localClock(now, tester.timeZone), tester);
  const when = opts.sendNow || !quiet ? "within a minute" : `when their quiet hours end (${tester.quietHoursEnd} their time)`;
  await addThreadLine(db, {
    testerId: tester.id,
    kind: "coach",
    author: APP_AUTHOR,
    body: `Queued word for word: it goes out ${when}, unless ZOH already has 3 texts they haven't answered (then after they reply).`,
    at,
  });
  return { needsAnswer: false };
}

async function runCapability(ctx: CapabilityContext, name: string, input: unknown): Promise<{ content: string; is_error?: boolean }> {
  try {
    if (LOOKUPS.includes(name)) {
      const result = await runMemoryTool(ctx.db, ctx.tester, name, input, { at: ctx.now, budget: ctx.budget });
      return result.ok ? { content: result.message } : { content: result.error, is_error: true };
    }
    const capability = CAPABILITIES[name];
    if (!capability) return { content: `Unknown tool "${name}"`, is_error: true };
    return { content: await capability.run(ctx, input) };
  } catch (err) {
    if (err instanceof CapabilityError) return { content: err.message, is_error: true };
    throw err;
  }
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
    lines.push(`${label(date)}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : i === -1 ? " (yesterday)" : ""}: ${status}${time}${row?.note ? ` (${row.note})` : ""}`);
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
  const reply = "or sooner, in your reply, if they text first";
  if (tester.phase !== "active") return `in your reply to their next text (they're in ${tester.phase}: no morning texts yet).`;
  const today = serviceDate(now, tester);
  const [claimed] = await db
    .select({ id: nudges.id })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.date, today), eq(nudges.kind, "kickoff")));
  const start = dayBounds(today, tester).start;
  const quiet = insideQuietHours(localClock(now, tester.timeZone), tester);
  if (!claimed && !quiet && now.getTime() >= start && now.getTime() < start + KICKOFF_WINDOW_MS) return `this morning's text, in the next few minutes, ${reply}.`;
  const date = now.getTime() < start ? today : addDays(today, 1);
  return `the morning text, ${localTime(new Date(dayBounds(date, tester).start), tester.timeZone)} their time, ${reply}.`;
}

/** Their local "YYYY-MM-DD HH:MM" as an instant. */
function zoned(local: string, timeZone: string): Date {
  const [date, time] = local.split(" ") as [string, string];
  return zonedTime(date, time, timeZone);
}
