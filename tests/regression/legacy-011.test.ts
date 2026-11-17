import { taxFixture, postTaxedDocument } from "../invariants/support/tax";
import { createTaxReturn, generateTaxReturn, taxReturnTieOut } from "@dulja/db";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts";
import {
  generateStatutorySchedule,
  MemoryObjectStore,
  partyBalance,
  payslipRows,
  reconcileParallelRun,
  salesByItem,
  withTenant,
} from "@dulja/db";
import { loadDocumentTypes } from "@dulja/db/seed";
import {
  seedAccount,
  seedItem,
  seedParty,
  seedTenantV2,
  startDb,
  type Db,
  uuidv7,
} from "@dulja/db/test";
import { repoFile, sharedDb } from "../support/regression";
import { REPO_ROOT, sourceFiles } from "../support/source";
import { postArDocument } from "../invariants/support/post-ar";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";
import { hrReportFixture, type HrReportFixture } from "../invariants/support/hr-reports";
import { Money, Quantity, currency } from "@dulja/domain";
import { loaders, replayLegacyMovements } from "@dulja/importer";
import {
  PayrollCalculationError,
  payrollCalculator,
  type RateTableRef,
} from "@dulja/domain/payroll";

describe("LEGACY-011 NULL arithmetic irreversibly nulls balances — 1A", () => {
  it("every amount column of account_balance and ledger_entry is NOT NULL with a zero default", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<
      {
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      select table_name, column_name, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'app'
         and table_name in ('account_balance', 'ledger_entry')
         and column_name in ('debit', 'credit', 'base_debit', 'base_credit')
       order by table_name, column_name`;
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.is_nullable).toBe("NO");
    for (const row of rows.filter((candidate) => candidate.table_name === "account_balance")) {
      expect(row.column_default).toContain("0");
    }
  });

  it("a MERGE of a zero-amount group cannot null an existing balance", async () => {
    const { db, rw } = await sharedDb();
    const seed = await seedTenantV2(db, "LEGACY011");
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy011" };
    await withTenant(
      rw,
      ctx,
      (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, base_debit)
      values (${seed.tenant}, ${seed.company}, ${seed.cash}, ${seed.period}, 'MYR', 5.0000, 5.0000)`,
    );
    await withTenant(
      rw,
      ctx,
      (tx) => tx`
      update app.account_balance set debit = debit + 0, base_debit = base_debit + 0
       where account_id = ${seed.cash} and fiscal_period_id = ${seed.period} and currency = 'MYR'`,
    );
    const [row] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ debit: string }[]>`
      select debit::text as debit from app.account_balance
       where account_id = ${seed.cash} and fiscal_period_id = ${seed.period}`,
    );
    expect(row!.debit).toBe("5.0000");
  });
});

describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 4B", () => {
  it("every monetary column of both async projections is NOT NULL DEFAULT 0", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<
      {
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      select table_name, column_name, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'app'
         and table_name in ('party_ageing', 'item_profitability')
         and data_type = 'numeric'
       order by table_name, column_name`;
    // party_ageing: amount, base_amount; item_profitability: quantity_sold and the three base measures.
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "item_profitability.cogs_base",
      "item_profitability.margin_base",
      "item_profitability.quantity_sold",
      "item_profitability.revenue_base",
      "party_ageing.amount",
      "party_ageing.base_amount",
    ]);
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe("NO");
      expect(r.column_default, `${r.table_name}.${r.column_name}`).toBe("0");
    }
  });

  it("the ageing function coalesces its accumulations, so no NULL can reach a bucket", async () => {
    const { db } = await sharedDb();
    // Since 0129 (full review 2026-11-15, MON-01) the two charge sums live in app.document_control_exposure,
    // which party_ageing_rows reads, so the count is over the two functions together.
    const fns = await db.admin<{ prosrc: string }[]>`
      select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname in ('party_ageing_rows', 'document_control_exposure')`;
    expect(fns).toHaveLength(2);
    const fn = { prosrc: fns.map((f) => f.prosrc).join("\n") };
    // The old system's OnVouItemsAIUD coalesced nothing, and one NULL foreign-currency line nulled a whole
    // account balance permanently. Every place a NULL can enter app.party_ageing_rows' arithmetic is wrapped
    // — the two charge sums, a missing payment term, a missing relief (twice) — and one more `coalesce(`
    // reads a document that is never netted as not netted: six, the uncoalesced sums (the relief grouping
    // and the four outer projection sums) reading only values already coalesced or NOT NULL. (There were
    // eight until 4B T5's cross-currency allocation replaced the settlement side's `base ÷ rate` fallback,
    // whose coalesce this counted, with the NOT NULL `allocation.settlement_amount` — ADR 0047 decision 9;
    // and the two that chose the party's control account moved into app.party_control_account (0045) with
    // the code review's one definition of it.) A shrinking count is a coalesce someone removed.
    const sums = fn.prosrc.match(/sum\(/g) ?? [];
    const coalesced = fn.prosrc.match(/coalesce\(/g) ?? [];
    expect(sums.length).toBeGreaterThan(0);
    expect(coalesced.length).toBeGreaterThanOrEqual(sums.length - 3);
    expect(coalesced.length).toBeGreaterThanOrEqual(6);
  });
});

// ─── 4A ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A source file with its comments removed — TypeScript block and line comments and whole-line SQL comments —
 *  so a count over it counts SQL, not prose about SQL. */
const sqlOf = (f: string): string =>
  repoFile(f)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|\s)\/\/.*$/gm, "$1")
    .replaceAll(/^\s*--.*$/gm, "");
const count = (src: string, re: RegExp): number => src.match(re)?.length ?? 0;

// contracts §3.7.3: append, create-if-absent. 1A created this file; 4A's block is written order-independently
// (its own tenant, nothing read from the block above) so it would read the same had 4A created it.
describe("LEGACY-011 No NULL reaches an AR/AP balance or an aggregate — 4A", () => {
  it("every monetary column this slice adds is NOT NULL, or is deliberately nullable and documented", async () => {
    const { db } = await sharedDb();
    const cols = await db.admin<{ t: string; c: string; n: string; d: string | null }[]>`
      select table_name as t, column_name as c, is_nullable as n, column_default as d
        from information_schema.columns
       where table_schema = 'app'
         and ((table_name = 'allocation'   and column_name in ('amount','base_amount','fx_difference'))
           or (table_name = 'payment_term' and column_name = 'due_days')
           or (table_name = 'party'        and column_name in ('credit_limit','credit_hold')))
       order by 1, 2`;
    // All six columns exist: a missing one would otherwise make the loop below pass over nothing.
    expect(cols.map((c) => `${c.t}.${c.c}`)).toEqual([
      "allocation.amount",
      "allocation.base_amount",
      "allocation.fx_difference",
      "party.credit_hold",
      "party.credit_limit",
      "payment_term.due_days",
    ]);
    const byName = new Map(cols.map((c) => [`${c.t}.${c.c}`, c]));
    for (const k of [
      "allocation.amount",
      "allocation.base_amount",
      "allocation.fx_difference",
      "payment_term.due_days",
      "party.credit_hold",
    ]) {
      expect(byName.get(k)!.n, k).toBe("NO");
    }
    // The two with a default carry the zero / false a missing value means (0046, 0045).
    expect(byName.get("allocation.fx_difference")!.d).toMatch(/^0/);
    expect(byName.get("party.credit_hold")!.d).toBe("false");
    // The ONE nullable money column, and it is nullable on purpose: NULL is "no limit", not "a zero limit".
    expect(byName.get("party.credit_limit")!.n).toBe("YES");
  });

  it("every aggregate this slice writes coalesces at the accumulation boundary", async () => {
    const { db } = await sharedDb();
    // 0127 (ADR 0095): party_open_balance's sum now lives in party_company_open_balance, and the link sum in
    // source_line_linked_quantity; both are read here so the check still sees every aggregate.
    for (const fn of [
      "party_open_balance",
      "party_company_open_balance",
      "source_line_linked_quantity",
      "payment_due_date",
    ]) {
      const [p] = await db.admin<{ src: string }[]>`
        select prosrc as src from pg_proc where proname = ${fn} and pronamespace = 'app'::regnamespace`;
      expect(p, fn).toBeDefined();
      if (p!.src.includes("sum(")) expect(p!.src, fn).toMatch(/coalesce\(sum\(/);
    }
    // The plan counted `coalesce(sum(` against `sum(`. The tree coalesces at the boundary in two other,
    // equally correct spellings, so the count is taken over SQL with comments removed and each spelling
    // is named: in allocation.ts a scalar sub-select is wrapped whole, `coalesce((select sum(…) …), 0)`; in
    // sales-by-item.ts the two CTEs aggregate non-empty groups (a group by never yields a NULL sum for a
    // group that exists), and the NULL a FULL join produces for the missing side is coalesced in the outer
    // select, column by column.
    const allocation = sqlOf("packages/db/src/ar-ap/allocation.ts");
    expect(count(allocation, /sum\(/g)).toBeGreaterThan(0);
    expect(
      count(allocation, /coalesce\(sum\(/g) + count(allocation, /coalesce\(\(select sum\(/g),
    ).toBe(count(allocation, /sum\(/g));

    const report = sqlOf("packages/db/src/reports/sales-by-item.ts");
    // The per-movement cost is summed over cost_consumption rows that may not exist: coalesced where it sums.
    expect(report).toMatch(/coalesce\(sum\(cc\.value\), 0\)/);
    // Every figure read from either side of the full join is coalesced before it leaves the statement.
    for (const col of ["dv.delivered_quantity", "dv.cost", "rv.revenue"]) {
      const uses = count(report, new RegExp(`\\b${col.replace(".", "\\.")}\\b`, "g"));
      const coalesced = count(
        report,
        new RegExp(`coalesce\\(${col.replace(".", "\\.")}, 0\\)`, "g"),
      );
      expect(uses, col).toBeGreaterThan(0);
      expect(coalesced, col).toBe(uses);
    }
  });

  it("the NULL side of the report's full join and an idle party's balance read 0, never NULL — behaviourally", async () => {
    const { db } = await sharedDb();
    const s = await seedTenantV2(db, "legacy-011-4a");
    for (const [code, nameEn, type] of [
      ["1200", "Trade receivables", "asset"],
      ["1250", "Goods delivered not invoiced", "asset"],
      ["5000", "Cost of goods sold", "expense"],
    ] as const) {
      await seedAccount(db, s, { code, nameEn, type });
    }
    const seeded = await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      join(REPO_ROOT, "packages", "db", "seed", "my", "document-types"),
      PERMISSIONS.map((p) => p.code),
    );
    const invoiceType = seeded.find((row) => row.code === "SALES_INVOICE")!.documentTypeId;
    const partyId = await seedParty(db, s, { kind: "customer", code: "CUST-011" });
    const idle = await seedParty(db, s, { kind: "customer", code: "CUST-011-IDLE" });
    // A service item is invoiced and never delivered: the delivered side of the report's full join is NULL.
    const { itemId } = await seedItem(db, s, { code: "SV-011", kind: "service", trackLots: false });
    await postArDocument(db, s, {
      documentTypeId: invoiceType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-20",
      lines: [
        { kind: "item", itemId, quantity: "2.000000", unitPrice: "12.5000", amount: "25.0000" },
      ],
    });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const { rows, none, open } = await withTenant(db.rw, ctx, async (tx) => ({
      rows: await salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        itemId,
        limit: 10,
      }),
      none: await partyBalance(tx, { companyId: s.company, partyId: idle, asOf: "2026-01-31" }),
      open: await tx<{ v: string | null }[]>`
        select app.party_open_balance(${idle}, '2026-01-31'::date)::numeric(19,4)::text as v`,
    }));
    expect(rows).toEqual([
      expect.objectContaining({
        itemId,
        deliveredQuantity: "0.000000",
        cost: "0.0000",
        revenue: "25.0000",
        margin: "25.0000",
      }),
    ]);
    expect(none.base.toString()).toBe("0.0000");
    expect(open[0]!.v).toBe("0.0000");
  });
});

// ── appended by slice 5A ─────────────────────────────────────────────────────────────────────────────
describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 5A (the VAT-box half)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("every monetary column of app.tax_transaction is NOT NULL", async () => {
    // "A return is filed with tax but no base" was possible because `Output_Total` and `Output_Tax` were
    // separate accumulations and only one of them met a NULL. Here both figures are columns of one row
    // and neither can be null, so the two cannot disagree about whether a transaction happened.
    const rows = await withTenant(
      db.rw,
      {
        tenantId: (await sharedDb()).a.tenant,
        actorId: (await sharedDb()).a.human,
        requestId: "legacy011-tax",
      },
      (tx) => tx<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_transaction'
         and column_name in ('base', 'tax', 'base_base', 'tax_base')
       order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "base", is_nullable: "NO" },
      { column_name: "base_base", is_nullable: "NO" },
      { column_name: "tax", is_nullable: "NO" },
      { column_name: "tax_base", is_nullable: "NO" },
    ]);
  }, 180_000);

  it("an uncoded line is written 0.0000 rather than left stale, and an empty period ties out to 0.0000", async () => {
    const f = await taxFixture(db, "legacy011-5a");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "legacy011-5a" };
    const doc = await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      taxInclusive: false,
      lines: [{ lineNo: 1, accountId: f.accounts["4000"]!, amount: "400.0000", taxCode: null }],
    });
    const line = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ tax_amount: string; total: string }[]>`
        select tax_amount::text, total_incl_tax::text as total
          from app.document_line where document_id = ${doc.documentId}`,
    );
    expect(line[0]).toEqual({ tax_amount: "0.0000", total: "400.0000" });

    const tie = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
      await generateTaxReturn(tx, ctx, d.id);
      return taxReturnTieOut(tx, d.id);
    });
    // `coalesce(..., 0)` in taxReturnTieOut is what makes this a real assertion: a null difference
    // compares equal to nothing and passes every test, which is how the legacy return went unnoticed.
    expect(tie.map((r) => [r.accountCode, r.ledgerBase, r.difference])).toEqual([
      ["1350", "0.0000", "0.0000"],
      ["2300", "0.0000", "0.0000"],
    ]);
    for (const r of tie) expect(r.difference).not.toBeNull();
  }, 180_000);
});

describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 8B", () => {
  const MYR = currency("MYR");

  it("a missing statutory input is a REFUSAL naming the employee and the field, never a zero that propagates", () => {
    // The legacy failure was `"ActAdminDebit" + new."ItmLocalDebit"` with a NULL right-hand side: one line nulled a
    // balance for ever. The payroll analogue is a required profile field nobody filled. Invented figures (hazard 1).
    const ref: RateTableRef = {
      schemeId: "s",
      schemeCode: "SYNTH_PRG",
      version: 1,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      verified: true,
      definition: {
        schema_version: 1,
        scheme: "SYNTH_PRG",
        version: 1,
        kind: "progressive_schedule",
        effective_from: "2026-01-01",
        effective_to: null,
        source: {
          authority: "Dulja test fixture",
          publication: "none",
          url: "https://example.invalid/p",
          retrieved_on: "2026-01-01",
        },
        rounding_mode: "HALF_EVEN",
        required_profile_fields: ["child_relief_count"],
        table: {
          brackets: [{ from: "0", to: null, rate: "0.1", cumulative: "0" }],
          reliefs: { child_relief_count: "100.0000" },
        },
      },
    };
    let thrown: unknown;
    try {
      payrollCalculator.calculate({
        period: {
          start: "2026-01-01",
          end: "2026-01-31",
          payDate: "2026-02-05",
          prorationRule: "calendar_days",
        },
        employees: [
          {
            employeeId: "emp-null",
            branchId: "b",
            hiredOn: "2025-01-01",
            terminatedOn: null,
            statutoryProfile: { child_relief_count: null },
            compensation: [
              {
                componentId: "c",
                kind: "earning",
                amount: Money.of("3000.0000", MYR),
                quantity: null,
                schemeIds: ["s"],
              },
            ],
            manualOverrides: [],
          },
        ],
        rateTables: [ref],
        ytdBefore: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PayrollCalculationError);
    expect((thrown as PayrollCalculationError).code).toBe("ERR_PAYROLL_INPUT_MISSING");
    expect((thrown as PayrollCalculationError).detail).toContain("emp-null");
    expect((thrown as PayrollCalculationError).detail).toContain("child_relief_count");
  });
});

describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 8C", () => {
  // Only the Db is taken from the shared context; the block seeds its own tenant (payrollFixture is not idempotent).
  let db: Db;
  let tenant: Awaited<ReturnType<typeof seedTenantV2>>;
  let f: MoneyOutFixture;
  let scheduleId: string;
  let total: string;
  const ctx = () => ({
    tenantId: tenant.tenant,
    actorId: tenant.human,
    requestId: "00000000-0000-0000-0000-000000000000",
  });

  beforeAll(async () => {
    db = (await sharedDb()).db;
    tenant = await seedTenantV2(db, "LEGACY-011 8C");
    f = await moneyOutFixture(db, tenant);
    const [schedule] = await withTenant(db.rw, ctx(), (tx) =>
      generateStatutorySchedule(tx, ctx(), new MemoryObjectStore(), {
        companyId: tenant.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    );
    scheduleId = schedule!.scheduleId;
    total = schedule!.totalEmployee.add(schedule!.totalEmployer).toString();
  }, 240_000);

  it("both schedule totals are NOT NULL fixed-scale figures, never NULL", async () => {
    // The old system accumulated without coalesce and one NULL nulled a whole period's box. The generator coalesces
    // each share at the accumulation boundary and the columns are NOT NULL (spec:311).
    const [row] = await db.admin<
      { total_employer: string | null; total_employee: string | null }[]
    >`
      select total_employer::text as total_employer, total_employee::text as total_employee
        from app.statutory_schedule where id = ${scheduleId}`;
    expect(row!.total_employer).toMatch(/^\d+\.\d{4}$/);
    expect(row!.total_employee).toMatch(/^\d+\.\d{4}$/);
    const nullable = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_schedule'
         and column_name in ('total_employee', 'total_employer') and is_nullable = 'YES'`;
    expect(nullable).toEqual([]);
  });

  it("the remittance guard reads a document with NO bank leg as 0.0000 and refuses it, never as NULL", async () => {
    // `coalesce(sum(le.credit) - sum(le.debit), 0)` in app.assert_remittance_matches_schedule: without the coalesce,
    // `sum` over an empty set is NULL, `paid <> total` is UNKNOWN, the `if` does not fire and the guard SILENTLY
    // PASSES. The subject is the PAYROLL run itself: posted, with ledger rows, and not one of them on `1100`.
    const [bank] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${f.payrollDocumentId} and a.code = '1100'`;
    expect(bank!.n).toBe(0); // the premise, asserted rather than assumed

    await expect(
      withTenant(
        db.rw,
        ctx(),
        (tx) => tx`
        update app.statutory_schedule set remittance_document_id = ${f.payrollDocumentId}
         where id = ${scheduleId}`,
      ),
    ).rejects.toThrow(
      new RegExp(
        `ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles ${total.replace(".", "\\.")}, payment .* moves 0\\.0000`,
      ),
    );
    const [after] = await db.admin<{ remittance_document_id: string | null }[]>`
      select remittance_document_id from app.statutory_schedule where id = ${scheduleId}`;
    expect(after!.remittance_document_id).toBeNull(); // refused, not recorded
  });
});

describe("LEGACY-011 NULL arithmetic irreversibly nulls balances and tax boxes — 8D (the output half)", () => {
  // 8B proved the refusal of a NULL statutory input and 8C the schedule's NOT NULL totals; this block proves the
  // OUTPUT half: what a payslip and the parallel-run reconciliation print. Only the Db is shared; the block seeds its
  // own tenant (payrollFixture is not idempotent, and hrReportFixture calls it).
  let db: Db;
  let tenant: Awaited<ReturnType<typeof seedTenantV2>>;
  let f: HrReportFixture;
  const ctx = () => ({
    tenantId: tenant.tenant,
    actorId: tenant.human,
    requestId: "00000000-0000-0000-0000-000000000000",
  });

  beforeAll(async () => {
    db = (await sharedDb()).db;
    tenant = await seedTenantV2(db, "LEGACY-011 8D");
    f = await hrReportFixture(db, tenant);
  }, 300_000);

  it("every payslip bundle carries a complete set of 4 dp figures, never a null or an empty string", async () => {
    const bundles = await withTenant(db.rw, ctx(), (tx) =>
      payslipRows(tx, { companyId: tenant.company, payrollDocumentId: f.runDocumentId }),
    );
    expect(bundles.length).toBeGreaterThan(0);
    for (const b of bundles) {
      for (const field of ["gross", "totalDeductions", "net"] as const) {
        expect(b.header[field], `${b.header.employeeNumber}.${field}`).toMatch(/^-?\d+\.\d{4}$/);
      }
      // No printed line carries a NULL amount: a component or scheme line without one would print as a blank and
      // still be summed into nothing.
      for (const row of b.rows) {
        expect(row["amount"], `${b.header.employeeNumber} line`).not.toBeNull();
      }
    }
  });

  it("an employee the legacy run paid and Dulja did not is REPORTED, never silently dropped", async () => {
    const report = await withTenant(db.rw, ctx(), (tx) =>
      reconcileParallelRun(
        tx,
        {
          companyId: tenant.company,
          payrollDocumentId: f.runDocumentId,
          baseCurrency: currency("MYR"),
        },
        [
          {
            employeeNumber: "E-NOT-IN-DULJA",
            gross: "1.0000",
            totalDeductions: "0.0000",
            net: "1.0000",
            schemes: {},
          },
        ],
      ),
    );
    expect(report.differences.some((d) => d.kind === "missing_in_dulja")).toBe(true);
    // Dulja's own employees are absent from that legacy list, so they are reported too — nothing nets to silence.
    expect(report.differences.some((d) => d.kind === "missing_in_legacy")).toBe(true);
    expect(report.cleanToTheCent).toBe(false);
  });
});

describe("LEGACY-011 NULL-poisoned costs — 9B", () => {
  it("a legacy receipt with no value is refused, never costed at zero", () => {
    expect(() =>
      replayLegacyMovements(
        [
          {
            sourceKey: "1",
            itemKey: "10",
            warehouseKey: "1",
            lotKey: null,
            effectiveDate: "2025-06-01",
            sequence: 1n,
            lineNo: 1,
            direction: "in",
            quantity: Quantity.of("1.000000"),
            value: null,
          },
        ],
        "avco",
        currency("MYR"),
      ),
    ).toThrow("has no value; a receipt with no cost is never costed at zero (LEGACY-011, §5.1 #6)");
  });

  it("does not import a legacy cost figure at all — no loader reads MatCosts (§5.1 #6)", () => {
    // 9A's profiling and reconciliation name the table (they QUANTIFY its drift, packages/importer/src/legacy and
    // src/reconcile); what §5.1 #6 forbids is LOADING it, so the check is over the loaders and the registry.
    expect(loaders.map((l) => l.sourceTable)).not.toContain("MATCOSTS");
    const files = sourceFiles(["packages/importer/src/load"]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => /MATCOSTS/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});
