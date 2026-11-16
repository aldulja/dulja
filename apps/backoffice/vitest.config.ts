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
    /**
     * `import.meta.env` for the tests that render the real route tree. `/admin/users` fills its API
     * options from `readEnv()`, which in production has already run at the composition root
     * (`main.tsx` boots on it, naming the missing variable), so a test driving that tree needs the
     * same environment the app refuses to start without. `readEnv`'s own tests pass an explicit
     * source object and are unaffected by what is here.
     */
    env: {
      VITE_API_BASE_URL: "https://api.example.test",
      VITE_SUPABASE_URL: "https://project.supabase.co",
      VITE_SUPABASE_ANON_KEY: "anon-key",
    },
  },
});
