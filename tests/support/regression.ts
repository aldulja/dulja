import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createDb, withTenant } from "@dulja/db";
import { grantCodes, seedTenant, startDb, type Db, type Seed } from "@dulja/db/test";
import { REPO_ROOT } from "./source";

export function repoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

let started: Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }> | undefined;

export function sharedDb(): Promise<{ db: Db; rw: Sql; a: Seed; b: Seed }> {
  started ??= (async () => {
    const db = await startDb();
    const a = await seedTenant(db, "Alpha");
    const b = await seedTenant(db, "Beta");
    await grantCodes(db, a);
    await grantCodes(db, b);
    return {
      db,
      rw: createDb(db.url("app_rw")),
      a,
      b,
    };
  })();
  return started;
}

export interface ThinContext {
  db: Db;
  rw: Sql;
  a: Seed;
  b: Seed;
  withTenant: typeof withTenant;
  expect: typeof expect;
}

export function thinRegression(
  sah: string,
  heading: string,
  cites: string,
  body: (context: ThinContext) => Promise<void>,
): void {
  sliceRegression(
    sah,
    heading,
    "0B",
    `holds through the production API layer (first proven by ${cites})`,
    body,
  );
}

/**
 * The same shape as `thinRegression` with the slice label and the `it` title supplied by the caller, so a
 * later slice can append its own `— <slice>` block to a file 0B created (contracts §3.7.3) without editing
 * the block above it. It exists rather than a bare `describe` in each file because `ThinContext` hands the
 * body `withTenant` and `expect`: a file that imported either at module scope would have the 0B block's own
 * destructured parameter shadow it, which `no-shadow` refuses.
 */
export function sliceRegression(
  sah: string,
  heading: string,
  slice: string,
  title: string,
  body: (context: ThinContext) => Promise<void>,
): void {
  describe(`${sah} ${heading} — ${slice}`, () => {
    it(title, async () => {
      const context = await sharedDb();
      await body({ ...context, withTenant, expect });
    });
  });
}
