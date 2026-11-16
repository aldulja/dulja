import { sqlText } from "../apps/pos/sql-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [sqlText()],
  test: {
    include: [
      "invariants/**/*.test.ts",
      "regression/**/*.test.ts",
      "golden/**/*.test.ts",
      "lint/**/*.test.ts",
      // `scripts/` is not a Bun workspace, so `turbo run test` never reaches it and 0B's own rule
      // tests ("acceptance test 27", `scripts/lint/lint.test.ts`) executed nowhere — found while
      // fixing `dependency-rule`'s matcher, whose whole test file this is (0E final review). This
      // workspace already typechecks `../scripts/lint` (see tsconfig.json), so running it here keeps
      // both halves in one place rather than inventing a thirteenth workspace for one directory.
      "../scripts/lint/**/*.test.ts",
    ],
    testTimeout: 60000,
    hookTimeout: 180000,
    fileParallelism: false,
    isolate: false,
    pool: "threads",
    maxWorkers: 1,
  },
});
