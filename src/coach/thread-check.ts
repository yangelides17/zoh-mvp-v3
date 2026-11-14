import type { ClaudeModel } from "../claude/replier.js";

/** Where the coach is about to close out: after today's reflection, or at the end of onboarding. */
export type ClosingMoment = "next_step" | "plan";

/**
 * #157: a second read before the coach closes a conversation, from outside the coach (which leans toward wrapping
 * up). It sees the conversation and answers one question: is something they said still worth following up?
 */
export interface ThreadCheck {
  /** What's still open, in a few words, or undefined when it's time to close out. */
  open(conversation: string, moment: ClosingMoment): Promise<string | undefined>;
}

const MOMENTS: Record<ClosingMoment, string> = {
  next_step:
    "from the moment they sent proof of today's step until now. The coach is about to close the conversation by proposing tomorrow's step",
  plan: "from their first text until now, while the coach gets to know them. The coach is about to close this first conversation by proposing their plan",
};

const instructions = (moment: ClosingMoment) => `You read a text conversation between a habit coach (ZOH) and the person it coaches, ${MOMENTS[moment]}.

Answer one question: based on what the person just said, is it worth continuing the conversation first, or is this a good moment to close out?

Continue when their latest texts hold something the coach hasn't followed up yet: a worry, a feeling, a difficulty, a surprise, a story told part way, or a vague word the coach hasn't asked about. Close when they've said what they wanted to say and been heard, when their replies are getting short or flat, or when they're done, rushed or asking what's next. A plain yes, thanks or emoji is not something to follow up.

Reply with exactly one line: CLOSE, or OPEN: <what's still open, in under 12 words>.`;

export function createThreadCheck(model: ClaudeModel): ThreadCheck {
  return {
    async open(conversation, moment) {
      const res = await model.create({
        system: [{ type: "text", text: instructions(moment) }],
        messages: [{ role: "user", content: [{ type: "text", text: conversation }] }],
        tools: [],
        toolChoice: "none",
      });
      const answer = res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      const m = /^OPEN:\s*(.+)$/im.exec(answer);
      return m ? m[1]!.trim() : undefined;
    },
  };
}
