import Anthropic from "@anthropic-ai/sdk";

/** One turn of the text conversation, already flattened to what Claude should see. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Public image URL to show Claude (only for the latest inbound photo). */
  imageUrl?: string;
}

export interface Replier {
  reply(turns: Turn[]): Promise<string>;
  /** Cheap connectivity check for /health?deep=1. */
  check(): Promise<void>;
}

/** Placeholder until the coach exists: a generic, friendly texting assistant. */
export const GENERIC_SYSTEM_PROMPT = [
  "You are a friendly assistant replying to someone over iMessage.",
  "Keep replies short and natural, like a text message: usually one to three sentences.",
  "No markdown, bullet points or headings. Plain text only.",
  "If they send a photo, respond to what you see. If a message says it's a voice note transcript, respond to what they said.",
].join(" ");

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } };

/**
 * Turns into Claude messages: starts with a user turn, merges consecutive
 * same-role turns, and ends with a user turn.
 */
export function toClaudeMessages(turns: Turn[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: ContentBlock[] }[] = [];
  for (const turn of turns) {
    const blocks: ContentBlock[] = [];
    if (turn.imageUrl) blocks.push({ type: "image", source: { type: "url", url: turn.imageUrl } });
    if (turn.text.trim()) blocks.push({ type: "text", text: turn.text });
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content.push(...blocks);
    else out.push({ role: turn.role, content: blocks });
  }
  while (out[0]?.role === "assistant") out.shift();
  while (out.length > 0 && out[out.length - 1]?.role === "assistant") out.pop();
  return out as Anthropic.MessageParam[];
}

export interface ClaudeReplierOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  systemPrompt?: string;
  client?: Anthropic;
}

export function createClaudeReplier(opts: ClaudeReplierOptions): Replier {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 30_000 });
  return {
    async reply(turns) {
      const messages = toClaudeMessages(turns);
      if (messages.length === 0) throw new Error("Nothing to reply to");
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.systemPrompt ?? GENERIC_SYSTEM_PROMPT,
        messages,
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) throw new Error(`Claude returned no text (stop_reason: ${response.stop_reason})`);
      return text;
    },
    async check() {
      await client.models.retrieve(opts.model);
    },
  };
}
