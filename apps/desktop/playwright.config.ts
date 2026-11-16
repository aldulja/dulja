import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  // Task 5 (parallel to this one) builds the real ../backoffice/dist that main.ts serves. Until it
  // lands, this repo has no renderer to launch against at all, so the posture specs (which assert what
  // the renderer *cannot* do, never what it renders) would fail to load anything rather than exercising
  // the security posture. This writes a minimal placeholder index.html only when nothing is already
  // there — a real build is never touched — so the specs stay meaningful on a checkout that has not run
  // the backoffice build yet.
  globalSetup: "./test/global-setup.ts",
});
