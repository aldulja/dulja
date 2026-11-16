import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { down, up } from "../../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "../harness";

let db: Db;
beforeAll(async () => {
  db = await startDb();
}, 180_000);
afterAll(async () => {
  await db.stop();
});

it("0061 restores the exact previous credit functions on down and re-applies its correction", async () => {
  const sources = () => db.admin<{ proname: string; prosrc: string }[]>`
    select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname in ('document_base_total', 'assert_credit_available')
     order by p.proname`;
  const amended = await sources();
  await down(db.migrator, MIGRATIONS_DIR, 60);
  const prior = readFileSync(
    join(MIGRATIONS_DIR, "0045_alter_party_and_document_add_credit_terms.sql"),
    "utf8",
  );
  for (const row of await sources()) {
    const match = new RegExp(
      `create function app\\.${row.proname}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`,
    ).exec(prior);
    expect(match, row.proname).not.toBeNull();
    expect(row.prosrc, row.proname).toBe(match![1]);
  }
  await up(db.migrator, MIGRATIONS_DIR);
  expect(await sources()).toEqual(amended);
}, 180_000);
