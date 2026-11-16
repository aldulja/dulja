import { defineConfig } from "vitest/config";

// 9A's suites open no PostgreSQL connection. 9B's loader suites (`test/load/run.test.ts` and Tasks 4–8's) start a
// PostgreSQL 18 Testcontainer, so they take contracts §3.7.1's DB-backed timeouts (packages/db's), and the workspace
// runs in CI's Linux `database` job rather than the Windows `checks` job.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
