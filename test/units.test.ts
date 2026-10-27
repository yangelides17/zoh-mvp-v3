import { describe, expect, it } from "vitest";
import { toClaudeMessages } from "../src/claude/replier.js";
import { loadConfig, missingSettings, normalizePhone } from "../src/config.js";
import { mediaKind } from "../src/media/storage.js";
import sharp from "sharp";
import { prepareImageForClaude, sniffImageFormat } from "../src/media/images.js";
import { createSendblueClient, SendblueError } from "../src/sendblue/client.js";
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
