import { defineConfig } from "vitest/config";
import { sqlText } from "./sql-plugin";

export default defineConfig({
  plugins: [sqlText()],
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node", testTimeout: 30_000 },
});
