import { buildApp } from "./app.js";
import { createClaudeReplier } from "./claude/replier.js";
import { ConfigError, loadConfig, missingSettings } from "./config.js";
import { createDb } from "./db/client.js";
import { createS3MediaStore, fetchMedia } from "./media/storage.js";
import { createSendblueClient } from "./sendblue/client.js";
import { createSpeachesTranscriber } from "./transcription/speaches.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const { db, close: closeDb } = createDb(config.databaseUrl);

const sb = config.sendblue;
const sendblue =
  sb.apiKeyId && sb.apiKeySecret && sb.number
    ? createSendblueClient({ baseUrl: sb.baseUrl, apiKeyId: sb.apiKeyId, apiKeySecret: sb.apiKeySecret, fromNumber: sb.number })
    : undefined;

const replier = config.claude.apiKey
  ? createClaudeReplier({ apiKey: config.claude.apiKey, model: config.claude.model, maxTokens: config.claude.maxTokens })
  : undefined;

const b = config.bucket;
const media =
  b.endpoint && b.name && b.accessKeyId && b.secretAccessKey
    ? createS3MediaStore({
        endpoint: b.endpoint,
        bucket: b.name,
        region: b.region,
        accessKeyId: b.accessKeyId,
        secretAccessKey: b.secretAccessKey,
        forcePathStyle: b.forcePathStyle,
      })
    : undefined;

const transcriber = config.speaches.url
  ? createSpeachesTranscriber({ url: config.speaches.url, apiKey: config.speaches.apiKey, model: config.speaches.model })
  : undefined;

const { app, queue } = await buildApp({
  pipeline: {
    db,
    allowedNumbers: config.allowedNumbers,
    historyLimit: config.claude.historyLimit,
    typingIndicator: config.typingIndicator,
    sendblue,
    replier,
    media,
    transcriber,
    fetchMedia,
  },
  webhookSecret: config.sendblue.webhookSecret,
  missingSettings: () => missingSettings(config),
  version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7),
  logger: {
    level: config.logLevel,
    redact: {
      paths: ["req.headers.authorization", 'req.headers["sb-signing-secret"]', 'req.headers["sb-api-secret-key"]'],
      censor: "[redacted]",
    },
  },
});

const missing = missingSettings(config);
if (missing.length) app.log.warn({ missing }, "Some settings are missing; those features stay off until they are set");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, inFlight: queue.size }, "Shutting down");
  await app.close();
  await Promise.race([queue.idle(), new Promise((r) => setTimeout(r, 20_000))]);
  await closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  // "::" (IPv6 + IPv4) isn't available everywhere; fall back to IPv4 only.
  if ((err as NodeJS.ErrnoException).code === "EAFNOSUPPORT" && config.host === "::") {
    app.log.warn("IPv6 unavailable; listening on 0.0.0.0");
    await app.listen({ port: config.port, host: "0.0.0.0" });
  } else {
    throw err;
  }
}
