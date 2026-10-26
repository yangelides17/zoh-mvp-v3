import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { migrationsFolder } from "./paths.js";
import * as schema from "./schema.js";

/** Works with both node-postgres (production) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
  /** Applies pending migrations (idempotent). Runs at startup so the schema always matches the code. */
  migrate(): Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle({ client: pool, schema });
  return {
    db,
    close: () => pool.end(),
    migrate: () => migrate(drizzle({ client: pool }), { migrationsFolder }),
  };
}
