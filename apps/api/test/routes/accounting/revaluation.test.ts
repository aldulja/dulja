import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AllocateSettlementResultSchema,
  AllocationSchema,
  RevaluationResultSchema,
  SettlementResultSchema,
} from "@dulja/contracts";
import { ageingTieOut, listAllocations, withTenant } from "@dulja/db";
import {
  grantCodes,
  seedCurrency,
  seedRate,
  seedTenantV2,
  uuidv7,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../../tests/invariants/support/ar-ap";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

/**
 * 4B Task 5 — `POST /v1/companies/{companyId}/documents/revaluations` (the unrealised half, ADR 0047), and the
 * three 4A handlers that now post the REALISED half in their own transaction: `…/{documentId}/allocations`,
 * `…/allocations/{allocationId}/unallocate` and `…/settlements`.
 *
 * The settlements are in the settled invoice's own currency at a different rate, except the last case's USD
 * receipt paying a EUR invoice, whose line states both figures (ADR 0047 decision 9).
 */
describe("FX over HTTP (§4.14 FX_REVALUATION, ADR 0047)", () => {
  let api: StartedApi;
  let s: Seed;
  let f: ArApFixture;
  let invoiceId: string;
  let receiptId: string;
  let januaryId: string;
  let clerk: string;
  let sibling: string;
  let siblingPeriod: string;

  const ctx = async (seed: Seed = s) => ({
    tenantId: seed.tenant,
    actorId: seed.human,
    requestId: await uuidv7(api.db.admin),
  });
  const revalue = (
    body: unknown,
    opts: { as?: string; companyId?: string; idempotencyKey?: string | null } = {},
  ) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${opts.companyId ?? s.company}/documents/revaluations`,
      as: opts.as ?? s.human,
      body,
      ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
    });
  const difference1200 = async (asOf: string) => {
    const rows = await withTenant(api.db.rw, await ctx(), (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf }),
    );
    return rows.find((r) => r.accountCode === "1200")!.difference;
  };
  const fxDocumentsOf = async (settlementId: string) => {
    const [row] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
      select count(distinct l.document_id)::int as n from app.document_line l
       where l.custom_fields->>'fxKind' = 'realised'
         and l.custom_fields->>'settlementDocumentId' = ${settlementId}`,
    );
    return row!.n;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Revaluation");
    f = await arApFixture(api.db, s);
    await seedCurrency(api.db, s, { code: "EUR" });
    await seedRate(api.db, s, {
      from: "EUR",
      to: "MYR",
      on: "2026-01-31",
      rate: "5.50000000",
      source: "manual:test",
    });
    // A principal of the same tenant holding a settlement code and NOT accounting.journal.post.
    clerk = await secondPrincipal(api.db, s, "reval-clerk");
    await grantCodes(api.db, s, {
      codes: ["accounting.receipt.create"],
      principalId: clerk,
      roleCode: "reval-clerk",
    });
    // A sibling company of the same tenant, with a period of its own, where the reader holds nothing.
    sibling = await uuidv7(api.db.admin);
    siblingPeriod = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(api.db.admin) },
      async (tx) => {
        await tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${sibling}, ${s.tenant}, 'SIB', 'Sibling company', 'MYR')`;
        await tx`insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
                 values (${siblingPeriod}, ${s.tenant}, ${sibling}, '2026-01-01', '2026-01-31', 'open')`;
      },
    );
    const [january] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ id: string }[]>`
      select id::text as id from app.fiscal_period
       where company_id = ${s.company} and starts_on = '2026-01-01'`,
    );
    januaryId = january!.id;

    ({ documentId: invoiceId } = await postFromPack(api.db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "1000.0000" }],
    }));
    // Posted, not yet allocated: the allocation goes through the ROUTE below.
    ({ documentId: receiptId } = await postFromPack(api.db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-20",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.20000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "200.0000" }],
    }));
  }, 600_000);
  afterAll(async () => {
    await api.stop();
  });

  it("POST …/allocations posts the realised difference in the same transaction and returns its document", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receiptId}/allocations`,
      as: s.human,
      body: {
        lines: [{ settledDocumentId: invoiceId, amount: { amount: "200.0000", currency: "EUR" } }],
      },
    });
    expect(res.status).toBe(201);
    const body = AllocateSettlementResultSchema.parse(await res.json());
    expect(body.fxDifference).toEqual({ amount: "40.0000", currency: "MYR" }); // 200 × 5.2 − 200 × 5.0
    expect(body.fxDocumentIds).toHaveLength(1);
    expect(await difference1200("2026-01-31")).toBe("0.0000");
  });

  it("POST …/unallocate withdraws it in the same transaction, and a re-allocation restores it", async () => {
    const [allocation] = await withTenant(api.db.rw, await ctx(), (tx) =>
      listAllocations(tx, { companyId: s.company, settlementDocumentId: receiptId }),
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receiptId}/allocations/${allocation!.id}/unallocate`,
      as: s.human,
      body: { reason: "applied twice by mistake" },
    });
    expect(res.status).toBe(200);
    // The row names both of its figures, each with its own currency (4B's settlementAmount).
    expect(AllocationSchema.parse(await res.json())).toMatchObject({
      amount: { amount: "200.0000", currency: "EUR" },
      settlementAmount: { amount: "200.0000", currency: "EUR" },
      fxDifference: { amount: "40.0000", currency: "MYR" },
    });
    expect(await fxDocumentsOf(receiptId)).toBe(2); // the difference, and its withdrawal
    expect(await difference1200("2026-01-31")).toBe("0.0000");

    const again = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receiptId}/allocations`,
      as: s.human,
      body: {
        lines: [{ settledDocumentId: invoiceId, amount: { amount: "200.0000", currency: "EUR" } }],
      },
    });
    expect(again.status).toBe(201);
    expect(AllocateSettlementResultSchema.parse(await again.json()).fxDocumentIds).toHaveLength(1);
    expect(await difference1200("2026-01-31")).toBe("0.0000");
  });

  it("POST …/settlements with allocations posts the realised difference with the receipt", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/settlements`,
      as: s.human,
      body: {
        documentTypeCode: "RECEIPT",
        series: "RCT",
        effectiveDate: "2026-01-22",
        partyId: f.partyIds.customer,
        bankAccountId: f.accountIds["1100"],
        branchId: s.hq,
        currency: "EUR",
        exchangeRate: "5.20000000",
        amount: "100.0000",
        allocations: [{ settledDocumentId: invoiceId, amount: "100.0000" }],
      },
    });
    expect(res.status).toBe(201);
    const body = SettlementResultSchema.parse(await res.json());
    expect(body.allocationIds).toHaveLength(1);
    expect(body.fxDocumentIds).toHaveLength(1); // 100 × 5.2 − 100 × 5.0 = 20.0000
    expect(await difference1200("2026-01-31")).toBe("0.0000");
  });

  it("POST …/revaluations posts the period-end revaluation, every amount a { amount, currency }", async () => {
    const res = await revalue({ fiscalPeriodId: januaryId });
    expect(res.status).toBe(201);
    const body = RevaluationResultSchema.parse(await res.json());
    expect(body.documentId).not.toBeNull();
    expect(body).toMatchObject({
      fiscalPeriodId: januaryId,
      asOf: "2026-01-31",
      baseCurrency: "MYR",
    });
    // 1000 − 200 − 100 = 700 EUR open, carried at the invoice's 5.0 and revalued at 5.5.
    expect(body.lines).toEqual([
      {
        accountId: f.accountIds["1200"],
        accountCode: "1200",
        currency: "EUR",
        amountCcy: { amount: "700.0000", currency: "EUR" },
        carriedBase: { amount: "3500.0000", currency: "MYR" },
        revaluedBase: { amount: "3850.0000", currency: "MYR" },
        delta: { amount: "350.0000", currency: "MYR" },
        rate: "5.50000000",
      },
    ]);
    expect(await difference1200("2026-01-31")).toBe("0.0000");
  });

  it("a second POST for the same period is a no-op: documentId null and no lines", async () => {
    const res = await revalue({ fiscalPeriodId: januaryId });
    expect(res.status).toBe(201);
    expect(RevaluationResultSchema.parse(await res.json())).toMatchObject({
      documentId: null,
      lines: [],
    });
  });

  it("is gated by accounting.journal.post on the PATH company", async () => {
    const forbidden = await revalue({ fiscalPeriodId: januaryId }, { as: clerk });
    expect(forbidden.status).toBe(403);
    expect((await problemOf(forbidden)).code).toBe("ERR_RBAC_FORBIDDEN");
    // The poster's grant is on the seed company; the sibling company is not theirs to revalue.
    const sib = await revalue({ fiscalPeriodId: siblingPeriod }, { companyId: sibling });
    expect(sib.status).toBe(403);
  });

  it("binds the period to the path company: a sibling's period under this company's path is ERR_PERIOD_NOT_FOUND", async () => {
    const res = await revalue({ fiscalPeriodId: siblingPeriod });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_PERIOD_NOT_FOUND");
  });

  it("refuses a request without an Idempotency-Key, and a body without a period", async () => {
    const bare = await revalue({ fiscalPeriodId: januaryId }, { idempotencyKey: null });
    expect(bare.status).toBe(400);
    expect((await problemOf(bare)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    const empty = await revalue({});
    expect(empty.status).toBe(400);
    expect((await problemOf(empty)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a missing rate for an exposed currency is 422 ERR_RATE_NOT_FOUND naming the pair (LEGACY-012)", async () => {
    const gbp = await seedTenantV2(api.db, "RevaluationNoRate");
    const g = await arApFixture(api.db, gbp);
    await seedCurrency(api.db, gbp, { code: "GBP" });
    await postFromPack(api.db, gbp, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-05",
      partyId: g.partyIds.customer,
      currency: "GBP",
      exchangeRate: "6.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: g.accountIds["4000"]!, amount: "10.0000" }],
    });
    const [period] = await withTenant(
      api.db.rw,
      await ctx(gbp),
      (tx) => tx<{ id: string }[]>`
      select id::text as id from app.fiscal_period
       where company_id = ${gbp.company} and starts_on = '2026-01-01'`,
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${gbp.company}/documents/revaluations`,
      as: gbp.human,
      body: { fiscalPeriodId: period!.id },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RATE_NOT_FOUND");
    expect(problem.detail).toMatch(/GBP.*MYR/);
  });

  it("another tenant's poster cannot revalue this company (test 12)", async () => {
    const other = await seedTenantV2(api.db, "RevaluationOther");
    await grantCodes(api.db, other, {
      codes: ["accounting.journal.post"],
      roleCode: "other-poster",
    });
    const res = await revalue({ fiscalPeriodId: januaryId }, { as: other.human });
    expect([403, 404]).toContain(res.status);
    // …and nothing was written: January still carries exactly the one revaluation above.
    const [n] = await withTenant(
      api.db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
      select count(distinct l.document_id)::int as n from app.document_line l
       where l.custom_fields->>'fxKind' = 'unrealised'`,
    );
    expect(n!.n).toBe(1);
  });

  it("POST …/allocations pays a EUR invoice from a USD receipt when the line states both figures", async () => {
    await seedCurrency(api.db, s, { code: "USD" });
    const { documentId: eurInvoice } = await postFromPack(api.db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-25",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "5.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
    });
    const { documentId: usdReceipt } = await postFromPack(api.db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-26",
      partyId: f.partyIds.customer,
      currency: "USD",
      exchangeRate: "4.00000000",
      rateSource: "manual:test",
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "130.0000" }],
    });
    const allocate = (line: Record<string, unknown>) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${usdReceipt}/allocations`,
        as: s.human,
        body: { lines: [{ settledDocumentId: eurInvoice, ...line }] },
      });
    const without = await allocate({ amount: { amount: "100.0000", currency: "EUR" } });
    expect(without.status).toBe(400);
    expect((await problemOf(without)).detail).toMatch(/settlementAmount in USD is required/);

    const res = await allocate({
      amount: { amount: "100.0000", currency: "EUR" },
      settlementAmount: { amount: "130.0000", currency: "USD" },
    });
    expect(res.status).toBe(201);
    const body = AllocateSettlementResultSchema.parse(await res.json());
    expect(body.fxDifference).toEqual({ amount: "20.0000", currency: "MYR" }); // 130 × 4.0 − 100 × 5.0
    expect(body.fxDocumentIds).toHaveLength(1);
    expect(await difference1200("2026-01-31")).toBe("0.0000");
  });
});
