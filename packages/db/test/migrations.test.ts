import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, down, listApplied, up } from "../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "./harness";

/**
 * This is NOT the repository's first up → down → up proof: `privileges.test.ts`'s last case already rolls the whole
 * ladder to zero and back and compares a wider fingerprint than the one below. What that test structurally cannot
 * see is a **partial** rollback, and that is the only reason this file exists. A `0008.down.sql` that over-reached
 * — dropped `app.currency`, or a constraint 0005 owns — is invisible when every table in the schema is dropped a
 * moment later and rebuilt from nothing; here 0001–0007 stay in place and only 0008 is replayed over them, which is
 * also the shape every real rollback takes. `migrate.test.ts` proves the RUNNER against a throwaway fixture
 * directory; this proves one real pair.
 *
 * The fingerprint is deliberately wider than the constraints 0008 adds: an over-reaching down shows up as a missing
 * column, index, policy or trigger, not just a missing key.
 */
const CURRENCY_KEYS = [
  "account_currency_fk",
  "company_base_currency_fk",
  "document_currency_fk",
  "exchange_rate_from_currency_fk",
  "exchange_rate_to_currency_fk",
  "ledger_entry_currency_fk",
];

interface Fingerprint {
  constraints: string[];
  columns: string[];
  indexes: string[];
  policies: string[];
  triggers: string[];
}

const lines = (rows: { line: string }[]): string[] => rows.map((row) => row.line);

async function fingerprint(db: Db): Promise<Fingerprint> {
  const [constraints, columns, indexes, policies, triggers] = await Promise.all([
    // A generated constraint name would show up here as a changed line — which is why 0008 names all six keys.
    db.admin<{ line: string }[]>`
      select c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) as line
        from pg_constraint c where c.connamespace = 'app'::regnamespace order by 1`,
    db.admin<{ line: string }[]>`
      select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' '
             || coalesce(column_default, '-') as line
        from information_schema.columns where table_schema = 'app' order by 1`,
    db.admin<
      { line: string }[]
    >`select indexdef as line from pg_indexes where schemaname = 'app' order by 1`,
    db.admin<{ line: string }[]>`
      select tablename || ' ' || policyname || ' ' || permissive || ' ' || coalesce(qual, '-') || ' '
             || coalesce(with_check, '-') as line
        from pg_policies where schemaname = 'app' order by 1`,
    // tgisinternal excludes the RI triggers a foreign key installs; the constraint row above carries those.
    db.admin<{ line: string }[]>`
      select c.relname || ' ' || t.tgname as line
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'app'::regnamespace and not t.tgisinternal order by 1`,
  ]);
  return {
    constraints: lines(constraints),
    columns: lines(columns),
    indexes: lines(indexes),
    policies: lines(policies),
    triggers: lines(triggers),
  };
}

describe("the migration ladder", () => {
  let db: Db;

  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db.stop();
  });

  it("ships a down for every up, 0008 included, and none of them is an empty file", () => {
    const migrations = discover(MIGRATIONS_DIR); // throws if any up has no matching NNNN.down.sql
    expect(migrations.map((migration) => migration.version)).toContain(8);
    // `discover` only checks that the file exists, and the round trip below only exercises 0008's own pair. An
    // empty down is a file that exists and reverses nothing, while `down()` deletes the ledger row regardless — so
    // the next `up()` replays that migration over objects it never removed. Cheap to rule out for all of them.
    for (const migration of migrations)
      expect(readFileSync(migration.downPath, "utf8").trim(), migration.downPath).not.toBe("");
  });

  it("restores the schema exactly when 0008 is rolled back and re-applied", async () => {
    expect(await listApplied(db.migrator)).toContain(8);
    const before = await fingerprint(db);
    for (const key of CURRENCY_KEYS) {
      expect(
        before.constraints.some((line) => line.includes(key)),
        key,
      ).toBe(true);
    }

    // To 7, not 0 — and that is the point, not a shortcut. `privileges.test.ts` already does 0, where every table
    // is dropped and rebuilt from nothing, so a down that took a 0005 object with it still ends at an identical
    // fingerprint. Here 0005's objects have to survive 0008's down and still be there for 0008's up.
    const rolledBack = await down(db.migrator, MIGRATIONS_DIR, 7);
    expect(rolledBack).toContain(8);
    const at7 = await fingerprint(db);
    expect(
      at7.constraints.filter((line) => CURRENCY_KEYS.some((key) => line.includes(key))),
    ).toEqual([]);
    // The keys go and nothing else does: app.currency is 0005's table to drop, not 0008's.
    expect(at7.constraints.some((line) => line.startsWith("app.currency "))).toBe(true);

    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(rolledBack.toReversed());
    expect(await fingerprint(db)).toEqual(before);
  });
});
