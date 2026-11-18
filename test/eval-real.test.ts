import { describe, expect, it } from "vitest";
import { buildReplay, findSignals, maskText, numberLike, type Msg, type ReplayInput } from "../eval/real.js";
import { caseSchema } from "../eval/types.js";

const t0 = Date.parse("2026-11-10T23:00:00Z");
let seq = 0;
const msg = (direction: Msg["direction"], content: string, minutes: number): Msg => ({ id: `m${String(++seq).padStart(3, "0")}`, direction, content, createdAt: new Date(t0 + minutes * 60_000) });

describe("eval: real conversations worth a look (#197)", () => {
  it("picks out stop, silence after a question, a correction and a sudden short reply, each pointing at the ZOH text before it", () => {
    const msgs = [
      msg("outbound", "Hey Dana! What time works for your walk?", 0),
      msg("inbound", "I already said 7, before work", 2),
      msg("outbound", "Got it, 7 it is. How did the walk feel today?", 3),
      msg("inbound", "honestly it was great, the river was so calm and i actually noticed the birds for once", 5),
      msg("inbound", "and i felt way less stressed walking into work than i usually do on mondays", 6),
      msg("inbound", "my coworker even asked what changed because i was in such a good mood all morning", 7),
      msg("outbound", "Love that. What made the difference, the quiet or the timing?", 8),
      msg("inbound", "k", 9),
      msg("outbound", "Want to try 10 more minutes tomorrow?", 10),
      // No reply for two days.
      msg("outbound", "Dana, still on for 7?", 60 * 50),
      msg("inbound", "STOP", 60 * 50 + 1),
    ];
    const signals = findSignals(msgs, new Date(t0 + 60 * 60_000 * 60));
    expect(signals.map((s) => [s.kind, s.zohId])).toEqual([
      ["correction", msgs[0]!.id],
      ["short-reply", msgs[6]!.id],
      ["silence", msgs[8]!.id],
      ["stop", msgs[9]!.id],
    ]);
  });
});

describe("eval: real replays carry no names or phone numbers (#197)", () => {
  it("masks the tester's name (each part), the people they mention, emails and numbers", () => {
    const masked = maskText("Dana Reyes here, text Marco at (212) 555-0101 or dana.r@mail.com. dana says hi", ["Dana Reyes", "Marco"]);
    expect(masked).toBe("Alex here, text Sam at [number] or [email]. Alex says hi");
    expect(numberLike(masked)).toBe(false);
    // Times never read as a number.
    expect(numberLike("6:30, 7:00 or 8:15 tomorrow?")).toBe(false);
    expect(numberLike("my code is 555/123/4567")).toBe(true);
  });

  const base = (): ReplayInput => {
    seq = 100;
    const msgs = [
      msg("inbound", "hey its Dana", 0),
      msg("outbound", "Hey Dana! What do you want to work on?", 1),
      msg("inbound", "reading. my sister Priya got me into it", 2),
      msg("outbound", "Love that. Where will you read?", 3),
      msg("inbound", "on the couch, I told you that yesterday", 4),
      msg("outbound", "Got it. And where will you read?", 5),
      msg("inbound", "i already said the couch", 6),
    ];
    return {
      tester: { name: "Dana Reyes", phase: "onboarding", goalSlug: "read-more", timeZone: "America/New_York" },
      otherNames: ["Priya", "Mom"],
      answers: { what: "reading, Dana's pick", where: "the couch" },
      msgs,
      zohId: msgs[5]!.id,
      signal: "correction",
      id: "replay-correction-11-10",
    };
  };

  it("cuts just before the ZOH text that went wrong, as a replay case with everything masked", () => {
    const res = buildReplay(base());
    if (!("replay" in res)) throw new Error(res.refused);
    const c = res.replay;
    expect(caseSchema.parse(c)).toEqual(c);
    expect(c.suite).toBe("replay");
    expect(c.testerLines).toEqual(["on the couch, I told you that yesterday"]);
    expect(c.seed!.history.map((h) => h.text)).toEqual(["hey its Alex", "Hey Alex! What do you want to work on?", "reading. my sister Sam got me into it", "Love that. Where will you read?"]);
    expect(c.whatWentWrong).toBe('ZOH replied "Got it. And where will you read?", and the tester answered "i already said the couch".');
    expect(c.seed).toMatchObject({ name: "Alex", phase: "onboarding", answers: { what: "reading, Alex's pick", where: "the couch" } });
    expect(c).toMatchObject({ startTime: "18:04", startDay: "tue", timeZone: "America/New_York" });
    const json = JSON.stringify(c);
    for (const real of ["Dana", "Reyes", "Priya"]) expect(json).not.toContain(real);
  });

  it("refuses a moment where something number-like is left after masking", () => {
    const input = base();
    input.msgs[4] = { ...input.msgs[4]!, content: "on the couch. my locker is 555/123/4567" };
    expect(buildReplay(input)).toEqual({ refused: "Something number-like is left after masking, so it's left out." });
  });

  it("leaves out a possibly sensitive conversation, and a text ZOH started itself", () => {
    const input = base();
    input.msgs[2] = { ...input.msgs[2]!, content: "reading. my therapist suggested it" };
    expect(buildReplay(input)).toEqual({ refused: "Possibly sensitive (health or a personal crisis), so it's left out." });
    const started = base();
    started.zohId = started.msgs[1]!.id;
    started.msgs.splice(0, 1);
    expect("refused" in buildReplay(started)).toBe(true);
  });
});
