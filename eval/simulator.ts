import { addUsage, type Completer } from "./claude.js";
import type { Tester } from "./harness.js";
import { lineText, type CaseLine, type LineCounts, type Persona, type RegressionCase, type Scenario, type TranscriptLine } from "./types.js";

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

/** Extra replies a waiting line may take before the run is a case problem: per line, and for the whole case. */
export const WAITS_PER_LINE = 2;
export const WAITS_PER_CASE = 4;

const LENGTH_TEXT: Record<NonNullable<CaseLine["length"]>, string> = {
  thin: "very short: 1 to 4 words",
  short: "one short sentence",
  full: "a few sentences, like a real text",
};

/** How a case's tester texts when the case doesn't name a persona. */
const CASE_STYLE = "Casual. Short texts, lowercase is fine, no greetings; you answer what's asked like a normal person.";

export function caseTesterSystemPrompt(c: RegressionCase): string {
  return [
    `You are ${c.seed?.name ?? "a person"}, texting ZOH, a coaching service, from your phone.${c.seed ? ` What you're working on with it: ${c.seed.goal}.` : ""}`,
    "",
    "What's true about you (answer from this; if asked something it doesn't cover, give a plain, plausible answer that adds nothing new to the situation):",
    ...(c.facts?.length ? c.facts.map((f) => `- ${f}`) : ["- Nothing beyond what the conversation shows."]),
    "",
    `How you text: ${c.persona ? PERSONA_STYLE[c.persona] : CASE_STYLE}`,
    "",
    "Rules:",
    "- Write only text messages exactly as you'd type them. No quotes, names or stage directions.",
    "- Never mention or hint that you are an AI, a simulation or a test.",
    "- Never volunteer facts beyond the list above, and never do ZOH's job for it (don't propose plans or steps yourself).",
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

/** Asks whether a waiting line fits ZOH's latest text, and what to send if it doesn't quite. */
export function lineDecisionPrompt(transcript: TranscriptLine[], line: CaseLine): string {
  return [
    conversationForTester(transcript),
    "---",
    "Your next planned text:",
    `- Wording: ${line.say}`,
    ...(line.means ? [`- What it must get across: ${line.means}`] : []),
    `- It fits: ${line.when}`,
    `- Length: ${line.length ? LENGTH_TEXT[line.length] : "about as long as the wording"}`,
    "",
    "Decide, looking at ZOH's latest text:",
    `- "said": you've already got this text's point across earlier in the conversation, so sending it would repeat you. (Nothing is sent for it.)`,
    `- "fits": ZOH's latest text is that moment and the wording answers it as written. (The wording is sent; your text is ignored.)`,
    ...(line.fixed
      ? []
      : [
          `- "close": it's that moment, but the wording doesn't quite answer what ZOH actually said. Text: the wording changed as little as possible to answer it, same length, carrying only this text's own point: nothing else from what's true about you, and nothing you haven't been asked yet.`,
        ]),
    `- "wait": ZOH isn't at that moment yet (e.g. it asked something else first). Text: a natural reply to ZOH's latest text from what's true about you${
      line.lead
        ? ", steering the topic gently toward the planned text. Never ask ZOH to suggest, propose, plan or decide anything for you: that's what's being tested"
        : ""
    }.`,
  ].join("\n");
}

/** The reply written while a "don't lead" line waits: it never sees the line. */
export function waitingReplyPrompt(transcript: TranscriptLine[]): string {
  return `${conversationForTester(transcript)}\n\n---\n\nWrite your next text: a natural reply to ZOH's latest text from what's true about you.`;
}

function decisionSchema(fixed: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: { decision: { type: "string", enum: fixed ? ["said", "fits", "wait"] : ["said", "fits", "close", "wait"] }, text: { type: "string" } },
    required: ["decision", "text"],
    additionalProperties: false,
  };
}

/**
 * Plays a case's lines (#230). Plain lines and lines that start an exchange go out as written, like
 * `scriptedTester`. A line with a moment waits for it: the simulator decides whether its point was already made
 * (skipped), ZOH's latest text fits ("fits" sends the wording itself), is close (a minimal change, never for a fixed
 * line) or isn't there yet (a reply from the facts). Past WAITS_PER_LINE or WAITS_PER_CASE extra replies, the run
 * stops as a case problem.
 */
export function caseTester(c: RegressionCase, complete: Completer): Tester & { lines(): LineCounts } {
  const system = caseTesterSystemPrompt(c);
  const name = c.seed?.name ?? "";
  const counts: LineCounts = { exact: 0, adapted: 0, waited: 0, skipped: 0 };
  let usage = { input: 0, output: 0 };
  let i = 0;
  let waitsOnLine = 0;
  const ask = async (content: string, jsonSchema?: Record<string, unknown>) => {
    const res = await complete({ system, messages: [{ role: "user", content }], maxTokens: 1000, effort: "low", jsonSchema });
    usage = addUsage(usage, res.usage);
    return res.text;
  };
  return {
    get endReason() {
      return counts.problem ? ("case-problem" as const) : ("script" as const);
    },
    usage: () => usage,
    lines: () => ({ ...counts }),
    async next(transcript) {
      let line = c.testerLines[i];
      let decided: { decision?: string; text?: string } = {};
      // A line whose point was already made is skipped, so the tester never repeats itself (#230 trial).
      for (;;) {
        if (line === undefined || counts.problem) return null;
        if (typeof line === "string" || line.starts) {
          i += 1;
          return lineText(line);
        }
        try {
          decided = JSON.parse(await ask(lineDecisionPrompt(transcript, line), decisionSchema(line.fixed))) as typeof decided;
        } catch {
          throw new Error(`The simulator's decision for “${line.say}” wasn't JSON`);
        }
        if (decided.decision !== "said") break;
        counts.skipped += 1;
        i += 1;
        waitsOnLine = 0;
        line = c.testerLines[i];
      }
      if (decided.decision === "fits" || (decided.decision === "close" && !line.fixed)) {
        i += 1;
        waitsOnLine = 0;
        if (decided.decision === "fits") {
          counts.exact += 1;
          return line.say;
        }
        counts.adapted += 1;
        return cleanSimulatorText(decided.text ?? "", name) || line.say;
      }
      if (waitsOnLine >= WAITS_PER_LINE || counts.waited >= WAITS_PER_CASE) {
        const where = waitsOnLine >= WAITS_PER_LINE ? `${waitsOnLine} extra replies on it` : `${counts.waited} extra replies in the case`;
        counts.problem = `“${line.say}” never fit (${line.when}) after ${where}`;
        return null;
      }
      waitsOnLine += 1;
      counts.waited += 1;
      const reply = line.lead ? (decided.text ?? "") : await ask(waitingReplyPrompt(transcript));
      return cleanSimulatorText(reply, name) || "ok";
    },
  };
}
