// packages/db/test/ar-ap/code-review-a.test.ts — code review 2026-09-29, stream A: the AR/AP findings at the
// data layer, each written to fail against the tree it was found on (33d5e4d) and pass against the fix.
// The route-level halves are in apps/api/test/routes/accounting/code-review-a.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import type { Sql } from "postgres";
import { ageingTieOut } from "../../src/ar-ap/ageing";
import { allocateSettlement, openBalance } from "../../src/ar-ap/allocation";
import { creditStatus } from "../../src/ar-ap/credit";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { draftSettlement } from "../../src/ar-ap/settlement";
import { issueDocument, postDocument, recordOverride, reverseDocument } from "../../src/posting";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "../index";
import {
  arApFixture,
  postFromPack,
  seedTypeFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import {
  recordingJobs,
  secondPrincipal,
} from "../../../../tests/invariants/support/post-inventory";

const MYR = currency("MYR");

let db: Db;
let s: Seed;
let f: ArApFixture;
let supervisor: string;

/** Run `fn` in ONE production transaction as `s.human`, the way a route handler does. */
const as = async <T>(fn: (tx: Sql, c: TenantContext) => Promise<T>): Promise<T> => {
  const c = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};

/** A party whose credit columns are set as given (seedParty sets both control accounts). */
const partyWith = async (
  kind: "customer" | "vendor",
  code: string,
  opts: { limit?: string; hold?: boolean; receivable?: string | null } = {},
): Promise<string> => {
  const id = await seedParty(db, s, { kind, code });
  await as(
    (tx) => tx`
      update app.party
         set credit_limit = ${opts.limit ?? null}, credit_hold = ${opts.hold ?? false},
             receivable_account_id = ${opts.receivable === undefined ? f.accountIds["1200"]! : opts.receivable}
       where id = ${id}`,
  );
  return id;
};

/** A DRAFT of the seeded SALES_INVOICE for `amount` on one account line, `total_incl_tax` written as a
 *  drafting service writes it. */
const draftSale = async (partyId: string, amount: string): Promise<string> => {
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: f.documentTypeIds["SALES_INVOICE"]!,
    series: "INV",
    effectiveDate: "2026-01-10",
    partyId,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount }],
  });
  await setTotal(documentId, amount);
  await as((tx) => tx`update app.document set rate_source = 'unit' where id = ${documentId}`);
  return documentId;
};

/** What `PUT …/lines` does to the money of a one-line draft. */
const setTotal = (documentId: string, amount: string) =>
  as(
    (tx) => tx`
      update app.document_line set amount = ${amount}, total_incl_tax = ${amount}
       where document_id = ${documentId}`,
  );

const override = (documentId: string) =>
  as((tx, c) =>
    recordOverride(tx, c, {
      documentId,
      code: "accounting.credit_limit.override",
      reason: "director approved this sale",
      attributedTo: supervisor,
    }),
  );

const issue = (documentId: string) => as((tx, c) => issueDocument(tx, c, { documentId }));

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "code-review-a");
  f = await arApFixture(db, s);
  supervisor = await secondPrincipal(db, s, "cr-a-supervisor");
  await grantCodes(db, s, {
    codes: ["accounting.credit_limit.override"],
    principalId: supervisor,
    roleCode: "cr-a-supervisor",
  });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("A1 — a credit-limit override approves the amount it was recorded against", () => {
  it("an override recorded at 1,050 does not issue the same draft re-keyed to 100,000", async () => {
    const party = await partyWith("customer", "CR-A1-1", { limit: "1000.0000" });
    const sale = await draftSale(party, "1050.0000");
    await override(sale);
    await setTotal(sale, "100000.0000");
    await expect(issue(sale)).rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED/);
  });

  it("the override records the base total it approved, and admits that total or less", async () => {
    const party = await partyWith("customer", "CR-A1-2", { limit: "1000.0000" });
    const sale = await draftSale(party, "1050.0000");
    await override(sale);
    const [event] = await db.admin<{ approved: string | null }[]>`
      select approved_base_total::text as approved from app.document_event
       where document_id = ${sale} and event_kind = 'override'`;
    expect(event!.approved).toBe("1050.0000");
    await setTotal(sale, "1040.0000");
    await issue(sale);
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${sale}`;
    expect(doc!.status).toBe("issued");
  });

  it("a figure the caller supplies is not the approval: the database stamps the document's own total", async () => {
    const party = await partyWith("customer", "CR-A1-3", { limit: "1000.0000" });
    const sale = await draftSale(party, "1050.0000");
    await as(
      (tx) => tx`
        insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status,
                                        to_status, override_code, attributed_to, reason, approved_base_total)
        values (${s.tenant}, ${s.company}, ${sale}, 'override', 'draft', 'draft',
                'accounting.credit_limit.override', ${supervisor}, 'forged', ${"999999.0000"})`,
    );
    const [event] = await db.admin<{ approved: string }[]>`
      select approved_base_total::text as approved from app.document_event
       where document_id = ${sale} and event_kind = 'override'`;
    expect(event!.approved).toBe("1050.0000");
    await setTotal(sale, "5000.0000");
    await expect(issue(sale)).rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED/);
  });

  it("recordOverride refuses a credit override on a document that has already issued", async () => {
    const party = await partyWith("customer", "CR-A1-4", { limit: "1000.0000" });
    const sale = await draftSale(party, "100.0000");
    await issue(sale);
    await expect(override(sale)).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
  });
});

/** The §4.14 test-only shape of a PAYMENT with no second principal: outbound, debits the party's PAYABLE
 *  account. Only so a document of that shape can sit at `issued` without a checker. */
const PAYOUT_TEST_POLICY = {
  version: 1,
  documentType: "PAYOUT_TEST",
  direction: "outbound",
  requires: ["party"],
  lines: [
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
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "POT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.payment.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as const;

describe("A2 — credit control is a sale's control, not every outbound document's", () => {
  const pay = (partyId: string, amount: string) =>
    postFromPack(db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-01-12",
      partyId,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount }],
    });

  it("app.policy_extends_credit: the seeded sale policies extend credit and other policies do not", async () => {
    for (const code of [
      "DELIVERY_ORDER",
      "GOODS_RECEIPT",
      "PURCHASE_RETURN",
      "EXPIRY_WRITE_OFF",
      "STOCK_COUNT",
      "TRANSFER",
    ]) {
      await seedTypeFromPack(db, s, code);
    }
    const rows = await db.admin<{ code: string; direction: string; extends: boolean }[]>`
      select t.code, pp.definition ->> 'direction' as direction,
             app.policy_extends_credit(pp.definition) as extends
        from app.document_type t join app.posting_policy pp on pp.document_type_id = t.id
       where t.company_id = ${s.company} and t.code <> 'PAYOUT_TEST'
       order by t.code`;
    const extending = rows.filter((r) => r.extends).map((r) => r.code);
    // TILL_PAID_OUT (OD-10, answered yes 2026-11-04) is outbound per §4.14 and names no payable account, so the
    // predicate — a property of the policy alone — answers true for it. It never acts on one: a paid-out carries
    // no party, `app.assert_credit_available()` returns at `party_id is null`, and a party's exposure sums only
    // documents naming that party (ADR 0064).
    // 8C T5's PAYROLL_PAYMENT and EMPLOYEE_ADVANCE (spec:2082) are outbound per round 18 B8 and name no payable
    // account (their debit is `{ "code": "2400" }` / `{ "code": "1400" }`), so the predicate answers true for them on
    // the same terms as TILL_PAID_OUT: their policies require no party and the money-out services never set one, so
    // `app.assert_credit_available()` returns at `party_id is null` and no party's exposure counts them.
    expect(extending).toEqual([
      "DELIVERY_ORDER",
      "EMPLOYEE_ADVANCE",
      "PAYROLL_PAYMENT",
      "POS_TICKET",
      "SALES_INVOICE",
      "TILL_PAID_OUT",
    ]);
    // Every outbound type that names party.payable_account is excluded — PAYMENT, PURCHASE_CREDIT_NOTE and
    // PURCHASE_RETURN — and the check found them, rather than finding no outbound type at all.
    expect(rows.filter((r) => r.direction === "outbound" && !r.extends).map((r) => r.code)).toEqual(
      ["PAYMENT", "PURCHASE_CREDIT_NOTE", "PURCHASE_RETURN"],
    );
    const [nul] = await db.admin<{ v: boolean }[]>`select app.policy_extends_credit(null) as v`;
    expect(nul!.v).toBe(false);
  });

  it("a vendor on credit hold can still be paid", async () => {
    const vendor = await partyWith("vendor", "CR-A2-HOLD", { hold: true });
    const { result } = await pay(vendor, "250.0000");
    expect(result.ledgerEntryIds.length).toBeGreaterThan(0);
  });

  it("a vendor with a credit limit and only a payable account can be paid", async () => {
    const vendor = await partyWith("vendor", "CR-A2-NOAR", { limit: "100.0000", receivable: null });
    const { result } = await pay(vendor, "250.0000");
    expect(result.ledgerEntryIds.length).toBeGreaterThan(0);
  });

  it("a payment above a vendor's limit is not a sale over the limit", async () => {
    const vendor = await partyWith("vendor", "CR-A2-LIMIT", { limit: "100.0000" });
    const { result } = await pay(vendor, "500.0000");
    expect(result.ledgerEntryIds.length).toBeGreaterThan(0);
  });

  it("an issued payment-shaped document is not counted as credit exposure", async () => {
    const payoutType = await seedDocumentType(db, s, {
      code: "PAYOUT_TEST",
      module: "accounting",
      policy: PAYOUT_TEST_POLICY,
    });
    const vendor = await partyWith("vendor", "CR-A2-PEND", { limit: "10000.0000" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: payoutType,
      series: "POT",
      effectiveDate: "2026-01-12",
      partyId: vendor,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount: "500.0000" }],
    });
    await setTotal(documentId, "500.0000");
    await issue(documentId);
    const status = await as((tx) => creditStatus(tx, { partyId: vendor }));
    expect(status.pendingBase.toString()).toBe("0.0000");
  });

  it("a sale is still controlled: over the limit, on hold", async () => {
    const customer = await partyWith("customer", "CR-A2-SALE", { limit: "100.0000" });
    await expect(issue(await draftSale(customer, "500.0000"))).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED/,
    );
    const held = await partyWith("customer", "CR-A2-HELD", { hold: true });
    await expect(issue(await draftSale(held, "5.0000"))).rejects.toThrow(/ERR_CREDIT_HOLD/);
  });
});

describe("A3 — a settlement's capacity is what its posting put on the control account", () => {
  let vendor: string;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;

  /** A posted PURCHASE_RETURN of one unit, keyed at `keyed` — it posts at the layer's AVCO cost, 115.0000. */
  const returnOne = async (keyed: string, on: string): Promise<string> =>
    (
      await postFromPack(db, s, {
        code: "PURCHASE_RETURN",
        effectiveDate: on,
        partyId: vendor,
        warehouseId,
        jobs: recordingJobs(),
        lines: [
          {
            kind: "item",
            itemId,
            unitId,
            warehouseId,
            quantity: "1.000000",
            unitPrice: keyed,
            amount: keyed,
          },
        ],
      })
    ).documentId;

  beforeAll(async () => {
    vendor = await seedParty(db, s, { kind: "vendor", code: "CR-A3-VEND" });
    ({ itemId, baseUnitId: unitId } = await seedItem(db, s, {
      code: "CR-A3-ITEM",
      kind: "product",
      trackLots: false,
    }));
    warehouseId = await seedWarehouse(db, s, { code: "CR-A3-WH" });
    // Two units at 115.0000, so each returned unit leaves at exactly 115.0000.
    await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-05",
      partyId: vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [
        {
          kind: "item",
          itemId,
          unitId,
          warehouseId,
          quantity: "2.000000",
          unitPrice: "115.0000",
          amount: "230.0000",
        },
      ],
    });
  });

  it("a return keyed at 120 but posted at cost 115 settles 115, with no FX difference, and closes", async () => {
    const invoice = (
      await postFromPack(db, s, {
        code: "PURCHASE_INVOICE",
        effectiveDate: "2026-01-06",
        partyId: vendor,
        lines: [{ kind: "account", accountId: f.accountIds["5900"]!, amount: "200.0000" }],
      })
    ).documentId;
    const ret = await returnOne("120.0000", "2026-01-08");
    const [control] = await db.admin<{ net: string }[]>`
      select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as net
        from app.ledger_entry e where e.document_id = ${ret} and e.account_id = ${f.accountIds["2100"]!}`;
    expect(control!.net).toBe("115.0000");

    const open = await as((tx) => openBalance(tx, { companyId: s.company, documentId: ret }));
    expect([open.document.toString(), open.base.toString()]).toEqual(["115.0000", "115.0000"]);

    // The keyed 120 is more than the ledger holds: refused, not settled at a 5.0000 "FX" difference.
    await expect(
      as((tx, c) =>
        allocateSettlement(tx, c, {
          companyId: s.company,
          settlementDocumentId: ret,
          lines: [{ settledDocumentId: invoice, amount: Money.of("120.0000", MYR) }],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: allocations total 120\.0000 exceed/);

    const { fxDifference } = await as((tx, c) =>
      allocateSettlement(tx, c, {
        companyId: s.company,
        settlementDocumentId: ret,
        lines: [{ settledDocumentId: invoice, amount: Money.of("115.0000", MYR) }],
      }),
    );
    expect(fxDifference.toString()).toBe("0.0000");
    const closed = await as((tx) => openBalance(tx, { companyId: s.company, documentId: ret }));
    expect([closed.document.toString(), closed.base.toString()]).toEqual(["0.0000", "0.0000"]);
    const rest = await as((tx) => openBalance(tx, { companyId: s.company, documentId: invoice }));
    expect(rest.document.toString()).toBe("85.0000");
  });

  it("a return keyed at zero still has its cost to settle", async () => {
    const ret = await returnOne("0.0000", "2026-01-09");
    const open = await as((tx) => openBalance(tx, { companyId: s.company, documentId: ret }));
    expect([open.document.toString(), open.base.toString()]).toEqual(["115.0000", "115.0000"]);
  });
});

describe("A5 — an invoice converts only a stock document that filled the corridor it relieves", () => {
  it("a posted PURCHASE_RETURN (outbound, issue) is not a source for a SALES_INVOICE", async () => {
    const vendor = await seedParty(db, s, { kind: "vendor", code: "CR-A5-VEND" });
    const { itemId, baseUnitId: unitId } = await seedItem(db, s, {
      code: "CR-A5-ITEM",
      kind: "product",
      trackLots: false,
    });
    const warehouseId = await seedWarehouse(db, s, { code: "CR-A5-WH" });
    const line = (quantity: string, price: string, amount: string) => ({
      kind: "item" as const,
      itemId,
      unitId,
      warehouseId,
      quantity,
      unitPrice: price,
      amount,
    });
    await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-05",
      partyId: vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [line("3.000000", "10.0000", "30.0000")],
    });
    const { documentId: ret } = await postFromPack(db, s, {
      code: "PURCHASE_RETURN",
      effectiveDate: "2026-01-07",
      partyId: vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [line("1.000000", "10.0000", "10.0000")],
    });
    // The return debited 2100 and credited inventory; it never debited 1250, so an invoice relieving 1250 at
    // its cost would drive the corridor negative and charge COGS for goods already relieved against 2100.
    await expect(
      as((tx, c) =>
        convertToInvoice(tx, c, {
          companyId: s.company,
          sourceDocumentId: ret,
          targetDocumentTypeId: f.documentTypeIds["SALES_INVOICE"]!,
          targetSeries: "INV",
          effectiveDate: "2026-01-08",
          lines: [],
        }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: source document .* filled no corridor SALES_INVOICE relieves/,
    );
  });
});

describe("A6 — a receipt posted by draftSettlement enqueues its projection rebuild", () => {
  const settle = async (
    partyId: string,
    invoice: string,
    jobs?: ReturnType<typeof recordingJobs>,
  ) =>
    as((tx, c) =>
      draftSettlement(tx, c, {
        companyId: s.company,
        documentTypeId: f.documentTypeIds["RECEIPT"]!,
        series: "RCT",
        effectiveDate: "2026-01-20",
        partyId,
        bankAccountId: f.accountIds["1100"]!,
        currency: "MYR",
        exchangeRate: "1.00000000",
        amount: "50.0000",
        allocations: [{ settledDocumentId: invoice, amount: "50.0000" }],
        ...(jobs === undefined ? {} : { jobs }),
      }),
    );
  const sale = async (partyId: string) =>
    (
      await postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-01-15",
        partyId,
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "50.0000" }],
      })
    ).documentId;

  it("the caller's JobClient reaches postDocument's step 14", async () => {
    const customer = await seedParty(db, s, { kind: "customer", code: "CR-A6-1" });
    const jobs = recordingJobs();
    const result = await settle(customer, await sale(customer), jobs);
    expect(jobs.enqueued.map((j) => [j.name, j.singletonKey])).toEqual([
      ["accounting.projection.rebuild", s.company],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("without one, the skipped enqueue is returned as a warning, never dropped", async () => {
    const customer = await seedParty(db, s, { kind: "customer", code: "CR-A6-2" });
    const result = await settle(customer, await sale(customer));
    expect(result.warnings).toEqual([
      expect.stringMatching(/accounting\.projection\.rebuild was not enqueued/),
    ]);
  });
});

describe("A7 — a refund has no posting rule, so draftSettlement refuses one plainly", () => {
  const attempt = (code: "RECEIPT" | "PAYMENT", partyId: string) =>
    as((tx, c) =>
      draftSettlement(tx, c, {
        companyId: s.company,
        documentTypeId: f.documentTypeIds[code]!,
        series: code === "RECEIPT" ? "RCT" : "PAY-OUT",
        effectiveDate: "2026-01-21",
        partyId,
        bankAccountId: f.accountIds["1100"]!,
        currency: "MYR",
        exchangeRate: "1.00000000",
        amount: "10.0000",
      }),
    );

  it("a PAYMENT to a customer would debit 2100, which that customer's open items are never read on", async () => {
    // seedParty gives the customer BOTH control accounts, so the PAYMENT would post — to 2100, while the
    // customer's credit note waits on 1200 for ever. Refused before anything is written.
    const customer = await seedParty(db, s, { kind: "customer", code: "CR-A7-CUST" });
    await expect(attempt("PAYMENT", customer)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*PAYMENT .*party\.payable_account.*receivable account.*no posting rule/,
    );
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where party_id = ${customer}`;
    expect(n!.n).toBe(0);
  });

  it("a RECEIPT from a vendor would credit 1200, which that vendor's open items are never read on", async () => {
    const vendor = await seedParty(db, s, { kind: "vendor", code: "CR-A7-VEND" });
    await expect(attempt("RECEIPT", vendor)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*RECEIPT .*party\.receivable_account.*payable account.*no posting rule/,
    );
  });

  it("the ordinary directions still draft: a customer's receipt, a vendor's payment", async () => {
    const customer = await seedParty(db, s, { kind: "customer", code: "CR-A7-CUST2" });
    const vendor = await seedParty(db, s, { kind: "vendor", code: "CR-A7-VEND2" });
    expect((await attempt("RECEIPT", customer)).documentId).toBeTruthy();
    expect((await attempt("PAYMENT", vendor)).documentId).toBeTruthy();
  });
});

/**
 * Code review 2 (F2). DELIVERY_ORDER reverses into DELIVERY_ORDER, which app.policy_extends_credit calls a
 * sale on credit, so reverseDocument's mirror — every magnitude negated, issued by postDocument inside the same
 * call — met the credit control as a NEW sale: a hold refused it outright and an exposure already over the
 * limit refused it although its own contribution was negative. A delivery made to a customer later put on
 * hold could not be taken back, even on the designed full-return path. A reversal that lowers the exposure is
 * not a sale; one that would raise it (a custom reversal type) is still controlled.
 */
describe("F2 (code review 2) — a reversal that takes a sale back is not a sale on credit", () => {
  let itemId: string;
  let unitId: string;
  let warehouseId: string;

  const deliver = async (partyId: string, amount: string, on: string): Promise<string> =>
    (
      await postFromPack(db, s, {
        code: "DELIVERY_ORDER",
        effectiveDate: on,
        partyId,
        warehouseId,
        jobs: recordingJobs(),
        lines: [
          {
            kind: "item",
            itemId,
            unitId,
            warehouseId,
            quantity: "1.000000",
            unitPrice: amount,
            amount,
          },
        ],
      })
    ).documentId;

  const reverse = (documentId: string, on: string) =>
    as((tx, c) =>
      reverseDocument(tx, c, {
        documentId,
        effectiveDate: on,
        reason: "returned",
        jobs: recordingJobs(),
      }),
    );

  const statusOf = async (documentId: string): Promise<string> => {
    const [row] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${documentId}`;
    return row!.status;
  };

  const setCredit = (partyId: string, set: { hold?: boolean; limit?: string }) =>
    as(
      (tx) => tx`
        update app.party
           set credit_hold = coalesce(${set.hold ?? null}::boolean, credit_hold),
               credit_limit = coalesce(${set.limit ?? null}::numeric, credit_limit)
         where id = ${partyId}`,
    );

  beforeAll(async () => {
    ({ itemId, baseUnitId: unitId } = await seedItem(db, s, {
      code: "CR-F2-ITEM",
      kind: "product",
      trackLots: false,
    }));
    warehouseId = await seedWarehouse(db, s, { code: "CR-F2-WH" });
    await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-02",
      partyId: f.partyIds.vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [
        {
          kind: "item",
          itemId,
          unitId,
          warehouseId,
          quantity: "50.000000",
          unitPrice: "3.0000",
          amount: "150.0000",
        },
      ],
    });
  });

  it("a delivery to a customer since put on hold reverses; a new delivery is still refused", async () => {
    const customer = await partyWith("customer", "CR-F2-HOLD");
    const d = await deliver(customer, "50.0000", "2026-01-10");
    await setCredit(customer, { hold: true });
    await reverse(d, "2026-01-11");
    expect(await statusOf(d)).toBe("reversed");
    await expect(deliver(customer, "50.0000", "2026-01-12")).rejects.toThrow(/ERR_CREDIT_HOLD/);
  });

  it("a delivery reverses under an exposure already over the limit; a new delivery is still refused", async () => {
    const customer = await partyWith("customer", "CR-F2-LIMIT");
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      partyId: customer,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "500.0000" }],
    });
    const d = await deliver(customer, "100.0000", "2026-01-10");
    await setCredit(customer, { limit: "100.0000" });
    await reverse(d, "2026-01-11");
    expect(await statusOf(d)).toBe("reversed");
    await expect(deliver(customer, "10.0000", "2026-01-12")).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED/,
    );
  });

  it("the designed full return — delivery invoiced, customer put on hold, delivery reversed — posts", async () => {
    const customer = await partyWith("customer", "CR-F2-RETURN");
    const d = await deliver(customer, "40.0000", "2026-01-10");
    const { documentId: si } = await as((tx, c) =>
      convertToInvoice(tx, c, {
        companyId: s.company,
        sourceDocumentId: d,
        targetDocumentTypeId: f.documentTypeIds.SALES_INVOICE!,
        targetSeries: "INV",
        effectiveDate: "2026-01-10",
        lines: [],
      }),
    );
    await as((tx, c) => postDocument(tx, c, { documentId: si, jobs: recordingJobs() }));
    await setCredit(customer, { hold: true });
    await reverse(d, "2026-01-11");
    expect(await statusOf(d)).toBe("reversed");
  });

  it("a document that names a reversed document but raises the exposure is still controlled", async () => {
    // The exemption is a reversal AND a non-positive contribution together: a custom reversal type whose
    // mirror adds exposure (an issue of a sale type pointing reverses_document_id somewhere) is a sale.
    const customer = await partyWith("customer", "CR-F2-RAISE");
    const d = await deliver(customer, "20.0000", "2026-01-10");
    await setCredit(customer, { hold: true });
    const sale = await draftSale(customer, "20.0000");
    await as((tx) => tx`update app.document set reverses_document_id = ${d} where id = ${sale}`);
    await expect(issue(sale)).rejects.toThrow(/ERR_CREDIT_HOLD/);
    await setCredit(customer, { hold: false, limit: "10.0000" });
    await expect(issue(sale)).rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED/);
  });
});

// Code review 2 (Phase 4), M5-X / review finding F7: A7's refusal lived only in draftSettlement, so the
// generic insert → issue → post sequence (POST …/documents, then …/transitions — `postFromPack` here) posted
// the same refund, and the 1200/2100 tie-out of the Phase 4 definition of done (spec:2290) stopped
// reconciling. postDocument step 6c now asks the one helper every path shares. Each red case posted on
// e8df83b.
describe("F7 / M5-X — the refund refusal is the posting service's, on every path", () => {
  const differences = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await as((tx) => ageingTieOut(tx, { companyId: s.company, asOf: "2026-01-31" }))).map(
        (r) => [r.accountCode, r.difference],
      ),
    );
  const ledgerRowsOf = async (partyId: string): Promise<number> => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e join app.document d on d.id = e.document_id
       where d.party_id = ${partyId}`;
    return n!.n;
  };
  const numbered = async (partyId: string): Promise<{ status: string; number: string | null }[]> =>
    db.admin<{ status: string; number: string | null }[]>`
      select status::text as status, number::text as number from app.document where party_id = ${partyId}`;
  const settle = (code: "RECEIPT" | "PAYMENT", partyId: string, amount: string) =>
    postFromPack(db, s, {
      code,
      effectiveDate: "2026-01-22",
      partyId,
      lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount }],
    });

  it("a RECEIPT from a vendor (both control accounts set) is refused at post, and the tie-out holds", async () => {
    const vendor = await seedParty(db, s, { kind: "vendor", code: "CR-F7-VEND" });
    const before = await differences();
    await expect(settle("RECEIPT", vendor, "100.0000")).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .*: a RECEIPT posts to party\.receivable_account, but vendor CR-F7-VEND's open items are on its payable account .*no posting rule/,
    );
    expect(await ledgerRowsOf(vendor)).toBe(0);
    // Refused before step 7: the draft kept no number.
    expect(await numbered(vendor)).toEqual([{ status: "draft", number: null }]);
    const after = await differences();
    expect(after).toEqual(before);
    expect([after["1200"], after["2100"]]).toEqual(["0.0000", "0.0000"]);
  });

  it("a PAYMENT to a customer is refused at post by its checker, and the tie-out holds", async () => {
    const customer = await seedParty(db, s, { kind: "customer", code: "CR-F7-CUST" });
    const before = await differences();
    await expect(settle("PAYMENT", customer, "40.0000")).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .*: a PAYMENT posts to party\.payable_account, but customer CR-F7-CUST's open items are on its receivable account .*no posting rule/,
    );
    expect(await ledgerRowsOf(customer)).toBe(0);
    const after = await differences();
    expect(after).toEqual(before);
    expect([after["1200"], after["2100"]]).toEqual(["0.0000", "0.0000"]);
  });

  it("control: the ordinary directions still post generically — a customer's receipt, a vendor's payment", async () => {
    const customer = await seedParty(db, s, { kind: "customer", code: "CR-F7-CUST2" });
    const vendor = await seedParty(db, s, { kind: "vendor", code: "CR-F7-VEND2" });
    expect((await settle("RECEIPT", customer, "15.0000")).result.ledgerEntryIds).toHaveLength(2);
    expect((await settle("PAYMENT", vendor, "16.0000")).result.ledgerEntryIds).toHaveLength(2);
    const after = await differences();
    expect([after["1200"], after["2100"]]).toEqual(["0.0000", "0.0000"]);
  });
});
