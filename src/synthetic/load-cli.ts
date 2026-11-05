#!/usr/bin/env tsx
/**
 * CLI to load synthetic testers from fixture files (#142).
 *
 * Usage: npm run load-scenario -- <scenario> --start <YYYY-MM-DD>
 *
 * Reads eval/memory-lab/fixtures/<scenario>.week<N>.json, validates them, checks
 * the database isn't production, and loads the scenario idempotently.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { Db } from "../db/client.js";
import { checkNotProduction, loadScenario, parseFixture, type Fixture } from "./loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../eval/memory-lab/fixtures");

function usage(): never {
  console.error("Usage: npm run load-scenario -- <scenario> --start <YYYY-MM-DD>");
  console.error("  scenario: name matching eval/memory-lab/fixtures/<scenario>.week<N>.json");
  console.error("  --start:  a Monday (day 1 in the fixture = this date)");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const scenarioName = args[0];
  const startIdx = args.indexOf("--start");
  if (!scenarioName || startIdx === -1 || !args[startIdx + 1]) usage();
  const startStr = args[startIdx + 1]!;
  const startDate = new Date(`${startStr}T00:00:00Z`);
  if (isNaN(startDate.getTime())) {
    console.error(`Invalid date: ${startStr}`);
    process.exit(1);
  }
  if (startDate.getUTCDay() !== 1) {
    console.error(`Start date must be a Monday, got ${startStr} (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][startDate.getUTCDay()]})`);
    process.exit(1);
  }

  // Glob for fixture files
  const pattern = new RegExp(`^${scenarioName}\\.week(\\d+)\\.json$`);
  let files: string[];
  try {
    files = fs.readdirSync(FIXTURES_DIR).filter((f) => pattern.test(f)).sort((a, b) => {
      const weekA = Number(pattern.exec(a)![1]);
      const weekB = Number(pattern.exec(b)![1]);
      return weekA - weekB;
    });
  } catch {
    console.error(`Could not read fixtures directory: ${FIXTURES_DIR}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No fixture files found for scenario "${scenarioName}" in ${FIXTURES_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} fixture file(s): ${files.join(", ")}`);

  // Parse fixtures
  const fixtures: Fixture[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8");
    fixtures.push(parseFixture(content, file));
  }

  // Connect to database
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  // All fixtures must agree on phone; use the first to display it
  const phone = fixtures[0]!.tester.phone;
  const host = new URL(databaseUrl).hostname;
  console.log(`Phone: ${phone}`);
  console.log(`Database host: ${host}`);

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema }) as unknown as Db;

  try {
    await checkNotProduction(db);
    const result = await loadScenario(db, fixtures, startDate);
    console.log(`\nLoaded scenario "${result.scenario}" (${result.phone})`);
    console.log("Rows per table:");
    for (const [table, count] of Object.entries(result.tables).sort()) {
      console.log(`  ${table}: ${count}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
