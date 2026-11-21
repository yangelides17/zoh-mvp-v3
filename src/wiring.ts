import { readFileSync } from "node:fs";
import type { AppDeps } from "./app.js";
import { createClaudeModel, WEB_TIMEOUT_MS } from "./claude/replier.js";
import { COACH_MAX_TOKENS, createCoach } from "./coach/coach.js";
import { missingSettings, type Config } from "./config.js";
import { CONSOLE_MAX_TOKENS, createConsoleCoach } from "./console/chat.js";
import { CONSOLE_JOB_MAX_TOKENS, createConsoleJobs, type ConsoleJobs } from "./console/jobs.js";
import type { Db } from "./db/client.js";
import { createFfmpegRewrapper } from "./media/rewrap.js";
import { createGeminiWatcher, type VideoWatcher } from "./video/gemini.js";
import { createS3MediaStore, fetchMedia, type MediaStore } from "./media/storage.js";
import { createMediaDescriber } from "./memory/describe.js";
import { createMemoryKeeper, KEEPER_MAX_TOKENS, type MemoryKeeper } from "./memory/keeper.js";
import { createNudgeScheduler, type NudgeScheduler } from "./nudges/scheduler.js";
import { HOLDING_AFTER_MS, routingOf, type Logger } from "./pipeline/inbound.js";
import { createSendblueClient, type SendblueClient } from "./sendblue/client.js";
import { createSpeachesTranscriber, SPEACHES_WAKE_RETRY_MS } from "./transcription/speaches.js";
import { createJumper } from "./testers/jump.js";
import { ReplyLines } from "./pipeline/conversation.js";
import type { BuildInfo } from "./testers/env.js";

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

  // One bucket client: the pipeline keeps files in it, the coach opens them again (#163).
  const media = pick("media", () => makeMedia(config));
  // One video watcher: the pipeline watches new videos, the coach re-watches one with a question (#163).
  const watcher = pick("watcher", () => (config.gemini.apiKey ? createGeminiWatcher({ apiKey: config.gemini.apiKey, model: config.gemini.model }) : undefined));
  const sendblue = pick("sendblue", () => makeSendblue(config));
  const deps: AppDeps = {
    pipeline: {
      ...overrides,
      db,
      allowedNumbers: pick("allowedNumbers", () => config.allowedNumbers),
      devNumbers: pick("devNumbers", () => config.devNumbers),
      appEnv: pick("appEnv", () => config.appEnv),
      devCommands: pick("devCommands", () => config.devCommands),
      build: pick("build", buildInfo),
      typingIndicator: pick("typingIndicator", () => config.typingIndicator),
      lines: pick("lines", () => new ReplyLines({ holdMs: config.typingHoldSeconds * 1000, graceMs: Math.round(config.replyGraceSeconds * 1000) })),
      sendblue,
      replier: pick("replier", () => makeCoach(config, db, media, watcher)),
      media,
      watcher,
      transcriber: pick("transcriber", () => makeTranscriber(config)),
      fetchMedia: pick("fetchMedia", () => fetchMedia),
      rewrapper: pick("rewrapper", () => createFfmpegRewrapper()),
      holdingAfterMs: pick("holdingAfterMs", () => HOLDING_AFTER_MS),
      describer: pick("describer", () => makeDescriber(config)),
    },
    webhookSecret: config.sendblue.webhookSecret,
    console: config.console,
    consoleCoach: makeConsoleCoach(config, db, { media, sendblue, watcher }),
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
      nudger: nudgeSchedulerFor(deps, log, config.sendblue.number, config.goalCap),
      keeper: memoryKeeperFor(config, deps, log),
      consoleJobs: consoleJobsFor(config, deps, log),
      now: deps.pipeline.now,
    });
  return deps;
}

/** The release (package.json) and commit (Railway) this app runs, for "env" and the console (#82). */
export function buildInfo(): BuildInfo {
  let release: string | undefined;
  try {
    // src/ and dist/ both sit one level under the folder with package.json.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    release = typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    release = undefined;
  }
  return { release, commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || undefined };
}

/** The nudge tick over the same database, Sendblue client, coach, allowed numbers and clock as the app. */
export function nudgeSchedulerFor(deps: AppDeps, log: Logger, lineNumber?: string, goalCap?: number): NudgeScheduler {
  const p = deps.pipeline;
  return createNudgeScheduler({
    db: p.db,
    log,
    sendblue: p.sendblue,
    replier: p.replier,
    allowedNumbers: p.allowedNumbers,
    lineNumber,
    routing: routingOf(p),
    goalCap,
    now: p.now,
  });
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
    routing: routingOf(p),
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
    routing: routingOf(p),
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

/**
 * #200: the status sheet rides at the end of their latest message rather than last in the system prompt. On, so
 * staging and the retest after #201 try it; false puts it back on its own, with nothing else changed.
 */
export const SHEET_IN_MESSAGE = true;

function makeCoach(config: Config, db: Db, media: MediaStore | undefined, watcher: VideoWatcher | undefined) {
  return config.claude.apiKey
    ? createCoach({
        db,
        media,
        watcher,
        goalCap: config.goalCap,
        sheetInMessage: SHEET_IN_MESSAGE,
        model: createClaudeModel({
          apiKey: config.claude.apiKey,
          model: config.claude.model,
          maxTokens: Math.max(config.claude.maxTokens, COACH_MAX_TOKENS),
          effort: "medium",
          // #162: a reply that searches and opens pages takes 20 to 60 s.
          timeoutMs: WEB_TIMEOUT_MS,
        }),
      })
    : undefined;
}

/** The console chat's coach: the texting coach's model and effort. */
function makeConsoleCoach(config: Config, db: Db, files: { media?: MediaStore; sendblue?: SendblueClient; watcher?: VideoWatcher }) {
  return config.claude.apiKey
    ? createConsoleCoach({
        db,
        ...files,
        goalCap: config.goalCap,
        model: createClaudeModel({ apiKey: config.claude.apiKey, model: config.claude.model, maxTokens: CONSOLE_MAX_TOKENS, effort: "medium", timeoutMs: WEB_TIMEOUT_MS }),
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
    ? createSpeachesTranscriber({ url: config.speaches.url, apiKey: config.speaches.apiKey, model: config.speaches.model, wakeRetryMs: SPEACHES_WAKE_RETRY_MS })
    : undefined;
}
