import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Replier } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import type { MediaStore } from "../media/storage.js";
import type { Transcriber } from "../transcription/speaches.js";

export interface HealthRouteOptions {
  db: Db;
  media?: MediaStore;
  transcriber?: Transcriber;
  replier?: Replier;
  /** Names of settings still missing; never values. */
  missingSettings: () => string[];
  version?: string;
}

type CheckResult = "ok" | "not_configured" | { error: string };

async function runCheck(fn: (() => Promise<unknown>) | undefined, timeoutMs = 5_000): Promise<CheckResult> {
  if (!fn) return "not_configured";
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return "ok";
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GET /health: 200 when the database answers (Railway uses this to decide a deploy is healthy).
 * Other services are reported but don't fail the check, so the app can boot before secrets exist.
 * Add ?deep=1 to also ping Claude.
 */
export async function healthRoutes(app: FastifyInstance, opts: HealthRouteOptions): Promise<void> {
  app.get<{ Querystring: { deep?: string } }>("/health", async (request, reply) => {
    const deep = request.query.deep === "1";
    const [database, bucket, transcription, claude] = await Promise.all([
      runCheck(() => opts.db.execute(sql`select 1`)),
      runCheck(opts.media ? () => opts.media!.check() : undefined),
      runCheck(opts.transcriber ? () => opts.transcriber!.check() : undefined),
      deep ? runCheck(opts.replier ? () => opts.replier!.check() : undefined, 10_000) : Promise.resolve(opts.replier ? "configured" : "not_configured"),
    ]);
    const missing = opts.missingSettings();
    const healthy = database === "ok";
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? (missing.length ? "degraded" : "ok") : "down",
      version: opts.version,
      checks: { database, bucket, transcription, claude },
      missingSettings: missing,
    });
  });
}
