import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  ageingRows,
  ageingTieOut,
  agedBalance,
  comparePartyAgeing,
  outstandingRevaluation,
  rebuildPartyAgeing,
} from "../../src";
import { startDb, withTenant, type Db } from "../harness";
// `seedParty` (2A) is for the cases that need a party of their own, so that no absolute figure asserted
// anywhere else in this file moves.
import { seedParty, seedTenantV2, type Seed } from "../fixtures";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";

/**
 * 4B Task 3 — `party_ageing`: the TypeScript over migration 0048's `app.party_ageing_rows`, the MERGE-and-zero
 * snapshot, its compare, the `agedBalance` report read and the definition-of-done tie-out (§4.8.2, ADR 0046).
 *
 * Every document is posted through 4A's REAL pack envelopes (`postFromPack` reads `SALES_INVOICE.json`,
 * `RECEIPT.json` and `PURCHASE_INVOICE.json` off disk). Their policies take ONE account line carrying the
 * amount and derive the control-account leg from the party, so a line here names the revenue, bank or
 * expense account only; the plan's JOURNAL-shaped debit/credit pair would post both legs against the party.
 */
const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let oldInvoiceId: string;
let billId: string;

/** One account line of an AR/AP document: the amount the pack policy posts to `accountId` and the party. */
const line = (code: string, amount: string) => ({
  kind: "account" as const,
  accountId: f.accountIds[code]!,
  amount,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "ageing");
  f = await arApFixture(db, s);

  // Four documents, all MYR, all against the 30-day term `postFromPack` pins from the party (SAH-013).
  // as_of is 2026-04-30 throughout — a month later than the plan's 2026-03-31, because every pack policy is
  // effective from 2026-01-01 and a 61_90 invoice as of March on a 30-day term would have to be dated 2025:
  //   2026-04-15 invoice → due 2026-05-15 → current
  //   2026-03-03 invoice → due 2026-04-02 → 28 days overdue → 1_30
  //   2026-01-01 invoice → due 2026-01-31 → 89 days overdue → 61_90
  //   2026-04-20 bill    → due 2026-05-20 → current (vendor)
  await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: "2026-04-15",
    partyId: f.partyIds.customer,
    lines: [line("4000", "1000.0000")],
  });
  await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: "2026-03-03",
    partyId: f.partyIds.customer,
    lines: [line("4000", "600.0000")],
  });
  // The 61_90 invoice's id is captured: the allocation below names it by ID (4A's frozen `AllocationLine`
  // shape), never by code-plus-index.
  ({ documentId: oldInvoiceId } = await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: "2026-01-01",
    partyId: f.partyIds.customer,
    lines: [line("4000", "400.0000")],
  }));
  ({ documentId: billId } = await postFromPack(db, s, {
    code: "PURCHASE_INVOICE",
    effectiveDate: "2026-04-20",
    partyId: f.partyIds.vendor,
    lines: [line("5900", "750.0000")],
  }));
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

const rowsAsOf = (asOf: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) => ageingRows(tx, { companyId: s.company, asOf }));

describe("party_ageing — the buckets (§4.8.2, spec:1042)", () => {
  it("cuts buckets on effective_date + payment_term.due_days, not on effective_date", async () => {
    const rows = await rowsAsOf("2026-04-30");
    const customer = rows.filter((r) => r.partyId === f.partyIds.customer);
    expect(new Map(customer.map((r) => [r.bucket, r.amount]))).toEqual(
      new Map([
        ["current", "1000.0000"], // due 2026-05-15 — not yet due
        ["1_30", "600.0000"], // due 2026-04-02 — 28 days
        ["61_90", "400.0000"], // due 2026-01-31 — 89 days
      ]),
    );
  });

  it("a vendor's open figure is POSITIVE, so an ageing row never depends on the reader knowing the sign", async () => {
    const rows = await rowsAsOf("2026-04-30");
    const vendor = rows.filter((r) => r.partyId === f.partyIds.vendor);
    expect(vendor).toEqual([
      {
        partyId: f.partyIds.vendor,
        currency: "MYR",
        bucket: "current",
        amount: "750.0000",
        baseAmount: "750.0000",
      },
    ]);
  });

  it("an allocation reduces the settled invoice's bucket and the receipt disappears entirely", async () => {
    const receipt = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-25",
      partyId: f.partyIds.customer,
      lines: [line("1100", "250.0000")],
      allocate: [{ settledDocumentId: oldInvoiceId, amount: Money.of("250.0000", MYR) }],
    });
    expect(receipt.result.number).toBeGreaterThan(0n);
    const rows = await rowsAsOf("2026-04-30");
    const customer = new Map(
      rows.filter((r) => r.partyId === f.partyIds.customer).map((r) => [r.bucket, r.amount]),
    );
    expect(customer.get("61_90")).toBe("150.0000"); // 400 − 250
    // The receipt itself is fully applied, so it contributes no row at all — not a zero row.
    expect(rows.filter((r) => r.amount === "0.0000")).toEqual([]);
  });

  it("an UNALLOCATED receipt on account sits in `current` as a negative figure (money held, not owed)", async () => {
    await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-28",
      partyId: f.partyIds.customer,
      lines: [line("1100", "90.0000")],
    });
    const rows = await rowsAsOf("2026-04-30");
    const current = rows.find((r) => r.partyId === f.partyIds.customer && r.bucket === "current")!;
    expect(current.amount).toBe("910.0000"); // 1000 invoice − 90 on account
  });

  it("SAH-011: a party with NO payment term and a document with no control-account leg yield 0, never NULL", async () => {
    // A party with no term: its invoice is due on its own effective date. 2026-02-14 is 75 days before
    // as_of — `61_90` with no term, where a 30-day term would have put it in `31_60`.
    const noTerm = await seedParty(db, s, {
      kind: "customer",
      code: "CUST-NOTERM",
      receivableAccountId: f.accountIds["1200"]!,
    });
    await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-02-14",
      partyId: noTerm,
      lines: [line("4000", "80.0000")],
    });
    // A party document with NO leg on the party's control account (a JOURNAL naming the party, bank to
    // sales): it charged the party nothing, so it must yield no row — neither a NULL one nor a zero one.
    const noLeg = await seedParty(db, s, {
      kind: "customer",
      code: "CUST-NOLEG",
      receivableAccountId: f.accountIds["1200"]!,
    });
    await postFromPack(db, s, {
      code: "JOURNAL",
      effectiveDate: "2026-04-10",
      partyId: noLeg,
      lines: [
        { kind: "account", accountId: f.accountIds["1100"]!, debit: "50.0000" },
        { kind: "account", accountId: f.accountIds["4000"]!, credit: "50.0000" },
      ],
    });

    const rows = await rowsAsOf("2026-04-30");
    expect(rows.filter((r) => r.partyId === noTerm)).toEqual([
      {
        partyId: noTerm,
        currency: "MYR",
        bucket: "61_90",
        amount: "80.0000",
        baseAmount: "80.0000",
      },
    ]);
    expect(rows.filter((r) => r.partyId === noLeg)).toEqual([]);
    for (const r of rows) {
      expect(r.amount).toMatch(/^-?\d+\.\d{4}$/);
      expect(r.baseAmount).toMatch(/^-?\d+\.\d{4}$/);
    }
  });
});

describe("party_ageing — the snapshot and its comparison (test 2, spec:1204)", () => {
  it("rebuildPartyAgeing writes the snapshot and comparePartyAgeing then finds nothing", async () => {
    const { merged, zeroed } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(merged).toBe((await rowsAsOf("2026-04-30")).length);
    expect(zeroed).toBe(0);
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(mismatches).toEqual([]);
    // The stored snapshot IS the fresh computation, row for row.
    const stored = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ partyId: string; currency: string; bucket: string; amount: string }[]>`
        select party_id as "partyId", currency::text as currency, bucket, amount::text as amount
          from app.party_ageing
         where company_id = ${s.company} and as_of = '2026-04-30'
         order by party_id, currency, bucket`,
    );
    expect(stored).toEqual(
      (await rowsAsOf("2026-04-30")).map(({ partyId, currency: c, bucket, amount }) => ({
        partyId,
        currency: c,
        bucket,
        amount,
      })),
    );
  });

  it("a hand-corrupted snapshot row is reported as amount_differs, naming the column and both values", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        update app.party_ageing set base_amount = base_amount + 1
         where company_id = ${s.company} and as_of = '2026-04-30' and bucket = '1_30'`;
    });
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ projection: "party_ageing", side: "amount_differs" });
    expect(mismatches[0]!.detail).toBe("base_amount 601.0000 <> 600.0000");
    expect(mismatches[0]!.key).toMatchObject({
      company_id: s.company,
      party_id: f.partyIds.customer,
      currency: "MYR",
      as_of: "2026-04-30",
      bucket: "1_30",
    });
    // Repair for the later cases.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
      ),
    ).toEqual([]);
  });

  it("a stored row the fresh computation lacks, and a fresh row the store lacks, are both reported", async () => {
    // A stale non-zero key (missing_in_rebuild) and a zeroed live key (missing_in_projection — a zero
    // row reads as an absent one, ADR 0046).
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${s.tenant}, ${s.company}, ${f.partyIds.vendor}, 'MYR', '2026-04-30', '31_60', 7, 7)`;
      await tx`
        update app.party_ageing set amount = 0, base_amount = 0
         where company_id = ${s.company} and as_of = '2026-04-30'
           and party_id = ${f.partyIds.vendor} and bucket = 'current'`;
    });
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(mismatches.map((m) => [m.key["bucket"], m.side, m.detail]).toSorted()).toEqual([
      ["31_60", "missing_in_rebuild", "stored amount 7.0000, base_amount 7.0000, no fresh row"],
      [
        "current",
        "missing_in_projection",
        "fresh amount 750.0000, base_amount 750.0000, no stored row",
      ],
    ]);
    const { zeroed } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(zeroed).toBe(1); // the stale 31_60 key; the vendor's `current` row is MERGEd back
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
      ),
    ).toEqual([]);
  });

  it("re-running the rebuild ZEROES a key that no longer applies — it never DELETEs (§3.5.4)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        insert into app.party_ageing (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
        values (${s.tenant}, ${s.company}, ${f.partyIds.vendor}, 'MYR', '2026-04-30', 'over_90', 42, 42)`;
    });
    const { zeroed } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(zeroed).toBe(1);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ amount: string; base_amount: string }[]>`
        select amount::text, base_amount::text from app.party_ageing
         where company_id = ${s.company} and as_of = '2026-04-30'
           and party_id = ${f.partyIds.vendor} and bucket = 'over_90'`;
      expect(row).toMatchObject({ amount: "0.0000", base_amount: "0.0000" });
    });
    // A second run finds nothing further to zero: an already-zero key is not counted again.
    const again = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(again.zeroed).toBe(0);
  });

  it("a snapshot is scoped to its (company, as_of): rebuilding one date leaves another untouched", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }),
    );
    const before = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.party_ageing
         where company_id = ${s.company} and as_of = '2026-03-31' and (amount <> 0 or base_amount <> 0)`,
    );
    expect(before[0]!.n).toBeGreaterThan(0);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildPartyAgeing(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        comparePartyAgeing(tx, { companyId: s.company, asOf: "2026-03-31" }),
      ),
    ).toEqual([]);
  });
});

describe("the definition-of-done tie-out (§4.8.2)", () => {
  it("Σ base_amount equals the 1200 and 2100 control-account balances to the cent", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    const byCode = new Map(rows.map((r) => [r.accountCode, r]));
    expect([...byCode.keys()]).toEqual(["1200", "2100"]);
    expect(byCode.get("1200")!.difference).toBe("0.0000");
    expect(byCode.get("2100")!.difference).toBe("0.0000");
    // The figures themselves, so a tie-out that read zero on both sides could not pass: 1000 + 600 + 400
    // + 80 invoiced, 250 + 90 received; 750 billed.
    expect(byCode.get("1200")).toMatchObject({
      accountType: "asset",
      ageingBase: "1740.0000",
      ledgerBase: "1740.0000",
    });
    // The liability row is what pins the sign rule: the ledger's −750 is brought into the ageing's
    // (positive) orientation, and the ageing column itself is never flipped.
    expect(byCode.get("2100")).toMatchObject({
      accountType: "liability",
      ageingBase: "750.0000",
      ledgerBase: "750.0000",
    });
    // No FX_REVALUATION type exists yet (Task 5), so the third column is zero — and the equality is
    // therefore also the ageing == ledger equality outright.
    expect(byCode.get("1200")!.revaluationBase).toBe("0.0000");
    expect(byCode.get("2100")!.revaluationBase).toBe("0.0000");
    // The tie-out's own `rev` term and the exported reader are two spellings of one figure (Task 5's test 8
    // asserts the same agreement once a revaluation exists).
    for (const code of ["1200", "2100"]) {
      expect(
        await withTenant(db.rw, s.tenant, s.human, (tx) =>
          outstandingRevaluation(tx, {
            companyId: s.company,
            accountId: f.accountIds[code]!,
            asOf: "2026-04-30",
          }),
        ),
      ).toBe(byCode.get(code)!.revaluationBase);
    }
  });

  it("in a SAME-CURRENCY month the per-currency equality holds as well (ADR 0046)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await ageingRows(tx, { companyId: s.company, asOf: "2026-04-30" });
      // Every party whose control account is 1200 — every customer here — against 1200's MYR rows.
      const ar = rows
        .filter((r) => r.partyId !== f.partyIds.vendor && r.currency === "MYR")
        .reduce((sum, r) => sum.add(Money.of(r.amount, MYR)), Money.zero(MYR));
      const [balance] = await tx<{ signed: string }[]>`
        select (sum(debit) - sum(credit))::text as signed
          from app.account_balance
         where company_id = ${s.company} and account_id = ${f.accountIds["1200"]!} and currency = 'MYR'`;
      expect(ar.toString()).toBe(Money.of(balance!.signed, MYR).toString());
    });
  });

  // LAST in this describe. The case the allocation as-of guard exists for. A receipt on account dated INSIDE
  // the reporting window, allocated to an invoice dated OUTSIDE it — the ordinary deposit-then-invoice
  // sequence, and equally any earlier month re-run after a later allocation. Without the guard the
  // allocation is subtracted from the receipt's open figure and never added back, and this `difference`
  // reads 300.0000.
  //
  // It uses its OWN party, so every absolute figure asserted above and in the `agedBalance` block below
  // (`current: "910.0000"`, `total: "1660.0000"`) is untouched; the 1200 tie-out still covers it, because
  // the tie-out sums the control account over ALL parties.
  it("an allocation across the as-of boundary keeps the tie-out at zero (the as-of guard)", async () => {
    const later = await seedParty(db, s, {
      kind: "customer",
      code: "CUST-LATER",
      receivableAccountId: f.accountIds["1200"]!,
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.party set payment_term_id = ${f.termId} where id = ${later}`,
    );

    // The invoice is dated AFTER as_of; the receipt that settles it is dated before.
    const { documentId: aprInvoice } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-05-05",
      partyId: later,
      lines: [line("4000", "300.0000")],
    });
    await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-20",
      partyId: later,
      lines: [line("1100", "300.0000")],
      allocate: [{ settledDocumentId: aprInvoice, amount: Money.of("300.0000", MYR) }],
    });

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(new Map(rows.map((r) => [r.accountCode, r.difference])).get("1200")).toBe("0.0000");

    // …and the reason it holds: as of 2026-04-30 the receipt is FULLY OPEN, because the invoice it paid
    // does not exist yet. A negative figure (money held, not owed) in `current` is the right answer.
    const open = await rowsAsOf("2026-04-30");
    expect(open.find((r) => r.partyId === later)).toMatchObject({
      bucket: "current",
      amount: "-300.0000",
    });

    // As of a date that contains BOTH documents the allocation applies and the party disappears — and the
    // tie-out still holds there too.
    const after = await rowsAsOf("2026-05-31");
    expect(after.filter((r) => r.partyId === later)).toEqual([]);
    const tieAfter = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-05-31" }),
    );
    expect(tieAfter.map((r) => [r.accountCode, r.difference])).toEqual([
      ["1200", "0.0000"],
      ["2100", "0.0000"],
    ]);
  });
});

describe("agedBalance — the accounting.ageing report read (§4.16.3, amendment 10)", () => {
  it("pivots the buckets into one row per party and currency, with both totals", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-04-30", limit: 50 }),
    );
    const customer = rows.find((r) => r.partyId === f.partyIds.customer)!;
    expect(customer).toMatchObject({
      partyCode: "CUST-1",
      partyKind: "customer",
      currency: "MYR",
      current: "910.0000",
      d1_30: "600.0000",
      d31_60: "0.0000",
      d61_90: "150.0000",
      over_90: "0.0000",
    });
    expect(customer.total).toBe("1660.0000");
    expect(customer.totalBase).toBe("1660.0000");
    // The report is the function's figures and nothing else: its totals tie to the tie-out's ageing column.
    const tie = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    const reported = rows
      .filter((r) => r.partyKind === "customer")
      .reduce((sum, r) => sum.add(Money.of(r.totalBase, MYR)), Money.zero(MYR));
    expect(reported.toString()).toBe(tie.find((r) => r.accountCode === "1200")!.ageingBase);
  });

  it("filters by party, party kind, currency and bucket, and keysets on (party_code, currency)", async () => {
    const vendors = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-04-30", partyKind: "vendor", limit: 50 }),
    );
    expect(vendors.map((r) => r.partyId)).toEqual([f.partyIds.vendor]);

    const one = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, {
        companyId: s.company,
        asOf: "2026-04-30",
        partyId: f.partyIds.customer,
        limit: 50,
      }),
    );
    expect(one.map((r) => r.partyId)).toEqual([f.partyIds.customer]);

    const eur = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-04-30", currency: "EUR", limit: 50 }),
    );
    expect(eur).toEqual([]);

    // A bucket filter narrows the rows the pivot sees, so only the parties with a 61_90 figure remain, and
    // their other columns read zero.
    const old = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-04-30", buckets: ["61_90"], limit: 50 }),
    );
    expect(old.map((r) => [r.partyCode, r.d61_90, r.current, r.total])).toEqual([
      ["CUST-1", "150.0000", "0.0000", "150.0000"],
      ["CUST-NOTERM", "80.0000", "0.0000", "80.0000"],
    ]);

    const first = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, { companyId: s.company, asOf: "2026-04-30", limit: 1 }),
    );
    const next = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      agedBalance(tx, {
        companyId: s.company,
        asOf: "2026-04-30",
        limit: 1,
        cursor: { partyCode: first[0]!.partyCode, currency: first[0]!.currency },
      }),
    );
    expect(first[0]!.partyCode).toBe("CUST-1");
    expect(next[0]!.partyCode).not.toBe(first[0]!.partyCode);
    expect(next[0]!.partyCode > first[0]!.partyCode).toBe(true);
  });

  it("another tenant reads nothing of this company's ageing (test 12)", async () => {
    const other = await seedTenantV2(db, "ageing-other");
    expect(
      await withTenant(db.rw, other.tenant, other.human, (tx) =>
        agedBalance(tx, { companyId: s.company, asOf: "2026-04-30", limit: 50 }),
      ),
    ).toEqual([]);
    expect(
      await withTenant(db.rw, other.tenant, other.human, (tx) =>
        ageingTieOut(tx, { companyId: s.company, asOf: "2026-04-30" }),
      ),
    ).toEqual([]);
  });
});

// LAST in the file: it settles the vendor's bill, which every block above asserts open.
describe("postFromPack — the approval path is read off the pack envelope (§4.5.1)", () => {
  it("an approval-required PAYMENT is submitted by the maker and approved, issued and posted by a second principal", async () => {
    const payment = await postFromPack(db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-04-29",
      partyId: f.partyIds.vendor,
      lines: [line("1100", "750.0000")],
      allocate: [{ settledDocumentId: billId, amount: Money.of("750.0000", MYR) }],
    });
    expect(payment.result.ledgerEntryIds).toHaveLength(2);
    const events = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ to_status: string; actor_id: string }[]>`
        select to_status::text as to_status, actor_id::text as actor_id from app.document_event
         where document_id = ${payment.documentId} and event_kind = 'transition'
         order by occurred_at, created_at`,
    );
    const actorOf = new Map(events.map((e) => [e.to_status, e.actor_id]));
    expect(actorOf.get("submitted")).toBe(s.human);
    expect(actorOf.get("approved")).not.toBe(s.human); // R1: the checker is never the maker
    expect(actorOf.get("posted")).toBe(actorOf.get("approved"));

    // The bill is settled: the vendor leaves the ageing, and the 2100 tie-out still reads zero.
    expect((await rowsAsOf("2026-04-30")).filter((r) => r.partyId === f.partyIds.vendor)).toEqual(
      [],
    );
    const tie = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ageingTieOut(tx, { companyId: s.company, asOf: "2026-04-30" }),
    );
    expect(tie.find((r) => r.accountCode === "2100")).toMatchObject({
      ageingBase: "0.0000",
      ledgerBase: "0.0000",
      difference: "0.0000",
    });
  });
});
