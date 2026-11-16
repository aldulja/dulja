import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SettlementResultSchema } from "@dulja/contracts";
import { issueDocument, postDocument } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
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
let customerId: string;
let vendorId: string;
let bankId: string;
let branchId: string;

/**
 * The two seeded policies' ledger shapes, inline: `loadTypesFromPack` lives in `packages/db/test/ar-ap/` and
 * `apps/api` may not reach into another package's test tree (§3.1). Same codes, series, sides and approval
 * blocks as `RECEIPT.json` / `PAYMENT.json`; the DB suite proves the seeded files themselves.
 */
const SETTLEMENT_POLICY = (code: string, series: string, outbound: boolean) => ({
  version: 1,
  documentType: code,
  direction: outbound ? "outbound" : "inbound",
  requires: ["party"],
  lines: outbound
    ? [
        {
          for: "each_line",
          side: "debit",
          account: { from: "party.payable_account" },
          amount: "line.total_incl_tax",
          when: { "line.kind": "account" },
        },
        {
          for: "each_line",
          side: "credit",
          account: { from: "line.account" },
          amount: "line.total_incl_tax",
          when: { "line.kind": "account" },
        },
      ]
    : [
        {
          for: "each_line",
          side: "debit",
          account: { from: "line.account" },
          amount: "line.total_incl_tax",
          when: { "line.kind": "account" },
        },
        {
          for: "each_line",
          side: "credit",
          account: { from: "party.receivable_account" },
          amount: "line.total_incl_tax",
          when: { "line.kind": "account" },
        },
      ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series, assignAt: "issue" },
  reversal: { allowed: true, producesType: code },
  approval: outbound
    ? {
        required: true,
        approve: "accounting.payment.approve",
        post: "accounting.payment.post",
        create: "accounting.payment.create",
      }
    : {
        required: false,
        approve: null,
        post: "accounting.receipt.post",
        create: "accounting.receipt.create",
      },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

/** The settled side: an account-line AR invoice (SALES_INVOICE's account rule), so a receipt has something on
 *  the OTHER side of the control account to pay — `allocateSettlement` refuses a same-side pair. */
const INVOICE_POLICY = {
  ...SETTLEMENT_POLICY("API_SET_INVOICE", "SINV", false),
  direction: "outbound",
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "party.receivable_account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.total_incl_tax",
      when: { "line.kind": "account" },
    },
  ],
  approval: { required: false, approve: null, post: "accounting.sales.post" },
};

const PATH = () => `/v1/companies/${s.company}/documents/settlements`;
const transition = (documentId: string, to: string, as: string) =>
  api.request({
    method: "POST",
    path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
    as,
    body: { to },
  });

const bodyFor = (
  documentTypeCode: "RECEIPT" | "PAYMENT",
  partyId: string,
  amount: string,
  extra: Record<string, unknown> = {},
) => ({
  documentTypeCode,
  series: documentTypeCode === "RECEIPT" ? "RCT" : "PAY-OUT",
  effectiveDate: "2026-01-15",
  partyId,
  bankAccountId: bankId,
  branchId,
  currency: "MYR",
  exchangeRate: "1.00000000",
  amount,
  reference: "TT-0001",
  allocations: [],
  ...extra,
});

const statusOf = async (documentId: string): Promise<string> => {
  const [doc] = await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx<
        { status: string }[]
      >`select status::text as status from app.document where id = ${documentId}`,
  );
  return doc!.status;
};

/** A posted one-line AR invoice for `amount`. */
async function invoice(amount: string): Promise<string> {
  const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
    documentTypeId: invType,
    series: "SINV",
    effectiveDate: "2026-01-15",
    partyId: customerId,
    lines: [{ kind: "account", accountId: s.sales, description: "invoice", amount }],
  });
  const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "settlements-api" };
  await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = ${"unit"} where id = ${documentId}`;
    await issueDocument(tx, ctx, { documentId });
    await postDocument(tx, ctx, { documentId });
  });
  return documentId;
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "settlements-api");
  // `4000` and `5920` are seedTenantV2's; `seedAccount` is idempotent on (company_id, code).
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"],
    ["1200", "Trade receivables", "asset"],
    ["2100", "Trade payables", "liability"],
  ] as const) {
    await seedAccount(api.db, s, { code, nameEn, type });
  }
  await seedDocumentType(api.db, s, {
    code: "RECEIPT",
    module: "accounting",
    policy: SETTLEMENT_POLICY("RECEIPT", "RCT", false),
  });
  await seedDocumentType(api.db, s, {
    code: "PAYMENT",
    module: "accounting",
    policy: SETTLEMENT_POLICY("PAYMENT", "PAY-OUT", true),
  });
  invType = await seedDocumentType(api.db, s, {
    code: "API_SET_INVOICE",
    module: "accounting",
    policy: INVOICE_POLICY,
  });
  customerId = await seedParty(api.db, s, { kind: "customer", code: "API-CUST" });
  vendorId = await seedParty(api.db, s, { kind: "vendor", code: "API-VEND" });
  await grantCodes(api.db, s, {
    codes: [
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.payment.create",
      "accounting.sales.post",
    ],
  });
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
  // A branch that is NOT the head-office default the service falls back on, so the pass-through case below
  // can tell the caller's value from the default.
  branchId = await seedBranch(api.db, s, { code: "ZZ-BRANCH", nameEn: "Second branch" });
}, 240_000);
afterAll(async () => {
  await api.stop();
});

describe("POST /v1/companies/{companyId}/documents/settlements (4A T10)", () => {
  it("drafts an on-account RECEIPT and returns 201 with the three-member result", async () => {
    const res = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("RECEIPT", customerId, "250.0000"),
    });
    expect(res.status).toBe(201);
    const body = SettlementResultSchema.parse(await res.json());
    expect(body.allocationIds).toEqual([]);
    const [line] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string; amount: string; account: string; description: string | null }[]>`
        select id, amount::text as amount, account_id as account, description
          from app.document_line where document_id = ${body.documentId}`,
    );
    expect(line).toEqual({
      id: body.lineId,
      amount: "250.0000",
      account: bankId,
      description: "TT-0001",
    });
    expect(await statusOf(body.documentId)).toBe("draft");
  });

  it("sends the caller's branchId through — it is never silently replaced by the head-office default", async () => {
    expect(branchId).not.toBe(s.hq);
    const res = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("RECEIPT", customerId, "10.0000"),
    });
    const { documentId } = SettlementResultSchema.parse(await res.json());
    const [doc] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ b: string }[]>`select branch_id as b from app.document where id = ${documentId}`,
    );
    expect(doc!.b).toBe(branchId);
  });

  it("POST without an Idempotency-Key is 400 ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const res = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      idempotencyKey: null,
      body: bodyFor("RECEIPT", customerId, "5.0000"),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replays the same key and hash without creating a second document", async () => {
    const request = {
      method: "POST" as const,
      path: PATH(),
      as: s.human,
      idempotencyKey: "4a-settlement-replay",
      body: bodyFor("RECEIPT", customerId, "33.0000", { reference: "REPLAY" }),
    };
    const first = await api.request(request);
    const again = await api.request(request);
    expect(first.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const firstId = SettlementResultSchema.parse(await first.json()).documentId;
    expect(SettlementResultSchema.parse(await again.json()).documentId).toBe(firstId);
    const [n] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_line where description = ${"REPLAY"}`,
    );
    expect(n!.n).toBe(1);
  });

  it("a negative or zero amount is refused on the wire, before the service sees it", async () => {
    for (const amount of ["-5.0000", "0.0000", "5.00001"]) {
      const res = await api.request({
        method: "POST",
        path: PATH(),
        as: s.human,
        body: bodyFor("RECEIPT", customerId, amount),
      });
      expect(res.status, amount).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("a RECEIPT with allocations is posted AND allocated in the one request", async () => {
    const inv = await invoice("5.0000");
    const res = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("RECEIPT", customerId, "5.0000", {
        allocations: [{ settledDocumentId: inv, amount: "5.0000" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = SettlementResultSchema.parse(await res.json());
    expect(body.allocationIds).toHaveLength(1);
    expect(await statusOf(body.documentId)).toBe("posted");
    const [row] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ settlement: string; settled: string; amount: string }[]>`
        select settlement_document_id as settlement, settled_document_id as settled, amount::text as amount
          from app.allocation where id = ${body.allocationIds[0]!}`,
    );
    expect(row).toEqual({ settlement: body.documentId, settled: inv, amount: "5.0000" });
  });

  it("an over-allocation is 400 ERR_VALIDATION_FAILED and posts NOTHING — the one-transaction claim, over HTTP", async () => {
    // ERR_VALIDATION_FAILED is a 400 in `ERRORS` (0B); the plan's 422 predates that row (4A T9's finding).
    const inv = await invoice("5.0000");
    const count = async () => {
      const [n] = await withTenant(
        api.db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ docs: number; allocations: number }[]>`
          select (select count(*)::int from app.document where company_id = ${s.company}) as docs,
                 (select count(*)::int from app.allocation where company_id = ${s.company}) as allocations`,
      );
      return n!;
    };
    const before = await count();
    const res = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("RECEIPT", customerId, "20.0000", {
        allocations: [{ settledDocumentId: inv, amount: "20.0000" }],
      }),
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/open balance of 5\.0000/);
    // Nothing survived: the handler's single `withTenant` rolled the posting back with the allocation.
    expect(await count()).toEqual(before);
  });

  it("the create-stage gate is resolved from the BODY's type, and an unauthenticated caller is 401", async () => {
    // `requireDocumentPermission("create")` reads the policy of `documentTypeCode` in the body — there is no
    // `:documentId` on this path — so a PAYMENT body asks `accounting.payment.create` and a RECEIPT body
    // `accounting.receipt.create`. A clerk holding only the receipt code is refused the payment, by name.
    const clerk = await secondPrincipal(api.db, s, "set-receipt-clerk");
    await grantCodes(api.db, s, {
      codes: ["accounting.receipt.create"],
      principalId: clerk,
      roleCode: "set-receipt-clerk",
    });
    const receipt = await api.request({
      method: "POST",
      path: PATH(),
      as: clerk,
      body: bodyFor("RECEIPT", customerId, "1.0000"),
    });
    expect(receipt.status).toBe(201);
    // …but drafting is all the clerk may do: with allocations the receipt is POSTED in the request, and the
    // post code is asked by 2B's status trigger (R2), which is the control — no gate of this route's.
    const inv = await invoice("1.0000");
    const posting = await api.request({
      method: "POST",
      path: PATH(),
      as: clerk,
      body: bodyFor("RECEIPT", customerId, "1.0000", {
        allocations: [{ settledDocumentId: inv, amount: "1.0000" }],
      }),
    });
    expect(posting.status).toBe(403);
    expect((await problemOf(posting)).detail).toMatch(/does not hold accounting\.receipt\.post/);
    const payment = await api.request({
      method: "POST",
      path: PATH(),
      as: clerk,
      body: bodyFor("PAYMENT", vendorId, "1.0000"),
    });
    expect(payment.status).toBe(403);
    expect((await problemOf(payment)).detail).toMatch(/accounting\.payment\.create/);
    const unknown = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("RECEIPT", customerId, "1.0000", { documentTypeCode: "NO_SUCH_TYPE" }),
    });
    expect(unknown.status).toBe(404);
    const stranger = await api.request({
      method: "POST",
      path: PATH(),
      body: bodyFor("PAYMENT", vendorId, "80.0000"),
    });
    expect(stranger.status).toBe(401);
  });

  it("a PAYMENT is drafted and NOT posted, and a PAYMENT with allocations is refused", async () => {
    const res = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("PAYMENT", vendorId, "80.0000"),
    });
    expect(res.status).toBe(201);
    const { documentId } = SettlementResultSchema.parse(await res.json());
    expect(await statusOf(documentId)).toBe("draft");
    const withAllocations = await api.request({
      method: "POST",
      path: PATH(),
      as: s.human,
      body: bodyFor("PAYMENT", vendorId, "80.0000", {
        allocations: [{ settledDocumentId: documentId, amount: "80.0000" }],
      }),
    });
    expect(withAllocations.status).toBe(400);
    expect((await problemOf(withAllocations)).detail).toMatch(/requires approval/);
  });

  it("TEST 10 and 31 over the API — the submitter of a PAYMENT can neither approve nor post it", async () => {
    // Two real sessions (two principals, two tokens): the maker holds all three payment codes through two
    // roles (spec:2177 — R6 binds seeded roles, R1 binds the person), so every refusal is R1's, not R2's.
    const maker = await secondPrincipal(api.db, s, "set-maker");
    await grantCodes(api.db, s, {
      codes: ["accounting.payment.create"],
      principalId: maker,
      roleCode: "set-maker-create",
    });
    await grantCodes(api.db, s, {
      codes: ["accounting.payment.approve", "accounting.payment.post"],
      principalId: maker,
      roleCode: "set-maker-approve",
    });
    const checker = await secondPrincipal(api.db, s, "set-checker");
    await grantCodes(api.db, s, {
      codes: ["accounting.payment.approve", "accounting.payment.post"],
      principalId: checker,
      roleCode: "set-checker",
    });

    const drafted = await api.request({
      method: "POST",
      path: PATH(),
      as: maker,
      body: bodyFor("PAYMENT", vendorId, "40.0000"),
    });
    const { documentId } = SettlementResultSchema.parse(await drafted.json());
    expect((await transition(documentId, "submitted", maker)).status).toBe(200);

    const selfApprove = await transition(documentId, "approved", maker);
    expect(selfApprove.status).toBe(409);
    expect((await problemOf(selfApprove)).code).toBe("ERR_SOD_MAKER_IS_CHECKER");

    expect((await transition(documentId, "approved", checker)).status).toBe(200);
    expect((await transition(documentId, "issued", checker)).status).toBe(200);

    const selfPost = await transition(documentId, "posted", maker);
    expect(selfPost.status).toBe(409);
    expect((await problemOf(selfPost)).code).toBe("ERR_SOD_MAKER_IS_CHECKER");
    expect(await statusOf(documentId)).toBe("issued");

    expect((await transition(documentId, "posted", checker)).status).toBe(200);
    expect(await statusOf(documentId)).toBe("posted");
  });

  it("the path company binds the type, the party and the bank account (AGENTS.md)", async () => {
    const other = await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'API-SET-B', 'Settlement second company', 'MYR') returning id`;
      const [party] = await tx<{ id: string }[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en)
        values (${s.tenant}, ${company!.id}, 'customer', 'B-CUST', 'Sibling customer') returning id`;
      const [account] = await tx<{ id: string }[]>`
        insert into app.account (tenant_id, company_id, code, name_en, type)
        values (${s.tenant}, ${company!.id}, '1100', 'Sibling bank', 'asset') returning id`;
      return { companyId: company!.id, partyId: party!.id, accountId: account!.id };
    });
    // s.human becomes a member of the sibling company (a role holding nothing): a caller with no role in the
    // path company is refused on the company first (S3, code review 2), and this case is about the binding.
    await grantCodes(api.db, { ...s, company: other.companyId }, { roleCode: "api-set-b-member" });
    // The sibling company has no RECEIPT type: the gate 404s on the path company.
    const wrongCompany = await api.request({
      method: "POST",
      path: `/v1/companies/${other.companyId}/documents/settlements`,
      as: s.human,
      body: bodyFor("RECEIPT", customerId, "1.0000"),
    });
    expect(wrongCompany.status).toBe(404);
    for (const extra of [{ partyId: other.partyId }, { bankAccountId: other.accountId }]) {
      const res = await api.request({
        method: "POST",
        path: PATH(),
        as: s.human,
        body: bodyFor("RECEIPT", customerId, "1.0000", extra),
      });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).detail).toMatch(/is not (a live party|an account) of company/);
    }
  });

  it("a sub-path adds no route module (hazard 31)", async () => {
    // The PROBES half is asserted where PROBES lives (`tests/invariants/tenant-isolation.test.ts` compares its
    // keys with ROUTES); this workspace may not import `tests/invariants/probes.ts` (dependency-rule).
    const { ROUTES } = await import("../../../src/routes");
    expect(ROUTES.some((r) => r.path === "/v1/companies/:companyId/documents")).toBe(true);
    expect(ROUTES.filter((r) => /settlement/.test(r.path)).map((r) => r.path)).toEqual([]);
  });
});
