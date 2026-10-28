import { and, asc, count, desc, eq, gt, gte, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { Replier } from "../claude/replier.js";
import { COACH_HISTORY_CAP } from "../coach/coach.js";
import { approvedKind, dueCheckin, readyToRaise } from "../coach/next-steps.js";
import { loadCurrentPlan, loadRecentDays } from "../coach/state.js";
import { alertSecondMiss } from "../coach/tools.js";
import type { Db } from "../db/client.js";
import { insertOutbound } from "../db/messages.js";
import { coachHistory } from "../memory/context.js";
import { maintenanceCheckins, messages, nudges, stepDays, suggestions, testers, type Tester } from "../db/schema.js";
import { raiseAlert, saveFlag } from "../console/alerts.js";
import { loadCheckins, loadTesterGoals } from "../testers/goals.js";
import { safeError } from "../errors.js";
import { maskNumber, toTurns, type Logger } from "../pipeline/inbound.js";
import type { SendblueClient } from "../sendblue/client.js";
import { updateTester } from "../testers/testers.js";
import { summarizeDays } from "./streak.js";
import {
  addDays,
  CARRYING_MOMENTS,
  daysToClose,
  dueNudge,
  serviceDate,
  zonedTime,
  type DueNudge,
  type NudgeCarry,
  type NudgeDecision,
} from "./schedule.js";

export const WENT_QUIET_FLAG = "went_quiet";
export const DEFAULT_TICK_MS = 60_000;
/** Whole local days without a text from them before the founders get a "went quiet" alert. */
export const QUIET_ALERT_DAYS = 2;

export interface NudgeSchedulerDeps {
  db: Db;
  log: Logger;
  /** Without Sendblue or a coach that writes nudges, the tick does nothing. */
  sendblue?: SendblueClient;
  replier?: Replier;
  /** Only these numbers ever get a nudge (ALLOWED_NUMBERS). */
  allowedNumbers: string[];
  /** Our Sendblue line, recorded on each text. */
  lineNumber?: string;
  now?: () => Date;
}

export interface NudgeScheduler {
  /** One pass over every allowed tester; ticks never overlap. Returns each tester's decision. */
  tick(now?: Date): Promise<Map<string, NudgeDecision>>;
  start(intervalMs?: number): void;
  /** Stops the timer and waits for a running tick. */
  stop(): Promise<void>;
}

/**
 * Once a minute, works out for each tester whether ZOH should start a text now (`dueNudge`),
 * records missed step days, and sends what's due. A slot is claimed in `nudges` before the text
 * is written, so ticks and restarts never double-send; a slot missed while the app was down still
 * goes out if its window is open.
 */
export function createNudgeScheduler(deps: NudgeSchedulerDeps): NudgeScheduler {
  const clock = deps.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  async function run(now: Date): Promise<Map<string, NudgeDecision>> {
    const decisions = new Map<string, NudgeDecision>();
    if (deps.allowedNumbers.length === 0) return decisions;
    const rows = await deps.db.select().from(testers).where(inArray(testers.phone, deps.allowedNumbers));
    for (const tester of rows) {
      try {
        decisions.set(tester.id, await forTester(deps, tester, now));
      } catch (err) {
        deps.log.error({ contact: maskNumber(tester.phone), err: safeError(err) }, "Nudge tick failed for a tester");
      }
    }
    return decisions;
  }

  return {
    tick(now = clock()) {
      const next = chain.then(() => run(now));
      chain = next.catch(() => undefined);
      return next;
    },
    start(intervalMs = DEFAULT_TICK_MS) {
      if (timer) return;
      if (!deps.sendblue || !deps.replier?.nudge) {
        deps.log.warn("Nudges are off: Sendblue or the coach isn't configured");
        return;
      }
      timer = setInterval(() => {
        void this.tick().catch((err: unknown) => deps.log.error({ err: safeError(err) }, "Nudge tick failed"));
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

/** The last text ZOH sent this tester for the same moment, so the next one can read differently. */
async function lastSent(db: Db, testerId: string, moment: string): Promise<string | undefined> {
  const [row] = await db
    .select({ content: messages.content })
    .from(nudges)
    .innerJoin(messages, eq(messages.id, nudges.messageId))
    .where(and(eq(nudges.testerId, testerId), eq(nudges.moment, moment), eq(nudges.status, "sent")))
    .orderBy(desc(nudges.createdAt))
    .limit(1);
  return row?.content ?? undefined;
}

async function forTester(deps: NudgeSchedulerDeps, tester: Tester, now: Date): Promise<NudgeDecision> {
  const { db } = deps;
  const date = serviceDate(now, tester);
  const plan = tester.phase === "active" ? await loadCurrentPlan(db, tester, date) : undefined;

  // A step day that ended with nothing done is a miss, whatever else happens.
  if (plan && !tester.stoppedAt) {
    const rows = await db
      .select()
      .from(stepDays)
      .where(and(eq(stepDays.testerId, tester.id), inArray(stepDays.date, [addDays(date, -1), date])));
    const missed = daysToClose({ now, tester, plan, rows: Object.fromEntries(rows.map((r) => [r.date, r])) });
    for (const day of missed) {
      await db
        .insert(stepDays)
        .values({ testerId: tester.id, date: day, planId: plan.id, status: "missed", updatedAt: now })
        .onConflictDoUpdate({
          target: [stepDays.testerId, stepDays.date],
          set: { status: "missed", planId: plan.id, updatedAt: now },
          setWhere: isNull(stepDays.status),
        });
      await alertSecondMiss(db, tester.id, plan.goalSlug, day, now);
    }
  }

  const [todayRow] = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, date)))
    .limit(1);
  const claimed = await db
    .select({ kind: nudges.kind })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.date, date)));
  const { lastInboundAt, lastOutboundAt } = await lastTexts(db, tester);
  // Two whole days without a word from them, after the plan is locked: one alert per silence.
  if (plan && !tester.stoppedAt && lastInboundAt) {
    const lastDay = serviceDate(lastInboundAt, tester);
    if (addDays(lastDay, QUIET_ALERT_DAYS) <= date) {
      await raiseAlert(db, {
        testerId: tester.id,
        topic: "quiet",
        key: `quiet:${tester.id}:${lastDay}`,
        body: `No text from them since ${lastDay}`,
        at: now,
      });
    }
  }
  const midnight = zonedTime(date, "00:00", tester.timeZone);
  const since = lastInboundAt && lastInboundAt > midnight ? lastInboundAt : midnight;
  // The cap counts only texts ZOH started: chatting with ZOH never costs them a nudge.
  const [started] = await db
    .select({ n: count() })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.status, "sent"), gte(nudges.createdAt, since)));
  const [stalls] = await db
    .select({ n: count() })
    .from(nudges)
    .where(
      and(
        eq(nudges.testerId, tester.id),
        eq(nudges.kind, "stall"),
        ne(nudges.status, "failed"),
        lastInboundAt ? gt(nudges.createdAt, lastInboundAt) : undefined,
      ),
    );

  // The slip ladder counts misses on this version of the plan: reworking it starts fresh.
  const sinceLock = plan?.lockedAt ? serviceDate(plan.lockedAt, tester) : undefined;
  const recent = plan ? (await loadRecentDays(db, tester, date)).filter((d) => !sinceLock || d.date >= sinceLock) : [];
  const [dayThree] = await db
    .select({ at: max(nudges.createdAt) })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.moment, "day_three"), eq(nudges.status, "sent")));

  const decision = dueNudge({
    now,
    tester,
    plan,
    today: todayRow,
    claimedToday: claimed.map((c) => c.kind),
    lastInboundAt,
    lastOutboundAt,
    nudgesSinceReply: started?.n ?? 0,
    stallsSinceReply: stalls?.n ?? 0,
    missesInARow: summarizeDays(recent, []).missesInARow,
    lastDayThreeAt: dayThree?.at ? new Date(dayThree.at) : undefined,
  });

  if (decision.action === "pause") {
    await updateTester(db, tester.id, { autoTextsPausedAt: now });
    await saveFlag(
      db,
      tester.id,
      WENT_QUIET_FLAG,
      `No reply since ${lastInboundAt ? serviceDate(lastInboundAt, tester) : "their first text"} (phase ${tester.phase}); ZOH's own texts paused on ${decision.date}`,
    );
    deps.log.info({ contact: maskNumber(tester.phone) }, "Tester went quiet; ZOH's own texts paused and flagged");
  } else if (decision.action === "send") {
    await send(deps, tester, decision.nudge, now);
  }
  return decision;
}

/** When a message happened: Sendblue's time when we have it (and the eval's clock), else when we stored it. */
const sentTime = sql<Date>`coalesce(${messages.sentAt}, ${messages.createdAt})`;
const delivered = () => sql`coalesce(${messages.status}, '') <> 'SEND_FAILED'`;

async function lastTexts(db: Db, tester: Tester): Promise<{ lastInboundAt?: Date; lastOutboundAt?: Date }> {
  const rows = await db
    .select({ direction: messages.direction, at: max(sentTime) })
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), gte(messages.createdAt, tester.contextStartedAt), delivered()))
    .groupBy(messages.direction);
  const at = (direction: string) => {
    const value = rows.find((r) => r.direction === direction)?.at;
    return value ? new Date(value) : undefined;
  };
  return { lastInboundAt: at("inbound"), lastOutboundAt: at("outbound") };
}

/**
 * What a step-day kickoff carries (spec #9): an approved deepen or upgrade not raised yet, else one
 * maintenance check-in that's due. A new focus is raised in a reply instead, where the goal cap is checked.
 */
async function carryFor(db: Db, tester: Tester, date: string): Promise<NudgeCarry | undefined> {
  const rows = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.testerId, tester.id), gte(suggestions.createdAt, tester.contextStartedAt)))
    .orderBy(asc(suggestions.createdAt));
  const ready = rows.find((s) => readyToRaise(s) && approvedKind(s) !== "new_focus");
  if (ready) return { suggestionId: ready.id };
  const [yesterday] = await db
    .select({ status: stepDays.status })
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, addDays(date, -1))));
  const goal = dueCheckin({
    today: date,
    goals: await loadTesterGoals(db, tester.id),
    checkins: await loadCheckins(db, tester.id),
    missedYesterday: yesterday?.status === "missed",
  });
  return goal ? { checkinGoal: goal } : undefined;
}

/** Claims the slot, has the coach write it, sends it and records it. */
async function send(deps: NudgeSchedulerDeps, tester: Tester, nudge: DueNudge, now: Date): Promise<void> {
  const { db, log } = deps;
  const ctx = { contact: maskNumber(tester.phone), kind: nudge.kind };
  if (!deps.sendblue || !deps.replier?.nudge) return;
  const [claim] = await db
    .insert(nudges)
    .values({ testerId: tester.id, date: nudge.date, kind: nudge.kind, moment: nudge.moment, status: "claimed", createdAt: now })
    .onConflictDoNothing()
    .returning();
  // Another tick (or the app before a restart) has this slot.
  if (!claim) return;

  let text: string;
  let carry: NudgeCarry | undefined;
  try {
    const history = await coachHistory(db, tester, now, COACH_HISTORY_CAP);
    const previous = await lastSent(db, tester.id, nudge.moment);
    carry = CARRYING_MOMENTS.includes(nudge.moment) ? await carryFor(db, tester, nudge.date) : undefined;
    text = await deps.replier.nudge({ tester, turns: toTurns(history, "", {}), now, moment: nudge.moment, previous, ...(carry ? { carry } : {}) });
  } catch (err) {
    // Free the slot: the next tick tries again while its window is open. Never the system-down text.
    await db.delete(nudges).where(eq(nudges.id, claim.id));
    log.error({ ...ctx, err: safeError(err) }, "Writing a nudge failed; will retry next tick");
    return;
  }

  try {
    const sent = await deps.sendblue.sendMessage({ number: tester.phone, content: text });
    const message = await insertOutbound(db, {
      contactNumber: tester.phone,
      lineNumber: deps.lineNumber ?? null,
      content: text,
      sendblueHandle: sent.messageHandle ?? null,
      status: sent.status ?? null,
      inReplyTo: null,
      sentAt: now,
      raw: sent.raw as object,
    });
    await db.update(nudges).set({ status: "sent", messageId: message.id }).where(eq(nudges.id, claim.id));
    if (carry && "suggestionId" in carry) {
      await db.update(suggestions).set({ outcome: "delivered", deliveredAt: now, updatedAt: now }).where(eq(suggestions.id, carry.suggestionId));
    } else if (carry) {
      await db.insert(maintenanceCheckins).values({ testerId: tester.id, goalSlug: carry.checkinGoal, date: nudge.date, messageId: message.id, createdAt: now });
    }
    log.info(ctx, "Nudge sent");
  } catch (err) {
    // No retry: a text that may have gone out must not go twice.
    const message = await insertOutbound(db, {
      contactNumber: tester.phone,
      lineNumber: deps.lineNumber ?? null,
      content: text,
      status: "SEND_FAILED",
      error: err instanceof Error ? err.message : String(err),
      inReplyTo: null,
    });
    await db.update(nudges).set({ status: "failed", messageId: message.id }).where(eq(nudges.id, claim.id));
    log.error({ ...ctx, err: safeError(err) }, "Sending a nudge failed");
  }
}
