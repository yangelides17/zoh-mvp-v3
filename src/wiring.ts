import type { AppDeps } from "./app.js";
import { createClaudeModel } from "./claude/replier.js";
import { COACH_MAX_TOKENS, createCoach } from "./coach/coach.js";
import { missingSettings, type Config } from "./config.js";
import type { Db } from "./db/client.js";
import { createS3MediaStore, fetchMedia } from "./media/storage.js";
import { createSendblueClient } from "./sendblue/client.js";
import { createSpeachesTranscriber } from "./transcription/speaches.js";

/**
 * Everything the app needs, built from config the way production runs it.
 * Production (`src/index.ts`) and the judgment harness (`eval/`) both build the
 * app through here, so the eval always runs the real coach.
 *
 * Any pipeline dependency passed in `overrides` replaces the real one, and the
 * real one is then never constructed (the eval passes a fake Sendblue).
 */
export function appDeps(
  config: Config,
  db: Db,
  overrides: Partial<AppDeps["pipeline"]> = {},
  extra: Partial<Omit<AppDeps, "pipeline">> = {},
): AppDeps {
  const pick = <K extends keyof AppDeps["pipeline"]>(key: K, make: () => AppDeps["pipeline"][K]): AppDeps["pipeline"][K] =>
    key in overrides ? (overrides[key] as AppDeps["pipeline"][K]) : make();

  return {
    pipeline: {
      ...overrides,
      db,
      allowedNumbers: pick("allowedNumbers", () => config.allowedNumbers),
      devNumbers: pick("devNumbers", () => config.devNumbers),
      typingIndicator: pick("typingIndicator", () => config.typingIndicator),
      sendblue: pick("sendblue", () => makeSendblue(config)),
      replier: pick("replier", () => makeCoach(config, db)),
      media: pick("media", () => makeMedia(config)),
      transcriber: pick("transcriber", () => makeTranscriber(config)),
      fetchMedia: pick("fetchMedia", () => fetchMedia),
    },
    webhookSecret: config.sendblue.webhookSecret,
    missingSettings: () => missingSettings(config),
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", 'req.headers["sb-signing-secret"]', 'req.headers["sb-api-secret-key"]'],
        censor: "[redacted]",
      },
    },
    ...extra,
  };
}

function makeSendblue(config: Config) {
  const sb = config.sendblue;
  return sb.apiKeyId && sb.apiKeySecret && sb.number
    ? createSendblueClient({ baseUrl: sb.baseUrl, apiKeyId: sb.apiKeyId, apiKeySecret: sb.apiKeySecret, fromNumber: sb.number })
    : undefined;
}

function makeCoach(config: Config, db: Db) {
  return config.claude.apiKey
    ? createCoach({
        db,
        model: createClaudeModel({
          apiKey: config.claude.apiKey,
          model: config.claude.model,
          maxTokens: Math.max(config.claude.maxTokens, COACH_MAX_TOKENS),
          effort: "medium",
        }),
      })
    : undefined;
}

function makeMedia(config: Config) {
  const b = config.bucket;
  return b.endpoint && b.name && b.accessKeyId && b.secretAccessKey
    ? createS3MediaStore({
        endpoint: b.endpoint,
        bucket: b.name,
        region: b.region,
        accessKeyId: b.accessKeyId,
        secretAccessKey: b.secretAccessKey,
        forcePathStyle: b.forcePathStyle,
      })
    : undefined;
}

function makeTranscriber(config: Config) {
  return config.speaches.url
    ? createSpeachesTranscriber({ url: config.speaches.url, apiKey: config.speaches.apiKey, model: config.speaches.model })
    : undefined;
}
