import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { PipelineDeps } from "./pipeline/inbound.js";
import { TaskQueue } from "./pipeline/task-queue.js";
import type { ConsoleConfig } from "./config.js";
import { safeError } from "./errors.js";
import { consoleRoutes } from "./routes/console.js";
import { healthRoutes, type HealthRouteOptions } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhook.js";

export interface AppDeps {
  pipeline: Omit<PipelineDeps, "log">;
  webhookSecret?: string;
  /** The founder console; without a password and secret it stays shut. */
  console?: ConsoleConfig;
  missingSettings: () => string[];
  version?: string;
  logger?: FastifyServerOptions["logger"];
}

export interface BuiltApp {
  app: FastifyInstance;
  queue: TaskQueue;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Railway sits behind a proxy.
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  const queue = new TaskQueue((err) => app.log.error({ err: safeError(err) }, "Background task failed"));

  // Never let a raw error (which can embed phone numbers or message text) reach the logs or the response.
  app.setErrorHandler((err: unknown, request, reply) => {
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === "number" && statusCode < 500 ? statusCode : 500;
    request.log.error({ err: safeError(err), route: request.routeOptions.url }, "Request failed");
    void reply.code(status).send({ error: status === 500 ? "internal error" : safeError(err).message });
  });
  const pipeline: PipelineDeps = { ...deps.pipeline, log: app.log };

  const health: HealthRouteOptions = {
    db: pipeline.db,
    media: pipeline.media,
    transcriber: pipeline.transcriber,
    replier: pipeline.replier,
    missingSettings: deps.missingSettings,
    version: deps.version,
  };

  app.get("/", async () => ({ name: "zoh-mvp-v3", ok: true }));
  await app.register(healthRoutes, health);
  await app.register(webhookRoutes, { webhookSecret: deps.webhookSecret, pipeline, queue });
  await app.register(consoleRoutes, { names: [], ...deps.console, db: pipeline.db, media: pipeline.media, now: pipeline.now });

  return { app, queue };
}
