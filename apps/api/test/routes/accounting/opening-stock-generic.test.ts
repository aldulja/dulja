import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedDocumentType, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/**
 * 9B Task 6 — OPENING_STOCK is posted ONLY by the cut-over load (`draftAndPost`, as the tenant's system principal), at a
 * cost the load recomputed from the legacy movement history (§5.1 #6), in the series `OS` no other type uses (contracts
 * round 20 C1). Its policy resolves the generic routes' gate to `inventory.receipt.post`, so without the refusal a
 * storekeeper could draft and post a hand-priced "opening" — stock credited to `3900` at a cost nobody recomputed — that
 * the cut-over reconciliation would read as the legacy valuation's. OPENING_BALANCE's precedent (T5).
 */
const ENVELOPE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../packages/db/seed/my/document-types/OPENING_STOCK.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { module: "accounting" | "inventory" | "hr" | "pos"; policy: Record<string, unknown> };

describe("the generic document routes refuse OPENING_STOCK — the cut-over load posts it", () => {
  let api: StartedApi;
  let s: Seed;

  const ctx = async () => ({
    tenantId: s.tenant,
    actorId: s.system,
    requestId: await uuidv7(api.db.admin),
  });
  const count = async (code: string) => {
    const [row] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} and t.code = ${code}`,
    );
    return row!.n;
  };
  const draft = (documentTypeCode: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode,
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        lines: [{ lineNo: 1, accountId: s.cash, debit: "1.0000" }],
      },
    });

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "OpeningStockGeneric");
    await seedDocumentType(api.db, s, {
      code: "OPENING_STOCK",
      module: ENVELOPE.module,
      policy: ENVELOPE.policy,
    });
    // The same policy under another code: the control the gate admits.
    await seedDocumentType(api.db, s, {
      code: "STOCK_IN",
      module: ENVELOPE.module,
      policy: {
        ...ENVELOPE.policy,
        documentType: "STOCK_IN",
        numbering: { series: "SI", assignAt: "issue" },
        reversal: { allowed: true, producesType: "STOCK_IN" },
      },
    });
    // The code both gates resolve to, so the refusal below is the handler's, not the gate's.
    await grantCodes(api.db, s, { codes: ["inventory.receipt.post"] });
    await api.loadPrincipals();
  }, 600_000);
  afterAll(async () => {
    await api?.stop();
  });

  it("POST …/documents drafts the same policy under another code, so the gate admits this principal", async () => {
    expect((await draft("STOCK_IN")).status).toBe(201);
  });

  it("POST …/documents refuses documentTypeCode OPENING_STOCK with ERR_VALIDATION_FAILED and writes nothing", async () => {
    const res = await draft("OPENING_STOCK");
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/^OPENING_STOCK is posted only by the cut-over load/);
    expect(await count("OPENING_STOCK")).toBe(0);
  });
});
