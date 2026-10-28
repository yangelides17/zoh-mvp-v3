import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COACH_HISTORY_CAP, createCoach, MAX_ROUNDS } from "../src/coach/coach.js";
import {
  buildStateBlock,
  CORE_VOICE,
  EXAMPLES,
  FIXED_INSTRUCTIONS,
  MEMORY,
  fullVoiceInstructions,
  NUDGES,
  ONBOARDING,
  PLAN_AGREEMENT,
  PROMPT_BUDGET_CHARS,
  PROOF,
  TOOL_RULES,
} from "../src/coach/prompt.js";
import { loadVoiceDoc, voiceForCoach, VOICE_DOC_PATH } from "../src/coach/voice.js";
import { readFileSync } from "node:fs";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import type { Db } from "../src/db/client.js";
import { flags, messages, planInputs, type Tester } from "../src/db/schema.js";
import { FALLBACK_REPLY, SYSTEM_DOWN_REPLY } from "../src/pipeline/inbound.js";
import { OPT_OUT_CONFIRMATION } from "../src/testers/commands.js";
import { getTesterByPhone, updateTester } from "../src/testers/testers.js";
import { DEV, FakeClaudeModel, ME, WESTERN, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

const GOAL_LINES = [
  "• Daily reading",
  "• Daily exercise",
  "• Daily nutrition",
  "• Daily reflection and planning",
  "• Daily deep work target",
  "• Same bedtime every night",
  "• Something else",
];

let t: TestApp;
let model: FakeClaudeModel;

async function text(from: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await postWebhook(t, inboundEvent({ content, from_number: from, number: from, ...extra }));
  expect(res.statusCode).toBe(200);
  await t.queue.idle();
}

async function tester(phone = ME): Promise<Tester> {
  const row = await getTesterByPhone(t.db, phone);
  if (!row) throw new Error("no tester row");
  return row;
}

async function inputs(phone = ME) {
  const row = await tester(phone);
  return (await t.db.select().from(planInputs).where(eq(planInputs.testerId, row.id)))[0];
}

const sent = () => t.sendblue.sends.map((s) => s.content);

beforeEach(async () => {
  const { db } = await makeDb();
  model = new FakeClaudeModel();
  t = await makeApp({ replier: createCoach({ db, model }) });
});
afterEach(async () => {
  await t.close();
});

describe("first text", () => {
  it("creates the tester and asks the coach with first-text state, the intro rules and the goal list", async () => {
    model.script("Yo! I'm ZOH…");
    await text(ME, "Start");

    expect(await tester()).toMatchObject({ phase: "onboarding", name: null, goalSlug: null });
    expect(model.requests).toHaveLength(1);
    const req = model.requests[0]!;
    expect(req.system[0]).toMatchObject({ text: FIXED_INSTRUCTIONS, cache_control: { type: "ephemeral" } });
    expect(req.system[0]!.text).toContain('they can text "stop" anytime');
    // The coaching-style line belongs in the intro, not dropped mid-conversation.
    expect(req.system[0]!.text).toContain('"stop" anytime, and they can change how you coach anytime');
    expect(req.system[0]!.text.match(/change how you coach/g)).toHaveLength(1);
    expect(req.system[0]!.text).toContain("start one thing and actually stick with it");
    const state = model.stateOf();
    expect(state).toContain(`First text from this tester: yes. After the intro, ask "What's your name, and what are you looking to work on?"`);
    expect(state).toContain(GOAL_LINES.join("\n"));
    expect(state).toContain("Time zone: Eastern (assumed");
    expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Start", cache_control: { type: "ephemeral" } }] }]);
    expect(sent()).toEqual(["Yo! I'm ZOH…"]);
  });

  it("asks only for the name when the first text gives a goal without one", async () => {
    model.script({ tools: [{ name: "choose_goal", input: { slug: "nutrition" } }] }, "150g a day, let's go! I'm ZOH… What's your name?");
    await text(ME, "hey wanna hit 150g protein a day");
    expect(model.stateOf()).toContain("Their goal is known: skip the list");
    expect(model.stateOf()).toContain("Your one question: their name.");
  });

  it("asks only for the goal when the first text gives a name without one", async () => {
    model.script({ tools: [{ name: "save_name", input: { name: "Pat" } }] }, "Pat! I'm ZOH…");
    await text(ME, "hi, I'm Pat");
    expect(model.stateOf()).toContain('ask "What are you looking to work on?" followed by the goal list');
  });

  it("is no longer the first text once ZOH has replied", async () => {
    await text(ME, "Start");
    await text(ME, "Alex");
    expect(model.stateOf()).toContain("First text from this tester: no");
  });

  it("saves a name and goal given in the first text and keeps the state current within the reply", async () => {
    model.script(
      { tools: [{ name: "save_name", input: { name: "Maya" } }, { name: "choose_goal", input: { slug: "reflection" } }] },
      { tools: [{ name: "save_plan_inputs", input: { what: "journaling", where: "home", when: "mornings before work", how_long: "10 min" } }] },
      "Maya! I'm ZOH…",
    );
    await text(ME, "hi! I'm Maya, I want to journal every morning at home before work, maybe 10 min");
    expect(await tester()).toMatchObject({ name: "Maya", goalSlug: "reflection" });
    expect(model.stateOf(0)).toContain('ask "What\'s your name, and what are you looking to work on?"');
    expect(model.stateOf(1)).toContain("Their goal is known: skip the list");
    expect(model.stateOf(1)).toContain("Then ask the next open question.");
    expect(model.stateOf(1)).toContain("Name: Maya");
    expect(model.stateOf(1)).toContain("Goal: Daily reflection and planning [reflection]");
    // All of reflection's required questions were answered at once, so this is already the recap turn.
    expect((await tester()).phase).toBe("planning");
    expect(model.stateOf()).toContain("ONBOARDING JUST FINISHED");
  });
});

describe("tools", () => {
  let db: Db;
  const at = new Date("2026-10-27T15:00:00Z");
  async function state(phone = ME) {
    return loadCoachState(db, await tester(phone), { now: at, isFirstText: false });
  }
  const run = async (name: string, input: unknown, phone = ME) => runTool(db, await state(phone), name, input, at);

  beforeEach(async () => {
    db = t.db;
    await text(ME, "Start");
    await text(WESTERN, "Start");
  });

  it("notes a possibly non-Eastern time zone without asking the city during onboarding", async () => {
    await text(WESTERN, "hey");
    const westernState = model.stateOf();
    expect(westernState).toContain("Time zone: possibly outside Eastern (area code), best guess America/Denver. Don't ask their city");
    expect(FIXED_INSTRUCTIONS).not.toMatch(/ask (their|what) city/);
    expect((await tester(WESTERN)).timeZoneStatus).toBe("needs_city");
  });

  it("save_name saves the name and rejects an empty one", async () => {
    expect(await run("save_name", { name: "  " })).toMatchObject({ ok: false });
    expect(await run("save_name", { name: "Alex" })).toMatchObject({ ok: true });
    expect((await tester()).name).toBe("Alex");
  });

  it("choose_goal saves a listed goal and rejects an unknown slug", async () => {
    expect(await run("choose_goal", { slug: "juggling" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown goal") });
    expect((await tester()).goalSlug).toBeNull();
    expect(await run("choose_goal", { slug: "exercise", accepted: true })).toMatchObject({ ok: false });
    expect(await run("choose_goal", { slug: "exercise" })).toMatchObject({ ok: true });
    expect((await tester()).goalSlug).toBe("exercise");
    expect(await inputs()).toMatchObject({ goalSlug: "exercise", what: null });
  });

  it("a declined something-else saves an off_list_goal flag and no goal", async () => {
    expect(await run("choose_goal", { slug: "something_else", description: "learn guitar" })).toMatchObject({ ok: false });
    expect(await run("choose_goal", { slug: "something_else", description: "learn guitar", accepted: false })).toMatchObject({ ok: true });
    expect((await tester()).goalSlug).toBeNull();
    expect(await inputs()).toBeUndefined();
    expect(await db.select().from(flags)).toEqual([expect.objectContaining({ kind: "off_list_goal", detail: "learn guitar" })]);
    expect((await state()).declinedGoals).toEqual(["learn guitar"]);
  });

  it("an accepted something-else is stored with its description", async () => {
    expect(await run("choose_goal", { slug: "something_else", description: "daily stretching", accepted: true })).toMatchObject({ ok: true });
    expect((await tester()).goalSlug).toBe("something_else");
    expect((await inputs())?.extraNotes).toEqual({ goal_description: "daily stretching" });
    expect(await db.select().from(flags)).toHaveLength(0);
    expect(buildStateBlock(await state())).toContain("Goal: Something else (daily stretching) [something_else]");
  });

  it("save_plan_inputs saves several answers at once and none of them shows as still open", async () => {
    expect(await run("save_plan_inputs", { what: "lifting" })).toMatchObject({ ok: false, error: "Choose a goal first." });
    await run("choose_goal", { slug: "exercise" });
    expect(await run("save_plan_inputs", {})).toMatchObject({ ok: false });
    expect(await run("save_plan_inputs", { what: "lifting", mood: "great" })).toMatchObject({ ok: false });
    expect(await run("save_plan_inputs", { where: "home, dumbbells", when: "mornings 7:30", how_long: "20 min" })).toMatchObject({
      ok: true,
    });
    expect(await inputs()).toMatchObject({ where: "home, dumbbells", when: "mornings 7:30", howLong: "20 min", what: null });
    const s = await state();
    expect(s.openRequired.map((q) => q.key)).toEqual(["what", "tracks_with"]);
    const block = buildStateBlock(s);
    expect(block).toContain("- where: home, dumbbells\n- when: mornings 7:30\n- how long: 20 min");
    expect(block).toContain("Still open, required: what [what], tracks with [tracks_with]");
    // A later answer overwrites the earlier one.
    await run("save_plan_inputs", { when: "evenings" });
    expect(await inputs()).toMatchObject({ when: "evenings", where: "home, dumbbells" });
  });

  it("save_plan_inputs rejects a question the goal doesn't use", async () => {
    await run("choose_goal", { slug: "reading" });
    expect(await run("save_plan_inputs", { tracks_with: "Goodreads" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("tracks_with doesn't apply"),
    });
    expect((await inputs())?.tracksWith).toBeNull();
  });

  it("set_time_zone only works when the status is needs_city, and only with a real zone", async () => {
    expect(await run("set_time_zone", { city: "Chicago", time_zone: "America/Chicago" })).toMatchObject({ ok: false });
    expect((await tester()).timeZone).toBe("America/New_York");
    expect(await run("set_time_zone", { city: "Denver", time_zone: "Mountain" }, WESTERN)).toMatchObject({ ok: false });
    expect(await run("set_time_zone", { city: "Boulder", time_zone: "America/Denver" }, WESTERN)).toMatchObject({ ok: true });
    expect(await tester(WESTERN)).toMatchObject({ timeZone: "America/Denver", timeZoneStatus: "confirmed" });
    expect(await run("set_time_zone", { city: "LA", time_zone: "America/Los_Angeles" }, WESTERN)).toMatchObject({ ok: false });
  });

  it("set_quiet_hours saves 24-hour times and rejects anything else", async () => {
    expect(await run("set_quiet_hours", { start: "11pm", end: "7am" })).toMatchObject({ ok: false });
    expect(await run("set_quiet_hours", { start: "23:00", end: "23:00" })).toMatchObject({ ok: false });
    expect(await run("set_quiet_hours", { start: "23:00", end: "07:30" })).toMatchObject({ ok: true });
    expect(await tester()).toMatchObject({ quietHoursStart: "23:00", quietHoursEnd: "07:30" });
  });

  it("save_preference adds to the style notes, in any phase", async () => {
    model.script({ tools: [{ name: "save_preference", input: { preference: "no emojis" } }] }, "Got it, no emojis.");
    await text(ME, "no emojis pls");
    model.script({ tools: [{ name: "save_preference", input: { preference: "chill out" } }] }, "Dialing it back.");
    await text(ME, "chill out a bit");
    expect((await tester()).styleNotes).toBe("no emojis; chill out");
  });

  it("rejects unknown tools", async () => {
    expect(await run("propose_plan", {})).toMatchObject({ ok: false });
  });

  it("sends a rejected call back to Claude as an error so it can fix it", async () => {
    model.script({ tools: [{ name: "choose_goal", input: { slug: "juggling" } }] }, "Which one sounds best?");
    await text(ME, "juggling");
    const results = model.requests.at(-1)!.messages.at(-1)!;
    expect(results.content).toEqual([
      expect.objectContaining({ type: "tool_result", is_error: true, content: expect.stringContaining("Unknown goal") }),
    ]);
    expect(sent().at(-1)).toBe("Which one sounds best?");
  });
});

describe("finishing onboarding", () => {
  it("moves to planning when the last required answer is saved; that reply carries on into the plan with no recap; later texts don't restart onboarding", async () => {
    model.script(
      "intro",
      { tools: [{ name: "save_name", input: { name: "Alex" } }, { name: "choose_goal", input: { slug: "exercise" } }] },
      "Let's go, Alex. Have you lifted before?",
      { tools: [{ name: "save_plan_inputs", input: { what: "dumbbells, used to lift in college", where: "home, has dumbbells" } }] },
      "When are you free?",
      { tools: [{ name: "save_plan_inputs", input: { when: "mornings 7:30", how_long: "20 min" } }] },
      "Do you track workouts anywhere?",
    );
    await text(ME, "Start");
    await text(ME, "Alex. Exercise, wanna get back to the gym");
    await text(ME, "used to lift in college, home with dumbbells");
    await text(ME, "mornings 7:30, 20 min tops");
    expect((await tester()).phase).toBe("onboarding");
    expect(model.stateOf()).toContain("Still open, required: tracks with [tracks_with]");
    expect(model.stateOf()).toContain("Onboarding is NOT finished");

    model.script({ tools: [{ name: "save_plan_inputs", input: { tracks_with: "doesn't track it" } }] }, "Which exercises do you like doing with the dumbbells?");
    await text(ME, "nah I don't track it");
    expect((await tester()).phase).toBe("planning");
    expect(await inputs()).toMatchObject({ tracksWith: "doesn't track it" });
    const handoff = model.stateOf();
    expect(handoff).toContain("ONBOARDING JUST FINISHED");
    expect(handoff).toContain("carry straight on into PLAN AGREEMENT, no recap");
    expect(handoff).toContain("without saying you have everything");
    expect(handoff).not.toMatch(/buffering|on its way/);
    expect(handoff).toContain("Still open, required: none");
    expect(handoff).toContain("Plan: not proposed yet");
    expect(model.requests.at(-1)!.messages.at(-1)!.content).toEqual([
      expect.objectContaining({ content: expect.stringContaining("Onboarding finished: ask the next thing the plan needs, or bridge into the plan") }),
    ]);
    // The reply that finishes onboarding can already propose the plan.
    expect(model.requests.at(-1)!.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["propose_plan", "lock_plan"]));

    model.script("Here's your plan…");
    await text(ME, "rows and presses mostly");
    const later = model.stateOf();
    expect(later).toContain("Phase: planning");
    expect(later).not.toContain("ONBOARDING JUST FINISHED");
    expect(later).toContain("Still open, required: none");
    const fixed = model.requests.at(-1)!.system[0]!.text;
    expect(fixed).toContain('PLAN AGREEMENT (phases "planning" and "active"; none of this applies during onboarding)');
    expect(fixed).not.toContain("PLAN COMING");
    expect(model.requests.at(-1)!.tools.map((x) => x.name)).not.toContain("choose_goal");
    expect((await tester()).phase).toBe("planning");
  });

  it("doesn't finish without a goal, or with optional questions only", async () => {
    model.script({ tools: [{ name: "choose_goal", input: { slug: "nutrition" } }] }, "ok");
    await text(ME, "nutrition");
    model.script({ tools: [{ name: "save_plan_inputs", input: { what: "120g protein" } }] }, "ok");
    await text(ME, "120g protein a day");
    expect((await tester()).phase).toBe("onboarding");
    // nutrition's "when" is optional: tracks_with is the last required one.
    model.script({ tools: [{ name: "save_plan_inputs", input: { tracks_with: "MyFitnessPal" } }] }, "recap");
    await text(ME, "I use MyFitnessPal");
    expect((await tester()).phase).toBe("planning");
  });

  it("asks tracks_with only for exercise, nutrition, bedtime and deep work", async () => {
    await text(ME, "Start");
    const row = await tester();
    const required: Record<string, string[]> = {};
    for (const slug of ["reading", "exercise", "nutrition", "reflection", "deep_work", "bedtime", "something_else"]) {
      await updateTester(t.db, row.id, { goalSlug: slug });
      const s = await loadCoachState(t.db, await tester(), { now: new Date(), isFirstText: false });
      required[slug] = s.openRequired.map((q) => q.key);
    }
    expect(required).toEqual({
      reading: ["what", "when", "how_long"],
      exercise: ["what", "where", "when", "how_long", "tracks_with"],
      nutrition: ["what", "tracks_with"],
      reflection: ["what", "when", "how_long"],
      deep_work: ["what", "when", "how_long", "tracks_with"],
      bedtime: ["what", "when", "tracks_with"],
      something_else: ["what", "where", "when", "how_long"],
    });
  });
});

describe("memory", () => {
  it("sees the whole conversation since context start, past 12 messages", async () => {
    for (let i = 1; i <= 10; i++) await text(ME, `text ${i}`);
    const msgs = model.requests.at(-1)!.messages;
    // 10 inbound + 9 replies, merged into alternating turns.
    expect(msgs).toHaveLength(19);
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "text 1" }] });
    expect(COACH_HISTORY_CAP).toBeGreaterThanOrEqual(200);
  });

  it("sees nothing from before a reset", async () => {
    await text(DEV, "old stuff, I'm Stamati");
    await text(DEV, "more old stuff");
    await text(DEV, "reset");
    expect(model.stateOf()).toContain("First text from this tester: yes");
    expect(model.requests.at(-1)!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "reset", cache_control: { type: "ephemeral" } }] }]);
    await text(DEV, "hey");
    const contents = JSON.stringify(model.requests.at(-1)!.messages);
    expect(contents).not.toContain("old stuff");
  });

  it("keeps showing photos to the coach", async () => {
    await text(ME, "look", { media_url: "https://cdn.example/photo.jpg" });
    const content = model.requests.at(-1)!.messages[0]!.content as { type: string }[];
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(content[1]).toEqual({ type: "text", text: "[Sent a photo]\nlook", cache_control: { type: "ephemeral" } });
  });
});

describe("opting out and failures", () => {
  it('"stop" never reaches the coach', async () => {
    await text(ME, "stop");
    expect(model.requests).toHaveLength(0);
    expect(sent()).toEqual([OPT_OUT_CONFIRMATION]);
  });

  it('"leave me alone" reaches the coach, and the opt-out tool stops them with the exact confirmation', async () => {
    await text(ME, "Start");
    model.script({ tools: [{ name: "opt_out", input: {} }], text: "Sorry to see you go!" });
    await text(ME, "leave me alone");
    expect((await tester()).stoppedAt).toBeInstanceOf(Date);
    expect(sent().at(-1)).toBe(OPT_OUT_CONFIRMATION);
    expect(model.requests).toHaveLength(2);
  });

  it("Claude failing three times sends the system-down text and records the errors", async () => {
    model.script(new Error("Claude overloaded"), new Error("Claude overloaded"), new Error("Claude overloaded"));
    await text(ME, "Start");
    expect(sent()).toEqual([SYSTEM_DOWN_REPLY]);
    const [inbound] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(inbound).toMatchObject({ status: "REPLIED_WITH_ERRORS", error: expect.stringContaining("claude (attempt 3): Claude overloaded") });
  });

  it("a failed attempt that already saved answers is retried with the tester as saved", async () => {
    model.script({ tools: [{ name: "save_name", input: { name: "Alex" } }] }, new Error("Claude overloaded"), "Hey Alex!");
    await text(ME, "Start, I'm Alex");
    expect(sent()).toEqual(["Hey Alex!"]);
    expect(model.stateOf()).toContain("Name: Alex");
  });

  it(`caps the tool loop at ${MAX_ROUNDS} Claude calls, the last without tools`, async () => {
    const loop = { tools: [{ name: "save_style_note", input: { note: "more hype" } }], text: "Hype it is!" };
    model.script(loop, loop, loop, loop, loop);
    await text(ME, "more hype pls");
    expect(model.requests).toHaveLength(MAX_ROUNDS);
    const lastRequest = model.requests.at(-1)!;
    expect(lastRequest.toolChoice).toBe("none");
    expect(lastRequest.messages.at(-1)!.content).toContainEqual({
      type: "text",
      text: "No more tool calls for this reply: write your text to the tester now.",
    });
    // The tool list stays the same for every round of one reply.
    expect(new Set(model.requests.map((r) => r.tools.map((x) => x.name).join()))).toHaveProperty("size", 1);
    expect(sent()).toEqual(["Hype it is!"]);
  });

  it("tries a round again once when it comes back with neither text nor a tool call", async () => {
    model.script("", "Hey, I'm ZOH!");
    await text(ME, "Start");
    expect(model.requests).toHaveLength(2);
    expect(sent()).toEqual(["Hey, I'm ZOH!"]);
  });

  it("records which tools ran when Claude never writes text, without tester content", async () => {
    const silent = { tools: [{ name: "save_preference", input: { preference: "secret words" } }] };
    model.script(silent, silent, silent, silent, "", silent, silent, silent, silent, "");
    await text(ME, "more hype pls");
    expect(sent()).toEqual([FALLBACK_REPLY]);
    const [inbound] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(inbound!.error).toContain("rounds: save_preference:ok | save_preference:ok | save_preference:ok | save_preference:ok");
    expect(inbound!.error).not.toContain("secret words");
  });
});

describe("instructions", () => {
  it("stay within their length budget", () => {
    expect(CORE_VOICE.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.core);
    expect(ONBOARDING.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.onboarding);
    expect(EXAMPLES.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.examples);
    expect(PLAN_AGREEMENT.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.plan);
    expect(NUDGES.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.nudges);
    expect(MEMORY.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.memory);
    expect(PROOF.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.proof);
    expect(loadVoiceDoc().length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS.fullVoice);
  });

  it("keep follow-ups, the commitment ask and the quiet-hours offer natural", () => {
    // The coach echoed "say it like you mean it" back word for word.
    expect(PLAN_AGREEMENT).not.toContain("say it like they mean it");
    expect(PLAN_AGREEMENT).toContain("never pick apart their wording");
    expect(PLAN_AGREEMENT).toContain("ask nothing else in that text");
    // "Ha, I need a number" after "yea" to an either/or question.
    expect(ONBOARDING).toContain("never correcting them");
    expect(PLAN_AGREEMENT).toContain("a vague answer gets one kind follow-up, never a correction");
    // Testers were asked to move quiet hours without ever hearing what they are.
    expect(PLAN_AGREEMENT).toContain("explain that by default you stay quiet then");
  });

  it("allow at most 3 Greek words a day, in the onboarding prompt and the voice page", () => {
    expect(CORE_VOICE).toContain("At most 3 a day");
    expect(loadVoiceDoc()).toContain("At most 3 a day");
  });
});

describe("the voice page", () => {
  it("is read as the coach sees it: people-only parts left out, \"Learns what works\" active", () => {
    const raw = readFileSync(VOICE_DOC_PATH, "utf8");
    const voice = loadVoiceDoc();
    expect(raw).toContain("## Yanni's coaching voice");
    expect(voice).not.toContain("Yanni's coaching voice");
    expect(voice).not.toContain("people only");
    expect(voice).not.toContain("**Decision:**");
    expect(voice).not.toContain("This is a first draft, to be refined");
    expect(voice).toContain("ZOH is the friend you wish you'd had");
    expect(voice).toContain("## Learns what works for each person");
    expect(voice).not.toContain("Not active yet: turns on with coach memory");
    expect(voice).not.toContain("Not active yet: turns on with the nudge scheduler");
    expect(voice).toContain('never reuse these lines or the name "Sam"');
  });

  it("refuses a missing page or an unclosed marker, so the app can't start without its voice", () => {
    expect(() => loadVoiceDoc("/nope/coach-voice.md")).toThrow(/Can't read the coach's voice page/);
    expect(() => voiceForCoach("a <!-- people only --> b")).toThrow(/unclosed/);
    expect(voiceForCoach("a\n<!-- people only -->\nsecret\n<!-- /people only -->\n\n\nb")).toBe("a\n\nb");
  });

  it("onboarding uses the condensed prompt; after onboarding the coach reads the whole page", async () => {
    model.script("Yo! I'm ZOH…");
    await text(ME, "Start");
    expect(model.requests.at(-1)!.system[0]!.text).toBe(FIXED_INSTRUCTIONS);

    await updateTester(t.db, (await tester()).id, { phase: "planning" });
    model.script("On its way!");
    await text(ME, "when's my plan coming?");
    const fixed = model.requests.at(-1)!.system[0]!;
    expect(fixed).toMatchObject({ text: fullVoiceInstructions(loadVoiceDoc()), cache_control: { type: "ephemeral" } });
    expect(fixed.text).toContain("## When they start to slip");
    expect(fixed.text).toContain('Sections marked "Not active yet" describe features that aren\'t built yet: don\'t act on them.');
    expect(fixed.text).toContain(TOOL_RULES);
    expect(fixed.text).toContain(PLAN_AGREEMENT);
    expect(FIXED_INSTRUCTIONS).toContain(PLAN_AGREEMENT);
    expect(fixed.text).toContain(NUDGES);
    expect(FIXED_INSTRUCTIONS).toContain(NUDGES);
    expect(fixed.text).not.toContain(ONBOARDING);
    expect(fixed.text).not.toContain("Yanni's coaching voice");
  });
});
