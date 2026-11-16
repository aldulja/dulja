import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import { draftSettlement, type SettlementInput } from "../../src/ar-ap/settlement";
import { openBalance, partyBalance, type PartyBalance } from "../../src/ar-ap/allocation";
import { issueDocument, postDocument, transitionDocument } from "../../src/posting";
import {
  grantCodes,
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { accountByCode, loadTypesFromPack } from "./_support";

let db: Db;
let s: Seed;
let rctType: string;
let payType: string;
let invType: string;
let customerId: string;
let vendorId: string;
let itemId: string;
let bankId: string;
let termId: string;
const MYR = currency("MYR");

const ctxOf = (seed: Seed, actor?: string) => ({
  tenantId: seed.tenant,
  actorId: actor ?? seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** The one-line settlement every case drafts, less what the case varies. MYR at the identity rate. */
const receiptInput = (
  effectiveDate: string,
  amount: string,
  extra: Partial<SettlementInput> = {},
): SettlementInput => ({
  companyId: s.company,
  documentTypeId: rctType,
  series: "RCT",
  effectiveDate,
  partyId: customerId,
  bankAccountId: bankId,
  currency: "MYR",
  exchangeRate: "1.00000000",
  amount,
  ...extra,
});
const paymentInput = (
  effectiveDate: string,
  amount: string,
  extra: Partial<SettlementInput> = {},
): SettlementInput =>
  receiptInput(effectiveDate, amount, {
    documentTypeId: payType,
    series: "PAY-OUT",
    partyId: vendorId,
    ...extra,
  });

/** One status change by bare `app_rw` UPDATE as `actor` — no service in the way (test 31's lowest path). */
const bySql = (documentId: string, to: string, actor: string) =>
  withTenant(
    db.rw,
    s.tenant,
    actor,
    (tx) =>
      tx`update app.document set status = ${to}::app.document_status where id = ${documentId}`,
  );

const statusOf = async (documentId: string): Promise<string> => {
  const [doc] = await db.admin<{ status: string }[]>`
    select status::text as status from app.document where id = ${documentId}`;
  return doc!.status;
};

const ledgerOf = (documentId: string) =>
  db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, e.debit::text as debit, e.credit::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId} order by a.code`;

/** A party-facing balance's figure in `code`, or zero when the party has nothing posted in it. */
const figure = (b: PartyBalance, code: CurrencyCode): Money =>
  b.byCurrency[code] ?? Money.zero(code);

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "settlement");
  // `seedAccount` is idempotent on (company_id, code); 4A seeds no account (Global Constraint 14).
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"],
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["2100", "Trade payables", "liability"],
    ["5000", "Cost of goods sold", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  bankId = await accountByCode(db, s, "1100");
  ({
    receiptType: rctType,
    paymentType: payType,
    salesInvoiceType: invType,
  } = (await loadTypesFromPack(db, s, ["RECEIPT", "PAYMENT", "SALES_INVOICE"])) as {
    receiptType: string;
    paymentType: string;
    salesInvoiceType: string;
  });
  customerId = await seedParty(db, s, { kind: "customer", code: "CUST-SET" });
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-SET" });
  // The customer carries a term, so the pin at draft (LEGACY-013) has a value to be wrong about.
  termId = await seedPaymentTerm(db, s, { code: "NET14", dueDays: 14 });
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`update app.party set payment_term_id = ${termId} where id = ${customerId}`,
  );
  ({ itemId } = await seedItem(db, s, { code: "IT-SET", kind: "product", trackLots: false }));
  await seedCurrency(db, s, { code: "USD" });
  await grantCodes(db, s, {
    codes: [
      "accounting.sales.post",
      "accounting.receipt.create",
      "accounting.receipt.post",
      "accounting.payment.create",
    ],
  });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("RECEIPT and PAYMENT — §4.14, spec:2147, tests 10 and 31", () => {
  it("a RECEIPT posts debit bank, credit trade receivables, and needs ONE principal (spec:2147)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(
        tx,
        ctxOf(s),
        receiptInput("2026-01-10", "250.0000", { reference: "TT-8891" }),
      );
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
      return d;
    });
    expect(r.allocationIds).toEqual([]);
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1100", debit: "250.0000", credit: "0.0000" },
      { code: "1200", debit: "0.0000", credit: "250.0000" },
    ]);
    // What the draft wrote: the pinned term (LEGACY-013), the rate's provenance (LEGACY-012), the head-office
    // branch the service defaults to, and ONE account line carrying the bank and the reference.
    const [doc] = await db.admin<
      { term: string | null; rateSource: string | null; branch: string; series: string }[]
    >`
      select payment_term_id as term, rate_source as "rateSource", branch_id as branch, series
        from app.document where id = ${r.documentId}`;
    expect(doc).toEqual({ term: termId, rateSource: "unit", branch: s.hq, series: "RCT" });
    const lines = await db.admin<
      { id: string; kind: string; account: string; description: string | null; total: string }[]
    >`
      select id, kind, account_id as account, description, total_incl_tax::text as total
        from app.document_line where document_id = ${r.documentId}`;
    expect(lines).toEqual([
      {
        id: r.lineId,
        kind: "account",
        account: bankId,
        description: "TT-8891",
        total: "250.0000",
      },
    ]);
  });

  it("draftSettlement posts and allocates in ONE transaction, so a failed allocation posts nothing", async () => {
    const inv = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId: customerId,
      effectiveDate: "2026-01-11",
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "1.000000",
          unitPrice: "60.0000",
          amount: "60.0000",
          cost: "10.0000",
        },
      ],
    });
    // The settlement is large enough to carry the line (100.0000), so the refusal is the SETTLED document's
    // open balance, and it comes AFTER the receipt was issued and posted on the same transaction.
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftSettlement(
          tx,
          ctxOf(s),
          receiptInput("2026-01-12", "100.0000", {
            allocations: [{ settledDocumentId: inv.documentId, amount: "100.0000" }],
          }),
        ),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: document .* has an open balance of 60\.0000/);
    // Nothing survived: the whole withTenant rolled back — no document, no ledger row, no number burned.
    const [n] = await db.admin<{ docs: number; ledger: number }[]>`
      select count(distinct d.id)::int as docs, count(e.id)::int as ledger
        from app.document d
        left join app.ledger_entry e on e.document_id = d.id
       where d.document_type_id = ${rctType} and d.effective_date = '2026-01-12'`;
    expect(n).toEqual({ docs: 0, ledger: 0 });
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openBalance(tx, { companyId: s.company, documentId: inv.documentId }),
    );
    expect(open.document.toString()).toBe("60.0000");
  });

  it("a good allocation drives the invoice's open balance to zero in the same transaction", async () => {
    const inv = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId: customerId,
      effectiveDate: "2026-01-13",
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "1.000000",
          unitPrice: "60.0000",
          amount: "60.0000",
          cost: "10.0000",
        },
      ],
    });
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      draftSettlement(
        tx,
        ctxOf(s),
        receiptInput("2026-01-14", "60.0000", {
          allocations: [{ settledDocumentId: inv.documentId, amount: "60.0000" }],
        }),
      ),
    );
    expect(r.allocationIds).toHaveLength(1);
    expect(await statusOf(r.documentId)).toBe("posted");
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openBalance(tx, { companyId: s.company, documentId: inv.documentId }),
    );
    expect(open.document.toString()).toBe("0.0000");
  });

  it("TEST 10 and 31 — a PAYMENT cannot be approved or posted by its own submitter through any path", async () => {
    // The maker holds ALL THREE payment codes, through two roles: R6 keeps the pair off any one SEEDED role,
    // "a principal may still hold both through two roles … and R1 then guarantees the same person never acts
    // on both sides of one document" (spec:2177). Holding them is what makes every refusal below R1's, not
    // R2's — a maker without approve would be refused for the wrong reason.
    const maker = await secondPrincipal(db, s, "pay-maker");
    await grantCodes(db, s, {
      codes: ["accounting.payment.create"],
      principalId: maker,
      roleCode: "pay-maker-create",
    });
    await grantCodes(db, s, {
      codes: ["accounting.payment.approve", "accounting.payment.post"],
      principalId: maker,
      roleCode: "pay-maker-approve",
    });
    const checker = await secondPrincipal(db, s, "pay-checker");
    await grantCodes(db, s, {
      codes: ["accounting.payment.approve", "accounting.payment.post"],
      principalId: checker,
      roleCode: "pay-checker",
    });

    // Session 1, the maker: draft and submit.
    const pay = await withTenant(db.rw, s.tenant, maker, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s, maker), paymentInput("2026-01-15", "80.0000"));
      await transitionDocument(tx, ctxOf(s, maker), { documentId: d.documentId, to: "submitted" });
      return d;
    });
    // (a) the service path: the submitter approves.
    await expect(
      withTenant(db.rw, s.tenant, maker, (tx) =>
        transitionDocument(tx, ctxOf(s, maker), { documentId: pay.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* cannot approve it/);
    // (b) direct app_rw SQL: the same refusal, from the trigger, with no service in the way (test 31).
    await expect(bySql(pay.documentId, "approved", maker)).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* cannot approve it/,
    );
    expect(await statusOf(pay.documentId)).toBe("submitted");

    // Session 2, the checker: approve and issue.
    await withTenant(db.rw, s.tenant, checker, async (tx) => {
      await transitionDocument(tx, ctxOf(s, checker), {
        documentId: pay.documentId,
        to: "approved",
      });
      await issueDocument(tx, ctxOf(s, checker), { documentId: pay.documentId });
    });
    // (c) and (d) the posting edge: R1 binds `posted` as well as `approved`, on both paths.
    await expect(
      withTenant(db.rw, s.tenant, maker, (tx) =>
        postDocument(tx, ctxOf(s, maker), { documentId: pay.documentId }),
      ),
    ).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* cannot post it/);
    await expect(bySql(pay.documentId, "posted", maker)).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* cannot post it/,
    );
    expect(await statusOf(pay.documentId)).toBe("issued");
    expect(await ledgerOf(pay.documentId)).toEqual([]);

    // Session 3, the checker posts.
    await withTenant(db.rw, s.tenant, checker, (tx) =>
      postDocument(tx, ctxOf(s, checker), { documentId: pay.documentId }),
    );
    expect(await ledgerOf(pay.documentId)).toEqual([
      { code: "1100", debit: "0.0000", credit: "80.0000" },
      { code: "2100", debit: "80.0000", credit: "0.0000" },
    ]);
    // The record says who did what — written by the AFTER trigger, never by a handler.
    const events = await db.admin<{ to: string; actor: string }[]>`
      select to_status::text as to, actor_id as actor from app.document_event
       where document_id = ${pay.documentId} and event_kind = 'transition' order by id`;
    expect(events).toEqual([
      { to: "submitted", actor: maker },
      { to: "approved", actor: checker },
      { to: "issued", actor: checker },
      { to: "posted", actor: checker },
    ]);
  });

  it("TEST 10 — nobody sets a PAYMENT's state above their own authority (R2, from the trigger)", async () => {
    const drafter = await secondPrincipal(db, s, "pay-drafter");
    await grantCodes(db, s, {
      codes: ["accounting.payment.create"],
      principalId: drafter,
      roleCode: "pay-drafter",
    });
    // A second create-only principal, who did NOT submit — so R1 has nothing to say and R2 is what refuses.
    const clerk = await secondPrincipal(db, s, "pay-clerk");
    await grantCodes(db, s, {
      codes: ["accounting.payment.create"],
      principalId: clerk,
      roleCode: "pay-clerk",
    });
    const approver = await secondPrincipal(db, s, "pay-approver-only");
    await grantCodes(db, s, {
      codes: ["accounting.payment.approve"],
      principalId: approver,
      roleCode: "pay-approver-only",
    });

    const pay = await withTenant(db.rw, s.tenant, drafter, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s, drafter), paymentInput("2026-01-16", "10.0000"));
      await transitionDocument(tx, ctxOf(s, drafter), {
        documentId: d.documentId,
        to: "submitted",
      });
      return d;
    });
    await expect(
      withTenant(db.rw, s.tenant, clerk, (tx) =>
        transitionDocument(tx, ctxOf(s, clerk), { documentId: pay.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.payment\.approve/,
    );
    await expect(bySql(pay.documentId, "approved", clerk)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.payment\.approve/,
    );

    // Approving is within the approver's authority, and issuing evaluates no code (ADR 0029) — posting is not.
    await withTenant(db.rw, s.tenant, approver, async (tx) => {
      await transitionDocument(tx, ctxOf(s, approver), {
        documentId: pay.documentId,
        to: "approved",
      });
      await issueDocument(tx, ctxOf(s, approver), { documentId: pay.documentId });
    });
    await expect(
      withTenant(db.rw, s.tenant, approver, (tx) =>
        postDocument(tx, ctxOf(s, approver), { documentId: pay.documentId }),
      ),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.payment\.post/);
    await expect(bySql(pay.documentId, "posted", approver)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.payment\.post/,
    );
    expect(await statusOf(pay.documentId)).toBe("issued");
  });

  it("a RECEIPT needs NO submission — draft → issued is legal; a PAYMENT's is refused (§4.5.1, spec:2147)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s), receiptInput("2026-01-17", "5.0000"));
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId }); // straight from draft
      return d;
    });
    expect(await statusOf(r.documentId)).toBe("issued");

    const pay = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      draftSettlement(tx, ctxOf(s), paymentInput("2026-01-17", "5.0000")),
    );
    expect(await statusOf(pay.documentId)).toBe("draft");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        issueDocument(tx, ctxOf(s), { documentId: pay.documentId }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: draft → issued needs approval\.required = false/);
  });

  it("a PAYMENT with allocations is refused up front: it cannot post in the drafter's transaction", async () => {
    const before = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where document_type_id = ${payType}`;
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftSettlement(
          tx,
          ctxOf(s),
          paymentInput("2026-01-17", "5.0000", {
            allocations: [{ settledDocumentId: customerId, amount: "5.0000" }],
          }),
        ),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* requires approval/);
    const after = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where document_type_id = ${payType}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("an ON-ACCOUNT receipt with no allocation posts, and shows in partyBalance as a credit", async () => {
    const balance = () =>
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        partyBalance(tx, { companyId: s.company, partyId: customerId, asOf: "2026-01-31" }),
      );
    const before = await balance();
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(tx, ctxOf(s), receiptInput("2026-01-18", "15.0000"));
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
    });
    const after = await balance();
    // `Money.compare`/`subtract`, never `Number(...)`: no `number` holds a monetary value, in a test either
    // (Global Constraint 4, §3.7.5). A 15.0000 receipt credits 1200, so the balance falls by exactly that.
    expect(figure(after, MYR).compare(figure(before, MYR))).toBe(-1);
    expect(figure(before, MYR).subtract(figure(after, MYR)).toString()).toBe("15.0000");
    expect(before.base.subtract(after.base).toString()).toBe("15.0000");
  });

  it("a foreign-currency receipt keeps the caller's rate and labels it manual:<actor> (LEGACY-012, LEGACY-014)", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const d = await draftSettlement(
        tx,
        ctxOf(s),
        receiptInput("2026-01-19", "10.0000", { currency: "USD", exchangeRate: "4.68350000" }),
      );
      await issueDocument(tx, ctxOf(s), { documentId: d.documentId });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId });
      return d;
    });
    const [doc] = await db.admin<{ rate: string; rateSource: string | null }[]>`
      select exchange_rate::text as rate, rate_source as "rateSource"
        from app.document where id = ${r.documentId}`;
    expect(doc).toEqual({ rate: "4.68350000", rateSource: `manual:${s.human}` });
    const legs = await db.admin<{ code: string; baseDebit: string; baseCredit: string }[]>`
      select a.code, e.base_debit::text as "baseDebit", e.base_credit::text as "baseCredit"
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${r.documentId} order by a.code`;
    // base = round(10.0000 × 4.68350000, 4) on both legs (spec:1816), never a rate looked up afresh.
    expect(legs).toEqual([
      { code: "1100", baseDebit: "46.8350", baseCredit: "0.0000" },
      { code: "1200", baseDebit: "0.0000", baseCredit: "46.8350" },
    ]);
    // The base currency is the identity pair: a rate other than 1 on it is refused, not silently posted.
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftSettlement(
          tx,
          ctxOf(s),
          receiptInput("2026-01-19", "1.0000", { exchangeRate: "4.00000000" }),
        ),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* base currency MYR .* rate 1\.00000000/);
  });

  it("refuses what it cannot settle: a bad amount, another company's rows, a non-settlement type", async () => {
    const attempt = (input: SettlementInput) =>
      withTenant(db.rw, s.tenant, s.human, (tx) => draftSettlement(tx, ctxOf(s), input));
    await expect(attempt(receiptInput("2026-01-20", "0.0000"))).rejects.toThrow(
      /ERR_VALIDATION_FAILED: a settlement amount must be positive/,
    );
    await expect(attempt(receiptInput("2026-01-20", "-5.0000"))).rejects.toThrow(
      /ERR_VALIDATION_FAILED: a settlement amount must be positive/,
    );
    await expect(attempt(receiptInput("2026-01-20", "1.00001"))).rejects.toThrow(/ERR_MONEY_SCALE/);

    // RLS bounds the tenant and nothing else (AGENTS.md): each id is bound to the company asked through.
    const sibling = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'SET-B', 'Settlement sibling', 'MYR') returning id`;
      const [party] = await tx<{ id: string }[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en)
        values (${s.tenant}, ${company!.id}, 'customer', 'SET-B-CUST', 'Sibling customer') returning id`;
      const [account] = await tx<{ id: string }[]>`
        insert into app.account (tenant_id, company_id, code, name_en, type)
        values (${s.tenant}, ${company!.id}, '1100', 'Sibling bank', 'asset') returning id`;
      return { companyId: company!.id, partyId: party!.id, accountId: account!.id };
    });
    await expect(
      attempt(receiptInput("2026-01-20", "1.0000", { companyId: sibling.companyId })),
    ).rejects.toThrow(/ERR_NOT_FOUND: document type .* is not a live type of company/);
    await expect(
      attempt(receiptInput("2026-01-20", "1.0000", { partyId: sibling.partyId })),
    ).rejects.toThrow(/ERR_NOT_FOUND: party .* is not a live party of company/);
    await expect(
      attempt(receiptInput("2026-01-20", "1.0000", { bankAccountId: sibling.accountId })),
    ).rejects.toThrow(/ERR_NOT_FOUND: account .* is not an account of company/);
    await expect(
      attempt(receiptInput("2026-01-20", "1.0000", { branchId: sibling.partyId })),
    ).rejects.toThrow(/ERR_NOT_FOUND: branch .* is not a live branch of company/);

    // A type whose policy does not RELIEVE the party's control account is not a settlement: a SALES_INVOICE
    // debits it, so "settling" through this service would draft (and, with allocations, post) an invoice.
    await expect(
      attempt(receiptInput("2026-01-20", "1.0000", { documentTypeId: invType, series: "INV" })),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* is not a settlement/);
    // The series is the policy's: issue numbers in it whatever the draft says (§4.3.6), so a draft that
    // named another would display a series it will never be numbered in.
    await expect(attempt(receiptInput("2026-01-20", "1.0000", { series: "INV" }))).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .* series RCT/,
    );
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where effective_date = '2026-01-20'`;
    expect(n!.n).toBe(0);
  });

  it("the two series number independently and gaplessly (test 16's shape over this slice's series)", async () => {
    for (const series of ["RCT", "PAY-OUT"]) {
      const [row] = await db.admin<{ rows: number; issued: number; gaps: number }[]>`
        select count(distinct ds.fiscal_period_id)::int as rows,
               coalesce(sum(ds.next_number - 1), 0)::int as issued,
               (select count(*)::int from app.document_series ds2
                  cross join lateral app.series_gaps(ds2.company_id, ds2.series, ds2.fiscal_period_id)
                 where ds2.company_id = ${s.company} and ds2.series = ${series}) as gaps
          from app.document_series ds
         where ds.company_id = ${s.company} and ds.series = ${series}`;
      // Not vacuous: the suite above issued in both series, and the rolled-back receipt burned no number.
      expect(row!.rows).toBe(1);
      expect(row!.issued).toBeGreaterThan(0);
      expect(row!.gaps).toBe(0);
    }
  });
});
