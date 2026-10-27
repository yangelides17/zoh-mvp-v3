import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The voice page. Same relative spot from `src/coach/` (tsx) and `dist/coach/` (production). */
export const VOICE_DOC_PATH = fileURLToPath(new URL("../../docs/coach-voice.md", import.meta.url));

const PEOPLE_ONLY = /<!-- people only -->[\s\S]*?<!-- \/people only -->/g;

/** The page as the coach reads it: everything except the `<!-- people only -->` parts. */
export function voiceForCoach(markdown: string): string {
  const stripped = markdown.replace(PEOPLE_ONLY, "");
  if (stripped.includes("people only -->")) throw new Error("coach-voice.md has an unclosed <!-- people only --> marker");
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Reads the voice page once, when the coach is built at startup. A missing or broken page throws,
 * so the app fails to start (the deploy fails and the old version keeps running) rather than a
 * tester getting a broken reply.
 */
export function loadVoiceDoc(path: string = VOICE_DOC_PATH): string {
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Can't read the coach's voice page at ${path}: ${(err as Error).message}`);
  }
  const voice = voiceForCoach(markdown);
  if (!voice) throw new Error(`The coach's voice page at ${path} is empty`);
  return voice;
}
