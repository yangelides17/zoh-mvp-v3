import { buildApp } from "./app.js";
import { ConfigError, loadConfig, missingSettings } from "./config.js";
import { createDb } from "./db/client.js";
import { safeError } from "./errors.js";
import type { MemoryKeeper } from "./memory/keeper.js";
import type { NudgeScheduler } from "./nudges/scheduler.js";
import { appDeps, memoryKeeperFor, nudgeSchedulerFor } from "./wiring.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const { db, close: closeDb, migrate } = createDb(config.databaseUrl);
try {
  await migrate();
} catch (err) {
  console.error("Database migration failed:", safeError(err));
  process.exit(1);
}

const deps = appDeps(config, db, {}, { version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) });
const { app, queue } = await buildApp(deps);
let nudger: NudgeScheduler | undefined;
let keeper: MemoryKeeper | undefined;

const missing = missingSettings(config);
if (missing.length) app.log.warn({ missing }, "Some settings are missing; those features stay off until they are set");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, inFlight: queue.size }, "Shutting down");
  await nudger?.stop();
  await keeper?.stop();
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

// ZOH's own texts: one tick a minute, once the app is taking texts.
nudger = nudgeSchedulerFor(deps, app.log, config.sendblue.number);
nudger.start();

// Coach memory: each tester's day is filed overnight (3 am their time); checked once a minute.
keeper = memoryKeeperFor(config, deps, app.log);
keeper.start();
