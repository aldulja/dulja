import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, down, listApplied, up } from "../src/migrate";
import { startDb, type Db } from "./harness";

function fixtureDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "dulja-mig-"));
  writeFileSync(
    join(directory, "0001_create_smoke.sql"),
    "create schema smoke;\ncreate table smoke.t (id int primary key);\n",
  );
  writeFileSync(join(directory, "0001.down.sql"), "drop schema smoke cascade;\n");
  writeFileSync(
    join(directory, "0002_add_name.sql"),
    "alter table smoke.t add column name text not null default '';\n",
  );
  writeFileSync(join(directory, "0002.down.sql"), "alter table smoke.t drop column name;\n");
  return directory;
}

describe("migration runner", () => {
  let db: Db | undefined;

  beforeAll(async () => {
    db = await startDb({ migrate: false });
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("discovers files in version order and demands a down for every up", () => {
    const directory = fixtureDir();
    expect(discover(directory).map((migration) => [migration.version, migration.name])).toEqual([
      [1, "create_smoke"],
      [2, "add_name"],
    ]);

    writeFileSync(join(directory, "0003_orphan.sql"), "select 1;");
    expect(() => discover(directory)).toThrow(/0003\.down\.sql/);
  });

  // DBS-15 (2026-11-15 full review): a file that missed the naming rule was skipped in silence, so `up`, `status`
  // and the up → down → up test (built on `discover`) never saw it, and its policy or index existed nowhere.
  it.each([
    ["0003_add_employee-index.sql"],
    ["0003_add_index.SQL"],
    ["003_add_index.sql"],
    ["0003-add-index.sql"],
    ["0003_Add_Index.sql"],
  ])("refuses a misnamed migration file %s instead of skipping it", (file) => {
    const directory = fixtureDir();
    writeFileSync(join(directory, file), "select 1;");
    expect(() => discover(directory)).toThrow(new RegExp(`${file.replace(".", "\\.")}.*NNNN_`));
  });

  it("refuses a down file with no up file, and ignores a file that is not SQL", () => {
    const directory = fixtureDir();
    writeFileSync(join(directory, "README.md"), "notes\n");
    expect(discover(directory).map((migration) => migration.version)).toEqual([1, 2]);
    writeFileSync(join(directory, "0004.down.sql"), "select 1;");
    expect(() => discover(directory)).toThrow(/0004\.down\.sql has no 0004_<verb>_<noun>\.sql/);
  });

  it("applies pending migrations once and records them", async () => {
    const directory = fixtureDir();
    expect(await up(db!.migrator, directory)).toEqual([1, 2]);
    expect(await listApplied(db!.migrator)).toEqual([1, 2]);
    expect(await up(db!.migrator, directory)).toEqual([]);

    const columns = await db!.migrator<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'smoke' and table_name = 't' order by 1
    `;
    expect(columns.map((column) => column.column_name)).toEqual(["id", "name"]);
  });

  it("rolls back newest-first to a target version and then to zero", async () => {
    const directory = fixtureDir();
    expect(await down(db!.migrator, directory, 1)).toEqual([2]);
    expect(await listApplied(db!.migrator)).toEqual([1]);
    expect(await down(db!.migrator, directory)).toEqual([1]);

    const [schema] = await db!.migrator<{ count: number }[]>`
      select count(*)::int as count from information_schema.schemata where schema_name = 'smoke'
    `;
    expect(schema?.count).toBe(0);
  });

  it("leaves the ledger and schema untouched when a migration fails", async () => {
    const directory = fixtureDir();
    await up(db!.migrator, directory);
    writeFileSync(
      join(directory, "0003_broken.sql"),
      "create table smoke.u (id int);\nselect this_is_not_sql;\n",
    );
    writeFileSync(join(directory, "0003.down.sql"), "drop table smoke.u;\n");

    await expect(up(db!.migrator, directory)).rejects.toThrow();
    expect(await listApplied(db!.migrator)).toEqual([1, 2]);

    const [table] = await db!.migrator<{ count: number }[]>`
      select count(*)::int as count from information_schema.tables
       where table_schema = 'smoke' and table_name = 'u'
    `;
    expect(table?.count).toBe(0);
    await down(db!.migrator, directory);
  });
});
