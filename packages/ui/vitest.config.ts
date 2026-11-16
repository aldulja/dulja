import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    /*
     * Not vitest's 5-second default: CI's Windows `checks` job runs every workspace's suite at once
     * through turbo, and there a file's first user-event test also pays for building jsdom (12 s across
     * three files on one run). The UI suite's first test timed out that way on PR 12 once the till's
     * and back office's jsdom suites grew; 30 s is `apps/pos`'s, the other React user-event suite.
     */
    testTimeout: 30_000,
  },
});
