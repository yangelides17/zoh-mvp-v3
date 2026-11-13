import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { consoleMessages, type ConsoleMessage } from "../db/schema.js";

/**
 * #155: what the console chat proposes to do for the founders. It's a draft card in the chat until a
 * founder confirms it (Do it, or a typed yes): only then does anything happen. Confirming lives in
 * `chat.ts`, next to the capabilities it runs.
 */

/** How the coaches and the page name a draft: the first 8 characters of its id. */
export const draftRef = (id: string) => id.slice(0, 8);

export async function createDraft(
  db: Db,
  opts: { testerId: string; author: string; action: string; input: unknown; summary: string; at: Date },
): Promise<ConsoleMessage> {
  const [row] = await db
    .insert(consoleMessages)
    .values({
      testerId: opts.testerId,
      kind: "draft",
      author: opts.author,
      body: opts.summary,
      draftAction: opts.action,
      draftInput: opts.input,
      draftStatus: "draft",
      createdAt: opts.at,
    })
    .returning();
  return row!;
}

/** Drops a draft nobody confirmed; undefined when it isn't this tester's or isn't a draft any more. */
export async function cancelDraft(db: Db, opts: { testerId: string; draftId: string; by: string }): Promise<ConsoleMessage | undefined> {
  const [row] = await db
    .update(consoleMessages)
    .set({ draftStatus: "cancelled", draftResult: `Cancelled by ${opts.by}.` })
    .where(and(eq(consoleMessages.id, opts.draftId), eq(consoleMessages.testerId, opts.testerId), eq(consoleMessages.kind, "draft"), eq(consoleMessages.draftStatus, "draft")))
    .returning();
  return row;
}

/** Drafts still waiting for a founder, oldest first. */
export async function openDrafts(db: Db, testerId: string): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, testerId), eq(consoleMessages.kind, "draft"), eq(consoleMessages.draftStatus, "draft")))
    .orderBy(asc(consoleMessages.createdAt));
}

/** A draft by its full id or ref, this tester's only. */
export async function findDraft(db: Db, testerId: string, ref: string): Promise<ConsoleMessage | undefined> {
  const wanted = ref.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (wanted.length < 8) return undefined;
  const rows = await db.select().from(consoleMessages).where(and(eq(consoleMessages.testerId, testerId), eq(consoleMessages.kind, "draft")));
  return rows.find((r) => r.id.startsWith(wanted));
}
