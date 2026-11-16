import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, type Db } from "../harness";

describe("app.serial_unit — ⚠️ OD-07, default NOT BUILT (spec:1032, 1310)", () => {
  let db: Db;

  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db.stop();
  });

  it("the table does not exist, and no source file references it", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'app' and table_name = 'serial_unit'`;
    // §3.0.3 puts serial tracking on the "probably not needed" list for a food distributor and spec:1310
    // agrees. If OD-07 comes back yes, this file's expectation flips to 1 and Step 2 builds the table.
    expect(row!.n).toBe(0);
  });

  it("no regression file for the three serial defects exists either (§3.7.3's conditional rule)", async () => {
    const { readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // A resolved PATH, not an import of `tests/support/source`. §4.18 pins the allowances that let a file
    // outside the `tests` workspace import from it to `apps/api/test/**` and `apps/worker/test/**`, and
    // `packages/db/test/**` is not one of them; adding a third would be a contracts amendment bought for
    // one assertion. `dependency-rule` lints `import` statements, so reading the tree by path needs no
    // allowance and no tsconfig `include` entry.
    const files = readdirSync(resolve(import.meta.dirname, "../../../../tests/regression"));
    // 3A is the NAMED creator of sah-052, 056 and 057 (§3.7.3), so their absence is this slice's statement
    // that the decision has not landed — not an oversight by a later slice. 6A appends to 052 when it does.
    for (const sah of ["sah-052", "sah-056", "sah-057"]) {
      expect(
        files.some((f) => f.startsWith(sah)),
        sah,
      ).toBe(false);
    }
  });
});
