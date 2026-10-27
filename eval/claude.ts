import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "./types.js";

export interface CompletionRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  effort?: "low" | "medium" | "high";
  /** JSON schema for structured output. */
  jsonSchema?: Record<string, unknown>;
}

export interface Completion {
  text: string;
  usage: TokenUsage;
  stopReason: string | null;
}

/** One Claude call. The simulator and grader use this so tests can swap in fakes. */
export type Completer = (req: CompletionRequest) => Promise<Completion>;

export function createCompleter(opts: { apiKey: string; model: string; client?: Anthropic }): Completer {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 120_000 });
  return async (req) => {
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      output_config: {
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.jsonSchema ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
      },
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return {
      text,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      stopReason: response.stop_reason,
    };
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output };
}
