/**
 * Real conversations for the eval (#197), read-only against production (DATABASE_URL: Railway's public Postgres URL).
 *
 *   npm run real -- list [--days 14]                      conversations worth a look, picked by signals
 *   npm run real -- replay <last 4> <ZOH text id> <feature>   that moment as a replay case, cut just before the text
 *
 * Signals choose what to look at, never targets to optimize. Names and numbers are masked; a replay is refused
 * when anything number-like is left, and possibly sensitive conversations (health, personal crises) are left out.
 * It only reads, and prints numbers masked.
 */
import { readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, asc, desc, eq, gte, isNull, like } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { memoryPages, messages, planInputs, plans, testers, type Plan } from "../src/db/schema.js";
import { maskNumber } from "../src/pipeline/inbound.js";
import { CASES_DIR, getFeature } from "./features.js";
import { caseSchema, type RegressionCase } from "./types.js";

export interface Msg {
  id: string;
  direction: "inbound" | "outbound";
  content: string | null;
  createdAt: Date;
}

export const SIGNALS = ["stop", "silence", "correction", "short-reply"] as const;
export type SignalKind = (typeof SIGNALS)[number];

export interface Signal {
  kind: SignalKind;
  at: Date;
  /** The ZOH text it points at: the one just before the tester's reaction (or the unanswered one). */
  zohId: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CORRECTION = /\b(i (already|just) (said|told you|did|sent)|i told you|already (said|told you)|like i said|as i said)\b/i;
const words = (s: string | null) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** Signals in one tester's messages, oldest first. */
export function findSignals(msgs: Msg[], now: Date): Signal[] {
  const out: Signal[] = [];
  let lastZoh: Msg | undefined;
  const recentLengths: number[] = [];
  for (const [i, m] of msgs.entries()) {
    if (m.direction === "outbound") {
      lastZoh = m;
      // Silence after a question: no reply within a day.
      if (m.content?.includes("?")) {
        const reply = msgs.slice(i + 1).find((x) => x.direction === "inbound");
        if ((reply?.createdAt ?? now).getTime() - m.createdAt.getTime() > DAY_MS) out.push({ kind: "silence", at: m.createdAt, zohId: m.id });
      }
      continue;
    }
    if (!lastZoh) continue;
    const text = m.content ?? "";
    const avg = recentLengths.length >= 3 ? recentLengths.slice(-3).reduce((a, b) => a + b, 0) / 3 : 0;
    if (/^\s*stop\s*$/i.test(text)) out.push({ kind: "stop", at: m.createdAt, zohId: lastZoh.id });
    else if (CORRECTION.test(text)) out.push({ kind: "correction", at: m.createdAt, zohId: lastZoh.id });
    else if (avg >= 12 && words(text) <= 3) out.push({ kind: "short-reply", at: m.createdAt, zohId: lastZoh.id });
    recentLengths.push(words(text));
  }
  return out;
}

/** Health and personal-crisis words: a conversation with any is left out of replays. */
const SENSITIVE =
  /\b(suicid\w*|kill (myself|me)|self[- ]?harm\w*|depress\w*|anxiety|panic attacks?|therap(y|ist)|diagnos\w*|cancer|chemo\w*|pregnan\w*|miscarr\w*|abus(e|ed|ive)|rehab|overdos\w*|hospital\w*|medication|meds|eating disorder|anorexi\w*|bulimi\w*|funeral|passed away|grie(f|ving)|divorc\w*)\b/i;

export function looksSensitive(texts: string[]): boolean {
  return texts.some((t) => SENSITIVE.test(t));
}

/**
 * Seven or more digits, however they're separated (up to 3 of anything but letters, or a colon so times
 * like "6:30, 7:00" never chain): a phone number, an account. Broader than the masking, as a safety net.
 */
const NUMBER_LIKE = /(?:\d[^\p{L}\d:]{0,3}){6,}\d/u;
export function numberLike(text: string): boolean {
  return NUMBER_LIKE.test(text);
}

const PLACEHOLDERS = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Jamie"];
const RELATIONS = /^(my |the )?(mom|mum|mother|dad|father|parents?|sister|brother|sibling|wife|husband|partner|girlfriend|boyfriend|son|daughter|kids?|children|grand\w+|aunt|uncle|cousin|boss|manager|coach|trainer|friend|roommate|neighbou?r|coworker|colleague|team)s?$/i;

/** Masks emails, numbers and the given names (each part of a full name too), the same name always the same way. */
export function maskText(text: string, names: string[]): string {
  let out = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]").replace(/\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g, "[number]");
  const parts = [...new Set(names.flatMap((n) => [n, ...n.split(/\s+/)]).map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  for (const name of parts) {
    const stand = PLACEHOLDERS[names.findIndex((n) => n === name || n.split(/\s+/).includes(name)) % PLACEHOLDERS.length] ?? "Alex";
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), stand);
  }
  return out;
}

const SHOULD: Record<SignalKind, string> = {
  correction: "ZOH uses what the tester already said instead of asking for it again, so they never need to correct it.",
  stop: "ZOH's reply fits what they said and doesn't push, so they'd have no reason to text stop.",
  silence: "ZOH's text is easy to answer: a light reply with at most one clear question that fits where they are.",
  "short-reply": "ZOH's reply meets them where they are, so they stay in the conversation rather than shutting down.",
};

export interface ReplayInput {
  tester: { name: string | null; phase: "onboarding" | "planning" | "active"; goalSlug: string | null; timeZone: string };
  /** Other people's names to mask (the people on their memory pages). */
  otherNames: string[];
  answers?: Partial<Record<"what" | "where" | "when" | "how_long" | "tracks_with", string | null>>;
  /** Their plan locked before the moment, if any. */
  plan?: Pick<Plan, "setupStep" | "step" | "destination" | "place" | "stepTime" | "days" | "proof" | "proofNote" | "reason" | "minutes" | "startDate">;
  msgs: Msg[];
  /** The ZOH text that went wrong: the replay stops just before it. */
  zohId: string;
  signal: SignalKind;
  id: string;
}

/** The moment as a replay case, or why it's refused. */
export function buildReplay(input: ReplayInput): { replay: RegressionCase } | { refused: string } {
  const msgs = input.msgs.filter((m) => m.content?.trim());
  const at = msgs.findIndex((m) => m.id === input.zohId && m.direction === "outbound");
  if (at < 0) return { refused: "That ZOH text isn't in this tester's conversation." };
  let prevZoh = at - 1;
  while (prevZoh >= 0 && msgs[prevZoh]!.direction !== "outbound") prevZoh -= 1;
  const turn = msgs.slice(prevZoh + 1, at);
  if (turn.length === 0) return { refused: "That's a text ZOH started itself; a replay starts from the tester's text before it." };
  const history = msgs.slice(Math.max(0, prevZoh - 19), prevZoh + 1);
  if (history.length === 0) return { refused: "There's no earlier conversation to start from." };
  const next = msgs.slice(at + 1).find((m) => m.direction === "inbound");
  const all = [...history, ...turn, msgs[at]!, ...(next ? [next] : [])].map((m) => m.content!);
  if (looksSensitive(all)) return { refused: "Possibly sensitive (health or a personal crisis), so it's left out." };

  // A memory page for "Mom" or "my boss" isn't a name to mask.
  const people = input.otherNames.filter((n) => !RELATIONS.test(n.trim()));
  const names = [input.tester.name, ...people].filter((n): n is string => !!n?.trim());
  const mask = (s: string) => maskText(s, names);
  const placeholder = input.tester.name ? mask(input.tester.name.split(/\s+/)[0]!) : "Alex";
  const first = turn[0]!.createdAt;
  const local = new Intl.DateTimeFormat("en-US", { timeZone: input.tester.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(first);
  const part = (t: string) => local.find((p) => p.type === t)!.value;
  const answers = Object.fromEntries(Object.entries(input.answers ?? {}).filter(([, v]) => v?.trim()).map(([k, v]) => [k, mask(v!)]));
  const plan = input.plan;
  const seed: Record<string, unknown> = {
    name: placeholder,
    goal: input.tester.goalSlug ?? "something-else",
    phase: plan ? "active" : input.tester.phase,
    answers,
    history: history.map((m) => ({ from: m.direction === "inbound" ? "tester" : "zoh", text: mask(m.content!) })),
    history_hours_ago: Math.round(Math.min(72, Math.max(0, (first.getTime() - history.at(-1)!.createdAt.getTime()) / 3_600_000)) * 10) / 10,
  };
  if (plan) {
    const started = plan.startDate ? Math.round((Date.parse(`${first.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${plan.startDate}T00:00:00Z`)) / DAY_MS) : 0;
    seed.plan = {
      ...(plan.setupStep ? { setup_step: mask(plan.setupStep) } : {}),
      step: mask(plan.step),
      ...(plan.destination ? { destination: mask(plan.destination) } : {}),
      ...(plan.place ? { place: mask(plan.place) } : {}),
      time: plan.stepTime,
      days: plan.days,
      proof: plan.proof,
      ...(plan.proofNote ? { proof_note: mask(plan.proofNote) } : {}),
      reason: mask(plan.reason),
      ...(plan.minutes !== null ? { minutes: plan.minutes } : {}),
      started_days_ago: Math.min(30, Math.max(0, started)),
    };
  }
  const draft = {
    id: input.id,
    title: `Real replay: ${input.signal.replace("-", " ")} after a ZOH text`,
    origin: `A real tester conversation (${first.toISOString().slice(0, 10)}), picked by the "${input.signal}" signal; names and numbers masked.`,
    suite: "replay",
    testerLines: turn.map((m) => mask(m.content!)),
    whatWentWrong: `ZOH replied "${mask(msgs[at]!.content!)}"${next ? `, and the tester answered "${mask(next.content!)}"` : ", and the tester never answered"}.`,
    shouldHaveHappened: SHOULD[input.signal],
    startTime: `${part("hour")}:${part("minute")}`,
    startDay: part("weekday").toLowerCase().slice(0, 3),
    timeZone: input.tester.timeZone,
    seed,
  };
  // Every text that came from them or ZOH, after masking: nothing number-like may be left.
  const texts = [...draft.testerLines, draft.whatWentWrong, ...Object.values(answers), ...(seed.history as { text: string }[]).map((h) => h.text), ...Object.values((seed.plan as Record<string, unknown>) ?? {}).filter((v): v is string => typeof v === "string")];
  if (texts.some(numberLike)) return { refused: "Something number-like is left after masking, so it's left out." };
  const parsed = caseSchema.safeParse(draft);
  if (!parsed.success) return { refused: `It doesn't make a valid case: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}` };
  return { replay: parsed.data };
}

// ---- Command line (reads only) ----

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { days: { type: "string" } } });
  const url = process.env.DATABASE_URL;
  const [command, digits, zohPrefix, feature] = positionals;
  if (!url || (command !== "list" && command !== "replay") || (command === "replay" && (!digits || !zohPrefix || !feature || !getFeature(feature)))) {
    console.error("Usage: DATABASE_URL=... npm run real -- list [--days 14]\n       DATABASE_URL=... npm run real -- replay <last 4 digits> <ZOH text id> <feature>");
    return 1;
  }
  const { db, close } = createDb(url);
  try {
    if (command === "list") {
      const since = new Date(Date.now() - Number(values.days ?? 14) * DAY_MS);
      const people = await db.select().from(testers).where(and(eq(testers.isTestUser, false), isNull(testers.scenario)));
      for (const t of people) {
        const msgs = await db.select({ id: messages.id, direction: messages.direction, content: messages.content, createdAt: messages.createdAt }).from(messages).where(and(eq(messages.contactNumber, t.phone), gte(messages.createdAt, since))).orderBy(asc(messages.createdAt));
        const signals = findSignals(msgs, new Date());
        if (signals.length === 0) continue;
        if (looksSensitive(msgs.map((m) => m.content ?? ""))) {
          console.log(`${maskNumber(t.phone)}: ${signals.length} signal(s), possibly sensitive: left out`);
          continue;
        }
        const names = [t.name ?? ""];
        console.log(`${maskNumber(t.phone)}: ${signals.length} signal(s)`);
        for (const s of signals) {
          const zoh = msgs.find((m) => m.id === s.zohId)?.content ?? "";
          console.log(`  ${s.kind.padEnd(11)} ${s.at.toISOString().slice(0, 10)}  ZOH text ${s.zohId.slice(0, 8)}: "${maskText(zoh, names).slice(0, 90)}"`);
        }
      }
      return 0;
    }
    const found = await db.select().from(testers).where(like(testers.phone, `%${digits!.replace(/\D/g, "")}`));
    if (found.length !== 1) {
      console.error(found.length ? `${found.length} testers end in ${digits}; give more digits.` : `No tester ends in ${digits}.`);
      return 1;
    }
    const t = found[0]!;
    const msgs = await db.select({ id: messages.id, direction: messages.direction, content: messages.content, createdAt: messages.createdAt }).from(messages).where(and(eq(messages.contactNumber, t.phone), gte(messages.createdAt, t.contextStartedAt))).orderBy(asc(messages.createdAt));
    const target = msgs.find((m) => m.direction === "outbound" && m.id.startsWith(zohPrefix!));
    if (!target) {
      console.error(`No ZOH text starting ${zohPrefix} for ${maskNumber(t.phone)}.`);
      return 1;
    }
    const signal = findSignals(msgs, new Date()).find((s) => s.zohId === target.id)?.kind ?? "correction";
    // The plan version that was live at that moment: the newest locked before it.
    const locked = await db.select().from(plans).where(and(eq(plans.testerId, t.id), eq(plans.status, "locked"))).orderBy(desc(plans.lockedAt));
    const plan = locked.find((p) => p.lockedAt && p.lockedAt < target.createdAt);
    const inputs = t.goalSlug ? (await db.select().from(planInputs).where(and(eq(planInputs.testerId, t.id), eq(planInputs.goalSlug, t.goalSlug))))[0] : undefined;
    const people = await db.select({ title: memoryPages.title }).from(memoryPages).where(and(eq(memoryPages.testerId, t.id), eq(memoryPages.kind, "person")));
    const dir = `${CASES_DIR}${feature}/`;
    const existing = await readdir(dir).catch(() => [] as string[]);
    const n = String(existing.filter((f) => /^\d{3}-/.test(f)).length + 1).padStart(3, "0");
    const id = `replay-${signal}-${target.createdAt.toISOString().slice(5, 10)}`;
    const res = buildReplay({
      tester: { name: t.name, phase: t.phase, goalSlug: t.goalSlug, timeZone: t.timeZone },
      otherNames: people.map((p) => p.title),
      answers: inputs ? { what: inputs.what, where: inputs.where, when: inputs.when, how_long: inputs.howLong, tracks_with: inputs.tracksWith } : undefined,
      plan,
      msgs,
      zohId: target.id,
      signal,
      id,
    });
    if ("refused" in res) {
      console.error(`Not made: ${res.refused}`);
      return 1;
    }
    const path = `${dir}${n}-${id}.json`;
    await writeFile(path, `${JSON.stringify(res.replay, null, 2)}\n`);
    console.log(`Wrote ${path.slice(CASES_DIR.length - "eval/cases/".length)}. Read it before using it: the masking is automatic.`);
    return 0;
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
