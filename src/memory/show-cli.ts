/**
 * Prints one tester's memory, read-only: `npm run memory -- <last 4 digits of their number>`.
 * Needs DATABASE_URL (Railway's public Postgres URL to read production). Never prints full numbers.
 */
import { asc, eq, like } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { memoryPages, testers } from "../db/schema.js";
import { maskNumber } from "../pipeline/inbound.js";
import { renderPage, renderTimeline } from "./render.js";
import { timeline } from "./store.js";

const digits = process.argv[2]?.replace(/\D/g, "");
const url = process.env.DATABASE_URL;
if (!digits || digits.length < 4 || !url) {
  console.error("Usage: DATABASE_URL=... npm run memory -- <last 4 digits of their number>");
  process.exit(1);
}

const { db, close } = createDb(url);
try {
  const found = await db.select().from(testers).where(like(testers.phone, `%${digits}`));
  if (found.length !== 1) {
    console.error(found.length ? `${found.length} testers end in ${digits}; give more digits.` : `No tester ends in ${digits}.`);
    process.exitCode = 1;
  } else {
    const tester = found[0]!;
    console.log(`${tester.name ?? "(no name)"} ${maskNumber(tester.phone)} · memory written through ${tester.memoryThrough ?? "(not yet)"}\n`);
    const pages = await db.select().from(memoryPages).where(eq(memoryPages.testerId, tester.id)).orderBy(asc(memoryPages.kind), asc(memoryPages.date), asc(memoryPages.title));
    const order = ["self", "preferences", "goal", "person", "subject", "daily"];
    pages.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const page of pages) console.log(`${await renderPage(db, tester, page, { refs: true })}\n`);
    console.log(`TIMELINE (newest first)\n${renderTimeline(await timeline(db, tester, 30), tester)}`);
  }
} finally {
  await close();
}
