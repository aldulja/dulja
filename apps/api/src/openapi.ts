import { createHrKeyRing, DEV_HR_KEY, MemoryObjectStore } from "@dulja/db";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { createLogger } from "@dulja/contracts";
import { createApp } from "./app";
import { StubAuthAdmin } from "./auth-admin";

export const OPENAPI_PATH = "packages/contracts/openapi.json";

export function buildOpenApiDocument(): ReturnType<
  ReturnType<typeof createApp>["getOpenAPIDocument"]
> {
  const app = createApp({
    terminalJwtSigningKey: new TextEncoder().encode(
      "dulja-test-terminal-signing-key-0123456789abcdef",
    ),
    objectStore: new MemoryObjectStore(),
    // 8A — the generator seals nothing; the ring only has to exist.
    hrKeys: createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }),
    db: null as unknown as Sql,
    jobs: {
      enqueue: () => {
        throw new Error("the OpenAPI generator runs no jobs");
      },
    },
    logger: createLogger({ sink: () => {} }),
    authAdmin: new StubAuthAdmin(),
    verifier: () => {
      throw new Error("the OpenAPI generator verifies no tokens");
    },
  });
  return app.getOpenAPIDocument({
    openapi: "3.1.0",
    info: {
      title: "Dulja API",
      version: "1",
      description:
        "Accounting, inventory, HR/payroll and POS. Errors are RFC 9457 application/problem+json (ADR-0003).",
    },
    servers: [
      {
        url: "/",
        description: "Behind the Cloudflare edge Worker; the container has no public ingress.",
      },
    ],
  });
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  writeFileSync(
    join(root, OPENAPI_PATH),
    `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`wrote ${OPENAPI_PATH}\n`);
}
