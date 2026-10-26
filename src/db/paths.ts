import { fileURLToPath } from "node:url";

/** Repo-root ./drizzle, resolved the same from src/db (tsx, tests) and dist/db (built). */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
