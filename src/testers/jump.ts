import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { localDate } from "../coach/state.js";
import type { ConsoleJobs } from "../console/jobs.js";
import type { Db } from "../db/client.js";
import { consoleMessages, jumps, memoryPages, nudges, stepDays, type Tester } from "../db/schema.js";
import { safeError } from "../errors.js";
import type { MemoryKeeper } from "../memory/keeper.js";
import { addDays, localClock, serviceDate, weekdayOf, zonedTime } from "../nudges/schedule.js";
import { forecastNudge, type NudgeScheduler } from "../nudges/scheduler.js";
import { maskNumber, type Logger } from "../pipeline/inbound.js";
import type { SendblueClient } from "../sendblue/client.js";
import { aheadBy, testerNow, whileJumping } from "./clock.js";
import { JUMP_USAGE, MAX_JUMP_MS, parseJump, type JumpTarget } from "./commands.js";
import { getTester, getTesterByPhone, updateTester } from "./testers.js";

/**
 * Test mode (spec: GitHub issue "Test mode", #14). A dev account texts "jump 3h", "jump 2d",
 * "jump 7:30am" or "jump next"; their clock walks forward and everything due on the way happens in
 * order (nudges, missed days, the memory pass, the Sunday summary), then one log line comes back.
 * The jump text and the log line are ghosts: neither is a message, so the coach never sees them
 * and they never count as a reply.
 */

/** The walk's step. The shortest nudge window is 10 minutes, so nothing is stepped over. */
export const JUMP_STEP_MS = 5 * 60_000;

export interface JumperDeps {
  db: Db;
  log: Logger;
  sendblue?: SendblueClient;
  nudger: Pick<NudgeScheduler, "tickTester">;
  keeper?: Pick<MemoryKeeper, "tickTester">;
  consoleJobs?: Pick<ConsoleJobs, "tickTester">;
  now?: () => Date;
}

export interface Jumper {
  /**
   * Records the jump and starts it in the background; `done` settles when its log line is sent.
   * Undefined for a webhook delivered twice.
   */
  start(input: { contact: string; text: string; handle: string }): Promise<{ done: Promise<void> } | undefined>;
}

export function createJumper(deps: JumperDeps): Jumper {
  const clock = deps.now ?? (() => new Date());
  return {
    async start({ contact, text, handle }) {
      const tester = await getTesterByPhone(deps.db, contact);
      if (!tester) return { done: sendLog(deps, contact, "⏩ Text ZOH first, then jump.") };
      const [jump] = await deps.db.insert(jumps).values({ testerId: tester.id, text, sendblueHandle: handle }).onConflictDoNothing().returning();
      if (!jump) return undefined;
      const done = whileJumping(tester.id, async () => {
        let line: string;
        try {
          line = await walk(deps, clock, tester.id, jump.id, parseJump(text));
        } catch (err) {
          deps.log.error({ contact: maskNumber(contact), err: safeError(err) }, "Jump failed");
          line = "⏩ The jump stopped partway with an error; the clock is where it got to.";
        }
        await deps.db.update(jumps).set({ log: line }).where(eq(jumps.id, jump.id));
        await sendLog(deps, contact, line);
      });
      return { done };
    },
  };
}

/** Walks the tester's clock to the target and returns the log line. */
async function walk(deps: JumperDeps, clock: () => Date, testerId: string, jumpId: string, target: JumpTarget): Promise<string> {
  const { db } = deps;
  let tester = (await getTester(db, testerId))!;
  if (target.kind === "invalid") return JUMP_USAGE;
  const from = testerNow(tester, clock());
  const limit = new Date(from.getTime() + MAX_JUMP_MS);

  let to: Date;
  if (target.kind === "by") to = new Date(from.getTime() + target.ms);
  else if (target.kind === "at") to = nextLocal(from, target.hhmm, tester.timeZone);
  else {
    // "next": straight to nothing coming, without walking two weeks for it.
    const next = await forecastNudge(db, tester, from, limit, JUMP_STEP_MS);
    if (!next) return `⏩ ${stamp(from, tester)} · nothing coming${tester.stoppedAt ? " (they texted stop)" : ""}`;
    to = limit;
  }

  let at = from;
  while (at < to) {
    at = new Date(Math.min(Math.floor(at.getTime() / JUMP_STEP_MS) * JUMP_STEP_MS + JUMP_STEP_MS, to.getTime()));
    // Saved as it goes, so a restart mid-jump leaves the clock where the walk got to.
    tester = await updateTester(db, testerId, { clockOffsetMs: at.getTime() - clock().getTime() });
    const decision = await deps.nudger.tickTester(tester, at);
    await deps.keeper?.tickTester(tester, at);
    await deps.consoleJobs?.tickTester(tester, at);
    if (target.kind === "next" && (decision.action === "send" || (decision.action === "none" && decision.reason.startsWith("sent the team")))) break;
  }
  tester = await updateTester(db, testerId, { clockOffsetMs: at.getTime() - clock().getTime() });
  await db.update(jumps).set({ fromAt: from, toAt: at }).where(eq(jumps.id, jumpId));
  return logLine(db, tester, from, at);
}

/** "⏩ Wed Oct 30, 7:30 am · sent: kickoff 9:00 am, check-in 6:50 pm · Tue missed · next: follow-up 7:50 pm (in 1h)". */
async function logLine(db: Db, tester: Tester, from: Date, to: Date): Promise<string> {
  const within = (column: AnyPgColumn) => and(gt(column, from), lte(column, to));
  const sent = await db
    .select({ moment: nudges.moment, at: nudges.createdAt })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.status, "sent"), within(nudges.createdAt)))
    .orderBy(asc(nudges.createdAt));
  const missed = await db
    .select({ date: stepDays.date })
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), eq(stepDays.status, "missed"), within(stepDays.updatedAt)))
    .orderBy(asc(stepDays.date));
  const filed = await db
    .select({ date: memoryPages.date })
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, tester.id), eq(memoryPages.kind, "daily"), within(memoryPages.createdAt)));
  const summaries = await db
    .select({ id: consoleMessages.id })
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "summary"), within(consoleMessages.createdAt)));

  const today = serviceDate(to, tester);
  const when = (at: Date) => (serviceDate(at, tester) === today ? clockTime(at, tester) : `${weekday(serviceDate(at, tester))} ${clockTime(at, tester)}`);
  const parts = [`⏩ ${stamp(to, tester)}`];
  if (sent.length) parts.push(`sent: ${sent.map((n) => `${label(n.moment)} ${when(n.at)}`).join(", ")}`);
  if (missed.length) parts.push(`${missed.map((d) => weekday(d.date)).join(", ")} missed`);
  if (filed.length) parts.push("memory filed");
  if (summaries.length) parts.push("weekly summary written");
  if (tester.autoTextsPausedAt && tester.autoTextsPausedAt > from && tester.autoTextsPausedAt <= to) parts.push("ZOH's texts paused (went quiet)");
  if (tester.stoppedAt) parts.push("nothing sent: they texted stop");
  else if (parts.length === 1) parts.push("nothing due");

  const next = await forecastNudge(db, tester, to, new Date(to.getTime() + MAX_JUMP_MS), JUMP_STEP_MS);
  parts.push(next ? `next: ${label(next.moment)} ${when(next.at)} (in ${aheadBy(next.at.getTime() - to.getTime())})` : "next: nothing coming");
  return parts.join(" · ");
}

/** The log line goes straight to their phone and is never stored as a message (spec #14, rule 2). */
async function sendLog(deps: JumperDeps, contact: string, line: string): Promise<void> {
  if (!deps.sendblue) return;
  try {
    await deps.sendblue.sendMessage({ number: contact, content: line });
  } catch (err) {
    deps.log.error({ contact: maskNumber(contact), err: safeError(err) }, "Sending the jump log failed");
  }
}

/** The next moment after `from` that is local "HH:MM". */
function nextLocal(from: Date, hhmm: string, timeZone: string): Date {
  let date = localDate(from, timeZone);
  for (;;) {
    const at = zonedTime(date, hhmm, timeZone);
    if (at > from) return at;
    date = addDays(date, 1);
  }
}

const LABELS: Record<string, string> = {
  kickoff: "kickoff",
  kickoff_checkin: "kickoff + check-in",
  rest_day: "rest-day text",
  checkin: "check-in",
  followup: "follow-up",
  stall: "nudge",
  after_miss: "after-miss kickoff",
  one_a_day: "daily text",
  day_three: "day-3 check-in",
  team: "team nudge",
  team_exact: "team text",
};

function label(moment: string): string {
  return LABELS[moment] ?? moment;
}

/** "Wed Oct 30, 7:30 am" on their clock. */
function stamp(at: Date, tester: Pick<Tester, "timeZone">): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tester.timeZone, month: "short", day: "numeric" }).format(at);
  return `${weekday(localDate(at, tester.timeZone))} ${date}, ${clockTime(at, tester)}`;
}

/** "7:30 am". */
function clockTime(at: Date, tester: Pick<Tester, "timeZone">): string {
  const [h, m] = localClock(at, tester.timeZone).split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "Wed". */
function weekday(date: string): string {
  const day = weekdayOf(date);
  return day.charAt(0).toUpperCase() + day.slice(1);
}
