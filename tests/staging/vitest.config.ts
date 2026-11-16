import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Separate from tests/vitest.config.ts: these run against a deployed environment, start no container, and skip
 * entirely when STAGING_BASE_URL is unset — so a developer's `bun run test` never needs the cloud.
 *
 * `root` is set explicitly to this file's own directory. Without it, `include: ["*.test.ts"]` is resolved against
 * the *runner's* working directory, so `bun run test:staging` from the repository root would collect nothing and
 * exit 0 — a green run that tested the Phase 0 exit gate not at all.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { include: ["*.test.ts"], testTimeout: 120_000, fileParallelism: false },
});
