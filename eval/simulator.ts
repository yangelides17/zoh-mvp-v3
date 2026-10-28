import { addUsage, type Completer } from "./claude.js";
import type { Tester } from "./harness.js";
import type { Persona, Scenario, TranscriptLine } from "./types.js";

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
  const lines = transcript.filter((l) => l.from !== "founder" && !l.console).map((l) => `${l.from === "tester" ? "YOU" : "ZOH"}: ${l.text}`);
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
