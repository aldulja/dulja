import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMPORT_LOADER_WRITE_CODES,
  importWriteCodes,
  missingImportWriteCodes,
  unmappedImportTargets,
} from "../../src/import/gates";
import { grantCodes, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

/**
 * 9B review, finding 4 — the cut-over load runs as the system principal, so the requester must hold the write code of
 * every loader the run executes (7A's "the writer holds the permission", `assertDatasetGate`). These cases pin the
 * table's vocabulary and the company-scope question the route and the worker both ask.
 */
let db: Db;
let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "import-gates");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("IMPORT_LOADER_WRITE_CODES", () => {
  it("names only catalogued codes (app.permission), and only mutating ones but the sensitive-read the sealed fields need", async () => {
    // The catalogue is read from the database, not imported: packages/db's tests may not import @dulja/contracts.
    const rows = await db.admin<{ code: string; mutating: boolean }[]>`
      select code, mutating from app.permission`;
    const catalogue = new Map(rows.map((r) => [r.code, r.mutating]));
    for (const [target, codes] of Object.entries(IMPORT_LOADER_WRITE_CODES))
      for (const code of codes) {
        expect(catalogue.has(code), `${target}: ${code}`).toBe(true);
        if (code !== "hr.employee.read_sensitive")
          expect(catalogue.get(code), `${target}: ${code}`).toBe(true);
      }
  });

  it("respects only, and contributes nothing for an unknown target (runLoad refuses it)", () => {
    expect(importWriteCodes(["unit_of_measure", "lot"])).toEqual(["inventory.item.manage"]);
    expect(importWriteCodes(["no_such_table"])).toEqual([]);
    expect(unmappedImportTargets(["unit_of_measure", "no_such_table"])).toEqual(["no_such_table"]);
  });
});

describe("missingImportWriteCodes — app.principal_has at company scope", () => {
  it("names each code the principal lacks, and none once every one is held", async () => {
    const ask = (only: readonly string[] | null) =>
      withTenant(db.rw, s.tenant, s.system, (tx) =>
        missingImportWriteCodes(tx, { principalId: s.human, companyId: s.company, only }),
      );
    expect(await ask(["opening_balance", "opening_stock"])).toEqual([
      "accounting.journal.post",
      "inventory.receipt.post",
    ]);
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    expect(await ask(["opening_balance", "opening_stock"])).toEqual(["inventory.receipt.post"]);
    await grantCodes(db, s, { codes: importWriteCodes(null) });
    expect(await ask(null)).toEqual([]);
  });

  it("is not cleared by a branch-narrowed assignment (test 36)", async () => {
    const other = await seedTenantV2(db, "import-gates-narrow");
    await grantCodes(db, other, { codes: importWriteCodes(null), branchIds: [other.hq] });
    const missing = await withTenant(db.rw, other.tenant, other.system, (tx) =>
      missingImportWriteCodes(tx, {
        principalId: other.human,
        companyId: other.company,
        only: ["unit_of_measure"],
      }),
    );
    expect(missing).toEqual(["inventory.item.manage"]);
  });
});
