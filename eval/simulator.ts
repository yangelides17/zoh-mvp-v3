import { addUsage, type Completer } from "./claude.js";
import type { Tester } from "./harness.js";
import { LINE_VERDICTS, lineText, type CaseLine, type LineCounts, type LineVerdict, type Persona, type RegressionCase, type Scenario, type TranscriptLine } from "./types.js";

/** What the simulator texts back when the conversation is over. Never sent to ZOH. */
export const DONE = "<<DONE>>";

const PERSONA_STYLE: Record<Persona, string> = {
  terse:
    "Terse. A few words per text, mostly lowercase, no greetings, no punctuation unless needed. You answer what's asked and nothing more.",
  chatty:
    "Chatty. Friendly, a sentence or three, shares a bit of backstory and the odd tangent, some exclamation points. Still reads like texting, not email.",
  joking:
    "Joking. Answers with a joke or a bit of sarcasm first, then the real answer (sometimes only when pushed). lol, haha, the odd emoji.",
  confused:
    "Confused. Not sure what this is or what ZOH wants, sometimes answers a different question than the one asked, asks what things mean. Casual, lowercase.",
  "all-at-once":
    "Answers everything at once. Packs several facts into one text (who you are, what, where, when, how long) so there's less back-and-forth.",
  resistant:
    "Resistant. Skeptical, pushes back on suggestions, says things like 'idk if this will work' or 'that's too much', but is still here for a reason.",
};

export function simulatorSystemPrompt(scenario: Scenario, doneWhen: string): string {
  const f = scenario.facts;
  const facts = [
    `Name: ${f.name}`,
    `What you want: ${f.goal}`,
    f.experience && `Background: ${f.experience}`,
    f.equipment && `Where / what you have: ${f.equipment}`,
    `Schedule: ${f.schedule}`,
    `Time available: ${f.timeAvailable}`,
    f.tracksWith && `Already tracks it with: ${f.tracksWith}`,
    f.city && `City: ${f.city}`,
    f.other && `Also: ${f.other}`,
  ].filter(Boolean);
  return [
    `You are ${f.name}, a real person texting ZOH, a coaching service, from your phone. You're one of its first beta testers.`,
    `Why you're texting: ${scenario.intent}`,
    "",
    "What's true about you (answer from this; if asked something not covered, make up a plausible answer that fits and stick to it):",
    ...facts.map((x) => `- ${x}`),
    "",
    `How you text: ${PERSONA_STYLE[scenario.persona]}`,
    ...(scenario.directions.length ? ["", "During this conversation:", ...scenario.directions.map((d) => `- ${d}`)] : []),
    "",
    "Rules:",
    "- Write only your next text message, exactly as you'd type it on your phone. No quotes, no names, no stage directions.",
    "- Never mention or hint that you are an AI, a simulation or a test. You are just this person.",
    "- Answer what ZOH asks; don't volunteer facts it hasn't asked for unless your texting style says you would.",
    "- Keep it short like a real text unless your style says otherwise.",
    `- When ${doneWhen} reply with exactly ${DONE} and nothing else.`,
    `- If ZOH keeps going in circles or ignores you, keep texting like a real person would (you can get a bit impatient). Only send ${DONE} when it has wrapped up.`,
  ].join("\n");
}

/** The conversation so far, from the tester's side, for the simulator's next call. */
export function simulatorPrompt(transcript: TranscriptLine[]): string {
  if (transcript.length === 0) return "You're about to send your very first text to the ZOH number. Write it.";
  // The console chat is between ZOH and the founders: the tester never sees it.
  const lines = transcript.filter((l) => l.from !== "founder" && l.from !== "lookup" && !l.console).map((l) => `${l.from === "tester" ? "YOU" : "ZOH"}: ${l.text}`);
  return `The conversation so far:\n\n${lines.join("\n\n")}\n\nWrite your next text (or ${DONE} if ZOH has wrapped up).`;
}

/** A Claude playing the tester. Uses the scenario's fixed opening text when it has one. */
export function simulatedTester(scenario: Scenario, complete: Completer, doneWhen: string): Tester {
  const system = simulatorSystemPrompt(scenario, doneWhen);
  let usage = { input: 0, output: 0 };
  let started = false;
  return {
    endReason: "simulator",
    usage: () => usage,
    async next(transcript) {
      // A seeded conversation already has lines, so "first" means this tester's first text.
      const first = !started;
      started = true;
      if (first && scenario.opening) return scenario.opening;
      const res = await complete({
        system,
        messages: [{ role: "user", content: simulatorPrompt(transcript) }],
        maxTokens: 2000,
        effort: "low",
      });
      usage = addUsage(usage, res.usage);
      const text = cleanSimulatorText(res.text, scenario.facts.name);
      if (!text || text.includes(DONE)) return null;
      return text;
    },
  };
}

/** Strips things a model sometimes adds around a text ("YOU:", surrounding quotes). */
export function cleanSimulatorText(raw: string, name: string): string {
  const prefix = new RegExp(`^(YOU|ME|${name.replace(/\W/g, "")}):\\s*`, "i");
  let t = raw.trim().replace(prefix, "");
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim();
  return t;
}

// ---- #230: case lines that wait for the moment they answer ----

/** Extra replies a waiting line may take before the run ends: per line, and for the whole case. */
export const WAITS_PER_LINE = 2;
export const WAITS_PER_CASE = 4;

const LENGTH_TEXT: Record<NonNullable<CaseLine["length"]>, string> = {
  thin: "very short: 1 to 4 words",
  short: "one short sentence",
  full: "a few sentences, like a real text",
};

/** How a case's tester texts when the case doesn't name a persona. */
const CASE_STYLE = "Casual. Short texts, lowercase is fine, no greetings; you answer what's asked like a normal person.";

/**
 * What the tester knows about themselves, for every call. Small invented details are fine when they're plausible;
 * what must never happen is a reply that changes what the case tests (Yanni, Nov 21: a fair test over no invention).
 */
export function caseTesterSystemPrompt(c: RegressionCase): string {
  return [
    `You are ${c.seed?.name ?? "a person"}, texting ZOH, a coaching service, from your phone.${c.seed ? ` What you're working on with it: ${c.seed.goal}.` : ""}`,
    "",
    "What's true about you (answer from this; if you're asked something it doesn't cover, give a plain, plausible answer that fits):",
    ...(c.facts?.length ? c.facts.map((f) => `- ${f}`) : ["- Nothing beyond what the conversation shows."]),
    "",
    `How you text: ${c.persona ? PERSONA_STYLE[c.persona] : CASE_STYLE}`,
    "",
    "Rules:",
    "- Write only text messages exactly as you'd type them. No quotes, names or stage directions.",
    "- Never mention or hint that you are an AI, a simulation or a test.",
  ].join("\n");
}

/** The conversation as the tester saw it, with ZOH's texts since their last one called out. */
function conversationForTester(transcript: TranscriptLine[]): string {
  const seen = transcript.filter((l) => l.from !== "founder" && l.from !== "lookup" && !l.console);
  const lastTester = seen.map((l) => l.from).lastIndexOf("tester");
  const latest = seen.slice(lastTester + 1).filter((l) => l.from === "zoh");
  const all = seen.map((l) => `${l.from === "tester" ? "YOU" : "ZOH"}: ${l.text}`);
  return [
    `The conversation so far:\n\n${all.join("\n\n") || "(nothing yet)"}`,
    `ZOH's latest text${latest.length > 1 ? "s" : ""} (what your next text answers):\n\n${latest.map((l) => l.text).join("\n\n") || "(none since your last text)"}`,
  ].join("\n\n---\n\n");
}

/** The decisions a line allows: a fixed line is never changed or skipped; only an optional line can be passed. */
export function verdictsFor(line: CaseLine): LineVerdict[] {
  return LINE_VERDICTS.filter((v) => !(line.fixed && (v === "close" || v === "said")) && !(v === "passed" && !line.optional));
}

/** Asks only whether a waiting line fits ZOH's latest text, with a one-sentence reason first. Writes nothing. */
export function lineDecisionPrompt(transcript: TranscriptLine[], line: CaseLine): string {
  const allowed = verdictsFor(line);
  const choices: Record<LineVerdict, string> = {
    said: `"said": YOUR earlier texts already got this text's point across, so sending it would repeat you. (ZOH saying it doesn't count.)`,
    fits: `"fits": ZOH's latest text is that moment and the wording answers it as written.`,
    close: `"close": ZOH's latest text asks for exactly this text's point, but in other words, so the wording needs a small change to answer it. If ZOH asked about anything else, or proposed something, it is not close: choose "wait".`,
    wait: `"wait": ZOH isn't at that moment yet (it asked or said something else). You'll reply to that instead and keep this text for later.`,
    passed: `"passed": this text only applies if ZOH asks for it, and ZOH has moved past that point (it won't ask now). It's dropped.`,
  };
  return [
    conversationForTester(transcript),
    "---",
    "Your next planned text:",
    `- Wording: ${line.say}`,
    ...(line.means ? [`- Its point: ${line.means}`] : []),
    `- It fits: ${line.when}`,
    "",
    "Decide, looking at ZOH's latest text. First write one sentence: what ZOH's latest text asks or proposes, and whether this text answers it. Then choose one:",
    ...allowed.map((v) => `- ${choices[v]}`),
  ].join("\n");
}

/** Writes a "close" line: the wording changed just enough to answer ZOH, carrying only its own point. */
export function closeLinePrompt(transcript: TranscriptLine[], line: CaseLine): string {
  return [
    conversationForTester(transcript),
    "---",
    `Your planned text: ${line.say}`,
    `Its point: ${line.means}`,
    `Length: ${line.length ? LENGTH_TEXT[line.length] : "about as long as the planned text"}`,
    "",
    "Change the wording as little as possible so it answers ZOH's latest text. Keep only its point. Don't agree to, choose or decide anything else, and don't add another topic. Write only the text.",
  ].join("\n");
}

/** The reply written while a line waits. It never sees the waiting line, so it can't give away what comes next. */
export function waitingReplyPrompt(transcript: TranscriptLine[]): string {
  return [
    conversationForTester(transcript),
    "---",
    "Write your next text: a reply to just what ZOH's latest text asks or says, from what's true about you (a plausible detail is fine if it isn't covered).",
    "Don't bring up anything ZOH didn't ask about. Never propose, agree to, choose or decide a plan, step, time or goal, and don't raise a new problem or wish of your own. One or two short sentences.",
  ].join("\n");
}

function decisionSchema(line: CaseLine): Record<string, unknown> {
  return {
    type: "object",
    properties: { reason: { type: "string" }, decision: { type: "string", enum: verdictsFor(line) } },
    required: ["reason", "decision"],
    additionalProperties: false,
  };
}

/**
 * Plays a case's lines (#230). Plain lines and the tester's own moves (`starts`) go out as written, like
 * `scriptedTester`. Before a line that answers ZOH, one call decides (with a reason, logged): already said
 * (skipped), fits (the wording itself is sent), close (a second call changes it to answer ZOH), passed (an optional
 * line ZOH moved past) or wait (a second call replies to ZOH without seeing the line). Past WAITS_PER_LINE or
 * WAITS_PER_CASE extra replies the run ends: graded as ZOH's miss when the line was `expected`, otherwise a case
 * problem. An empty reply is a case problem too, never a stand-in "ok".
 */
export function caseTester(c: RegressionCase, complete: Completer): Tester & { lines(): LineCounts } {
  const system = caseTesterSystemPrompt(c);
  const name = c.seed?.name ?? "";
  const counts: LineCounts = { exact: 0, adapted: 0, waited: 0, skipped: 0, passed: 0, log: [] };
  let usage = { input: 0, output: 0 };
  let i = 0;
  let waitsOnLine = 0;
  const ask = async (content: string, jsonSchema?: Record<string, unknown>) => {
    const res = await complete({ system, messages: [{ role: "user", content }], maxTokens: 1000, effort: "low", jsonSchema });
    usage = addUsage(usage, res.usage);
    return res.text;
  };
  const write = async (content: string, line: CaseLine, what: string): Promise<string | null> => {
    const text = cleanSimulatorText(await ask(content), name);
    if (text) return text;
    counts.problem = `the simulator wrote nothing ${what} “${line.say}”`;
    return null;
  };
  return {
    get endReason() {
      return counts.problem ? ("case-problem" as const) : ("script" as const);
    },
    usage: () => usage,
    lines: () => ({ ...counts, log: [...counts.log] }),
    async next(transcript) {
      for (;;) {
        const line = c.testerLines[i];
        if (line === undefined || counts.problem || counts.missed) return null;
        if (typeof line === "string" || line.starts) {
          i += 1;
          return lineText(line);
        }
        let decided: { reason?: string; decision?: string };
        try {
          decided = JSON.parse(await ask(lineDecisionPrompt(transcript, line), decisionSchema(line))) as typeof decided;
        } catch {
          throw new Error(`The simulator's decision for “${line.say}” wasn't JSON`);
        }
        const allowed = verdictsFor(line);
        // A decision the line doesn't allow (the schema should prevent it) is treated as not yet.
        const decision: LineVerdict = allowed.includes(decided.decision as LineVerdict) ? (decided.decision as LineVerdict) : "wait";
        counts.log.push({ line: i, say: line.say, decision, reason: decided.reason ?? "" });
        if (decision === "said" || decision === "passed") {
          counts[decision === "said" ? "skipped" : "passed"] += 1;
          i += 1;
          waitsOnLine = 0;
          continue;
        }
        if (decision === "fits") {
          counts.exact += 1;
          i += 1;
          waitsOnLine = 0;
          return line.say;
        }
        if (decision === "close") {
          counts.adapted += 1;
          i += 1;
          waitsOnLine = 0;
          return write(closeLinePrompt(transcript, line), line, "for");
        }
        if (waitsOnLine >= WAITS_PER_LINE || counts.waited >= WAITS_PER_CASE) {
          const where = waitsOnLine >= WAITS_PER_LINE ? `${waitsOnLine} extra replies on it` : `${counts.waited} extra replies in the case`;
          const what = `“${line.say}” never fit (${line.when}) after ${where}`;
          if (line.expected) counts.missed = `ZOH never reached it: ${what}`;
          else counts.problem = what;
          return null;
        }
        waitsOnLine += 1;
        counts.waited += 1;
        return write(waitingReplyPrompt(transcript), line, "while waiting for");
      }
    },
  };
}
