import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { grantCodes, seedAccount, seedTenant, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "req-post",
});

/** Drafts a document and gives it the lines listed, in order. Returns the document id. */
async function draftWithLines(
  db: Db,
  seed: Seed,
  lines: {
    account: string;
    debit?: string;
    credit?: string;
    dimensions?: Record<string, string>;
  }[],
  opts: {
    effectiveDate?: string;
    periodId?: string;
    currency?: string;
    rate?: string;
  } = {},
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.rw, seed.tenant, seed.human, async (tx) => {
    if (opts.currency && opts.currency !== "MYR") {
      await tx`insert into app.currency (tenant_id, code, name_en)
               values (${seed.tenant}, ${opts.currency}, ${opts.currency})
               on conflict (tenant_id, code) do nothing`;
    }
    await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date,
                                       currency, exchange_rate, rate_source, branch_id)
             values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', ${opts.effectiveDate ?? "2026-01-15"},
                     ${opts.currency ?? "MYR"}, ${opts.rate ?? "1"}, ${opts.rate ? "BNM test" : null}, ${seed.hq})`;
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit, dimensions)
               values (${seed.tenant}, ${seed.company}, ${id}, ${lineNo}, ${line.account}, ${line.debit ?? "0"}, ${line.credit ?? "0"},
                       ${JSON.stringify(line.dimensions ?? {})}::text::jsonb)`;
    }
  });
  return id;
}

describe("postDocument — contracts §4.3.2 (SAH-003, 012, 031, 041, 044)", () => {
  let db: Db;
  let a: Seed;
  let plain: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    plain = await seedTenant(db, "Plain");
    await grantCodes(db, plain, { codes: ["accounting.journal.post"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("issues, stamps a posting_seq, writes the ledger and merges the balance in one transaction", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "100.0000" },
    ]);
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      postDocument(tx, ctx(a), { documentId: doc }),
    );

    expect(result.series).toBe("JV");
    expect(result.fiscalPeriodId).toBe(a.period);
    expect(result.ledgerEntryIds).toHaveLength(2);
    expect(result.movementIds).toEqual([]);
    expect(result.taxTransactionIds).toEqual([]);
    expect(result.enqueuedJobIds).toEqual([]);
    expect(result.postingSeq).toBeGreaterThan(0n);

    const [header] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        {
          status: string;
          posted_by: string;
          posting_policy_id: string;
          posted_at: Date | null;
        }[]
      >`select status::text as status, posted_by::text as posted_by, posting_policy_id::text as posting_policy_id, posted_at
        from app.document where id = ${doc}`,
    );
    expect(header!.status).toBe("posted");
    // Stamped from the session, never a parameter (SAH-044).
    expect(header!.posted_by).toBe(a.human);
    expect(header!.posting_policy_id).toBe(result.postingPolicyId);
    expect(header!.posted_at).not.toBeNull();

    const entries = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        {
          line_no: number;
          account_id: string;
          debit: string;
          credit: string;
          base_debit: string;
          currency: string;
          exchange_rate: string;
          posted_by: string;
        }[]
      >`select line_no, account_id::text as account_id, debit::text as debit, credit::text as credit,
             base_debit::text as base_debit, currency, exchange_rate::text as exchange_rate, posted_by::text as posted_by
        from app.ledger_entry where document_id = ${doc} order by line_no`,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      line_no: 1,
      account_id: a.cash,
      debit: "100.0000",
      credit: "0.0000",
      base_debit: "100.0000",
      currency: "MYR",
      posted_by: a.human,
    });
    expect(entries[1]).toMatchObject({ line_no: 2, account_id: a.sales, credit: "100.0000" });

    const dims = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ dimension_value_id: string }[]>`
      select d.dimension_value_id::text as dimension_value_id
        from app.ledger_entry_dimension d join app.ledger_entry l on l.id = d.entry_id
       where l.document_id = ${doc}`,
    );
    expect(dims).toHaveLength(2);
    // BRANCH on every line (spec:1066).
    expect(dims.every((dim) => dim.dimension_value_id === a.hq)).toBe(true);

    const [balance] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ debit: string; base_debit: string }[]>`
      select debit::text as debit, base_debit::text as base_debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(balance).toMatchObject({ debit: "100.0000", base_debit: "100.0000" });
  });

  it("accumulates the projection over two documents rather than replacing it (SAH-002)", async () => {
    // The tenant is seeded once in beforeAll and the first test in this file posts 100.0000 to a.cash, so
    // the value is deterministic. Asserted as the exact numeric(19,4) STRING: converting a money column to
    // a JS float to compare it approximately is the thing spec:97-104 forbids, and this is a test, which is
    // exactly where the habit would start.
    const [before] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(before!.debit).toBe("100.0000");
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "40.0000" },
      { account: a.sales, credit: "40.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    const [after] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(after!.debit).toBe("140.0000");
  });

  it("adds one FX-rounding line when per-line base rounding leaves a residue (spec:1868)", async () => {
    // The fixture has to LEAVE a residue, which is fussier than it looks. At 4.68350000 the obvious
    // 0.3335 = 0.1667 + 0.1668 splits to 1.5619 = 0.7807 + 0.7812 in base — exactly balanced, no residue,
    // no fx line, and this test would assert a state it can never reach. This fixture does leave one:
    //   debit  0.0003 × 4.68350000 = 0.00140505 → 0.0014
    //   credit 0.0001 × 4.68350000 = 0.00046835 → 0.0005, three of them → 0.0015
    //   residue = 0.0014 − 0.0015 = −0.0001, inside the 0.01 × 4 tolerance, so ONE fx_rounding DEBIT line
    //   of 0.0001 MYR at rate 1.00000000 is appended and Σbase debit = Σbase credit = 0.0015.
    const bank = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    const control = await seedAccount(db, a, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    const doc = await draftWithLines(
      db,
      a,
      [
        { account: a.cash, debit: "0.0003" },
        { account: bank, credit: "0.0001" },
        { account: control, credit: "0.0001" },
        { account: a.sales, credit: "0.0001" },
      ],
      { currency: "USD", rate: "4.68350000" },
    );
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      postDocument(tx, ctx(a), { documentId: doc }),
    );
    // Four policy lines plus the fx_rounding line.
    expect(result.ledgerEntryIds).toHaveLength(5);
    const [fx] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        {
          currency: string;
          exchange_rate: string;
          account_id: string;
          debit: string;
          base_debit: string;
        }[]
      >`select currency, exchange_rate::text as exchange_rate, account_id::text as account_id,
             debit::text as debit, base_debit::text as base_debit
        from app.ledger_entry where document_id = ${doc} order by line_no desc limit 1`,
    );
    expect(fx).toMatchObject({
      currency: "MYR",
      exchange_rate: "1.00000000",
      debit: "0.0001",
      base_debit: "0.0001",
    });
    const [company] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ fx: string }[]>`
      select fx_rounding_account_id::text as fx from app.company where id = ${a.company}`,
    );
    expect(fx!.account_id).toBe(company!.fx);
    const [sum] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ diff: string }[]>`
      select (sum(base_debit) - sum(base_credit))::text as diff from app.ledger_entry where document_id = ${doc}`,
    );
    expect(sum!.diff).toBe("0.0000");
  });

  it("refuses a document with no lines and a document whose policy plans none", async () => {
    const empty = await draftWithLines(db, a, []);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: empty })),
    ).rejects.toMatchObject({ code: "ERR_DOC_NO_LINES" });

    // debit 0, credit 0
    const narrationOnly = await draftWithLines(db, a, [{ account: a.cash }]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) =>
        postDocument(tx, ctx(a), { documentId: narrationOnly }),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_NO_LINES" });
  });

  it("refuses an unbalanced document before writing any row (SAH-003)", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "100.0000" },
      { account: a.sales, credit: "90.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_LEDGER_UNBALANCED" });
    const [rows] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${doc}`,
    );
    expect(rows!.n).toBe(0);
    const [status] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ status: string }[]>`
      select status::text as status from app.document where id = ${doc}`,
    );
    expect(status!.status).toBe("draft");
  });

  it("refuses a closed and a locked period, and the trigger is the control (test 9, admin path)", async () => {
    for (const [periodId, date] of [
      [a.closedPeriod, "2026-02-15"],
      [a.lockedPeriod, "2026-03-15"],
    ] as const) {
      const doc = await draftWithLines(
        db,
        a,
        [
          { account: a.cash, debit: "5.0000" },
          { account: a.sales, credit: "5.0000" },
        ],
        { effectiveDate: date, periodId },
      );
      await expect(
        prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })),
      ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    }
    // The pre-check is a better message; the control is app.assert_period_open on ledger_entry (spec:1862).
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "5.0000" },
      { account: a.sales, credit: "5.0000" },
    ]);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                      currency, exchange_rate, base_debit, base_credit, effective_date,
                                      fiscal_period_id, posting_policy_id)
        values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 5.0000, 0, 'MYR', 1, 5.0000, 0,
                '2026-03-15', ${a.lockedPeriod}, ${a.policy})`,
      ),
    ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
  });

  it("refuses a second post of the same document", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "7.0000" },
      { account: a.sales, credit: "7.0000" },
    ]);
    await prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("refuses a line whose dimension names a type the company does not have", async () => {
    const doc = await draftWithLines(db, a, [
      { account: a.cash, debit: "1.0000", dimensions: { PROJECT: a.hq } },
      { account: a.sales, credit: "1.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => postDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_POLICY_REQUIRES_MISSING" });
  });

  it("refuses to post a document of a tenant whose policy is the 0A stub", async () => {
    const doc = await draftWithLines(db, plain, [
      { account: plain.cash, debit: "1.0000" },
      { account: plain.sales, credit: "1.0000" },
    ]);
    await expect(
      prodWithTenant(db.rw, ctx(plain), (tx) => postDocument(tx, ctx(plain), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_POLICY_INVALID" });
  });

  // 2A's step-9b case was here — "refuses to post a document whose policy names line.cost before the
  // costing engine exists". 3B Task 7 deletes the guard it pinned: step 9's applyMovements now FILLS
  // document_line.cost and the plan is re-evaluated from it, so a COGS-from-cost policy posts instead of
  // being refused. The replacement coverage is packages/db/test/costing/apply-movements.test.ts.
});
