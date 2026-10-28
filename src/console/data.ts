import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { localDate } from "../coach/state.js";
import type { Db } from "../db/client.js";
import {
  consoleMessages,
  goals,
  maintenanceCheckins,
  messages,
  plans,
  stepDays,
  testers,
  type ConsoleMessage,
  type Goal,
  type MaintenanceCheckin,
  type MemoryPage,
  type Message,
  type Plan,
  type StepDay,
  type Suggestion,
  type Tester,
  type TesterGoal,
} from "../db/schema.js";
import { renderPage } from "../memory/render.js";
import { getPages, messageTime, switchReasons } from "../memory/store.js";
import { addDays } from "../nudges/schedule.js";
import { maintenanceStreak, type HitRate, type StreakRun } from "../nudges/streak.js";
import { goalMetrics, loadTesterGoals } from "../testers/goals.js";
import { listSuggestions } from "./suggestions.js";

/** What the founder console reads (spec: GitHub issue "Founder console", "What we experience" 2 and 3). */

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

/** The tester list: every tester, most recently texting first. */
export async function testerRows(db: Db, now: Date): Promise<TesterRow[]> {
  const titles = await goalTitles(db);
  const all = await db.select().from(testers);
  const waiting = await db
    .select({ testerId: consoleMessages.testerId, n: count() })
    .from(consoleMessages)
    .where(and(eq(consoleMessages.kind, "alert"), isNull(consoleMessages.seenAt)))
    .groupBy(consoleMessages.testerId);
  const waitingBy = new Map(waiting.map((w) => [w.testerId, w.n]));
  const out: TesterRow[] = [];
  for (const tester of all) {
    const views = await goalViews(db, tester, now, titles);
    const [lastText] = await db
      .select()
      .from(messages)
      .where(eq(messages.contactNumber, tester.phone))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    out.push({
      tester,
      focus: views.find((v) => v.goal.role === "focus"),
      maintenance: views.filter((v) => v.goal.role === "maintenance"),
      lastText,
      alertsWaiting: waitingBy.get(tester.id) ?? 0,
    });
  }
  const at = (r: TesterRow) => (r.lastText ? messageTime(r.lastText).getTime() : r.tester.createdAt.getTime());
  return out.sort((a, b) => at(b) - at(a));
}

export interface StepDayView {
  day: StepDay;
  /** Photos, screenshots and voice notes they sent that day. */
  proofs: Message[];
}

export interface TesterPage {
  tester: Tester;
  titles: Map<string, Goal>;
  goals: GoalView[];
  switches: { pair: string; reason: string; at: Date }[];
  checkins: MaintenanceCheckin[];
  plans: Plan[];
  stepDays: StepDayView[];
  texts: Message[];
  memory: { page: MemoryPage; text: string }[];
  suggestions: Suggestion[];
  thread: ConsoleMessage[];
}

/** Everything on one tester's page. */
export async function testerPage(db: Db, testerId: string, now: Date): Promise<TesterPage | undefined> {
  const [tester] = await db.select().from(testers).where(eq(testers.id, testerId));
  if (!tester) return undefined;
  const titles = await goalTitles(db);
  const checkins = await db.select().from(maintenanceCheckins).where(eq(maintenanceCheckins.testerId, tester.id)).orderBy(asc(maintenanceCheckins.date));
  const texts = await db
    .select()
    .from(messages)
    .where(eq(messages.contactNumber, tester.phone))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const days = await db.select().from(stepDays).where(eq(stepDays.testerId, tester.id)).orderBy(desc(stepDays.date));
  const proofsByDay = new Map<string, Message[]>();
  for (const m of texts) {
    if (m.direction !== "inbound" || !m.mediaUrl) continue;
    const day = localDate(messageTime(m), tester.timeZone);
    proofsByDay.set(day, [...(proofsByDay.get(day) ?? []), m]);
  }
  const pages = await getPages(db, tester.id);
  const memory = [];
  for (const page of pages) memory.push({ page, text: await renderPage(db, tester, page) });
  const switches = [...(await switchReasons(db, tester)).entries()].map(([pair, s]) => ({ pair, ...s }));
  return {
    tester,
    titles,
    goals: await goalViews(db, tester, now, titles, checkins),
    switches,
    checkins,
    plans: await db.select().from(plans).where(eq(plans.testerId, tester.id)).orderBy(desc(plans.version)),
    stepDays: days.map((day) => ({ day, proofs: proofsByDay.get(day.date) ?? [] })),
    texts,
    memory,
    suggestions: await listSuggestions(db, tester.id),
    thread: await db.select().from(consoleMessages).where(eq(consoleMessages.testerId, tester.id)).orderBy(asc(consoleMessages.createdAt)),
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
