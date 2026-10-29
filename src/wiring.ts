import type { AppDeps } from "./app.js";
import { createClaudeModel } from "./claude/replier.js";
import { COACH_MAX_TOKENS, createCoach } from "./coach/coach.js";
import { missingSettings, type Config } from "./config.js";
import { CONSOLE_MAX_TOKENS, createConsoleCoach } from "./console/chat.js";
import { CONSOLE_JOB_MAX_TOKENS, createConsoleJobs, type ConsoleJobs } from "./console/jobs.js";
import type { Db } from "./db/client.js";
import { createMediaRetention, type MediaRetention } from "./media/retention.js";
import { createS3MediaStore, fetchMedia } from "./media/storage.js";
import { createMediaDescriber } from "./memory/describe.js";
import { createMemoryKeeper, KEEPER_MAX_TOKENS, type MemoryKeeper } from "./memory/keeper.js";
import { createNudgeScheduler, type NudgeScheduler } from "./nudges/scheduler.js";
import type { Logger } from "./pipeline/inbound.js";
import { createSendblueClient } from "./sendblue/client.js";
import { createSpeachesTranscriber } from "./transcription/speaches.js";
import { createJumper } from "./testers/jump.js";

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

  const deps: AppDeps = {
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
      describer: pick("describer", () => makeDescriber(config)),
    },
    webhookSecret: config.sendblue.webhookSecret,
    console: config.console,
    consoleCoach: makeConsoleCoach(config, db),
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
  // Test mode (#14): a jump runs one tester's nudge tick, memory pass and summary, as the app's own would.
  deps.jumper ??= (log) =>
    createJumper({
      db,
      log,
      sendblue: deps.pipeline.sendblue,
      nudger: nudgeSchedulerFor(deps, log, config.sendblue.number),
      keeper: memoryKeeperFor(config, deps, log),
      consoleJobs: consoleJobsFor(config, deps, log),
      now: deps.pipeline.now,
    });
  return deps;
}

/** The nudge tick over the same database, Sendblue client, coach, allowed numbers and clock as the app. */
export function nudgeSchedulerFor(deps: AppDeps, log: Logger, lineNumber?: string): NudgeScheduler {
  const p = deps.pipeline;
  return createNudgeScheduler({
    db: p.db,
    log,
    sendblue: p.sendblue,
    replier: p.replier,
    allowedNumbers: p.allowedNumbers,
    lineNumber,
    now: p.now,
  });
}

/** The hourly cleanup of old voice-note audio in the app's bucket. */
export function mediaRetentionFor(deps: AppDeps, log: Logger): MediaRetention {
  const p = deps.pipeline;
  return createMediaRetention({ db: p.db, log, media: p.media, now: p.now });
}

/** The overnight memory pass over the same database, allowed numbers and clock as the app, on the coach's model. */
export function memoryKeeperFor(config: Config, deps: AppDeps, log: Logger): MemoryKeeper {
  const p = deps.pipeline;
  return createMemoryKeeper({
    db: p.db,
    log,
    model: config.claude.apiKey
      ? createClaudeModel({
          apiKey: config.claude.apiKey,
          model: config.claude.model,
          maxTokens: KEEPER_MAX_TOKENS,
          effort: "medium",
          timeoutMs: 120_000,
        })
      : undefined,
    allowedNumbers: p.allowedNumbers,
    now: p.now,
  });
}

/** The console's alert whys and weekly summaries, on the coach's model at low effort. */
export function consoleJobsFor(config: Config, deps: AppDeps, log: Logger): ConsoleJobs {
  const p = deps.pipeline;
  return createConsoleJobs({
    db: p.db,
    log,
    model: config.claude.apiKey
      ? createClaudeModel({ apiKey: config.claude.apiKey, model: config.claude.model, maxTokens: CONSOLE_JOB_MAX_TOKENS, effort: "low" })
      : undefined,
    now: p.now,
  });
}

function makeDescriber(config: Config) {
  return config.claude.apiKey
    ? createMediaDescriber(createClaudeModel({ apiKey: config.claude.apiKey, model: config.claude.model, maxTokens: 1000, effort: "low" }))
    : undefined;
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
        goalCap: config.goalCap,
        model: createClaudeModel({
          apiKey: config.claude.apiKey,
          model: config.claude.model,
          maxTokens: Math.max(config.claude.maxTokens, COACH_MAX_TOKENS),
          effort: "medium",
        }),
      })
    : undefined;
}

/** The console chat's coach: the texting coach's model and effort. */
function makeConsoleCoach(config: Config, db: Db) {
  return config.claude.apiKey
    ? createConsoleCoach({
        db,
        goalCap: config.goalCap,
        model: createClaudeModel({ apiKey: config.claude.apiKey, model: config.claude.model, maxTokens: CONSOLE_MAX_TOKENS, effort: "medium" }),
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
