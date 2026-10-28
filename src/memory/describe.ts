import type { ClaudeModel } from "../claude/replier.js";
import type { ClaudeImage } from "../media/images.js";

/**
 * One line on what a photo shows, written as it arrives so memory can index and find it right away
 * (spec: GitHub issue "Coach memory"). Behind an interface: tests use a fake.
 */
export interface MediaDescriber {
  describe(image: ClaudeImage, caption?: string): Promise<string>;
}

export const DESCRIBE_INSTRUCTIONS = `Describe this photo in one plain line (at most 25 words) for a coach's searchable notes about the person who sent it: what it shows, and any readable detail that matters (a book title or page number, app stats, a time, a meal). If you can't make it out, say so plainly ("blurry photo, possibly a book"). Never guess or add anything that isn't visible. No preamble.`;

export function createMediaDescriber(model: ClaudeModel): MediaDescriber {
  return {
    async describe(image, caption) {
      const response = await model.create({
        system: [{ type: "text", text: DESCRIBE_INSTRUCTIONS }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
              { type: "text", text: caption?.trim() ? `Their caption: ${caption.trim()}` : "No caption." },
            ],
          },
        ],
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
    },
  };
}
