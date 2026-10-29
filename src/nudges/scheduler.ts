import { and, asc, count, desc, eq, gt, gte, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { Replier } from "../claude/replier.js";
import { COACH_HISTORY_CAP } from "../coach/coach.js";
import { approvedKind, dueCheckin, readyToRaise } from "../coach/next-steps.js";
import { loadCurrentPlan, loadRecentDays } from "../coach/state.js";
import { alertSecondMiss } from "../coach/tools.js";
import type { Db } from "../db/client.js";
import { insertOutbound } from "../db/messages.js";
import { coachHistory } from "../memory/context.js";
import { consoleMessages, maintenanceCheckins, messages, nudges, stepDays, suggestions, testers, type Plan, type Tester } from "../db/schema.js";
import { alertFailure, raiseAlert, saveFlag } from "../console/alerts.js";
import { activePause, endPause, lastPauseEnd, pausedOn, pauseEnds, pausesSince } from "../testers/pauses.js";
import { addThreadLine, APP_AUTHOR, cancelRequest, closeRequest, doneLine, expireRequests, MORNING_CARRIES, pendingExact, pendingRequests } from "../console/requests.js";
import { insideQuietHours } from "../coach/state.js";
import { loadCheckins, loadTesterGoals } from "../testers/goals.js";
import { safeError } from "../errors.js";
import { maskNumber, toTurns, type Logger } from "../pipeline/inbound.js";
import type { SendblueClient } from "../sendblue/client.js";
import { isJumping, onTesterClock, testerNow } from "../testers/clock.js";
import { getTester, updateTester } from "../testers/testers.js";
import { summarizeDays } from "./streak.js";
import {
  addDays,
  CARRYING_MOMENTS,
  daysToClose,
  dueNudge,
  localClock,
  REPLY_IN_PROGRESS_MS,
  REQUEST_CARRYING_MOMENTS,
  serviceDate,
  zonedTime,
  type DueNudge,
  type NudgeCarry,
  type NudgeDecision,
  type NudgeInput,
} from "./schedule.js";

export const WENT_QUIET_FLAG = "went_quiet";
export const DEFAULT_TICK_MS = 60_000;
/** Whole local days without a text from them before the founders get a "went quiet" alert. */
export const QUIET_ALERT_DAYS = 2;
/** The founders' exact texts never go past this many unanswered texts from ZOH (spec #10, rule 1). */
export const MAX_UNANSWERED = 3;
/** The `nudges` moment for a founder's exact text. */
export const EXACT_MOMENT = "team_exact";
/** They texted this recently: a due manual nudge waits, so ZOH's reply carries it instead of a text on top. */
export const MID_CONVERSATION_MS = 10 * 60_000;
/** Pauses that ended this long ago can still cover yesterday, the oldest day a tick closes. */
const PAUSE_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

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
  /** One pass over every allowed tester, each on their own clock; ticks never overlap. Returns each tester's decision. */
  tick(now?: Date): Promise<Map<string, NudgeDecision>>;
  /** One tester at `now` on their clock, outside the ticks (a jump, #14: the ticks skip them meanwhile). */
  tickTester(tester: Tester, now: Date): Promise<NudgeDecision>;
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
    for (const row of rows) {
      // Mid-jump, the jump runs this tester's ticks itself (#14).
      if (isJumping(row.id)) continue;
      try {
        // A dev account's clock may have moved since the rows were read.
        const tester = (row.isTestUser && (await getTester(deps.db, row.id))) || row;
        decisions.set(tester.id, await forTester(deps, tester, testerNow(tester, now)));
      } catch (err) {
        deps.log.error({ contact: maskNumber(row.phone), err: safeError(err) }, "Nudge tick failed for a tester");
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
    tickTester(tester, now) {
      return forTester(deps, tester, now);
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

  // A break they asked for: it lifts on its own once their end date's quiet hours are over.
  let pause = await activePause(db, tester.id);
  if (pause && pauseEnds(pause, now, tester)) {
    await endPause(db, tester.id, { at: now, by: "end_date" });
    pause = undefined;
  }

  // A step day that ended with nothing done is a miss, whatever else happens, unless it ended inside a pause.
  if (plan && !tester.stoppedAt) {
    const rows = await db
      .select()
      .from(stepDays)
      .where(and(eq(stepDays.testerId, tester.id), inArray(stepDays.date, [addDays(date, -1), date])));
    const recentPauses = await pausesSince(db, tester.id, new Date(now.getTime() - PAUSE_LOOKBACK_MS));
    const missed = daysToClose({ now, tester, plan, rows: Object.fromEntries(rows.map((r) => [r.date, r])) }).filter(
      (day) => !pausedOn(recentPauses, day, tester),
    );
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

  const input = await loadNudgeInput(db, tester, plan, date, now);
  const { lastInboundAt, lastOutboundAt, pauseEndedAt } = input;
  const heardAt = pauseEndedAt && (!lastInboundAt || pauseEndedAt > lastInboundAt) ? pauseEndedAt : lastInboundAt;
  // Two whole days without a word from them, after the plan is locked: one alert per silence.
  if (plan && !tester.stoppedAt && !pause && heardAt) {
    const lastDay = serviceDate(heardAt, tester);
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
  const unanswered = input.nudgesSinceReply;
  const quiet = insideQuietHours(localClock(now, tester.timeZone), tester);
  // A request still pending past its too-late-after time is dropped with a note, never sent late.
  const blockedBy = tester.stoppedAt
    ? "they texted stop"
    : pause
      ? "they asked for a break"
      : unanswered >= MAX_UNANSWERED
      ? `${MAX_UNANSWERED} texts from ZOH unanswered`
      : quiet
        ? "their quiet hours"
        : "no fitting text came up";
  await expireRequests(db, tester, now, blockedBy);
  // While paused ZOH starts nothing: not its own texts, not the founders' (spec "Commands and safety", rule 1).
  if (pause) return { action: "none", reason: "paused" };

  // The founders' "send exactly this": one per tick, and that tick sends nothing else.
  if (await sendExact(deps, tester, { now, date, lastInboundAt, lastOutboundAt, unanswered })) {
    return { action: "none", reason: "sent the team's text" };
  }
  // A manual nudge (its own text in ZOH's words, at the time agreed in the console): the same rules as
  // ZOH's own texts. Mid-conversation it waits: the reply carries it instead (the state lists it).
  if (deps.sendblue && deps.replier?.nudge && !tester.stoppedAt && !quiet && unanswered < MAX_UNANSWERED) {
    const midConversation = lastInboundAt !== undefined && now.getTime() - lastInboundAt.getTime() < MID_CONVERSATION_MS;
    const [request] = midConversation ? [] : await pendingRequests(db, tester.id, now, ["own_text"]);
    if (request) {
      await send(deps, tester, { kind: `team:${request.id}`, moment: "team", date }, now, { requestId: request.id });
      return { action: "none", reason: "sent the team's nudge" };
    }
  }

  const decision = dueNudge(input);

  if (decision.action === "pause") {
    await updateTester(db, tester.id, { autoTextsPausedAt: now });
    await saveFlag(
      db,
      tester.id,
      WENT_QUIET_FLAG,
      `No reply since ${lastInboundAt ? serviceDate(lastInboundAt, tester) : "their first text"} (phase ${tester.phase}); ZOH's own texts paused on ${decision.date}`,
      onTesterClock(tester, now),
    );
    deps.log.info({ contact: maskNumber(tester.phone) }, "Tester went quiet; ZOH's own texts paused and flagged");
  } else if (decision.action === "send") {
    await send(deps, tester, decision.nudge, now);
  }
  return decision;
}

/**
 * Test mode (#14): when ZOH would next start a text after `from`, checked every `stepMs` on the
 * nudge rules alone, assuming nothing changes meanwhile (a forecast: a reply or a missed day can
 * move it). Founders' requests aren't counted, and a break they asked for means nothing is coming.
 * Undefined when nothing comes before `until`.
 */
export async function forecastNudge(
  db: Db,
  tester: Tester,
  from: Date,
  until: Date,
  stepMs: number,
): Promise<{ at: Date; moment: string } | undefined> {
  if (await activePause(db, tester.id)) return undefined;
  const date = serviceDate(from, tester);
  const plan = tester.phase === "active" ? await loadCurrentPlan(db, tester, date) : undefined;
  const base = await loadNudgeInput(db, tester, plan, date, from);
  for (let t = Math.floor(from.getTime() / stepMs) * stepMs + stepMs; t <= until.getTime(); t += stepMs) {
    const now = new Date(t);
    // A later day starts with nothing claimed and nothing sent since its midnight.
    const later = serviceDate(now, tester) !== date ? { today: undefined, claimedToday: [], nudgesSinceReply: 0 } : {};
    const decision = dueNudge({ ...base, ...later, now });
    if (decision.action === "send") return { at: now, moment: decision.nudge.moment };
    if (decision.action === "pause") return undefined;
  }
  return undefined;
}

/** What the nudge rules read for this tester at `now` (their local `date`), from saved state. */
async function loadNudgeInput(db: Db, tester: Tester, plan: Plan | undefined, date: string, now: Date): Promise<NudgeInput> {
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
  // A break they asked for isn't silence: it counts from when the pause ended.
  const pauseEndedAt = await lastPauseEnd(db, tester.id);
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

  return {
    now,
    tester,
    plan,
    today: todayRow,
    claimedToday: claimed.map((c) => c.kind),
    lastInboundAt,
    lastOutboundAt,
    pauseEndedAt,
    nudgesSinceReply: started?.n ?? 0,
    stallsSinceReply: stalls?.n ?? 0,
    missesInARow: summarizeDays(recent, []).missesInARow,
    lastDayThreeAt: dayThree?.at ? new Date(dayThree.at) : undefined,
  };
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
 * A founder's "send exactly this" that's due (spec #10, rule 1): word for word, under the rules for
 * ZOH's own texts: never after a stop, never past 3 unanswered, never in quiet hours unless "send
 * now" was ticked, and not while a reply to them is being written. True when one went out (or failed).
 */
async function sendExact(
  deps: NudgeSchedulerDeps,
  tester: Tester,
  ctx: { now: Date; date: string; lastInboundAt?: Date; lastOutboundAt?: Date; unanswered: number },
): Promise<boolean> {
  const { db, log } = deps;
  if (!deps.sendblue || tester.stoppedAt || ctx.unanswered >= MAX_UNANSWERED) return false;
  const { now, lastInboundAt: lastIn, lastOutboundAt: lastOut } = ctx;
  const theirsIsLatest = lastIn !== undefined && (lastOut === undefined || lastIn > lastOut);
  if (theirsIsLatest && now.getTime() - lastIn.getTime() < REPLY_IN_PROGRESS_MS) return false;
  const quiet = insideQuietHours(localClock(now, tester.timeZone), tester);
  const request = (await pendingExact(db, tester.id, now)).find((r) => r.sendNow || !quiet);
  if (!request) return false;

  // The slot counts toward the unanswered cap like any text ZOH starts, and claiming it means one send.
  const [claim] = await db
    .insert(nudges)
    .values({ testerId: tester.id, date: ctx.date, kind: `exact:${request.id}`, moment: EXACT_MOMENT, status: "claimed", createdAt: now })
    .onConflictDoNothing()
    .returning();
  if (!claim) return false;
  const logCtx = { contact: maskNumber(tester.phone), kind: EXACT_MOMENT };
  try {
    const sent = await deps.sendblue.sendMessage({ number: tester.phone, content: request.body });
    const message = await insertOutbound(db, {
      contactNumber: tester.phone,
      lineNumber: deps.lineNumber ?? null,
      content: request.body,
      sendblueHandle: sent.messageHandle ?? null,
      status: sent.status ?? null,
      inReplyTo: null,
      sentAt: now,
      createdAt: onTesterClock(tester, now),
      raw: sent.raw as object,
    });
    await db.update(nudges).set({ status: "sent", messageId: message.id }).where(eq(nudges.id, claim.id));
    await closeRequest(db, { request, status: "sent", at: now, messageId: message.id, line: doneLine(request.body, "sent word for word", now) });
    log.info(logCtx, "Team text sent");
  } catch (err) {
    // No retry: a text that may have gone out must not go twice. The founders can send it again.
    await db.update(nudges).set({ status: "failed" }).where(eq(nudges.id, claim.id));
    await cancelRequest(db, { testerId: tester.id, requestId: request.id, at: now });
    await addThreadLine(db, {
      testerId: tester.id,
      kind: "coach",
      author: APP_AUTHOR,
      body: `Couldn't send your text (${err instanceof Error ? err.message.slice(0, 80) : "send failed"}). Send it again if you still want it to go.`,
      at: now,
    });
    log.error({ ...logCtx, err: safeError(err) }, "Sending a team text failed");
  }
  return true;
}

/**
 * What a morning text carries (spec #9, #10): a founder's request due now (kickoffs and the rest-day
 * text), else, on a step-day kickoff, an approved deepen or upgrade not raised yet, else one maintenance
 * check-in that's due. A new focus is raised in a reply instead, where the goal cap is checked.
 */
async function carryFor(db: Db, tester: Tester, nudge: DueNudge, now: Date): Promise<NudgeCarry | undefined> {
  if (REQUEST_CARRYING_MOMENTS.includes(nudge.moment)) {
    const [request] = await pendingRequests(db, tester.id, now, MORNING_CARRIES);
    if (request) return { requestId: request.id };
  }
  if (!CARRYING_MOMENTS.includes(nudge.moment)) return undefined;
  const date = nudge.date;
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

/** Claims the slot, has the coach write it, sends it and records it. `given`: what it carries (a manual nudge), instead of working it out. */
async function send(deps: NudgeSchedulerDeps, tester: Tester, nudge: DueNudge, now: Date, given?: NudgeCarry): Promise<void> {
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
    carry = given ?? (await carryFor(db, tester, nudge, now));
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
      createdAt: onTesterClock(tester, now),
      raw: sent.raw as object,
    });
    await db.update(nudges).set({ status: "sent", messageId: message.id }).where(eq(nudges.id, claim.id));
    if (carry && "requestId" in carry) {
      const [request] = await db.select().from(consoleMessages).where(eq(consoleMessages.id, carry.requestId));
      if (request) await closeRequest(db, { request, status: "done", at: now, messageId: message.id, line: doneLine(request.body, nudge.moment === "team" ? "in its own text" : "in the morning text", now) });
    } else if (carry && "suggestionId" in carry) {
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
      createdAt: onTesterClock(tester, now),
    });
    await db.update(nudges).set({ status: "failed", messageId: message.id }).where(eq(nudges.id, claim.id));
    log.error({ ...ctx, err: safeError(err) }, "Sending a nudge failed");
    await alertFailure(db, tester.id, `A ${nudge.moment} text didn't send (${(err instanceof Error ? err.message : String(err)).slice(0, 120)})`, now);
  }
}
