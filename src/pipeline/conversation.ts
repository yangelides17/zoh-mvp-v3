import type { Message } from "../db/schema.js";
import type { ClaudeImage } from "../media/images.js";

/**
 * #16: one reply at a time per tester. Each tester has a line: the texts waiting for a reply,
 * whether a draft is running, and their last typing signal from Sendblue. A text that arrives
 * while a draft runs interrupts it; the running reply then answers everything together.
 *
 * Kept in the app's memory, so each environment runs one app instance (docs/reference.md).
 */

/** How long a ready reply waits while they're typing, at most, per hold. */
export const TYPING_HOLD_MS = 30_000;
/** A "typing" signal older than this is ignored (a stuck signal never holds a reply). */
export const TYPING_FRESH_MS = 60_000;

/** A text's photo or voice note, made ready for the coach. */
export interface PreparedMedia {
  transcript?: string;
  image?: ClaudeImage;
}

/** One stored text waiting for (or covered by) the reply being written. */
export interface PendingText {
  inbound: Message;
  /** Media copy and transcription, started when the text arrived. */
  prepared: Promise<PreparedMedia | undefined>;
  timings: Record<string, string | number>;
  errors: string[];
  /** The typing bubble sent for this text. */
  typing: Promise<void>;
}

export class ReplyLine {
  /** A draft (or its send) is running for this tester. */
  running = false;
  /** Texts that arrived since the running draft took its batch. */
  pending: PendingText[] = [];
  /** They texted again since the current draft began. */
  interrupted = false;
  /** "stop" or "reset": drop what's being written and send nothing for it. */
  cancelled = false;
  typing?: { on: boolean; at: number };
  private abort = new AbortController();
  private wakers = new Set<() => void>();

  /** A fresh signal for the draft about to start. */
  startDraft(): AbortSignal {
    this.interrupted = false;
    this.abort = new AbortController();
    return this.abort.signal;
  }

  /** A text arrived (or a cancel): flag the running draft, cut off its Claude call, end any wait. */
  interrupt(): void {
    this.interrupted = true;
    this.abort.abort();
    this.wake();
  }

  /** Ends any wait early (a text, a typing change, a cancel). */
  wake(): void {
    for (const w of this.wakers) w();
    this.wakers.clear();
  }

  /** Resolves after `ms`, or sooner when woken. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.wakers.add(done);
    });
  }
}

export interface ReplyLinesOptions {
  /** Longest hold while they type; 0 turns the hold off (TYPING_HOLD_SECONDS). */
  holdMs?: number;
  /** How long a "typing" signal counts without a fresh one. */
  freshMs?: number;
  /** Real time in ms (tests can move it). */
  nowMs?: () => number;
}

/** Every tester's line, for one app. */
export class ReplyLines {
  readonly holdMs: number;
  readonly freshMs: number;
  readonly nowMs: () => number;
  private lines = new Map<string, ReplyLine>();

  constructor(opts: ReplyLinesOptions = {}) {
    this.holdMs = opts.holdMs ?? TYPING_HOLD_MS;
    this.freshMs = opts.freshMs ?? TYPING_FRESH_MS;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  line(phone: string): ReplyLine {
    let line = this.lines.get(phone);
    if (!line) {
      line = new ReplyLine();
      this.lines.set(phone, line);
    }
    return line;
  }

  /** A typing signal from Sendblue: remembered, and it ends a hold when they stop. */
  typing(phone: string, isTyping: boolean): void {
    const line = this.line(phone);
    line.typing = { on: isTyping, at: this.nowMs() };
    line.wake();
  }

  /** They're typing now: a fresh "typing" with no "stopped" since. */
  isTyping(phone: string): boolean {
    const t = this.lines.get(phone)?.typing;
    return Boolean(t?.on && this.nowMs() - t.at < this.freshMs);
  }

  /** "stop" or "reset": whatever is being written for them is dropped unsent. */
  cancel(phone: string): void {
    const line = this.lines.get(phone);
    if (!line?.running) return;
    line.cancelled = true;
    line.interrupt();
  }
}
