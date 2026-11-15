import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeModel } from "../claude/replier.js";
import type { ClaudeImage } from "../media/images.js";

/**
 * One line on what a photo shows, written as it arrives so memory can index and find it right away
 * (spec: GitHub issue "Coach memory"). Behind an interface: tests use a fake.
 */
export interface MediaDescriber {
  describe(image: ClaudeImage, caption?: string): Promise<string>;
  /** #163: one line on what a document is: a PDF (base64) or its text. */
  describeDocument(doc: { pdf: string } | { text: string }, caption?: string): Promise<string>;
}

export const DESCRIBE_INSTRUCTIONS = `Describe this photo in one plain line (at most 25 words) for a coach's searchable notes about the person who sent it: what it shows, and any readable detail that matters (a book title or page number, app stats, a time, a meal). If you can't make it out, say so plainly ("blurry photo, possibly a book"). Never guess or add anything that isn't visible. No preamble.`;

export const DESCRIBE_DOCUMENT_INSTRUCTIONS = `Describe this document in one plain line (at most 25 words) for a coach's searchable notes about the person who sent it: what it is and what it's about (an essay draft on…, a workout log for…, slides on…), with a telling detail (a title, a length, a date). Never guess or add anything that isn't in it. No preamble.`;

/** Enough of a long document's text to say what it is. */
const DESCRIBE_DOCUMENT_CHARS = 12_000;

export function createMediaDescriber(model: ClaudeModel): MediaDescriber {
  async function oneLine(system: string, content: Anthropic.ContentBlockParam[], caption?: string): Promise<string> {
    const response = await model.create({
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: [...content, { type: "text", text: caption?.trim() ? `Their caption: ${caption.trim()}` : "No caption." }] }],
      tools: [],
    });
    const line = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) throw new Error(`No description came back (stop_reason: ${response.stopReason})`);
    return line.slice(0, 300);
  }
  return {
    describe(image, caption) {
      return oneLine(DESCRIBE_INSTRUCTIONS, [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }], caption);
    },
    describeDocument(doc, caption) {
      const block: Anthropic.ContentBlockParam =
        "pdf" in doc
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.pdf } }
          : { type: "text", text: `<document>\n${doc.text.slice(0, DESCRIBE_DOCUMENT_CHARS)}\n</document>` };
      return oneLine(DESCRIBE_DOCUMENT_INSTRUCTIONS, [block], caption);
    },
  };
}
