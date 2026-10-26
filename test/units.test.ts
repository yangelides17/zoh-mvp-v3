import { describe, expect, it } from "vitest";
import { toClaudeMessages } from "../src/claude/replier.js";
import { loadConfig, missingSettings, normalizePhone } from "../src/config.js";
import { isClaudeReadableImage, mediaKind } from "../src/media/storage.js";
import { createSendblueClient, SendblueError } from "../src/sendblue/client.js";
import { makeApp } from "./helpers.js";

describe("config", () => {
  it("treats empty strings as unset and parses the allowlist", () => {
    const c = loadConfig({
      DATABASE_URL: "postgres://x",
      ANTHROPIC_API_KEY: "",
      ALLOWED_NUMBERS: " +1 (908) 578-2266, 9175551234 ,",
      TYPING_INDICATOR: "",
    });
    expect(c.claude.apiKey).toBeUndefined();
    expect(c.allowedNumbers).toEqual(["+19085782266", "+19175551234"]);
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
      { role: "user", text: "Anyone there?", imageUrl: "https://x.test/a.jpg" },
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
    expect(isClaudeReadableImage("image/heic", "https://x/p.heic")).toBe(false);
    expect(isClaudeReadableImage("image/jpeg", "https://x/p")).toBe(true);
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
    const sent = await client.sendMessage({ number: "+19085782266", content: "hi" });
    expect(sent.messageHandle).toBe("h1");
    expect(requests[0]?.url).toBe("https://api.sendblue.test/api/send-message");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      number: "+19085782266",
      from_number: "+19177412162",
      content: "hi",
    });
    expect((requests[0]?.init.headers as Record<string, string>)["sb-api-key-id"]).toBe("id");

    respond = () =>
      new Response(JSON.stringify({ status: "DECLINED", error_key: "PRE_REPLY_LIMIT_REACHED" }), { status: 400 });
    await expect(client.sendMessage({ number: "+1", content: "x" })).rejects.toBeInstanceOf(SendblueError);

    respond = () => new Response("", { status: 503 });
    expect(await client.sendTypingIndicator("+19085782266")).toBe(false);
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
