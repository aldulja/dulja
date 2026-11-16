import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AllocateSettlementResultSchema,
  AllocationList,
  AllocationSchema,
  OpenBalanceSchema,
  PartyBalanceSchema,
} from "@dulja/contracts";
import { issueDocument, postDocument } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedParty,
  seedTenantV2,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories up.
import { problemOf } from "../../../../../tests/support/api";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let invType: string;
let rctType: string;
let partyId: string;
let bankId: string;

/** Two minimal `effect: "none"` account-line policies — an AR debit type and a bank/AR settlement type. They
 *  are the ledger shapes of `SALES_INVOICE` and `RECEIPT` reduced to `kind: "account"` lines, which is all a
 *  ROUTE test needs; the seeded files' own shapes are proven by the DB suites. The receipt's create code is
 *  `accounting.receipt.create`, which is what the two write routes' gate resolves from the path settlement. */
const ACCOUNT_POLICY = (
  code: string,
  series: string,
  post: string,
  direction: "outbound" | "inbound",
  arSide: "debit" | "credit",
) => ({
  version: 1,
  documentType: code,
  direction,
  requires: ["party"],
  lines: [
    {
      for: "each_line",
      side: arSide,
      account: { from: "party.receivable_account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: arSide === "debit" ? "credit" : "debit",
      account: { from: "line.account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series, assignAt: "issue" },
  reversal: { allowed: true, producesType: code },
  approval: { required: false, approve: null, post, create: post },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

const ctx = () => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const docPath = (documentId: string, tail: string, companyId = s.company) =>
  `/v1/companies/${companyId}/documents/${documentId}/${tail}`;
const line = (settledDocumentId: string, amount: string) => ({
  settledDocumentId,
  amount: { amount, currency: "MYR" },
});

/** Draft, issue and post a one-account-line document of `typeId` for `amount`. An invoice's line is the
 *  sales account, a receipt's the bank. */
async function posted(
  typeId: string,
  series: string,
  amount: string,
  effectiveDate: string,
  party = partyId,
): Promise<string> {
  const accountId = typeId === rctType ? bankId : s.sales;
  const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
    documentTypeId: typeId,
    series,
    effectiveDate,
    partyId: party,
    lines: [{ kind: "account", accountId, description: "line", amount }],
  });
  await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = ${"unit"} where id = ${documentId}`;
    await issueDocument(tx, ctx(), { documentId });
    await postDocument(tx, ctx(), { documentId });
  });
  return documentId;
}
const invoice = (amount: string, on: string, party?: string) =>
  posted(invType, "AINV", amount, on, party);
const receipt = (amount: string, on: string, party?: string) =>
  posted(rctType, "ARCT", amount, on, party);

async function openAmount(documentId: string): Promise<string> {
  const res = await api.request({
    method: "GET",
    path: docPath(documentId, "open-balance"),
    as: s.human,
  });
  return OpenBalanceSchema.parse(await res.json()).document.amount;
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "allocations-api");
  // `4000` and `5920` are seedTenantV2's; `seedAccount` is idempotent on (company_id, code).
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"],
    ["1200", "Trade receivables", "asset"],
  ] as const) {
    await seedAccount(api.db, s, { code, nameEn, type });
  }
  const [bank] = await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx<
        { id: string }[]
      >`select id from app.account where company_id = ${s.company} and code = ${"1100"}`,
  );
  bankId = bank!.id;
  invType = await seedDocumentType(api.db, s, {
    code: "API_AR_INVOICE",
    module: "accounting",
    policy: ACCOUNT_POLICY("API_AR_INVOICE", "AINV", "accounting.sales.post", "outbound", "debit"),
  });
  rctType = await seedDocumentType(api.db, s, {
    code: "API_AR_RECEIPT",
    module: "accounting",
    policy: ACCOUNT_POLICY(
      "API_AR_RECEIPT",
      "ARCT",
      "accounting.receipt.create",
      "inbound",
      "credit",
    ),
  });
  partyId = await seedParty(api.db, s, { kind: "customer", code: "API-ALLOC" });
  // The two post codes the fixtures need, the settlement's create code the two write gates resolve, the
  // accounting read code the two document reads resolve, and the parties module's code.
  await grantCodes(api.db, s, {
    codes: [
      "accounting.sales.post",
      "accounting.receipt.create",
      "accounting.ledger.read",
      "accounting.party.manage",
    ],
  });
}, 240_000);
afterAll(async () => {
  await api.stop();
});

describe("the five allocation routes (4A T9)", () => {
  it("GET …/documents/{id}/open-balance returns the total in BOTH currencies before anything is allocated", async () => {
    const inv = await invoice("100.0000", "2026-01-05");
    const res = await api.request({
      method: "GET",
      path: docPath(inv, "open-balance"),
      as: s.human,
    });
    expect(res.status).toBe(200);
    expect(OpenBalanceSchema.parse(await res.json())).toEqual({
      documentId: inv,
      document: { amount: "100.0000", currency: "MYR" },
      base: { amount: "100.0000", currency: "MYR" },
    });
  });

  it("POST …/allocations returns 201 with the allocation ids and a zero fxDifference in BASE", async () => {
    const inv = await invoice("60.0000", "2026-01-06");
    const rct = await receipt("60.0000", "2026-01-07");
    const res = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(inv, "60.0000")] },
    });
    expect(res.status).toBe(201);
    const body = AllocateSettlementResultSchema.parse(await res.json());
    expect(body.allocationIds).toHaveLength(1);
    expect(body.fxDifference).toEqual({ amount: "0.0000", currency: "MYR" });
    expect(await openAmount(inv)).toBe("0.0000");
  });

  it("POST …/allocations without an Idempotency-Key is 400 ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const inv = await invoice("9.0000", "2026-01-08");
    const rct = await receipt("9.0000", "2026-01-08");
    const res = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      idempotencyKey: null,
      body: { lines: [line(inv, "9.0000")] },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replaying the same key allocates once and answers with the first result", async () => {
    const inv = await invoice("7.0000", "2026-01-08");
    const rct = await receipt("7.0000", "2026-01-08");
    const request = {
      method: "POST" as const,
      path: docPath(rct, "allocations"),
      as: s.human,
      idempotencyKey: "4a-allocate-replay",
      body: { lines: [line(inv, "7.0000")] },
    };
    const first = await api.request(request);
    const again = await api.request(request);
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(AllocateSettlementResultSchema.parse(await again.json()).allocationIds).toEqual(
      AllocateSettlementResultSchema.parse(await first.json()).allocationIds,
    );
    const [n] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.allocation where settlement_document_id = ${rct}`,
    );
    expect(n!.n).toBe(1);
  });

  it("an over-allocation is 400 ERR_VALIDATION_FAILED and names the open balance", async () => {
    // ERR_VALIDATION_FAILED is a 400 in `ERRORS` (0B); the plan's 422 predates that row.
    const inv = await invoice("30.0000", "2026-01-09");
    const rct = await receipt("100.0000", "2026-01-09");
    const res = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(inv, "100.0000")] },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/open balance of 30\.0000/);
    // …and past the settlement's own total, naming what is still unallocated on it.
    const small = await receipt("10.0000", "2026-01-09");
    const past = await api.request({
      method: "POST",
      path: docPath(small, "allocations"),
      as: s.human,
      body: { lines: [line(inv, "20.0000")] },
    });
    expect(past.status).toBe(400);
    expect((await problemOf(past)).detail).toMatch(/exceed the settlement total 10\.0000/);
  });

  it("an empty `lines` array is refused on the WIRE by `.min(1)`, before the service", async () => {
    const rct = await receipt("1.0000", "2026-01-10");
    const res = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [] },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a settlement in another currency than its line is 422 ERR_MONEY_CURRENCY_MISMATCH naming the line", async () => {
    const inv = await invoice("5.0000", "2026-01-10");
    const rct = await receipt("5.0000", "2026-01-10");
    const res = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [{ settledDocumentId: inv, amount: { amount: "5.0000", currency: "EUR" } }] },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_MONEY_CURRENCY_MISMATCH");
    expect(problem.detail).toMatch(/line 1 is in EUR/);
  });

  it("GET …/allocations reads BOTH directions and returns three `{ amount, currency }` objects per row", async () => {
    const inv = await invoice("40.0000", "2026-01-11");
    const rct = await receipt("40.0000", "2026-01-11");
    const created = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(inv, "40.0000")] },
    });
    expect(created.status).toBe(201);
    // From the SETTLEMENT's side…
    const fromReceipt = await api.request({
      method: "GET",
      path: docPath(rct, "allocations"),
      as: s.human,
    });
    expect(fromReceipt.status).toBe(200);
    const a = AllocationList.parse(await fromReceipt.json()).items;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      settlementDocumentId: rct,
      settledDocumentId: inv,
      partyId,
      companyId: s.company,
      allocatedBy: s.human,
      amount: { amount: "40.0000", currency: "MYR" },
      baseAmount: { amount: "40.0000", currency: "MYR" },
      fxDifference: { amount: "0.0000", currency: "MYR" },
      unallocatedAt: null,
      unallocatedBy: null,
      unallocationReason: null,
    });
    // The two currency carriers are destructured out, not leaked beside the schema's members.
    expect(Object.keys(a[0]!)).not.toContain("baseCurrency");
    // …and from the SETTLED document's side, which is the read a clerk looking at an invoice makes.
    const fromInvoice = await api.request({
      method: "GET",
      path: docPath(inv, "allocations"),
      as: s.human,
    });
    expect(AllocationList.parse(await fromInvoice.json()).items.map((r) => r.id)).toEqual([
      a[0]!.id,
    ]);
  });

  it("POST …/unallocate stores the compelled reason, returns the reversed row, and the filter finds it", async () => {
    const inv = await invoice("12.0000", "2026-01-12");
    const rct = await receipt("12.0000", "2026-01-12");
    // TWO allocations on the settlement, so a handler that returned the first row instead of the reversed
    // one would be caught.
    const other = await invoice("3.0000", "2026-01-12");
    const created = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(other, "3.0000"), line(inv, "9.0000")] },
    });
    const { allocationIds } = AllocateSettlementResultSchema.parse(await created.json());
    const res = await api.request({
      method: "POST",
      path: docPath(rct, `allocations/${allocationIds[1]}/unallocate`),
      as: s.human,
      body: { reason: "applied to the wrong invoice" },
    });
    expect(res.status).toBe(200);
    const reversed = AllocationSchema.parse(await res.json());
    expect(reversed).toMatchObject({
      id: allocationIds[1],
      settledDocumentId: inv,
      unallocationReason: "applied to the wrong invoice",
      unallocatedBy: s.human,
    });
    expect(reversed.unallocatedAt).not.toBeNull();
    expect(await openAmount(inv)).toBe("12.0000");
    // The default read is the live rows; `filter[unallocated][eq]=true` is the reversed ones (§4.2.8).
    const live = await api.request({
      method: "GET",
      path: docPath(rct, "allocations"),
      as: s.human,
    });
    expect(AllocationList.parse(await live.json()).items.map((r) => r.id)).toEqual([
      allocationIds[0],
    ]);
    const gone = await api.request({
      method: "GET",
      path: `${docPath(rct, "allocations")}?filter[unallocated][eq]=true`,
      as: s.human,
    });
    expect(AllocationList.parse(await gone.json()).items.map((r) => r.id)).toEqual([
      allocationIds[1],
    ]);
    // A second reversal of the same row is 404: it is no longer an OPEN allocation.
    const twice = await api.request({
      method: "POST",
      path: docPath(rct, `allocations/${allocationIds[1]}/unallocate`),
      as: s.human,
      body: { reason: "again" },
    });
    expect(twice.status).toBe(404);
  });

  it("an EMPTY reason is refused on the wire — `unallocate` compels one (§4.8.1)", async () => {
    const inv = await invoice("3.0000", "2026-01-13");
    const rct = await receipt("3.0000", "2026-01-13");
    const created = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(inv, "3.0000")] },
    });
    const { allocationIds } = AllocateSettlementResultSchema.parse(await created.json());
    const res = await api.request({
      method: "POST",
      path: docPath(rct, `allocations/${allocationIds[0]}/unallocate`),
      as: s.human,
      body: { reason: "" },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    expect(await openAmount(inv)).toBe("0.0000");
  });

  it("GET …/parties/{partyId}/balance is party-facing, concrete, and requires an explicit asOf", async () => {
    const fresh = await seedParty(api.db, s, { kind: "customer", code: "API-BAL" });
    await invoice("25.0000", "2026-01-14", fresh);
    await receipt("5.0000", "2026-01-20", fresh);
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/parties/${fresh}/balance?asOf=2026-01-31`,
      as: s.human,
    });
    expect(res.status).toBe(200);
    expect(PartyBalanceSchema.parse(await res.json())).toEqual({
      partyId: fresh,
      asOf: "2026-01-31",
      byCurrency: { MYR: { amount: "20.0000", currency: "MYR" } },
      base: { amount: "20.0000", currency: "MYR" },
    });
    // The date filter is on the ledger row: before the receipt, the whole invoice is open.
    const earlier = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/parties/${fresh}/balance?asOf=2026-01-15`,
      as: s.human,
    });
    expect(PartyBalanceSchema.parse(await earlier.json()).base.amount).toBe("25.0000");
    const noAsOf = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/parties/${fresh}/balance`,
      as: s.human,
    });
    expect(noAsOf.status).toBe(400);
    expect((await problemOf(noAsOf)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("each route is gated: the settlement's create code on the writes, the module read code on the reads", async () => {
    const inv = await invoice("2.0000", "2026-01-15");
    const rct = await receipt("2.0000", "2026-01-15");
    const outsider = await secondPrincipal(api.db, s, "alloc-outsider");
    // A member of the company holding no code: a caller with NO role in the path company is refused on the
    // company before any policy is resolved (S3, code review 2), and this case is about which code is asked.
    await grantCodes(api.db, s, { principalId: outsider, roleCode: "alloc-outsider" });
    const write = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: outsider,
      body: { lines: [line(inv, "2.0000")] },
    });
    expect(write.status).toBe(403);
    expect((await problemOf(write)).detail).toMatch(/accounting\.receipt\.create/);
    const read = await api.request({
      method: "GET",
      path: docPath(inv, "open-balance"),
      as: outsider,
    });
    expect(read.status).toBe(403);
    expect((await problemOf(read)).detail).toMatch(/accounting\.ledger\.read/);
    const balance = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/parties/${partyId}/balance?asOf=2026-01-31`,
      as: outsider,
    });
    expect(balance.status).toBe(403);
    // An invoice on the path of the WRITE resolves the INVOICE's create code: a principal who may bank a
    // receipt may not thereby allocate through a sales document.
    const receiptClerk = await secondPrincipal(api.db, s, "alloc-receipt-clerk");
    await grantCodes(api.db, s, {
      codes: ["accounting.receipt.create"],
      principalId: receiptClerk,
      roleCode: "alloc-receipt-clerk",
    });
    const viaInvoice = await api.request({
      method: "POST",
      path: docPath(inv, "allocations"),
      as: receiptClerk,
      body: { lines: [line(rct, "2.0000")] },
    });
    expect(viaInvoice.status).toBe(403);
    expect((await problemOf(viaInvoice)).detail).toMatch(/accounting\.sales\.post/);
  });

  it("the path company binds every document, allocation and party the request names (AGENTS.md)", async () => {
    const inv = await invoice("4.0000", "2026-01-16");
    const rct = await receipt("4.0000", "2026-01-16");
    const [company] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
      insert into app.company (tenant_id, code, name, base_currency)
      values (${s.tenant}, 'API-ALLOC-B', 'Allocation second company', 'MYR') returning id`,
    );
    // A blank company assignment grants row visibility without granting financial authority.
    await grantCodes(api.db, { ...s, company: company!.id }, { roleCode: "api-alloc-b-member" });
    const other = await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      const [branchType] = await tx<
        { id: string }[]
      >`insert into app.dimension_type(tenant_id,company_id,code,name_en) values(${s.tenant},${company!.id},'BRANCH','Branch') returning id`;
      const [branch] = await tx<
        { id: string }[]
      >`insert into app.dimension_value(tenant_id,dimension_type_id,code,name_en) values(${s.tenant},${branchType!.id},'B-HQ','Sibling HQ') returning id`;
      const [party] = await tx<{ id: string }[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en)
        values (${s.tenant}, ${company!.id}, 'customer', 'B-CUST', 'Sibling customer') returning id`;
      const [type] = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, module)
        values (${s.tenant}, ${company!.id}, 'API_AR_INVOICE', 'Invoice', 'accounting') returning id`;
      const [doc] = await tx<{ id: string }[]>`
        insert into app.document (tenant_id, company_id, document_type_id, series, effective_date,
                                  currency, branch_id, party_id)
        values (${s.tenant}, ${company!.id}, ${type!.id}, 'AINV', '2026-01-16', 'MYR', ${branch!.id},
                ${party!.id})
        returning id`;
      return { companyId: company!.id, partyId: party!.id, documentId: doc!.id };
    });
    // This company's receipt reached through the sibling company's path: the gate 404s on the document.
    const wrongCompany = await api.request({
      method: "POST",
      path: docPath(rct, "allocations", other.companyId),
      as: s.human,
      body: { lines: [line(inv, "4.0000")] },
    });
    expect(wrongCompany.status).toBe(404);
    // A sibling company's document named in the BODY: the service 404s on it.
    const wrongSettled = await api.request({
      method: "POST",
      path: docPath(rct, "allocations"),
      as: s.human,
      body: { lines: [line(other.documentId, "4.0000")] },
    });
    expect(wrongSettled.status).toBe(404);
    expect((await problemOf(wrongSettled)).detail).toMatch(/is not a document of company/);
    // A sibling company's party through this company's path.
    const wrongParty = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/parties/${other.partyId}/balance?asOf=2026-01-31`,
      as: s.human,
    });
    expect(wrongParty.status).toBe(404);
    // An allocation of ANOTHER settlement, unallocated through this settlement's path.
    const elsewhere = await receipt("4.0000", "2026-01-16");
    const made = await api.request({
      method: "POST",
      path: docPath(elsewhere, "allocations"),
      as: s.human,
      body: { lines: [line(inv, "4.0000")] },
    });
    const { allocationIds } = AllocateSettlementResultSchema.parse(await made.json());
    const crossed = await api.request({
      method: "POST",
      path: docPath(rct, `allocations/${allocationIds[0]}/unallocate`),
      as: s.human,
      body: { reason: "not mine" },
    });
    expect(crossed.status).toBe(404);
    expect(await openAmount(inv)).toBe("0.0000");
  });

  it("an unauthenticated caller is 401 on the reads, and no route module was added (hazard 31)", async () => {
    const inv = await invoice("1.0000", "2026-01-17");
    for (const path of [
      docPath(inv, "open-balance"),
      docPath(inv, "allocations"),
      `/v1/companies/${s.company}/parties/${partyId}/balance?asOf=2026-01-31`,
    ]) {
      expect((await api.request({ method: "GET", path })).status).toBe(401);
    }
    // The PROBES half is asserted where PROBES lives (`tests/invariants/tenant-isolation.test.ts` compares
    // its keys with ROUTES); this workspace may not import `tests/invariants/probes.ts` (dependency-rule).
    // Five sub-paths of two existing modules add no RouteModule, so ROUTES — and therefore PROBES — is unmoved.
    const { ROUTES } = await import("../../../src/routes");
    expect(ROUTES.some((r) => r.path === "/v1/companies/:companyId/documents")).toBe(true);
    expect(ROUTES.some((r) => r.path === "/v1/companies/:companyId/parties")).toBe(true);
    expect(
      ROUTES.filter((r) => /allocation|open-balance|balance/.test(r.path)).map((r) => r.path),
    ).toEqual([]);
  });
});
