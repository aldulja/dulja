import { defineConfig } from "drizzle-kit";

// Drizzle generates candidates only; handwritten migrations remain authoritative.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./.drizzle",
  dbCredentials: { url: process.env["DATABASE_URL_MIGRATOR"] ?? "" },
  schemaFilter: ["app"],
  verbose: true,
  strict: true,
});
