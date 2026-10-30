import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { ClaudeModel } from "../claude/replier.js";
import { localDate } from "../coach/state.js";
import { describePlan } from "../coach/tools.js";
import type { Db } from "../db/client.js";
import { consoleMessages, memoryPages, messages, plans, stepDays, takeaways, testers, type Plan, type Tester } from "../db/schema.js";
import { evidenceText, learnings } from "../coach/week.js";
import { safeError } from "../errors.js";
import { addDays, isStepDay, localClock } from "../nudges/schedule.js";
import { maskNumber, type Logger } from "../pipeline/inbound.js";
import { testerNow, isJumping } from "../testers/clock.js";
import { goalMetrics } from "../testers/goals.js";
import { suggestionsForCoach } from "./suggestions.js";

/**
 * The console's background work (spec: GitHub issue "Founder console", 6 and 7): a one-line why on
 * each alert, and each tester's weekly summary, Sunday 8 am Eastern. Checked once a minute; ticks
 * never overlap. Without Claude, summaries carry the numbers only and alerts go without a why.
 */

export const SUMMARY_ZONE = "America/New_York";
export const SUMMARY_DAY = "sun";
export const SUMMARY_AT = "08:00";
/** Alerts older than this never get a why (a backlog after downtime isn't worth the calls). */
export const WHY_WITHIN_MS = 2 * 86_400_000;
/** Whys per tick, so one tick stays quick. */
const WHY_BATCH = 5;
/** After a failed Claude call, that alert or summary waits this long before another try. */
const RETRY_AFTER_MS = 60 * 60_000;
const DEFAULT_TICK_MS = 60_000;
export const CONSOLE_JOB_MAX_TOKENS = 1500;

export const WHY_INSTRUCTIONS = `You help the two founders of ZOH, a texting coach, read their console. An alert just fired about one tester. Write one plain line (at most 25 words) on why it fired and what it likely means, from the texts and numbers below. Only what the record shows: if the cause isn't clear, say so. No preamble, no advice to text the tester.`;

export const SUMMARY_INSTRUCTIONS = `You write the weekly summary of one tester for the two founders of ZOH, a texting coach. From the week's record below, write three short lines, each starting with its label:
Did: what they actually did this week, specifically.
Notable: moments worth knowing (a struggle, a win, something new in their life), or "nothing stood out".
Next step: your read on whether they're ready for a next step (deepen or upgrade their plan) and why, in a sentence.
Only what the record shows; never invent. Plain words, no preamble.`;

export interface ConsoleJobsDeps {
  db: Db;
  log: Logger;
  /** A cheap model for whys and summaries; without it, summaries are numbers only. */
  model?: ClaudeModel;
  now?: () => Date;
}

export interface ConsoleJobs {
  tick(now?: Date): Promise<{ whys: number; summaries: number }>;
  /** One tester's weekly summary at `now` on their clock, if due (a jump, #14). True when one was written. */
  tickTester(tester: Tester, now: Date): Promise<boolean>;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

export function createConsoleJobs(deps: ConsoleJobsDeps): ConsoleJobs {
  const clock = deps.now ?? (() => new Date());
  const failedAt = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const waiting = (key: string, now: Date) => {
    const at = failedAt.get(key);
    return at !== undefined && now.getTime() - at < RETRY_AFTER_MS;
  };

  async function run(now: Date) {
    const whys = deps.model ? await writeWhys(now) : 0;
    const summaries = await writeSummaries(now);
    return { whys, summaries };
  }

  async function writeWhys(now: Date): Promise<number> {
    const rows = await deps.db
      .select({ alert: consoleMessages, tester: testers })
      .from(consoleMessages)
      .innerJoin(testers, eq(testers.id, consoleMessages.testerId))
      .where(and(eq(consoleMessages.kind, "alert"), isNull(consoleMessages.why), gte(consoleMessages.createdAt, new Date(now.getTime() - WHY_WITHIN_MS))))
      .orderBy(asc(consoleMessages.createdAt))
      .limit(WHY_BATCH * 2);
    let written = 0;
    for (const { alert, tester } of rows) {
      if (written >= WHY_BATCH) break;
      if (waiting(alert.id, now)) continue;
      try {
        const context = await testerContext(deps.db, tester, testerNow(tester, now));
        const why = await ask(deps.model!, WHY_INSTRUCTIONS, `Alert: ${alert.topic ?? "alert"}: ${alert.body}\n\n${context}`);
        await deps.db.update(consoleMessages).set({ why: why.slice(0, 300) }).where(eq(consoleMessages.id, alert.id));
        written += 1;
      } catch (err) {
        failedAt.set(alert.id, now.getTime());
        deps.log.warn({ contact: maskNumber(tester.phone), err: safeError(err) }, "Alert why failed");
      }
    }
    return written;
  }

  async function writeSummaries(now: Date): Promise<number> {
    const active = await deps.db.select().from(testers).where(eq(testers.phase, "active"));
    let written = 0;
    for (const tester of active) {
      // Mid-jump, the jump writes this tester's summary itself (#14).
      if (isJumping(tester.id)) continue;
      if (await summaryFor(tester, testerNow(tester, now))) written += 1;
    }
    if (written) deps.log.info({ written }, "Weekly summaries written");
    return written;
  }

  /** The tester's summary for the Sunday due at `now` on their clock, unless it's written. */
  async function summaryFor(tester: Tester, now: Date): Promise<boolean> {
    const sunday = summaryDate(now);
    if (!sunday) return false;
    const key = summaryKey(tester.id, sunday);
    if (waiting(key, now)) return false;
    const [exists] = await deps.db.select({ id: consoleMessages.id }).from(consoleMessages).where(eq(consoleMessages.eventKey, key));
    if (exists) return false;
    try {
      const body = await weeklySummary(deps.db, tester, sunday, now, deps.model);
      const rows = await deps.db
        .insert(consoleMessages)
        .values({ testerId: tester.id, kind: "summary", topic: "weekly_summary", eventKey: key, body, createdAt: now })
        .onConflictDoNothing({ target: consoleMessages.eventKey })
        .returning({ id: consoleMessages.id });
      return rows.length > 0;
    } catch (err) {
      failedAt.set(key, now.getTime());
      deps.log.warn({ contact: maskNumber(tester.phone), err: safeError(err) }, "Weekly summary failed");
      return false;
    }
  }

  return {
    tick(now = clock()) {
      const next = chain.then(() => run(now));
      chain = next.catch(() => undefined);
      return next;
    },
    tickTester(tester, now) {
      return summaryFor(tester, now);
    },
    start(intervalMs = DEFAULT_TICK_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void this.tick().catch((err: unknown) => deps.log.error({ err: safeError(err) }, "Console jobs tick failed"));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}

/** The Sunday (Eastern) whose summary is due: from 8 am to midnight that day; otherwise none. */
export function summaryDate(now: Date): string | undefined {
  const date = localDate(now, SUMMARY_ZONE);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: SUMMARY_ZONE, weekday: "short" }).format(now).toLowerCase();
  return weekday === SUMMARY_DAY && localClock(now, SUMMARY_ZONE) >= SUMMARY_AT ? date : undefined;
}

export const summaryKey = (testerId: string, sunday: string) => `summary:${testerId}:${sunday}`;

/** The plan version that applied on a local date: the newest locked one started by then and not yet ended. */
export function planOn(goalPlans: Plan[], date: string): Plan | undefined {
  return goalPlans
    .filter((p) => p.startDate && p.startDate <= date && (!p.endsOn || p.endsOn >= date))
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
}

export interface WeekNumbers {
  from: string;
  to: string;
  committed: number;
  done: number;
  reduced: number;
  streak: number;
  /** Where the current plan is headed, if anywhere (#78). */
  destination?: string;
  /** "Understood: …" and "Explained only: …" lines for the week, with evidence (#78). */
  learnings: string[];
}

/** The seven local days before `sunday`: step days committed and done on the focus goal, and the streak now. */
export async function weekNumbers(db: Db, tester: Tester, sunday: string): Promise<WeekNumbers> {
  const from = addDays(sunday, -7);
  const to = addDays(sunday, -1);
  const out: WeekNumbers = { from, to, committed: 0, done: 0, reduced: 0, streak: 0, learnings: [] };
  if (!tester.goalSlug) return out;
  const goalPlans = await db
    .select()
    .from(plans)
    .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, tester.goalSlug), eq(plans.status, "locked")));
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const committed = new Set(dates.filter((d) => {
    const plan = planOn(goalPlans, d);
    return plan && isStepDay(plan, d);
  }));
  const rows = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), inArray(stepDays.date, [...committed])));
  out.committed = committed.size;
  out.done = rows.filter((r) => r.status === "done" || r.status === "done_reduced").length;
  out.reduced = rows.filter((r) => r.status === "done_reduced").length;
  out.streak = (await goalMetrics(db, tester.id, tester.goalSlug, to)).current?.length ?? 0;
  const current = goalPlans.filter((p) => p.startDate && p.startDate <= to).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  if (current?.destination) out.destination = current.destination;
  // The same "understood" as the coach's Sunday look-back: applied or recalled this week.
  const lessons = await db
    .select()
    .from(takeaways)
    .where(and(eq(takeaways.testerId, tester.id), lte(takeaways.day, to)));
  const { understood, explained } = learnings(lessons, from);
  const each = (l: { text: string }, evidence: string) => `"${l.text}" (${evidence})`;
  if (understood.length) out.learnings.push(`Understood this week: ${understood.map((l) => each(l, evidenceText(l))).join("; ")}`);
  if (explained.length) out.learnings.push(`Explained only so far: ${explained.map((l) => each(l, evidenceText(l))).join("; ")}`);
  return out;
}

/** One tester's weekly summary: the numbers, then the coach's read of the week when Claude is set up. */
export async function weeklySummary(db: Db, tester: Tester, sunday: string, now: Date, model?: ClaudeModel): Promise<string> {
  const n = await weekNumbers(db, tester, sunday);
  const numbers = [
    `Week of ${n.from} to ${n.to}: ${n.done} of ${n.committed} step days done${n.reduced ? ` (${n.reduced} reduced)` : ""}`,
    `streak ${n.streak}`,
  ].join(", ");
  // Progress as understanding (#78): the destination and the week's learnings with their evidence.
  const progress = [`Headed for: ${n.destination ?? "no destination yet"}.`, ...(n.learnings.length ? n.learnings : ["No lessons applied or recalled this week."])].join("\n");
  const facts = `${numbers}.\n${progress}`;
  if (!model) return facts;
  const record = await weekRecord(db, tester, n);
  const read = await ask(model, SUMMARY_INSTRUCTIONS, `${facts}\n\n${record}\n\n${await testerContext(db, tester, now)}`);
  return `${facts}\n${read}`;
}

/** The week as the summary reads it: each day's step, and the memory pass's daily docs. */
async function weekRecord(db: Db, tester: Tester, n: WeekNumbers): Promise<string> {
  const days = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), gte(stepDays.date, n.from)))
    .orderBy(asc(stepDays.date));
  const docs = await db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, tester.id), eq(memoryPages.kind, "daily"), gte(memoryPages.date, n.from)))
    .orderBy(asc(memoryPages.date));
  const open = await suggestionsForCoach(db, tester.id);
  const lines = [
    "Step days:",
    ...days.filter((d) => d.date <= n.to).map((d) => `- ${d.date}: ${d.status ?? "open"}${d.step ? `, step: ${d.step}` : ""}${d.note ? `, ${d.note}` : ""}${d.proofSeen ? ` (proof: ${d.proofSeen})` : ""}`),
    "Daily notes:",
    ...docs.filter((d) => d.date! <= n.to).map((d) => `- ${d.date}: ${d.title}. ${d.summary} ${d.body}`.trim()),
  ];
  if (open.length) lines.push("Next steps already approved:", ...open.map((s) => `- ${s.decidedProposal ?? s.proposal}`));
  return lines.join("\n");
}

/** Who they are and their last texts, for a why or a summary. Names only; never their number. */
async function testerContext(db: Db, tester: Tester, now: Date): Promise<string> {
  const [plan] = tester.goalSlug
    ? await db
        .select()
        .from(plans)
        .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, tester.goalSlug), eq(plans.status, "locked")))
        .orderBy(desc(plans.version))
        .limit(1)
    : [];
  const streak = tester.goalSlug ? ((await goalMetrics(db, tester.id, tester.goalSlug, localDate(now, tester.timeZone))).current?.length ?? 0) : 0;
  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.contactNumber, tester.phone))
    .orderBy(desc(messages.createdAt))
    .limit(12);
  const texts = recent
    .reverse()
    .map((m) => `${m.direction === "inbound" ? "Them" : "ZOH"} (${m.createdAt.toISOString().slice(0, 16)}): ${m.content ?? m.transcript ?? m.description ?? "(media)"}`);
  return [
    `Tester: ${tester.name ?? "unnamed"}, ${tester.phase}${tester.stoppedAt ? ", stopped" : ""}`,
    plan ? `Plan v${plan.version}: ${describePlan(plan)}` : "No locked plan",
    `Focus streak: ${streak}`,
    "Last texts:",
    ...texts,
  ].join("\n");
}

async function ask(model: ClaudeModel, instructions: string, input: string): Promise<string> {
  const response = await model.create({ system: [{ type: "text", text: instructions }], messages: [{ role: "user", content: input }], tools: [] });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`Nothing came back (stop_reason: ${response.stopReason})`);
  return text;
}
