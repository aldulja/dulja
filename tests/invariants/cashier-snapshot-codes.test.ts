import { afterAll, beforeAll, expect, it } from "vitest";
import { startDb, type Db } from "@dulja/db/test";
import { CASHIER_SNAPSHOT_CODES } from "@dulja/contracts/permissions";
let db: Db;
beforeAll(async () => {
  db = await startDb();
}, 180_000);
afterAll(async () => db.stop());
it("SQL and TypeScript derive the exact same cashier offline code set", async () => {
  const rows = await db.admin<
    { code: string }[]
  >`select code from app.permission where module='pos' and code not like 'pos.sync.%' order by code`;
  expect(rows.map((r) => r.code)).toEqual([...CASHIER_SNAPSHOT_CODES].toSorted());
  expect(CASHIER_SNAPSHOT_CODES).not.toContain("pos.sync.pull");
  expect(CASHIER_SNAPSHOT_CODES).not.toContain("pos.sync.push");
});
