import { describe, expect, it } from "vitest";
import { makeDb } from "./helpers.js";
import { insertInboundOnce, insertOutbound, recentConversation } from "../src/db/messages.js";

describe("message order (#57)", () => {
  it("a reply saved in the same millisecond as its text still comes after it", async () => {
    const { db } = await makeDb();
    for (let i = 0; i < 200; i++) {
      const inbound = (await insertInboundOnce(db, { contactNumber: "+1", content: `in ${i}`, sendblueHandle: `h${i}` }))!;
      // The app's clock can read a moment before the database stamped the text.
      await insertOutbound(db, { contactNumber: "+1", content: `out ${i}`, inReplyTo: inbound.id, createdAt: new Date(inbound.createdAt.getTime() - 1) });
    }
    const rows = await recentConversation(db, "+1", 1000);
    expect(rows.map((r) => r.content)).toEqual(Array.from({ length: 200 }, (_, i) => [`in ${i}`, `out ${i}`]).flat());
  });

  it("a later reply keeps its own time", async () => {
    const { db } = await makeDb();
    const inbound = (await insertInboundOnce(db, { contactNumber: "+1", content: "hi", sendblueHandle: "h" }))!;
    const later = new Date(inbound.createdAt.getTime() + 5_000);
    const out = await insertOutbound(db, { contactNumber: "+1", content: "hey", inReplyTo: inbound.id, createdAt: later });
    expect(out.createdAt.getTime()).toBe(later.getTime());
  });
});
