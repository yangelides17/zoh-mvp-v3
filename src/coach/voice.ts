import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The voice page. Same relative spot from `src/coach/` (tsx) and `dist/coach/` (production). */
export const VOICE_DOC_PATH = fileURLToPath(new URL("../../docs/coach-voice.md", import.meta.url));

const PEOPLE_ONLY = /<!-- people only -->[\s\S]*?<!-- \/people only -->/g;

/** The page as the coach reads it: everything except the `<!-- people only -->` parts. */
export function voiceForCoach(markdown: string): string {
  const stripped = markdown.replace(PEOPLE_ONLY, "");
  if (stripped.includes("people only -->")) throw new Error("coach-voice.md has an unclosed <!-- people only --> marker");
  return collapse(stripped);
}

const collapse = (text: string) => text.replace(/\n{3,}/g, "\n\n").trim();

/** #196: the page's rule sections, each under a heading marked `<!-- rules: <key> -->`. */
export const RULE_KEYS = ["tools", "plan", "nudges", "todaysStep", "proof", "weekLookback", "nextSteps", "team", "memory"] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export interface VoiceSections {
  /** The voice: the page without its rule sections. */
  voice: string;
  /** Each rule section's text, without its heading. */
  rules: Record<RuleKey, string>;
}

const RULES_HEADING = /^#+ .*<!-- rules: (\w+) -->\s*$/;

/**
 * Splits the page (as the coach reads it) into its voice and its rule sections. A rule section runs
 * from its marked heading to the next heading. A missing, unknown or repeated section throws, so the
 * app can't start with part of its instructions gone.
 */
export function splitVoicePage(page: string): VoiceSections {
  const voice: string[] = [];
  const rules: Partial<Record<RuleKey, string[]>> = {};
  let current: string[] = voice;
  for (const line of page.split("\n")) {
    const marked = RULES_HEADING.exec(line);
    if (marked) {
      const key = marked[1] as RuleKey;
      if (!RULE_KEYS.includes(key)) throw new Error(`coach-voice.md has an unknown rule section "${key}"`);
      if (rules[key]) throw new Error(`coach-voice.md has the rule section "${key}" twice`);
      current = rules[key] = [];
      continue;
    }
    if (/^#+ /.test(line)) current = voice;
    current.push(line);
  }
  const missing = RULE_KEYS.filter((k) => !rules[k]);
  if (missing.length) throw new Error(`coach-voice.md is missing the rule sections: ${missing.join(", ")}`);
  return {
    voice: collapse(voice.join("\n")),
    rules: Object.fromEntries(RULE_KEYS.map((k) => [k, collapse(rules[k]!.join("\n"))])) as Record<RuleKey, string>,
  };
}

/**
 * Reads the whole voice page (as the coach reads it, rule sections included), once at startup. A
 * missing or broken page throws, so the app fails to start (the deploy fails and the old version
 * keeps running) rather than a tester getting a broken reply.
 */
export function loadVoiceDoc(path: string = VOICE_DOC_PATH): string {
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Can't read the coach's voice page at ${path}: ${(err as Error).message}`);
  }
  const page = voiceForCoach(markdown);
  if (!page) throw new Error(`The coach's voice page at ${path} is empty`);
  splitVoicePage(page);
  return page;
}
