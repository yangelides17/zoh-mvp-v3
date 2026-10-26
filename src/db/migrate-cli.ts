/**
 * Applies pending migrations from ./drizzle. Railway runs this before each deploy
 * (see railway.json), so a failed migration stops the deploy.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationsFolder } from "./paths.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder });
  console.log(`Migrations applied from ${migrationsFolder}`);
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
