import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { PipelineDeps } from "./pipeline/inbound.js";
import { TaskQueue } from "./pipeline/task-queue.js";
import { healthRoutes, type HealthRouteOptions } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhook.js";

export interface AppDeps {
  pipeline: Omit<PipelineDeps, "log">;
  webhookSecret?: string;
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

  const queue = new TaskQueue((err) => app.log.error({ err }, "Background task failed"));
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

  return { app, queue };
}
