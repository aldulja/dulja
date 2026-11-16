import { grantCodes } from "./fixtures";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
// `down`, `listApplied` and `up` are `packages/db/src/migrate.ts`'s (§4.1). `MIGRATIONS_DIR` is NOT there —
// plan 0A declares it in `packages/db/test/harness.ts`, which is why it rides the `./harness` import below.
import { down, listApplied, up } from "../src/migrate";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";
import { MIGRATIONS_DIR, startDb, uuidv7, type Db } from "./harness";

const VERSION = 27;
const ctx = (s: Seed, requestId: string) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId,
});

/** Rolls the database back to just before 0027 so this file owns the transition it measures. */
async function rewind(db: Db): Promise<void> {
  const applied = await listApplied(db.migrator);
  if (applied.includes(VERSION)) await down(db.migrator, MIGRATIONS_DIR, VERSION - 1);
}

describe("migration 0027 — the EXPAND half on a live table (spec:2057, test 25)", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("adds one nullable column and nothing else", async () => {
    await rewind(db);
    const before = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document' order by column_name`;
    expect(before.map((r) => r.column_name)).not.toContain("notes");

    expect(await up(db.migrator, MIGRATIONS_DIR)).toContain(VERSION);
    // `up` has no ceiling, so it re-applied 0028 onwards too, and 3A's 0031 adds document columns of its own.
    // Stepping back down to 27 leaves exactly 0027's delta to measure; the ladder is restored before asserting.
    await down(db.migrator, MIGRATIONS_DIR, VERSION);
    const after = await db.admin<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      select column_name, is_nullable, column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'document' order by column_name`;
    await up(db.migrator, MIGRATIONS_DIR);
    const added = after.filter((r) => !before.some((b) => b.column_name === r.column_name));
    expect(added).toHaveLength(1);
    // Nullable and DEFAULT-less: that is what makes it catalogue-only rather than a table rewrite.
    expect(added[0]).toMatchObject({
      column_name: "notes",
      is_nullable: "YES",
      column_default: null,
    });
  });

  it("keeps the schema clean — lintSchema reports zero violations after 0027", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("round-trips a note through the column", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const note = "Returned to consignor on 2026-03-20 — سبب الإرجاع";
    const read = await prodWithTenant(db.rw, ctx(a, requestId), async (tx) => {
      await tx`update app.document set notes = ${note} where id = ${documentId}`;
      const [row] = await tx<{ notes: string }[]>`
        select notes from app.document where id = ${documentId}`;
      return row!.notes;
    });
    expect(read).toBe(note);
  });

  it("costs the same regardless of how many rows the table holds (spec:2443)", async () => {
    // Two measurements at a tenfold difference in row count. A nullable ADD COLUMN writes only the
    // catalogue, so the ratio must stay near 1 — this asserts PROPORTIONALITY, which no wall-clock bound
    // can, because a bound passes on a fast machine while proving nothing.
    const timings: number[] = [];
    for (const rows of [200, 2_000]) {
      await rewind(db);
      // `draftDocument` opens its own tenant session per call (§4.1); wrapping the loop in another
      // withTenant would nest one and raise ERR_TENANT_CONTEXT_NESTED (§4.2.2).
      for (let i = 0; i < rows; i += 1) await draftDocument(db, a);
      const started = performance.now();
      // After 3A merges, this `up()` applies 0027 AND 0028+ if they are unapplied on this instance. The
      // ratio assertion still holds for catalogue-only DDL; if a later slice adds a rewriting migration
      // to the same unapplied set, `rewind` grows a second call — it does not become a different test.
      await up(db.migrator, MIGRATIONS_DIR);
      timings.push(performance.now() - started);
    }
    const [small, large] = timings as [number, number];
    // Generous on purpose: the claim is "not proportional to the data", i.e. the tenfold row increase does
    // not produce anything like a tenfold increase in time.
    expect(large).toBeLessThan(small * 4 + 250);
  }, 240_000);

  it("bounds its lock: the file sets lock_timeout, so it fails fast instead of queuing", () => {
    const sql = readFileSync(`${MIGRATIONS_DIR}/0027_expand_document_add_notes.sql`, "utf8");
    expect(sql).toMatch(/set local lock_timeout\s*=\s*'\d+s'/);
    expect(sql).toMatch(/set local statement_timeout\s*=\s*'\d+s'/);
  });

  it("is reversible: the down file drops the column and never the table", async () => {
    const text = readFileSync(`${MIGRATIONS_DIR}/0027.down.sql`, "utf8");
    expect(text).toMatch(/alter table app\.document drop column/);
    expect(text).not.toMatch(/drop table/);

    await down(db.migrator, MIGRATIONS_DIR, VERSION - 1);
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'notes'`;
    expect(cols).toEqual([]);
    await up(db.migrator, MIGRATIONS_DIR);
  });
});
