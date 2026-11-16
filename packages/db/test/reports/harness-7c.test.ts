import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, type ReportDefinition } from "@dulja/domain";
// The 7C half of the harness and 7B's, reached through 3B's amendment A21(c) — the `packages/db/test/**` →
// `tests/invariants/support/**` allowance 7B's group tests use.
import {
  CATALOGUE_7C,
  CATALOGUE_DIR_7C,
  arApReportFixture,
  readEnvelope7C,
  type ArApReportFixture,
} from "../../../../tests/invariants/support/reports-7c";
import { assertTieOut } from "../../../../tests/invariants/support/reports";
import { startDb, withTenant, type Db } from "../harness";
import { DATASET_READ_CODES, type DatasetId } from "../../src/reports/datasets";

const MYR = currency("MYR");

/** A minimal definition over one dataset: the fields as text columns, no totals, and the tie-out under test. */
const definitionOver = (
  source: string,
  fields: readonly string[],
  tieOut: ReportDefinition["tieOut"],
  filters: ReportDefinition["dataset"]["filters"] = [],
): ReportDefinition =>
  ({
    version: 1,
    code: "accounting.harness_probe",
    nameEn: "Harness probe",
    nameAr: "اختبار",
    module: "accounting",
    // The dataset's own first admitted code: the row provider re-checks the gate (second review, finding 8).
    permission: DATASET_READ_CODES[source as DatasetId][0],
    parameters: [],
    dataset: { source, filters },
    columns: fields.map((field) => ({
      field,
      labelEn: field,
      labelAr: field,
      format: "text",
      align: "start",
    })),
    groups: [],
    totals: [],
    sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
    tieOut,
  }) as unknown as ReportDefinition;

/**
 * The 7C catalogue harness's own test (contracts §4.17.1; round 15, A3 and A4), so a broken branch fails here
 * and not inside a definition group. Each new `projection` branch is driven with a minimal in-test definition
 * over 7A's dataset — the real definitions are Tasks 3 and 4's — and is shown both to pass on the fixture and
 * to FAIL, naming the key, when the report and the stored source disagree.
 */
describe("the 7C catalogue harness — contracts §4.17.1 amendment A4", () => {
  let db: Db;
  let f: ArApReportFixture;
  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "harness-7c");
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.s.tenant, f.reader, fn as never) as Promise<T>;

  it("CATALOGUE_7C is the ten §4.16.1 codes in register order — no pdc_register under OD-09", () => {
    expect([...CATALOGUE_7C]).toEqual([
      "accounting.ageing",
      "accounting.party_statement",
      "accounting.allocation_register",
      "accounting.unreconciled_items",
      "pos.z_report",
      "pos.sales_by_cashier",
      "pos.sales_by_branch",
      "pos.needs_attention",
      "accounting.branch_profit_and_loss",
      "accounting.tax_return_view",
    ]);
    expect(CATALOGUE_DIR_7C.replaceAll("\\", "/")).toMatch(/packages\/db\/seed\/my\/reports\/7c$/);
  });

  it("readEnvelope7C refuses a missing file, naming the path", () => {
    expect(() => readEnvelope7C("accounting.not_a_report")).toThrow(
      /reports[\\/]7c[\\/]accounting\.not_a_report\.json/,
    );
  });

  it("the fixture posts the AR/AP corpus every 7C accounting definition reads", async () => {
    const counts = await read(
      (tx: never) => (tx as unknown as import("postgres").Sql)<{ what: string; n: number }[]>`
        select 'tax' as what, count(*)::int as n from app.tax_transaction where company_id = ${f.s.company}
        union all
        select 'allocation', count(*)::int from app.allocation where company_id = ${f.s.company}
        union all
        select 'line', count(*)::int from app.bank_statement_line where company_id = ${f.s.company}
        union all
        select 'ageing', count(*)::int from app.party_ageing
         where company_id = ${f.s.company} and as_of = ${f.ageingAsOf}::date
        order by 1`,
    );
    // Two taxed documents (one line each), one allocation, two statement lines, and a rebuilt snapshot.
    expect(Object.fromEntries(counts.map((c) => [c.what, c.n]))).toMatchObject({
      allocation: 1,
      line: 2,
      tax: 2,
    });
    expect(counts.find((c) => c.what === "ageing")!.n).toBeGreaterThan(0);
  });

  it("assertTieOut rejects an unknown projection source, naming it", async () => {
    // A REAL transaction and REAL parameters: `assertTieOut` runs `runDefinition` and `assertFieldCoverage`
    // before the switch, and the fixture's documents make the `document` dataset non-empty.
    const definition = definitionOver("document", ["base_total"], {
      kind: "projection",
      projection: "till_event",
    } as never);
    await read((tx) =>
      expect(
        assertTieOut(tx, definition, { params: { companyId: f.s.company }, baseCurrency: MYR }),
      ).rejects.toThrow(/projection "till_event" is not one this harness executes/),
    );
  });

  it("ledger_sum: base_total over a party window (partyId) ties a party's documents to their ledger", async () => {
    const definition = {
      ...definitionOver(
        "document",
        ["party_id", "effective_date", "base_total"],
        { kind: "ledger_sum" },
        [
          { field: "party_id", op: "eq", param: "partyId" },
          { field: "effective_date", op: "gte", param: "fromDate" },
          { field: "effective_date", op: "lte", param: "toDate" },
        ],
      ),
    } as ReportDefinition;
    const withMoney = {
      ...definition,
      columns: definition.columns.map((c) =>
        c.field === "base_total" ? { ...c, format: "money" as const, align: "end" as const } : c,
      ),
      totals: [{ field: "base_total", fn: "sum" as const }],
    } as ReportDefinition;
    const params = {
      companyId: f.s.company,
      partyId: f.customerId,
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    };
    await read((tx) =>
      assertTieOut(tx, withMoney, {
        params,
        baseCurrency: MYR,
        window: { partyId: f.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" },
      }),
    );
    // The window's partyId is load-bearing: the vendor's window has no ledger rows and must disagree.
    await read((tx) =>
      expect(
        assertTieOut(tx, withMoney, {
          params,
          baseCurrency: MYR,
          window: { partyId: f.vendorId, fromDate: "2026-01-01", toDate: "2026-01-31" },
        }),
      ).rejects.toThrow(/the report totals .* and the ledger totals 0\.0000/),
    );
  });

  it("ledger_sum: tax_base maps to the signed credit_net measure on 2300", async () => {
    const definition = {
      ...definitionOver("tax_transaction", ["tax_code_kind", "tax_base"], {
        kind: "ledger_sum",
        account: "2300",
      }),
    } as ReportDefinition;
    const withMoney = {
      ...definition,
      columns: definition.columns.map((c) =>
        c.field === "tax_base" ? { ...c, format: "money" as const, align: "end" as const } : c,
      ),
      totals: [{ field: "tax_base", fn: "sum" as const }],
    } as ReportDefinition;
    // The invoice's output tax less the credit note's: a signed figure `credit` alone would overstate.
    await read((tx) =>
      assertTieOut(tx, withMoney, {
        params: { companyId: f.s.company },
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.fiscalPeriodId },
      }),
    );
  });

  it("projection party_ageing: the rebuilt snapshot for the run's asOf, per (party, currency, bucket)", async () => {
    const definition = definitionOver(
      "party_ageing",
      ["party_id", "currency", "bucket", "amount", "base_amount"],
      { kind: "projection", projection: "party_ageing" },
      [{ field: "as_of", op: "eq", param: "asOf" }],
    );
    await read((tx) =>
      assertTieOut(tx, definition, {
        params: { companyId: f.s.company, asOf: f.ageingAsOf },
        baseCurrency: MYR,
      }),
    );
    // The stored side is one snapshot date, so a run that names none is refused rather than compared.
    await read((tx) =>
      expect(
        assertTieOut(tx, definition, { params: { companyId: f.s.company }, baseCurrency: MYR }),
      ).rejects.toThrow(/party_ageing tie-out needs the asOf parameter/),
    );
  });

  it("projection allocation: each allocation's base_amount, keyed on allocation_id", async () => {
    const definition = definitionOver(
      "allocation",
      ["allocation_id", "settled_effective_date", "base_amount"],
      { kind: "projection", projection: "allocation" },
      [
        { field: "settled_effective_date", op: "gte", param: "fromDate" },
        { field: "settled_effective_date", op: "lte", param: "toDate" },
      ],
    );
    await read((tx) =>
      assertTieOut(tx, definition, {
        params: { companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31" },
        baseCurrency: MYR,
      }),
    );
    // A report that carries an allocation its parameters should have excluded fails, naming it: the stored
    // side honours the 2025 window and selects nothing, the unfiltered report still lists the allocation.
    const unfiltered = definitionOver("allocation", ["allocation_id", "base_amount"], {
      kind: "projection",
      projection: "allocation",
    });
    await read((tx) =>
      expect(
        assertTieOut(tx, unfiltered, {
          params: { companyId: f.s.company, fromDate: "2025-01-01", toDate: "2025-01-31" },
          baseCurrency: MYR,
        }),
      ).rejects.toThrow(new RegExp(`the report has ${f.allocationId}, which the stored source`)),
    );
  });

  it("projection bank_statement_line: isMatched selects the open or the matched line, compared by line_id", async () => {
    const definition = definitionOver(
      "bank_statement_line",
      ["line_id", "is_matched", "amount", "matched_amount"],
      { kind: "projection", projection: "bank_statement_line" },
      [
        { field: "is_matched", op: "eq", param: "isMatched" },
        { field: "bank_account_id", op: "eq", param: "bankAccountId" },
      ],
    );
    for (const isMatched of ["false", "true"]) {
      await read((tx) =>
        assertTieOut(tx, definition, {
          params: { companyId: f.s.company, isMatched, bankAccountId: f.accounts["1100"]! },
          baseCurrency: MYR,
        }),
      );
    }
    // Absent, isMatched means "false" (the unreconciled meaning); a report of BOTH lines then disagrees with
    // a stored side of the open one, naming the matched line.
    const both = definitionOver("bank_statement_line", ["line_id", "amount", "matched_amount"], {
      kind: "projection",
      projection: "bank_statement_line",
    });
    await read((tx) =>
      expect(
        assertTieOut(tx, both, { params: { companyId: f.s.company }, baseCurrency: MYR }),
      ).rejects.toThrow(new RegExp(`the report has ${f.matchedLineId}`)),
    );
  });

  it("projection shift: no shift in an AR/AP company is refused by field coverage, never passed", async () => {
    // The shift branch's positive case needs a synced trading day, which needs a running API
    // (`posReportFixture`); Task 4's group test in `apps/api/test/routes/reports/` drives it. Here: an empty
    // shift report is never a vacuous pass.
    const definition = definitionOver(
      "shift",
      ["shift_id", "opening_float", "counted_cash", "expected_cash", "over_short"],
      { kind: "projection", projection: "shift" },
    );
    await read((tx) =>
      expect(
        assertTieOut(tx, definition, { params: { companyId: f.s.company }, baseCurrency: MYR }),
      ).rejects.toThrow(/the fixture returned no rows/),
    );
  });
});
