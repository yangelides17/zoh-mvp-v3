import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Generous: starting in-memory Postgres is slow on Railway's build machines.
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
