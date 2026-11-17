import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { lintSchema } from "../../src/lint-schema";
import {
  allocateSettlement,
  listAllocations,
  openBalance,
  partyBalance,
  unallocate,
} from "../../src/ar-ap/allocation";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import {
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedRate,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import { accountByCode, loadTypesFromPack } from "./_support";

let db: Db;
let s: Seed;
let invType: string;
let rctType: string;
let cnType: string;
let pinvType: string;
let partyId: string;
let itemId: string;
let bankId: string;
const MYR = currency("MYR");
const EUR = currency("EUR");
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "allocation");
  // `seedAccount` is idempotent on (company_id, code); 4A seeds no account (Global Constraint 14).
  for (const [code, nameEn, type] of [
    ["1100", "Bank", "asset"],
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"],
    ["5920", "FX rounding", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  bankId = await accountByCode(db, s, "1100");
  await seedCurrency(db, s, { code: "EUR" });
  await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "4.80000000" });
  // The settlement side is the pack's own RECEIPT (4A Task 10): debit the bank line's account, credit the
  // party's receivable control, both at `line.total_incl_tax`, no maker-checker. Until Task 10 this suite
  // carried that policy transcribed under a test-only code; the arithmetic below reads the ledger and the
  // allocation table, never the type's code, so the swap changes no expectation.
  const types = await loadTypesFromPack(db, s, [
    "SALES_INVOICE",
    "SALES_CREDIT_NOTE",
    "PURCHASE_INVOICE",
    "RECEIPT",
  ]);
  invType = types.salesInvoiceType!;
  cnType = types.salesCreditNoteType!;
  pinvType = types.purchaseInvoiceType!;
  rctType = types.receiptType!;
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-ALLOC" });
  ({ itemId } = await seedItem(db, s, { code: "IT-ALLOC", kind: "product", trackLots: false }));
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** One invoice for `amount` (a single item line), in MYR unless told otherwise. */
async function invoiceFor(
  amount: string,
  effectiveDate: string,
  opts: { party?: string; currencyCode?: string; rate?: string } = {},
) {
  return postArDocument(db, s, {
    documentTypeId: invType,
    series: "INV",
    partyId: opts.party ?? partyId,
    effectiveDate,
    currency: opts.currencyCode ?? "MYR",
    exchangeRate: opts.rate ?? "1.00000000",
    lines: [
      { kind: "item", itemId, quantity: "1.000000", unitPrice: amount, amount, cost: "1.0000" },
    ],
  });
}
/** One receipt for `amount` — a single bank line. */
async function receiptFor(
  amount: string,
  effectiveDate: string,
  currencyCode = "MYR",
  rate = "1.00000000",
  party = partyId,
) {
  return postArDocument(db, s, {
    documentTypeId: rctType,
    series: "RCT",
    partyId: party,
    effectiveDate,
    currency: currencyCode,
    exchangeRate: rate,
    lines: [
      {
        kind: "account",
        accountId: bankId,
        description: "bank transfer",
        amount,
        totalInclTax: amount,
      },
    ],
  });
}

const allocate = (
  settlementDocumentId: string,
  lines: { settledDocumentId: string; amount: Money; settlementAmount?: Money }[],
  companyId = s.company,
) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    allocateSettlement(tx, ctxOf(s), { companyId, settlementDocumentId, lines }),
  );
const openOf = (documentId: string, companyId = s.company) =>
  withTenant(db.rw, s.tenant, s.human, (tx) => openBalance(tx, { companyId, documentId }));

describe("app.allocation — migration 0046, contracts §4.8.1", () => {
  it("the schema linter reports zero violations after 0046", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("openBalance on a fresh invoice is its total, in both document and base currency", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-05");
    const open = await openOf(inv.documentId);
    expect(open.document.toString()).toBe("100.0000");
    expect(open.document.currency).toBe("MYR");
    expect(open.base.toString()).toBe("100.0000");
  });

  it("a full allocation drives openBalance to zero and records one row", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-06");
    const rct = await receiptFor("100.0000", "2026-01-07");
    const { allocationIds, fxDifference } = await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) },
    ]);
    expect(allocationIds).toHaveLength(1);
    expect(fxDifference.toString()).toBe("0.0000");
    const open = await openOf(inv.documentId);
    expect(open.document.toString()).toBe("0.0000");
    expect(open.base.toString()).toBe("0.0000");
    // The row carries the company, the party and the allocator — the stamp, not a payload (§3.3).
    const [row] = await db.admin<{ companyId: string; partyId: string; by: string }[]>`
      select company_id as "companyId", party_id as "partyId", allocated_by as by
        from app.allocation where id = ${allocationIds[0]!}`;
    expect(row).toEqual({ companyId: s.company, partyId, by: s.human });
  });

  it("allocating MORE than the settlement total is ERR_VALIDATION_FAILED (§6.2's allocation proof)", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-08");
    const rct = await receiptFor("40.0000", "2026-01-08");
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) },
      ]),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: allocations total 100\.0000 exceed the settlement total 40\.0000/,
    );
  });

  it("allocating MORE than the settled document's open balance is ERR_VALIDATION_FAILED naming the document", async () => {
    const inv = await invoiceFor("30.0000", "2026-01-09");
    const rct = await receiptFor("100.0000", "2026-01-09");
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: document .* has an open balance of 30\.0000/);
    // Two lines against ONE invoice inside one call are bounded together, not each against the full total.
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of("20.0000", MYR) },
        { settledDocumentId: inv.documentId, amount: Money.of("20.0000", MYR) },
      ]),
    ).rejects.toThrow(/has an open balance of 10\.0000/);
    // …and the refused call wrote nothing: the transaction rolled back whole.
    expect((await openOf(inv.documentId)).document.toString()).toBe("30.0000");
  });

  it("unallocate returns openBalance to the PRE-ALLOCATION figure, to the cent, and touches NO ledger entry", async () => {
    const inv = await invoiceFor("77.7700", "2026-01-10");
    const rct = await receiptFor("77.7700", "2026-01-10");
    const before = await openOf(inv.documentId);
    const [ledgerBefore] = await db.admin<{ h: string }[]>`
      select md5(string_agg(id::text || debit::text || credit::text, '|' order by id))::text as h
        from app.ledger_entry`;
    const { allocationIds } = await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("77.7700", MYR) },
    ]);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unallocate(tx, ctxOf(s), {
        companyId: s.company,
        settlementDocumentId: rct.documentId,
        allocationId: allocationIds[0]!,
        reason: "applied to the wrong invoice",
      }),
    );
    const after = await openOf(inv.documentId);
    expect(after.document.toString()).toBe(before.document.toString());
    expect(after.base.toString()).toBe(before.base.toString());
    const [ledgerAfter] = await db.admin<{ h: string }[]>`
      select md5(string_agg(id::text || debit::text || credit::text, '|' order by id))::text as h
        from app.ledger_entry`;
    expect(ledgerAfter!.h).toBe(ledgerBefore!.h); // spec:2457 — matching never alters a ledger entry

    // The compelled reason is STORED, and the un-allocator is stamped. Validating a reason and then
    // discarding it is the ADR 0023 loss (fiscal_period.reopen_reason) in a new table: app.audit_row
    // writes to_jsonb(new), so a value never written to a column can never be recovered from the audit.
    const [row] = await db.admin<{ reason: string | null; by: string | null; at: string | null }[]>`
      select unallocation_reason as reason, unallocated_by as by, unallocated_at as at
        from app.allocation where id = ${allocationIds[0]!}`;
    expect(row!.reason).toBe("applied to the wrong invoice");
    expect(row!.by).toBe(s.human);
    expect(row!.at).not.toBeNull();
    const [audit] = await db.admin<{ reason: string | null }[]>`
      select after->>'unallocation_reason' as reason from app.audit_log
       where table_name = 'allocation' and row_id = ${allocationIds[0]!} and action = 'update'`;
    expect(audit!.reason).toBe("applied to the wrong invoice");
    const [listed] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, {
        companyId: s.company,
        settledDocumentId: inv.documentId,
        includeUnallocated: true,
      }),
    );
    expect(listed!.unallocationReason).toBe("applied to the wrong invoice");
    expect(listed!.unallocatedBy).toBe(s.human);

    // A second reversal of the same row is refused, and so is an empty reason — nothing is written.
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        unallocate(tx, ctxOf(s), {
          companyId: s.company,
          settlementDocumentId: rct.documentId,
          allocationId: allocationIds[0]!,
          reason: "again",
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: allocation .* is not an open allocation/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        unallocate(tx, ctxOf(s), {
          companyId: s.company,
          settlementDocumentId: rct.documentId,
          allocationId: allocationIds[0]!,
          reason: "   ",
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: a reason is required/);
  });

  it("unallocate is bound to the settlement AND the company it is asked through", async () => {
    const inv = await invoiceFor("8.0000", "2026-01-10");
    const rct = await receiptFor("8.0000", "2026-01-10");
    const other = await receiptFor("8.0000", "2026-01-10");
    const { allocationIds } = await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("8.0000", MYR) },
    ]);
    const attempt = (settlementDocumentId: string, companyId: string) =>
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        unallocate(tx, ctxOf(s), {
          companyId,
          settlementDocumentId,
          allocationId: allocationIds[0]!,
          reason: "x",
        }),
      );
    // Asked through another settlement — the route's gate cleared THAT document, not this one.
    await expect(attempt(other.documentId, s.company)).rejects.toThrow(/ERR_NOT_FOUND/);
    // Asked through a sibling company of the same tenant — RLS bounds the tenant and nothing else.
    const sibling = await siblingCompany("ALLOC-B");
    await expect(attempt(rct.documentId, sibling)).rejects.toThrow(/ERR_NOT_FOUND/);
    expect((await openOf(inv.documentId)).document.toString()).toBe("0.0000");
  });

  it("a CREDIT NOTE as the settlement document has capacity |total| − allocated, not |total − allocated|", async () => {
    // §4.8.1 names a credit note as a legal settlement_document_id, and Task 8 writes its magnitudes
    // NEGATED, so `total_incl_tax` is −100.0000 here. `.abs()` AFTER the subtraction would report
    // |−100 − 30| = 130.0000 of remaining capacity where 70.0000 is the truth — over-allocation admitted by
    // exactly the amount already allocated, and growing with every allocation. This is the case that
    // discriminates the order of the two operations, and it is red against `.subtract(...).abs()`.
    //
    // The note is built through `creditNoteFrom` (Task 8) and NOT through `postArDocument`:
    // `SALES_CREDIT_NOTE.json` declares `requires: ["party", "reverses_document"]` and `draftTypedDocument`
    // does not write that column, so a note drafted through the helper is refused at post.
    const credited = await invoiceFor("100.0000", "2026-01-13");
    const [creditedLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${credited.documentId} order by line_no`;
    const note = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const r = await creditNoteFrom(tx, ctxOf(s), {
        companyId: s.company,
        settledDocumentId: credited.documentId,
        targetDocumentTypeId: cnType,
        targetSeries: "CN",
        effectiveDate: "2026-01-14",
        reason: "the whole invoice was returned",
        lines: [{ settledLineId: creditedLine!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
      await postDocument(tx, ctxOf(s), { documentId: r.documentId });
      return r;
    });
    const [noteTotal] = await db.admin<{ t: string }[]>`
      select coalesce(sum(total_incl_tax), 0)::text as t from app.document_line
       where document_id = ${note.documentId}`;
    expect(noteTotal!.t).toBe("-100.0000"); // negated magnitudes — the premise the rest of this case rests on
    const first = await invoiceFor("500.0000", "2026-01-14");
    const second = await invoiceFor("500.0000", "2026-01-14");
    await allocate(note.documentId, [
      { settledDocumentId: first.documentId, amount: Money.of("30.0000", MYR) },
    ]);
    // 100 magnitude, 30 spent, 70 left: 71 is refused and the message names 70.0000, not 130.0000.
    await expect(
      allocate(note.documentId, [
        { settledDocumentId: second.documentId, amount: Money.of("71.0000", MYR) },
      ]),
    ).rejects.toThrow(/exceed the settlement total 70\.0000/);
    const { allocationIds } = await allocate(note.documentId, [
      { settledDocumentId: second.documentId, amount: Money.of("70.0000", MYR) },
    ]);
    expect(allocationIds).toHaveLength(1);
    // Σ of the note's live allocations is exactly its magnitude — spent to the cent, never past it.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company, settlementDocumentId: note.documentId }),
    );
    expect(rows.map((r) => r.amount)).toEqual(["30.0000", "70.0000"]);
    await expect(
      allocate(note.documentId, [
        { settledDocumentId: second.documentId, amount: Money.of("0.0001", MYR) },
      ]),
    ).rejects.toThrow(/exceed the settlement total 0\.0000/);
    // The note's open balance counts BOTH roles: it has spent its whole magnitude as a settlement, so
    // nothing of it is left to be settled either. Counting the settled role alone reported |−100| = 100 here,
    // and an invoice (the opposite side of the control account) could then settle the same credit again.
    expect((await openOf(note.documentId)).document.toString()).toBe("0.0000");
    // An invoice cannot be put on the settlement side to spend the note again: since the Phase 4 review (S2)
    // the settlement side must be a settlement or a credit note by its pinned policy, which refuses the
    // invoice before any capacity is read. The note's zero open balance above is the both-roles figure.
    const third = await invoiceFor("100.0000", "2026-01-14");
    await expect(
      allocate(third.documentId, [
        { settledDocumentId: note.documentId, amount: Money.of("1.0000", MYR) },
      ]),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* is a SALES_INVOICE, which is not a settlement/,
    );
  });

  it("an unallocated row is excluded by default and visible with includeUnallocated", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company, includeUnallocated: true }),
    );
    expect(rows.some((r) => r.unallocatedAt !== null)).toBe(true);
    const live = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company }),
    );
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((r) => r.unallocatedAt === null)).toBe(true);
    // Every row names the two currencies its three money fields are in (§4.8.1's derived members).
    expect(live.every((r) => r.currency === "MYR" && r.baseCurrency === "MYR")).toBe(true);
  });

  it("a EUR receipt against a EUR invoice at a DIFFERENT rate records the fx_difference and posts NO fx line (4B does)", async () => {
    const inv = await invoiceFor("100.0000", "2026-01-11", {
      currencyCode: "EUR",
      rate: "4.80000000",
    });
    const rct = await receiptFor("100.0000", "2026-01-12", "EUR", "4.90000000");
    const { allocationIds, fxDifference } = await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("100.0000", EUR) },
    ]);
    // 100 EUR settled at 4.90 is 490.00 base; the invoice carried it at 4.80, that is 480.00. A gain of 10.
    expect(fxDifference.toString()).toBe("10.0000");
    expect(fxDifference.currency).toBe("MYR");
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company, settlementDocumentId: rct.documentId }),
    );
    expect(row).toMatchObject({
      id: allocationIds[0],
      amount: "100.0000",
      baseAmount: "480.0000",
      fxDifference: "10.0000",
      currency: "EUR",
      baseCurrency: "MYR",
    });
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.code in ('4900', '5910')`;
    expect(n!.n).toBe(0); // 4A stores it; 4B posts it (§4.8.1)
  });

  it("the completing allocation takes the BASE residue on both sides, so Σ fx_difference closes the control account exactly", async () => {
    // Thirds at 4.80 and 4.90 do not round evenly: round(33.3333 × 4.8, 4) = 159.9998 twice and
    // round(33.3334 × 4.8, 4) = 160.0003, which is 479.9999 — not the 480.0000 the 100 EUR invoice carried.
    // A per-line `toBase` would leave openBalance at 0.0001 in base on a fully settled invoice, and an fx
    // difference 4B could post without closing the control account. The allocation that COMPLETES a
    // document takes `open base − Σ earlier`, exactly as Tasks 6 and 8 take their residues.
    const fresh = await seedParty(db, s, { kind: "customer", code: "CUST-RESIDUE" });
    // (a) The settled side: one invoice of 100 EUR at 4.80, paid by three receipts at the SAME rate.
    const inv = await invoiceFor("100.0000", "2026-01-15", {
      party: fresh,
      currencyCode: "EUR",
      rate: "4.80000000",
    });
    let fx: Money = Money.zero(MYR);
    for (const amount of ["33.3333", "33.3333", "33.3334"]) {
      const rct = await receiptFor(`${amount}`, "2026-01-16", "EUR", "4.80000000", fresh);
      const r = await allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of(amount, EUR) },
      ]);
      fx = fx.add(r.fxDifference);
    }
    const open = await openOf(inv.documentId);
    expect(open.document.toString()).toBe("0.0000");
    expect(open.base.toString()).toBe("0.0000"); // 0.0001 without the residue
    const [bases] = await db.admin<{ base: string }[]>`
      select sum(base_amount)::text as base from app.allocation
       where settled_document_id = ${inv.documentId} and unallocated_at is null`;
    expect(bases!.base).toBe("480.0000"); // the invoice's own base, exactly
    // (b) The settlement side: one receipt of 100 EUR at 4.90 paying three invoices of a third each at 4.80.
    const thirds = [];
    for (const amount of ["33.3333", "33.3333", "33.3334"]) {
      thirds.push(
        await invoiceFor(amount, "2026-01-17", {
          party: fresh,
          currencyCode: "EUR",
          rate: "4.80000000",
        }),
      );
    }
    const rct = await receiptFor("100.0000", "2026-01-18", "EUR", "4.90000000", fresh);
    const r = await allocate(
      rct.documentId,
      thirds.map((t, i) => ({
        settledDocumentId: t.documentId,
        amount: Money.of(["33.3333", "33.3333", "33.3334"][i]!, EUR),
      })),
    );
    fx = fx.add(r.fxDifference);
    // The settlement's base consumed (base_amount + fx_difference) is ITS base, 490.0000, to the cent.
    const [consumed] = await db.admin<{ base: string }[]>`
      select sum(base_amount + fx_difference)::text as base from app.allocation
       where settlement_document_id = ${rct.documentId} and unallocated_at is null`;
    expect(consumed!.base).toBe("490.0000"); // 490.0001 without the residue
    // Every document of this party is fully allocated, so what the control account still holds in base is
    // exactly the realised difference — and Σ fx_difference is its negation, to the cent. That is the figure
    // 4B's FX_REVALUATION posts through 4900/5910, and posting it leaves the control at zero.
    const bal = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { companyId: s.company, partyId: fresh, asOf: "2026-01-31" }),
    );
    expect(bal.byCurrency["EUR"]!.toString()).toBe("0.0000");
    expect(bal.base.add(fx).toString()).toBe("0.0000");
    expect(fx.toString()).toBe("10.0000");
  });

  // 4B (ADR 0047 decision 9, a proposal) replaced 4A's "a cross-currency allocation is refused": a settlement
  // may pay a document in another currency, and then the line states BOTH figures, each in its own
  // document's currency — neither can be derived from the other without a cross rate nobody entered.
  it("a cross-currency allocation states both amounts, each in its own document's currency (4B)", async () => {
    const inv = await invoiceFor("50.0000", "2026-01-13"); // MYR
    const rct = await receiptFor("10.0000", "2026-01-13", "EUR", "4.80000000"); // 48.0000 base
    // Without the settlement's own figure the line cannot be valued on the settlement side.
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of("40.0000", MYR) },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: line 1: .*settlementAmount in EUR is required/);
    // `amount` is the SETTLED document's currency, `settlementAmount` the settlement's — named per line.
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of("10.0000", EUR) },
      ]),
    ).rejects.toThrow(/ERR_MONEY_CURRENCY_MISMATCH: line 1 is in EUR and document .* is in MYR/);
    await expect(
      allocate(rct.documentId, [
        {
          settledDocumentId: inv.documentId,
          amount: Money.of("40.0000", MYR),
          settlementAmount: Money.of("10.0000", MYR),
        },
      ]),
    ).rejects.toThrow(/ERR_MONEY_CURRENCY_MISMATCH: line 1 settlementAmount is in MYR/);

    // EUR 10 at 4.8 pays MYR 40 of the invoice: the receipt is spent in full (its base residue, 48.0000),
    // the invoice is carried at its own 40.0000, and the 8.0000 between them is the realised difference.
    const { fxDifference } = await allocate(rct.documentId, [
      {
        settledDocumentId: inv.documentId,
        amount: Money.of("40.0000", MYR),
        settlementAmount: Money.of("10.0000", EUR),
      },
    ]);
    expect(fxDifference.toString()).toBe("8.0000");
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, { companyId: s.company, settlementDocumentId: rct.documentId }),
    );
    expect(row).toMatchObject({
      amount: "40.0000",
      currency: "MYR",
      settlementAmount: "10.0000",
      settlementCurrency: "EUR",
      baseAmount: "40.0000",
      fxDifference: "8.0000",
    });
    // Each document's open balance is in its OWN currency: the invoice has 10 MYR left, the receipt nothing.
    const invOpen = await openOf(inv.documentId);
    const rctOpen = await openOf(rct.documentId);
    expect([invOpen.document.toString(), invOpen.base.toString()]).toEqual(["10.0000", "10.0000"]);
    expect([rctOpen.document.toString(), rctOpen.base.toString()]).toEqual(["0.0000", "0.0000"]);
    // …so the spent receipt has no capacity left in EUR, whatever the invoice still shows in MYR.
    await expect(
      allocate(rct.documentId, [
        {
          settledDocumentId: inv.documentId,
          amount: Money.of("1.0000", MYR),
          settlementAmount: Money.of("0.2000", EUR),
        },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: allocations total 0\.2000 exceed/);
    // A same-currency line may repeat its amount as settlementAmount, and may not contradict it.
    const inv2 = await invoiceFor("5.0000", "2026-01-13");
    const rct2 = await receiptFor("5.0000", "2026-01-13");
    await expect(
      allocate(rct2.documentId, [
        {
          settledDocumentId: inv2.documentId,
          amount: Money.of("5.0000", MYR),
          settlementAmount: Money.of("4.0000", MYR),
        },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: line 1: .*settlementAmount must equal amount/);
  });

  it("refuses a non-positive amount, an unposted or foreign-party document, a self-settlement and a same-side pair", async () => {
    const inv = await invoiceFor("20.0000", "2026-01-19");
    const rct = await receiptFor("20.0000", "2026-01-19");
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: inv.documentId, amount: Money.of("0.0000", MYR) },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*must be positive/);
    await expect(allocate(rct.documentId, [])).rejects.toThrow(/ERR_VALIDATION_FAILED/);
    // Another party's invoice.
    const stranger = await seedParty(db, s, { kind: "customer", code: "CUST-STRANGER" });
    const theirs = await invoiceFor("20.0000", "2026-01-19", { party: stranger });
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: theirs.documentId, amount: Money.of("5.0000", MYR) },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: document .* belongs to a different party/);
    // A receipt that settles itself.
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: rct.documentId, amount: Money.of("5.0000", MYR) },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*cannot settle itself/);
    // A receipt "settling" another receipt: both CREDIT the control account, so the pair would mark the second
    // spent while the ledger still holds both — ageing and the control account could never tie out again. (An
    // invoice on the settlement side is refused before this, by its policy's shape — review-4a.test.ts, S2.)
    const another = await receiptFor("20.0000", "2026-01-19");
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: another.documentId, amount: Money.of("5.0000", MYR) },
      ]),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .*same side of the party's control account/);
    // An unposted settlement.
    const draft = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.document (tenant_id, company_id, document_type_id, series, effective_date,
                                  currency, branch_id, party_id)
        values (${s.tenant}, ${s.company}, ${rctType}, 'RCT', '2026-01-19', 'MYR', ${s.hq}, ${partyId})
        returning id`;
      return row!.id;
    });
    await expect(
      allocate(draft, [{ settledDocumentId: inv.documentId, amount: Money.of("5.0000", MYR) }]),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: settlement .* is not posted/);
    // Nothing above wrote a row.
    expect((await openOf(inv.documentId)).document.toString()).toBe("20.0000");
  });

  it("every service is bound to the company it is asked through (AGENTS.md: RLS bounds the tenant only)", async () => {
    const inv = await invoiceFor("15.0000", "2026-01-20");
    const rct = await receiptFor("15.0000", "2026-01-20");
    const sibling = await siblingCompany("ALLOC-C");
    await expect(
      allocate(
        rct.documentId,
        [{ settledDocumentId: inv.documentId, amount: Money.of("15.0000", MYR) }],
        sibling,
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: document .* is not a document of company/);
    await expect(openOf(inv.documentId, sibling)).rejects.toThrow(/ERR_NOT_FOUND/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        partyBalance(tx, { companyId: sibling, partyId, asOf: "2026-01-31" }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: party .* is not a party of company/);
    await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("15.0000", MYR) },
    ]);
    const seen = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listAllocations(tx, {
        companyId: sibling,
        settledDocumentId: inv.documentId,
        includeUnallocated: true,
      }),
    );
    expect(seen).toEqual([]);
  });

  it("partyBalance is correct per currency and in base — CONCRETE figures (test 8's data-model half, §4.8.1)", async () => {
    // A FRESH party, because the figures must be arithmetic and not the residue of everything above.
    const fresh = await seedParty(db, s, { kind: "customer", code: "CUST-BAL" });
    // MYR: a 100 invoice fully settled by a 100 receipt. Both hit 1200, so the control account nets to
    // zero — and this is the number a document-side query gets wrong, reporting 100.0000.
    const inv = await invoiceFor("100.0000", "2026-01-20", { party: fresh });
    const rct = await receiptFor("100.0000", "2026-01-21", "MYR", "1.00000000", fresh);
    await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("100.0000", MYR) },
    ]);
    // EUR: a 100 invoice at 4.80 settled by a 100 receipt at 4.90. The EUR column nets to zero; the BASE
    // column keeps the −10.0000 the rate move created, which is the realised gain 4B posts through
    // 4900/5910 and the honest answer here rather than a hidden rounding.
    await invoiceFor("100.0000", "2026-01-22", {
      party: fresh,
      currencyCode: "EUR",
      rate: "4.80000000",
    });
    await receiptFor("100.0000", "2026-01-23", "EUR", "4.90000000", fresh);

    const bal = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { companyId: s.company, partyId: fresh, asOf: "2026-01-31" }),
    );
    expect(Object.keys(bal.byCurrency).toSorted()).toEqual(["EUR", "MYR"]);
    expect(bal.byCurrency["MYR"]!.toString()).toBe("0.0000");
    expect(bal.byCurrency["EUR"]!.toString()).toBe("0.0000");
    expect(bal.byCurrency["EUR"]!.currency).toBe("EUR");
    expect(bal.base.currency).toBe("MYR");
    expect(bal.base.toString()).toBe("-10.0000");
    // And an `asOf` BEFORE the receipt still shows the invoice open — the date filter is on the ledger row.
    const mid = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { companyId: s.company, partyId: fresh, asOf: "2026-01-20" }),
    );
    expect(mid.byCurrency["MYR"]!.toString()).toBe("100.0000");
    expect(mid.base.toString()).toBe("100.0000");
    // A party with nothing posted owes 0.0000 in base, never NULL (LEGACY-011), and names no currency.
    const idle = await seedParty(db, s, { kind: "customer", code: "CUST-IDLE" });
    const none = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { companyId: s.company, partyId: idle, asOf: "2026-01-31" }),
    );
    expect(none.byCurrency).toEqual({});
    expect(none.base.toString()).toBe("0.0000");
  });

  it("partyBalance is party-facing: a vendor's payable balance is the ledger figure NEGATED", async () => {
    // A vendor's control account carries a credit balance, so the raw Σ (debit − credit) on 2100 is negative;
    // partyBalance reports "owed by us" as positive (§4.8.1's sign convention). An expense PURCHASE_INVOICE
    // (an account line, so no 2150 corridor — Task 7) credits the vendor's payable at total_incl_tax.
    const vendor = await seedParty(db, s, { kind: "vendor", code: "VEND-BAL" });
    const expense = await accountByCode(db, s, "5900");
    const payable = await accountByCode(db, s, "2100");
    await postArDocument(db, s, {
      documentTypeId: pinvType,
      series: "PINV",
      partyId: vendor,
      effectiveDate: "2026-01-24",
      lines: [{ kind: "account", accountId: expense, description: "freight", amount: "42.0000" }],
    });
    const [raw] = await db.admin<{ net: string }[]>`
      select sum(e.base_debit - e.base_credit)::text as net
        from app.ledger_entry e join app.document d on d.id = e.document_id
       where d.party_id = ${vendor} and e.account_id = ${payable}`;
    expect(raw!.net).toBe("-42.0000");
    const bal = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      partyBalance(tx, { companyId: s.company, partyId: vendor, asOf: "2026-01-31" }),
    );
    expect(bal.byCurrency["MYR"]!.toString()).toBe("42.0000");
    expect(bal.base.toString()).toBe("42.0000");
  });

  it("an allocation is fixed at insert: only the un-allocation changes it, once, and never back (LEGACY-041)", async () => {
    const inv = await invoiceFor("12.0000", "2026-01-26");
    const rct = await receiptFor("12.0000", "2026-01-26");
    const { allocationIds } = await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("12.0000", MYR) },
    ]);
    const id = allocationIds[0]!;
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`update app.allocation set amount = 1.0000 where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: allocation .* is fixed at insert/);
    // 4B's settlement_amount is one of the fixed figures too.
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`update app.allocation set settlement_amount = 1.0000 where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: allocation .* is fixed at insert/);
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`update app.allocation set unallocated_at = now() where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: unallocating allocation .* needs a reason/);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unallocate(tx, ctxOf(s), {
        companyId: s.company,
        settlementDocumentId: rct.documentId,
        allocationId: id,
        reason: "posted to the wrong customer",
      }),
    );
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) =>
          tx`update app.allocation set unallocated_at = null, unallocation_reason = null where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE: allocation .* is already unallocated/);
  });

  it("a FULL reversal nets its original: it cannot settle, and a reversal waits for its allocations to go", async () => {
    const inv = await invoiceFor("30.0000", "2026-01-27");
    const rct = await receiptFor("30.0000", "2026-01-27");
    const { allocationIds } = await allocate(rct.documentId, [
      { settledDocumentId: inv.documentId, amount: Money.of("30.0000", MYR) },
    ]);
    const reverse = () =>
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        reverseDocument(tx, ctxOf(s), {
          documentId: inv.documentId,
          effectiveDate: "2026-01-28",
          reason: "raised against the wrong customer",
        }),
      );
    await expect(reverse()).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .*live allocation\(s\); unallocate them before reversing it/,
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unallocate(tx, ctxOf(s), {
        companyId: s.company,
        settlementDocumentId: rct.documentId,
        allocationId: allocationIds[0]!,
        reason: "invoice to be reversed",
      }),
    );
    const { reversalDocumentId } = await reverse();
    // The reversal's whole magnitude is spent on the invoice it nets: it settles no second invoice…
    const other = await invoiceFor("30.0000", "2026-01-28");
    await expect(
      allocate(reversalDocumentId, [
        { settledDocumentId: other.documentId, amount: Money.of("30.0000", MYR) },
      ]),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: settlement .* is the full reversal of another document/,
    );
    // …and nothing of it is open to be settled by the freed receipt either.
    await expect(
      allocate(rct.documentId, [
        { settledDocumentId: reversalDocumentId, amount: Money.of("30.0000", MYR) },
      ]),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* is the full reversal of another document/,
    );
    // The freed receipt settles the second invoice instead.
    await allocate(rct.documentId, [
      { settledDocumentId: other.documentId, amount: Money.of("30.0000", MYR) },
    ]);
    expect((await openOf(other.documentId)).document.toString()).toBe("0.0000");
  });

  it("a second tenant sees no allocation of this tenant (spec:106)", async () => {
    const other = await seedTenantV2(db, "allocation-other");
    const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      listAllocations(tx, { companyId: other.company, includeUnallocated: true }),
    );
    expect(rows).toEqual([]);
    // …and not by naming this tenant's company either: RLS hides every row of it.
    const named = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      listAllocations(tx, { companyId: s.company, includeUnallocated: true }),
    );
    expect(named).toEqual([]);
    const [raw] = await withTenant(
      db.rw,
      other.tenant,
      other.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.allocation`,
    );
    expect(raw!.n).toBe(0);
  });
});

/** A second company in THIS tenant — the case RLS cannot separate. */
async function siblingCompany(code: string): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.company (tenant_id, code, name, base_currency)
      values (${s.tenant}, ${code}, ${`Sibling ${code}`}, 'MYR') returning id`;
    return row!.id;
  });
}
