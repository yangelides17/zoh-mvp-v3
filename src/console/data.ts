import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { localDate } from "../coach/state.js";
import type { Db } from "../db/client.js";
import {
  consoleMessages,
  goals,
  maintenanceCheckins,
  messages,
  plans,
  stepDays,
  suggestions,
  takeaways,
  testers,
  type ConsoleMessage,
  type Goal,
  type MaintenanceCheckin,
  type Message,
  type Pause,
  type Plan,
  type StepDay,
  type Suggestion,
  type Tester,
  type TesterGoal,
} from "../db/schema.js";
import { messageTime, switchReasons } from "../memory/store.js";
import { addDays } from "../nudges/schedule.js";
import { maintenanceStreak, type HitRate, type StreakRun } from "../nudges/streak.js";
import { testerNow } from "../testers/clock.js";
import { goalMetrics, loadTesterGoals } from "../testers/goals.js";
import { activePause } from "../testers/pauses.js";
import { learnings, type Learnings } from "../coach/week.js";
import { listSuggestions } from "./suggestions.js";

/** What the founder console reads (spec: GitHub issue "Founder console", "What we experience" 2 and 3; per tab since #63). */

export interface GoalView {
  goal: TesterGoal;
  title: string;
  current?: StreakRun;
  past: StreakRun[];
  hitRate: HitRate;
  /** Maintenance goals: the last step day backed by proof, and the last check-in where they said they kept up. */
  provenThrough?: string;
  lastConfirmed?: string;
}

export interface TesterRow {
  tester: Tester;
  focus?: GoalView;
  maintenance: GoalView[];
  lastText?: Message;
  alertsWaiting: number;
  /** Next steps waiting for a decision whose alert is already seen (or that never had one). */
  suggestionsWaiting: number;
}

export async function goalTitles(db: Db): Promise<Map<string, Goal>> {
  const rows = await db.select().from(goals).orderBy(asc(goals.sortOrder));
  return new Map(rows.map((g) => [g.slug, g]));
}

/** Each goal's streaks and hit rate, through today in their zone. */
export async function goalViews(db: Db, tester: Tester, now: Date, titles: Map<string, Goal>, checkins?: MaintenanceCheckin[]): Promise<GoalView[]> {
  const today = localDate(now, tester.timeZone);
  const rows = await loadTesterGoals(db, tester.id);
  const answers =
    checkins ??
    (await db.select().from(maintenanceCheckins).where(eq(maintenanceCheckins.testerId, tester.id)).orderBy(asc(maintenanceCheckins.date)));
  const views: GoalView[] = [];
  for (const goal of rows) {
    const title = titles.get(goal.goalSlug)?.title ?? goal.goalSlug;
    const focusEra = await goalMetrics(db, tester.id, goal.goalSlug, today);
    if (goal.role !== "maintenance") {
      views.push({ goal, title, current: focusEra.current, past: focusEra.past, hitRate: focusEra.hitRate });
      continue;
    }
    // Proof-backed days run until it became maintenance; after that the streak is self-reported.
    const since = localDate(goal.roleSince, tester.timeZone);
    const proven = await goalMetrics(db, tester.id, goal.goalSlug, addDays(since, -1));
    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, goal.goalSlug), eq(plans.status, "locked")))
      .orderBy(desc(plans.version))
      .limit(1);
    const mine = answers.filter((c) => c.goalSlug === goal.goalSlug);
    const streak = plan
      ? maintenanceStreak({ carried: proven.current, since, plan, checkins: mine, today })
      : { current: proven.current, past: [] };
    const confirmed = mine.filter((c) => c.answer === "kept_up" || c.answer === "mostly").at(-1);
    views.push({
      goal,
      title,
      current: streak.current,
      past: [...proven.past, ...streak.past],
      hitRate: focusEra.hitRate,
      provenThrough: proven.current?.to ?? proven.past.at(-1)?.to,
      lastConfirmed: confirmed?.date,
    });
  }
  return views;
}

/**
 * The tester list (#63): every tester, the ones with something to look at first, then most recently
 * texting. The badge counts unseen alerts plus waiting suggestions whose alert is already seen, so a
 * waiting suggestion and its own alert count once.
 */
export async function testerRows(db: Db, now: Date): Promise<TesterRow[]> {
  const titles = await goalTitles(db);
  const all = await db.select().from(testers);
  const unseen = await db.select().from(consoleMessages).where(and(eq(consoleMessages.kind, "alert"), isNull(consoleMessages.seenAt)));
  const waiting = await db.select().from(suggestions).where(eq(suggestions.decision, "waiting"));
  const out: TesterRow[] = [];
  for (const tester of all) {
    const views = await goalViews(db, tester, testerNow(tester, now), titles);
    const [lastText] = await db
      .select()
      .from(messages)
      .where(eq(messages.contactNumber, tester.phone))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    const alerts = unseen.filter((a) => a.testerId === tester.id);
    const flagged = new Set(alerts.map((a) => a.suggestionId).filter(Boolean));
    out.push({
      tester,
      focus: views.find((v) => v.goal.role === "focus"),
      maintenance: views.filter((v) => v.goal.role === "maintenance"),
      lastText,
      alertsWaiting: alerts.length,
      suggestionsWaiting: waiting.filter((s) => s.testerId === tester.id && !flagged.has(s.id)).length,
    });
  }
  const at = (r: TesterRow) => (r.lastText ? messageTime(r.lastText).getTime() : r.tester.createdAt.getTime());
  const needs = (r: TesterRow) => (r.alertsWaiting + r.suggestionsWaiting > 0 ? 1 : 0);
  return out.sort((a, b) => needs(b) - needs(a) || at(b) - at(a));
}

export interface StepDayView {
  day: StepDay;
  /** Photos, screenshots and voice notes they sent that day. */
  proofs: Message[];
}

/** What every tab's header shows. */
export interface TesterHeader {
  tester: Tester;
  titles: Map<string, Goal>;
  goals: GoalView[];
  /** The break they asked for, while it's on. */
  pause?: Pause;
  alertsWaiting: number;
  /** Waiting suggestions whose alert is already seen (or that never had one). */
  suggestionsWaiting: number;
}

export async function testerHeader(db: Db, testerId: string, now: Date): Promise<TesterHeader | undefined> {
  const [tester] = await db.select().from(testers).where(eq(testers.id, testerId));
  if (!tester) return undefined;
  const titles = await goalTitles(db);
  const alerts = await db
    .select({ suggestionId: consoleMessages.suggestionId })
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, testerId), eq(consoleMessages.kind, "alert"), isNull(consoleMessages.seenAt)));
  const waiting = await db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(and(eq(suggestions.testerId, testerId), eq(suggestions.decision, "waiting")));
  // Counted as on the home list: a waiting suggestion and its own unseen alert count once.
  const flagged = new Set(alerts.map((a) => a.suggestionId).filter(Boolean));
  return {
    tester,
    titles,
    goals: await goalViews(db, tester, now, titles),
    pause: await activePause(db, tester.id),
    alertsWaiting: alerts.length,
    suggestionsWaiting: waiting.filter((s) => !flagged.has(s.id)).length,
  };
}

/** Items a thread shows at first, and per "load older". */
export const CHUNK = 50;

/** Where a chunk starts: older than (or at) `before`, or newer than `after`. */
export interface ChunkCursor {
  before?: Date;
  after?: Date;
}

/** One item in the console chat: a thread line (alerts live in their own section) or a next-step suggestion as a card. */
export type ThreadItem = { type: "line"; id: string; at: Date; line: ConsoleMessage } | { type: "suggestion"; id: string; at: Date; suggestion: Suggestion };

/**
 * A chunk of the console chat, oldest first: the newest `limit` items at or before `before`, or
 * everything after `after` (live updates). "At or before" can repeat an item already shown at the
 * edge; the page skips ids it already has.
 */
export async function threadChunk(db: Db, testerId: string, cursor: ChunkCursor = {}, limit = CHUNK): Promise<ThreadItem[]> {
  const lineTime = cursor.after ? gt(consoleMessages.createdAt, cursor.after) : cursor.before ? lte(consoleMessages.createdAt, cursor.before) : undefined;
  const lines = await db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, testerId), ne(consoleMessages.kind, "alert"), lineTime))
    .orderBy(desc(consoleMessages.createdAt))
    .limit(limit);
  const suggestionTime = cursor.after ? gt(suggestions.createdAt, cursor.after) : cursor.before ? lte(suggestions.createdAt, cursor.before) : undefined;
  const ideas = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.testerId, testerId), suggestionTime))
    .orderBy(desc(suggestions.createdAt))
    .limit(limit);
  const items: ThreadItem[] = [
    ...lines.map((line) => ({ type: "line" as const, id: line.id, at: line.createdAt, line })),
    ...ideas.map((suggestion) => ({ type: "suggestion" as const, id: suggestion.id, at: suggestion.createdAt, suggestion })),
  ];
  return items
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit)
    .reverse();
}

/** A chunk of their texts with ZOH, oldest first (same cursor rules as `threadChunk`). */
export async function textsChunk(db: Db, tester: Tester, cursor: ChunkCursor = {}, limit = CHUNK): Promise<Message[]> {
  const time = cursor.after ? gt(messages.createdAt, cursor.after) : cursor.before ? lte(messages.createdAt, cursor.before) : undefined;
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), time))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

/** Lines the "ZOH is thinking" check reads. */
const RECENT_LINES = 20;

/** The newest thread lines, oldest first, for `awaitingAnswer`. */
export async function recentLines(db: Db, testerId: string): Promise<ConsoleMessage[]> {
  const rows = await db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, testerId), ne(consoleMessages.kind, "alert")))
    .orderBy(desc(consoleMessages.createdAt))
    .limit(RECENT_LINES);
  return rows.reverse();
}

/** Seen alerts kept under "Earlier". */
export const EARLIER_ALERTS = 20;

export interface ConsoleTab {
  items: ThreadItem[];
  recent: ConsoleMessage[];
  /** Unseen first (newest first), then the latest seen ones. */
  alerts: { unseen: ConsoleMessage[]; earlier: ConsoleMessage[] };
  pending: Suggestion[];
}

export async function consoleTab(db: Db, testerId: string): Promise<ConsoleTab> {
  return { items: await threadChunk(db, testerId), recent: await recentLines(db, testerId), ...(await sideSection(db, testerId)) };
}

/** What sits under the chat: alerts and next steps waiting for a decision. */
export async function sideSection(db: Db, testerId: string): Promise<Pick<ConsoleTab, "alerts" | "pending">> {
  const alerts = (seen: boolean) =>
    db
      .select()
      .from(consoleMessages)
      .where(and(eq(consoleMessages.testerId, testerId), eq(consoleMessages.kind, "alert"), seen ? isNotNull(consoleMessages.seenAt) : isNull(consoleMessages.seenAt)))
      .orderBy(desc(consoleMessages.createdAt))
      .limit(seen ? EARLIER_ALERTS : 500);
  const pending = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.testerId, testerId), eq(suggestions.decision, "waiting")))
    .orderBy(asc(suggestions.createdAt));
  return { alerts: { unseen: await alerts(false), earlier: await alerts(true) }, pending };
}

export interface ProgressTab {
  switches: { pair: string; reason: string; at: Date }[];
  checkins: MaintenanceCheckin[];
  plans: Plan[];
  /** Newest first. */
  stepDays: StepDayView[];
  suggestions: Suggestion[];
  /** Where their focus goal's current plan is headed, if anywhere (#78). */
  destination?: string;
  /** Every lesson since their context started: understood (applied or recalled) and only explained (#78). */
  learnings: Learnings;
}

export async function progressTab(db: Db, tester: Tester): Promise<ProgressTab> {
  const checkins = await db.select().from(maintenanceCheckins).where(eq(maintenanceCheckins.testerId, tester.id)).orderBy(asc(maintenanceCheckins.date));
  const media = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), eq(messages.direction, "inbound"), isNotNull(messages.mediaUrl)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const proofsByDay = new Map<string, Message[]>();
  for (const m of media) {
    const day = localDate(messageTime(m), tester.timeZone);
    proofsByDay.set(day, [...(proofsByDay.get(day) ?? []), m]);
  }
  const days = await db.select().from(stepDays).where(eq(stepDays.testerId, tester.id)).orderBy(desc(stepDays.date));
  const testerPlans = await db.select().from(plans).where(eq(plans.testerId, tester.id)).orderBy(desc(plans.version));
  const lessons = await db
    .select()
    .from(takeaways)
    .where(and(eq(takeaways.testerId, tester.id), gte(takeaways.createdAt, tester.contextStartedAt)));
  const current = testerPlans.find((p) => p.status === "locked" && p.goalSlug === tester.goalSlug);
  return {
    switches: [...(await switchReasons(db, tester)).entries()].map(([pair, s]) => ({ pair, ...s })),
    checkins,
    plans: testerPlans,
    stepDays: days.map((day) => ({ day, proofs: proofsByDay.get(day.date) ?? [] })),
    suggestions: await listSuggestions(db, tester.id),
    ...(current?.destination ? { destination: current.destination } : {}),
    learnings: learnings(lessons),
  };
}

/** A media text the console may show: inbound, ours in the bucket, and from a tester we know. */
export async function mediaMessage(db: Db, messageId: string): Promise<Message | undefined> {
  const [row] = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(testers, eq(testers.phone, messages.contactNumber))
    .where(and(eq(messages.id, messageId), isNotNull(messages.mediaKey), isNull(messages.mediaDeletedAt)));
  return row?.message;
}

/** Unseen alerts across every tester, newest first. */
export async function waitingAlerts(db: Db, testerIds?: string[]): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.kind, "alert"),
        isNull(consoleMessages.seenAt),
        testerIds ? inArray(consoleMessages.testerId, testerIds) : undefined,
      ),
    )
    .orderBy(desc(consoleMessages.createdAt));
}
