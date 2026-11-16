// packages/db/test/ar-ap/review-4a.test.ts — the Phase 4 review's confirmed 4A findings at the data layer
// (A1, A2, A5, A6, A7, A8, A9, S2), each written to fail against the tree it was found on and pass against
// the fix. The route-level findings (S1, S3, A8's 409) are in apps/api/test/routes/accounting/review-4a.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { allocateSettlement, listAllocations, openBalance } from "../../src/ar-ap/allocation";
import { creditStatus } from "../../src/ar-ap/credit";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { archivePaymentTerm, updatePaymentTerm } from "../../src/ar-ap/payment-term";
import { issueDocument, postDocument, reverseDocument, voidDocument } from "../../src/posting";
import {
  draftTypedDocument,
  seedCurrency,
  seedItem,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "../index";
import { withTenant } from "../../src/with-tenant";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;
let serviceItem: string;
let productItem: string;
let warehouseId: string;
const MYR = currency("MYR");
const EUR = currency("EUR");

const ctx = async () => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A posted SALES_INVOICE of the fixture customer: one account line per amount, in MYR unless told. */
async function invoice(
  amounts: readonly string[],
  on: string,
  opts: { currency?: string; rate?: string } = {},
): Promise<string> {
  const { documentId } = await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: on,
    partyId: f.partyIds.customer,
    ...(opts.currency === undefined ? {} : { currency: opts.currency }),
    ...(opts.rate === undefined ? {} : { exchangeRate: opts.rate }),
    lines: amounts.map((amount) => ({ kind: "account", accountId: f.accountIds["4000"]!, amount })),
  });
  return documentId;
}

/** A posted RECEIPT of the fixture customer for `amount`. */
async function receipt(
  amount: string,
  on: string,
  opts: { currency?: string; rate?: string } = {},
): Promise<string> {
  const { documentId } = await postFromPack(db, s, {
    code: "RECEIPT",
    effectiveDate: on,
    partyId: f.partyIds.customer,
    ...(opts.currency === undefined ? {} : { currency: opts.currency }),
    ...(opts.rate === undefined ? {} : { exchangeRate: opts.rate }),
    lines: [{ kind: "account", accountId: f.accountIds["1100"]!, amount }],
  });
  return documentId;
}

async function statusOf(documentId: string): Promise<string> {
  const [row] = await db.admin<{ status: string }[]>`
    select status::text as status from app.document where id = ${documentId}`;
  return row!.status;
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "review-4a");
  f = await arApFixture(db, s);
  await seedCurrency(db, s, { code: "EUR" });
  ({ itemId: serviceItem } = await seedItem(db, s, {
    code: "SV-R4A",
    kind: "service",
    trackLots: false,
  }));
  ({ itemId: productItem } = await seedItem(db, s, {
    code: "PR-R4A",
    kind: "product",
    trackLots: false,
  }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-R4A" });
  // Ten units at 3.0000 on hand, so every delivery below is costed from a real layer.
  await postFromPack(db, s, {
    code: "GOODS_RECEIPT",
    effectiveDate: "2026-01-02",
    partyId: f.partyIds.vendor,
    warehouseId,
    jobs: recordingJobs(),
    lines: [
      {
        kind: "item",
        itemId: productItem,
        warehouseId,
        quantity: "10.000000",
        unitPrice: "3.0000",
        amount: "30.0000",
      },
    ],
  });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("A1 — a reversal and an allocation of the same invoice serialise", () => {
  it("an allocation that starts while the invoice's reversal is uncommitted is refused once it commits", async () => {
    const inv = await invoice(["100.0000"], "2026-01-05");
    const rct = await receipt("100.0000", "2026-01-06");
    const c1 = await ctx();
    const c2 = await ctx();
    let reversed!: () => void;
    let release!: () => void;
    const reversedYet = new Promise<void>((resolve) => (reversed = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));

    // T1 reverses the invoice — its "no live allocation" check passes, nothing is allocated yet — and holds.
    const t1 = withTenant(db.rw, c1, async (tx) => {
      await reverseDocument(tx, c1, {
        documentId: inv,
        effectiveDate: "2026-01-07",
        reason: "raised in error",
      });
      reversed();
      await released;
    });
    await reversedYet;
    // T2 allocates the receipt to that invoice while T1 is still open.
    const t2 = withTenant(db.rw, c2, (tx) =>
      allocateSettlement(tx, c2, {
        companyId: s.company,
        settlementDocumentId: rct,
        lines: [{ settledDocumentId: inv, amount: Money.of("100.0000", MYR) }],
      }),
    ).then(
      () => "allocated",
      (error: unknown) => String(error),
    );
    await sleep(400);
    release();
    await t1;

    expect(await statusOf(inv)).toBe("reversed");
    // The receipt must not be spent on an invoice the ledger no longer holds.
    expect(await t2).toMatch(
      /ERR_DOC_STATUS_ILLEGAL: document .* is not posted \(it is reversed\)/,
    );
    const live = await withTenant(db.rw, await ctx(), (tx) =>
      listAllocations(tx, { companyId: s.company, settledDocumentId: inv }),
    );
    expect(live).toEqual([]);
  });
});

describe("A2 — the base an allocation closes is the base the ledger posted", () => {
  it("a two-line EUR invoice paid in full at its own rate leaves NOTHING in 1200's base", async () => {
    // Each line posts round(10.0001 × 4.33333333, 4) = 43.3338, so the control account holds 86.6676; the
    // TOTAL at the rate is round(20.0002 × 4.33333333, 4) = 86.6675. The receipt's single line posts 86.6675.
    const rate = "4.33333333";
    const inv = await invoice(["10.0001", "10.0001"], "2026-01-08", { currency: "EUR", rate });
    const rct = await receipt("20.0002", "2026-01-08", { currency: "EUR", rate });
    const open = await withTenant(db.rw, await ctx(), (tx) =>
      openBalance(tx, { companyId: s.company, documentId: inv }),
    );
    expect(open.document.toString()).toBe("20.0002");
    expect(open.base.toString()).toBe("86.6676"); // the ledger's figure, not toBase(total)

    const c = await ctx();
    const { fxDifference } = await withTenant(db.rw, c, (tx) =>
      allocateSettlement(tx, c, {
        companyId: s.company,
        settlementDocumentId: rct,
        lines: [{ settledDocumentId: inv, amount: Money.of("20.0002", EUR) }],
      }),
    );
    // The 0.0001 the two documents' postings disagree by is the difference the allocation realises, so the
    // FX document settleWithFx posts for it takes 1200 back to exactly where it started.
    expect(fxDifference.toString()).toBe("-0.0001");
    const [row] = await db.admin<{ base: string; fx: string }[]>`
      select base_amount::text as base, fx_difference::text as fx from app.allocation
       where settled_document_id = ${inv} and unallocated_at is null`;
    expect(row).toEqual({ base: "86.6676", fx: "-0.0001" });
    // Before the FX posting the pair's own postings hold exactly that residue on the control account.
    const [pair] = await db.admin<{ net: string }[]>`
      select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as net
        from app.ledger_entry e
       where e.document_id = any(${[inv, rct]}::uuid[]) and e.account_id = ${f.accountIds["1200"]!}`;
    expect(pair!.net).toBe("0.0001");
  });
});

describe("A5 — a delivery is not reversed under an invoice that will still relieve its corridor", () => {
  async function delivery(on: string): Promise<string> {
    const { documentId } = await postFromPack(db, s, {
      code: "DELIVERY_ORDER",
      effectiveDate: on,
      partyId: f.partyIds.customer,
      warehouseId,
      jobs: recordingJobs(),
      lines: [
        {
          kind: "item",
          itemId: productItem,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
        },
      ],
    });
    return documentId;
  }
  const convert = async (source: string, on: string) => {
    const c = await ctx();
    return withTenant(db.rw, c, (tx) =>
      convertToInvoice(tx, c, {
        companyId: s.company,
        sourceDocumentId: source,
        targetDocumentTypeId: f.documentTypeIds.SALES_INVOICE!,
        targetSeries: "INV",
        effectiveDate: on,
        lines: [],
      }),
    );
  };
  const reverse = async (documentId: string, on: string) => {
    const c = await ctx();
    return withTenant(db.rw, c, (tx) =>
      reverseDocument(tx, c, {
        documentId,
        effectiveDate: on,
        reason: "returned",
        jobs: recordingJobs(),
      }),
    );
  };

  it("refuses while the converted invoice is a draft or issued, and allows it once that invoice is posted", async () => {
    const d = await delivery("2026-01-10");
    const { documentId: si } = await convert(d, "2026-01-10");
    await expect(reverse(d, "2026-01-11")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* has been converted into .* not yet posted/,
    );
    const c = await ctx();
    await withTenant(db.rw, c, (tx) => issueDocument(tx, c, { documentId: si }));
    await expect(reverse(d, "2026-01-11")).rejects.toThrow(/not yet posted/);
    expect(await statusOf(d)).toBe("posted");
    // The designed path — invoice posted, then the delivery reversed and a credit note raised — is not blocked.
    const c2 = await ctx();
    await withTenant(db.rw, c2, (tx) => postDocument(tx, c2, { documentId: si }));
    await reverse(d, "2026-01-11");
    expect(await statusOf(d)).toBe("reversed");
  });

  it("a VOID conversion releases the delivery", async () => {
    const d = await delivery("2026-01-12");
    const { documentId: si } = await convert(d, "2026-01-12");
    const c = await ctx();
    await withTenant(db.rw, c, async (tx) => {
      await issueDocument(tx, c, { documentId: si });
      await voidDocument(tx, c, { documentId: si, reason: "wrong customer" });
    });
    await reverse(d, "2026-01-13");
    expect(await statusOf(d)).toBe("reversed");
  });

  it("a conversion that starts while the delivery's reversal is uncommitted is refused once it commits", async () => {
    const d = await delivery("2026-01-14");
    const c1 = await ctx();
    let reversed!: () => void;
    let release!: () => void;
    const reversedYet = new Promise<void>((resolve) => (reversed = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const t1 = withTenant(db.rw, c1, async (tx) => {
      await reverseDocument(tx, c1, {
        documentId: d,
        effectiveDate: "2026-01-15",
        reason: "returned",
        jobs: recordingJobs(),
      });
      reversed();
      await released;
    });
    await reversedYet;
    const t2 = convert(d, "2026-01-15").then(
      () => "converted",
      (error: unknown) => String(error),
    );
    await sleep(400);
    release();
    await t1;
    expect(await statusOf(d)).toBe("reversed");
    // Refused either by `convertToInvoice`'s own `for share` read or, had it slipped past, by 0110's link
    // trigger — which re-reads the source after waiting — and in neither case is a link left behind.
    expect(await t2).toMatch(
      /ERR_DOC_STATUS_ILLEGAL: source document .* (is not posted \(it is reversed\)|is reversed)/,
    );
    const [links] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document_link
       where source_document_id = ${d} and link_kind = 'converts_to'`;
    expect(links!.n).toBe(0);
  });
});

describe("A9 — a partial credit note is not the signature of a full reversal", () => {
  it("an invoice with a POSTED partial credit note cannot be flipped to reversed by a bare UPDATE", async () => {
    const { documentId: inv } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-16",
      partyId: f.partyIds.customer,
      lines: [
        {
          kind: "item",
          itemId: serviceItem,
          quantity: "2.000000",
          unitPrice: "50.0000",
          amount: "100.0000",
        },
      ],
    });
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv}`;
    const c = await ctx();
    await withTenant(db.rw, c, async (tx) => {
      const note = await creditNoteFrom(tx, c, {
        companyId: s.company,
        settledDocumentId: inv,
        targetDocumentTypeId: f.documentTypeIds.SALES_CREDIT_NOTE!,
        targetSeries: "CN",
        effectiveDate: "2026-01-17",
        reason: "one unit short",
        lines: [{ settledLineId: line!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, c, { documentId: note.documentId });
      await postDocument(tx, c, { documentId: note.documentId });
    });
    // app_rw, no service: 0022's guard admitted this because a posted document points reverses_document_id at
    // the invoice — which the partial note does. The ledger still holds half the invoice.
    await expect(
      withTenant(
        db.rw,
        await ctx(),
        (tx) => tx`update app.document set status = 'reversed' where id = ${inv}`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: document .* can only be marked reversed by reverseDocument/,
    );
    expect(await statusOf(inv)).toBe("posted");
  });

  it("reverseDocument still marks an invoice reversed", async () => {
    const inv = await invoice(["12.0000"], "2026-01-18");
    await withTenant(db.rw, await ctx(), async (tx) =>
      reverseDocument(tx, await ctx(), {
        documentId: inv,
        effectiveDate: "2026-01-18",
        reason: "duplicate",
      }),
    );
    expect(await statusOf(inv)).toBe("reversed");
  });
});

describe("S2 — the settlement of an allocation is a settlement", () => {
  it("an INVOICE on the settlement side is refused, whatever the receipt on the other side", async () => {
    const inv = await invoice(["40.0000"], "2026-01-19");
    const rct = await receipt("40.0000", "2026-01-19");
    const c = await ctx();
    await expect(
      withTenant(db.rw, c, (tx) =>
        allocateSettlement(tx, c, {
          companyId: s.company,
          settlementDocumentId: inv,
          lines: [{ settledDocumentId: rct, amount: Money.of("40.0000", MYR) }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* is a SALES_INVOICE, which is not a settlement/,
    );
  });

  it("a partial CREDIT NOTE stays a legal settlement", async () => {
    const { documentId: inv } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-20",
      partyId: f.partyIds.customer,
      lines: [
        {
          kind: "item",
          itemId: serviceItem,
          quantity: "4.000000",
          unitPrice: "10.0000",
          amount: "40.0000",
        },
      ],
    });
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv}`;
    const c = await ctx();
    const noteId = await withTenant(db.rw, c, async (tx) => {
      const note = await creditNoteFrom(tx, c, {
        companyId: s.company,
        settledDocumentId: inv,
        targetDocumentTypeId: f.documentTypeIds.SALES_CREDIT_NOTE!,
        targetSeries: "CN",
        effectiveDate: "2026-01-20",
        reason: "one back",
        lines: [{ settledLineId: line!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, c, { documentId: note.documentId });
      await postDocument(tx, c, { documentId: note.documentId });
      return note.documentId;
    });
    const c2 = await ctx();
    const { allocationIds } = await withTenant(db.rw, c2, (tx) =>
      allocateSettlement(tx, c2, {
        companyId: s.company,
        settlementDocumentId: noteId,
        lines: [{ settledDocumentId: inv, amount: Money.of("10.0000", MYR) }],
      }),
    );
    expect(allocationIds).toHaveLength(1);
  });
});

describe("A6 / A7 — credit exposure counts every committed sale, whatever its date, one issue at a time", () => {
  /** A fresh party of `kind` on the fixture's receivable, with `limit` and/or a hold. */
  async function limited(
    code: string,
    opts: { limit?: string; hold?: boolean; kind?: "customer" | "vendor" | "dealer" },
  ): Promise<string> {
    const id = await seedParty(db, s, {
      kind: opts.kind ?? "customer",
      code,
      receivableAccountId: f.accountIds["1200"]!,
    });
    await withTenant(
      db.rw,
      await ctx(),
      (tx) => tx`update app.party set credit_limit = ${opts.limit ?? null},
                                      credit_hold = ${opts.hold ?? false}
                  where id = ${id}`,
    );
    return id;
  }
  /** Draft a one-line SALES_INVOICE (outbound) for `amount`; issue it unless told not to. */
  async function draft(partyId: string, amount: string, on: string): Promise<string> {
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: f.documentTypeIds.SALES_INVOICE!,
      series: "INV",
      effectiveDate: on,
      partyId,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount }],
    });
    await withTenant(
      db.rw,
      await ctx(),
      (tx) => tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`,
    );
    return documentId;
  }
  const issue = async (documentId: string) => {
    const c = await ctx();
    await withTenant(db.rw, c, (tx) => issueDocument(tx, c, { documentId }));
  };

  it("an issued-but-unposted sale counts: 900 + 900 against a 1000 limit is refused at the second issue", async () => {
    const p = await limited("CR-ISSUED", { limit: "1000.0000" });
    await issue(await draft(p, "900.0000", "2026-01-10"));
    await expect(issue(await draft(p, "900.0000", "2026-01-10"))).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED: party CR-ISSUED is over its credit limit/,
    );
  });

  it("a back-dated sale is measured against everything posted, not what was posted by its own date", async () => {
    const p = await limited("CR-BACKDATE", { limit: "1000.0000" });
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-20",
      partyId: p,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "900.0000" }],
    });
    await expect(issue(await draft(p, "900.0000", "2026-01-05"))).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED: party CR-BACKDATE/,
    );
  });

  it("a VOID sale releases its exposure, and a posted one is not counted twice", async () => {
    const p = await limited("CR-VOID", { limit: "1000.0000" });
    const first = await draft(p, "900.0000", "2026-01-10");
    await issue(first);
    const c = await ctx();
    await withTenant(db.rw, c, (tx) => voidDocument(tx, c, { documentId: first, reason: "wrong" }));
    await issue(await draft(p, "900.0000", "2026-01-11"));
    const status = await withTenant(db.rw, await ctx(), (tx) => creditStatus(tx, { partyId: p }));
    expect(status.openBase.toString()).toBe("0.0000");
    expect(status.pendingBase.toString()).toBe("900.0000");
    expect(status.exposureBase.toString()).toBe("900.0000");
    expect(status.headroomBase?.toString()).toBe("100.0000");
    // Posted, the same 900 moves from pending into the ledger — once.
    const p2 = await limited("CR-POSTED", { limit: "1000.0000" });
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-12",
      partyId: p2,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "900.0000" }],
    });
    const posted = await withTenant(db.rw, await ctx(), (tx) => creditStatus(tx, { partyId: p2 }));
    expect(posted.openBase.toString()).toBe("900.0000");
    expect(posted.pendingBase.toString()).toBe("0.0000");
    expect(posted.headroomBase?.toString()).toBe("100.0000");
  });

  it("two concurrent issues for one party serialise on the party row: 600 + 600 against 1000 admits one", async () => {
    const p = await limited("CR-RACE", { limit: "1000.0000" });
    const a = await draft(p, "600.0000", "2026-01-10");
    const b = await draft(p, "600.0000", "2026-01-10");
    const c1 = await ctx();
    const c2 = await ctx();
    let issued!: () => void;
    let release!: () => void;
    const issuedYet = new Promise<void>((resolve) => (issued = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const t1 = withTenant(db.rw, c1, async (tx) => {
      await issueDocument(tx, c1, { documentId: a });
      issued();
      await released;
    });
    await issuedYet;
    const t2 = withTenant(db.rw, c2, (tx) => issueDocument(tx, c2, { documentId: b })).then(
      () => "issued",
      (error: unknown) => String(error),
    );
    await sleep(400);
    release();
    await t1;
    expect(await t2).toMatch(/ERR_CREDIT_LIMIT_EXCEEDED: party CR-RACE/);
    expect(await statusOf(a)).toBe("issued");
    expect(await statusOf(b)).toBe("draft");
  });

  it("A7: a limit or a hold on a party that is not a customer is applied, not ignored", async () => {
    const dealer = await limited("CR-DEALER", { limit: "100.0000", kind: "dealer" });
    await expect(issue(await draft(dealer, "150.0000", "2026-01-10"))).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED: party CR-DEALER/,
    );
    const held = await limited("CR-HELD-VENDOR", { hold: true, kind: "vendor" });
    await expect(issue(await draft(held, "1.0000", "2026-01-10"))).rejects.toThrow(
      /ERR_CREDIT_HOLD: party CR-HELD-VENDOR is on credit hold/,
    );
    // …and a party of any kind with neither configured has no credit question.
    const plain = await limited("CR-PLAIN-VENDOR", { kind: "vendor" });
    const doc = await draft(plain, "5000.0000", "2026-01-10");
    await issue(doc);
    expect(await statusOf(doc)).toBe("issued");
  });
});

describe("A8 — a payment term's days are fixed once a document is aged on them (SAH-013)", () => {
  it("due_days, discount_days and discount_pct are refused once a non-draft document pins the term; names and archiving are not", async () => {
    const term = await seedPaymentTerm(db, s, { code: "N45-R4A", dueDays: 45 });
    const p = await seedParty(db, s, {
      kind: "customer",
      code: "CUST-N45",
      receivableAccountId: f.accountIds["1200"]!,
    });
    await withTenant(
      db.rw,
      await ctx(),
      (tx) => tx`update app.party set payment_term_id = ${term} where id = ${p}`,
    );
    const edit = async (patch: {
      dueDays?: number;
      discountDays?: number;
      discountPct?: string;
      nameEn?: string;
    }) => {
      const c = await ctx();
      return withTenant(db.rw, c, (tx) =>
        updatePaymentTerm(tx, c, { companyId: s.company, paymentTermId: term, ...patch }),
      );
    };
    // Only a draft pins it: the days are still the term's to change.
    const { documentId: draftId } = await draftTypedDocument(db, s, {
      documentTypeId: f.documentTypeIds.SALES_INVOICE!,
      series: "INV",
      effectiveDate: "2026-01-10",
      partyId: p,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "10.0000" }],
    });
    await withTenant(
      db.rw,
      await ctx(),
      (tx) => tx`update app.document set payment_term_id = ${term} where id = ${draftId}`,
    );
    expect((await edit({ dueDays: 40 })).dueDays).toBe(40);
    // A posted invoice pins it (postFromPack pins the party's term, as a drafting service does).
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      partyId: p,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "10.0000" }],
    });
    await expect(edit({ dueDays: 60 })).rejects.toThrow(
      /ERR_CONFLICT_REFERENCE: payment term .* is pinned on a document that is no longer a draft/,
    );
    await expect(edit({ discountDays: 10, discountPct: "0.020000" })).rejects.toThrow(
      /ERR_CONFLICT_REFERENCE/,
    );
    const [row] = await db.admin<{ d: number }[]>`
      select due_days as d from app.payment_term where id = ${term}`;
    expect(row!.d).toBe(40);
    // A rename, or re-saving the same days, is not a change to what the documents were aged on.
    expect((await edit({ nameEn: "Net forty", dueDays: 40 })).nameEn).toBe("Net forty");
    const c = await ctx();
    const archived = await withTenant(db.rw, c, (tx) =>
      archivePaymentTerm(tx, c, { companyId: s.company, paymentTermId: term }),
    );
    expect(archived.archivedAt).not.toBeNull();
  });
});
