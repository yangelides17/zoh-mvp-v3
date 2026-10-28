import { describe, expect, it } from "vitest";
import { toClaudeMessages } from "../src/claude/replier.js";
import { loadConfig, missingSettings, normalizePhone } from "../src/config.js";
import { mediaKind } from "../src/media/storage.js";
import sharp from "sharp";
import { prepareImageForClaude, sniffImageFormat } from "../src/media/images.js";
import { createSendblueClient, SendblueError } from "../src/sendblue/client.js";
import type { CheckinAnswer, Weekday } from "../src/db/schema.js";
import { addDays } from "../src/nudges/schedule.js";
import { hitRate, maintenanceStreak, streakRuns } from "../src/nudges/streak.js";
import { makeApp } from "./helpers.js";

describe("config", () => {
  it("treats empty strings as unset and parses the allowlist", () => {
    const c = loadConfig({
      DATABASE_URL: "postgres://x",
      ANTHROPIC_API_KEY: "",
      ALLOWED_NUMBERS: " +1 (908) 555-0100, 9175551234 ,",
      TYPING_INDICATOR: "",
    });
    expect(c.claude.apiKey).toBeUndefined();
    expect(c.allowedNumbers).toEqual(["+19085550100", "+19175551234"]);
    expect(c.typingIndicator).toBe(true);
    expect(c.claude.model).toBe("claude-sonnet-5-5");
    expect(missingSettings(c)).toContain("ANTHROPIC_API_KEY");
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("normalizes phone numbers", () => {
    expect(normalizePhone("+1 (917) 741-2162")).toBe("+19177412162");
    expect(normalizePhone("9177412162")).toBe("+19177412162");
    expect(normalizePhone("")).toBe("");
  });
});

describe("toClaudeMessages", () => {
  it("starts and ends with the user and merges consecutive turns", () => {
    const out = toClaudeMessages([
      { role: "assistant", text: "Welcome!" },
      { role: "user", text: "Hi" },
      { role: "user", text: "Anyone there?", image: { mediaType: "image/jpeg", data: "AAAA" } },
      { role: "assistant", text: "Yes" },
      { role: "user", text: "Cool" },
      { role: "assistant", text: "trailing" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[0]?.content).toHaveLength(3);
  });
});

describe("media helpers", () => {
  it("classifies by content type, then by extension", () => {
    expect(mediaKind("audio/x-caf", "https://x/a")).toBe("audio");
    expect(mediaKind(undefined, "https://x/a/voice.CAF")).toBe("audio");
    expect(mediaKind("application/octet-stream", "https://x/p.heic")).toBe("image");
  });
});

describe("sendblue client", () => {
  it("sends with our line and keys, and surfaces declines", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    let respond = () => new Response(JSON.stringify({ status: "QUEUED", message_handle: "h1" }), { status: 200 });
    const client = createSendblueClient({
      baseUrl: "https://api.sendblue.test",
      apiKeyId: "id",
      apiKeySecret: "secret",
      fromNumber: "+19177412162",
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return respond();
      }) as unknown as typeof fetch,
    });
    const sent = await client.sendMessage({ number: "+19085550100", content: "hi" });
    expect(sent.messageHandle).toBe("h1");
    expect(requests[0]?.url).toBe("https://api.sendblue.test/api/send-message");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      number: "+19085550100",
      from_number: "+19177412162",
      content: "hi",
    });
    expect((requests[0]?.init.headers as Record<string, string>)["sb-api-key-id"]).toBe("id");

    respond = () =>
      new Response(JSON.stringify({ status: "DECLINED", error_key: "PRE_REPLY_LIMIT_REACHED" }), { status: 400 });
    await expect(client.sendMessage({ number: "+1", content: "x" })).rejects.toBeInstanceOf(SendblueError);

    respond = () => new Response("", { status: 503 });
    expect(await client.sendTypingIndicator("+19085550100")).toBe(false);
  });
});

describe("GET /health", () => {
  it("is healthy when the database answers", async () => {
    const t = await makeApp();
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      checks: { database: "ok", bucket: "ok", transcription: "ok", claude: "configured" },
    });
    const deep = await t.app.inject({ method: "GET", url: "/health?deep=1" });
    expect(deep.json().checks.claude).toBe("ok");
    await t.close();
  });

  it("reports services that aren't configured", async () => {
    const t = await makeApp({ media: undefined, transcriber: undefined, replier: undefined });
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.json().checks).toMatchObject({ bucket: "not_configured", transcription: "not_configured", claude: "not_configured" });
    await t.close();
  });
});

describe("safeError", () => {
  it("keeps the database cause and drops query parameters", async () => {
    const { safeError } = await import("../src/errors.js");
    const cause = Object.assign(new Error('relation "messages" does not exist'), { code: "42P01" });
    const err = Object.assign(new Error('Failed query: insert into "messages" ...\nparams: inbound,+19085550100,secret text'), {
      name: "DrizzleQueryError",
      cause,
    });
    const safe = safeError(err);
    expect(safe).toEqual({ name: "DrizzleQueryError", message: 'relation "messages" does not exist', code: "42P01" });
    expect(JSON.stringify(safe)).not.toContain("+1908");
  });
});

describe("route errors", () => {
  it("returns a generic 500 when storing fails, without leaking details", async () => {
    const t = await makeApp();
    const { db } = t;
    (db as unknown as { insert: () => never }).insert = () => {
      throw Object.assign(new Error("Failed query: insert ...\nparams: +19085550100,hello"), {
        cause: new Error("connection refused"),
      });
    };
    const { inboundEvent, postWebhook } = await import("./helpers.js");
    const res = await postWebhook(t, inboundEvent());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("+1908");
    await t.close();
  });
});

describe("images for Claude", () => {
  const ascii = (str: string) => [...str].map((c) => c.charCodeAt(0));

  it("recognizes formats from their bytes, not labels", () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImageFormat(new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypheic"), 0, 0]))).toBe("heic");
    expect(sniffImageFormat(new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypmif1"), 0, 0]))).toBe("heic");
    expect(sniffImageFormat(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))).toBe("webp");
    expect(sniffImageFormat(new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypM4A "), 0, 0]))).toBeUndefined();
    expect(sniffImageFormat(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("converts to JPEG and shrinks large photos", async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#3a6" } }).png().toBuffer();
    const img = await prepareImageForClaude(new Uint8Array(big));
    expect(img).toMatchObject({ mediaType: "image/jpeg", format: "png", width: 1568, height: 1176 });
    expect(sniffImageFormat(Buffer.from(img!.data, "base64"))).toBe("jpeg");
    expect(await prepareImageForClaude(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("streaks per goal (spec: Step log and next step, rules 3, 4 and 8)", () => {
  type Status = "done" | "done_reduced" | "missed";
  /** Days from 2026-11-02 (a Monday): `d(0)` is Monday. */
  const d = (n: number) => addDays("2026-11-02", n);
  const day = (n: number, status: Status, planId = "v1") => ({ date: d(n), status, planId });
  const version = (id: string, v: number, changeKind: "deepen" | "upgrade" | "other" | null = null, endsOn: string | null = null) => ({
    id,
    version: v,
    changeKind,
    endsOn,
  });
  const v1 = version("v1", 1);

  it.each([
    {
      name: "deepen and other changes keep the streak",
      days: [day(0, "done"), day(1, "done", "v2"), day(2, "done", "v3")],
      plans: [v1, version("v2", 2, "deepen"), version("v3", 3, "other")],
      current: 3,
      past: [],
    },
    {
      name: "an upgrade starts a new streak; the old one is kept",
      days: [day(0, "done"), day(1, "done"), day(2, "done", "v2"), day(3, "done", "v2")],
      plans: [v1, version("v2", 2, "upgrade")],
      current: 2,
      past: [{ length: 2, from: d(0), to: d(1), endedBy: "upgrade" }],
    },
    {
      name: "a deepen after an upgrade keeps the upgrade's streak",
      days: [day(0, "done"), day(1, "done", "v2"), day(2, "done", "v3")],
      plans: [v1, version("v2", 2, "upgrade"), version("v3", 3, "deepen")],
      current: 2,
      past: [{ length: 1, from: d(0), to: d(0), endedBy: "upgrade" }],
    },
    {
      name: "an upgrade with no days on it yet ends the run before it",
      days: [day(0, "done"), day(1, "done")],
      plans: [v1, version("v2", 2, "upgrade")],
      current: 0,
      past: [{ length: 2, from: d(0), to: d(1), endedBy: "upgrade" }],
    },
    {
      name: "a temporary lighter plan keeps reduced days counting",
      days: [day(0, "done"), day(1, "done_reduced", "t2"), day(2, "done_reduced", "t2"), day(3, "done")],
      plans: [v1, version("t2", 2, "other", d(2))],
      current: 4,
      past: [],
    },
    {
      name: "misses and a second reduced day end runs; past runs are all kept",
      days: [day(0, "done"), day(1, "missed"), day(2, "done"), day(3, "done_reduced"), day(4, "done_reduced"), day(5, "done")],
      plans: [v1],
      current: 1,
      past: [
        { length: 1, from: d(0), to: d(0), endedBy: "miss" },
        { length: 2, from: d(2), to: d(3), endedBy: "reduced" },
      ],
    },
  ])("$name", ({ days, plans: versions, current, past }) => {
    const runs = streakRuns(days, versions);
    expect(runs.current?.length ?? 0).toBe(current);
    expect(runs.past).toEqual(past);
  });

  it("hit rate: done (full or reduced) out of closed step days, across upgrades; rest days count as neither", () => {
    const weekdays = { id: "v1", days: ["mon", "tue", "wed", "thu", "fri"] as Weekday[], startDate: d(0) };
    const lifting = { id: "v2", days: ["mon", "wed", "fri"] as Weekday[], startDate: d(0) };
    const days = [
      day(0, "done"),
      day(1, "done_reduced"),
      day(2, "missed"),
      day(5, "done"), // Saturday: a rest day on v1
      day(7, "done", "v2"),
      day(8, "missed", "v2"), // Tuesday: a rest day on v2
      day(9, "missed", "v2"),
      { date: d(11), status: null, planId: "v2" }, // still open
    ];
    expect(hitRate(days, [weekdays, lifting])).toEqual({ done: 3, closed: 5 });
  });

  describe("maintenance streak (rule 4)", () => {
    // Every day; became maintenance on Monday d(0), with a 10-day streak through that day.
    const plan = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as Weekday[], startDate: d(-30) };
    const carried = { length: 10, from: d(-9), to: d(0) };
    const streak = (checkins: { date: string; answer: CheckinAnswer | null }[], today: number) =>
      maintenanceStreak({ carried, since: d(0), plan, checkins, today: d(today) });

    it("grows on its step days, and no answer or a 'mostly' leaves it going", () => {
      expect(streak([], 4).current).toMatchObject({ length: 13, to: d(3) });
      expect(streak([{ date: d(2), answer: null }], 4).current).toMatchObject({ length: 13 });
      expect(streak([{ date: d(2), answer: "mostly" }], 4).current).toMatchObject({ length: 13 });
    });

    it("Monday yes, Thursday stopped: the streak counts through Monday", () => {
      const s = streak([{ date: d(7), answer: "kept_up" }, { date: d(10), answer: "stopped" }], 12);
      expect(s.current).toBeUndefined();
      expect(s.past).toEqual([{ length: 17, from: d(-9), to: d(7), endedBy: "stopped" }]);
    });

    it("on a plan with rest days it only counts step days", () => {
      const mwf = { days: ["mon", "wed", "fri"] as Weekday[], startDate: d(-30) };
      expect(maintenanceStreak({ since: d(-1), plan: mwf, checkins: [], today: d(7) }).current).toMatchObject({ length: 3, from: d(0), to: d(4) });
    });

    it("a kept up after a stop starts a new run from the stop", () => {
      const s = streak([{ date: d(3), answer: "stopped" }, { date: d(6), answer: "kept_up" }], 8);
      expect(s.past).toEqual([{ ...carried, endedBy: "stopped" }]);
      expect(s.current).toMatchObject({ length: 4, from: d(4), to: d(7) });
    });
  });
});
