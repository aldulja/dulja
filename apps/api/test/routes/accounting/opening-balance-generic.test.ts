import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedTenantV2,
  uuidv7,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/**
 * 9B Task 5 — OPENING_BALANCE is posted ONLY by the cut-over load (`draftAndPost`, as the tenant's system principal), in
 * the series `OB` that no other type uses and that is never re-used after cut-over (contracts round 20 C1). Its policy
 * resolves the generic routes' gate to `accounting.journal.post`, so without the refusal an accountant could draft and
 * post a hand-made "opening" that the cut-over reconciliation would read as the legacy trial balance's. FX_REVALUATION's
 * and the hr types' precedent: the generic writers refuse it, before any read.
 */
const ENVELOPE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../packages/db/seed/my/document-types/OPENING_BALANCE.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { module: "accounting" | "inventory" | "hr" | "pos"; policy: unknown };

describe("the generic document routes refuse OPENING_BALANCE — the cut-over load posts it", () => {
  let api: StartedApi;
  let s: Seed;
  let suspense: string;

  const ctx = async () => ({
    tenantId: s.tenant,
    actorId: s.system,
    requestId: await uuidv7(api.db.admin),
  });
  const openingDocuments = async () => {
    const [row] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
         where d.company_id = ${s.company} and t.code = 'OPENING_BALANCE'`,
    );
    return row!.n;
  };
  const lines = () => [
    { lineNo: 1, accountId: s.cash, debit: "1.0000" },
    { lineNo: 2, accountId: suspense, credit: "1.0000" },
  ];

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "OpeningGeneric");
    suspense = await seedAccount(api.db, s, {
      code: "3900",
      nameEn: "Opening-balance suspense",
      type: "equity",
    });
    await seedDocumentType(api.db, s, {
      code: "OPENING_BALANCE",
      module: ENVELOPE.module,
      policy: ENVELOPE.policy,
    });
    // The codes the OPENING_BALANCE and JOURNAL gates resolve to, so the refusal below is the handler's, not the gate's.
    await grantCodes(api.db, s, {
      codes: ["accounting.journal.create", "accounting.journal.post"],
    });
    await api.loadPrincipals();
  }, 600_000);
  afterAll(async () => {
    await api?.stop();
  });

  it("POST …/documents drafts a JOURNAL with the same lines, so the gate admits this principal", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "JOURNAL",
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        lines: lines(),
      },
    });
    expect(res.status).toBe(201);
  });

  it("POST …/documents refuses documentTypeCode OPENING_BALANCE with ERR_VALIDATION_FAILED and writes nothing", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "OPENING_BALANCE",
        effectiveDate: "2026-01-31",
        currency: "MYR",
        branchId: s.hq,
        lines: lines(),
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/^OPENING_BALANCE is posted only by the cut-over load/);
    expect(await openingDocuments()).toBe(0);
  });

  it("PUT …/lines refuses an OPENING_BALANCE draft, so no hand-keyed line reaches one", async () => {
    // No route can draft one; this one is inserted directly as the load would leave it before posting.
    const draftId = await uuidv7(api.db.admin);
    await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                  currency, exchange_rate, branch_id)
        select ${draftId}, ${s.tenant}, ${s.company}, t.id, 'OB', '2026-01-31', 'MYR', '1.00000000', ${s.hq}
          from app.document_type t where t.company_id = ${s.company} and t.code = 'OPENING_BALANCE'`,
    );
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${draftId}/lines`,
      as: s.human,
      body: { lines: lines() },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toMatch(/^OPENING_BALANCE is posted only/);
    const [n] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_line where document_id = ${draftId}`,
    );
    expect(n!.n).toBe(0);
  });
});
