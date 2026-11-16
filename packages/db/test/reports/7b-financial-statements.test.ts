import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  Money,
  STATEMENT_LAYOUTS,
  currency,
  statementDefinition,
  validateReportDefinition,
  type StatementKind,
} from "@dulja/domain";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import type { DatasetRow } from "../../src/reports/query";
import { trialBalance } from "../../src/reports/trial-balance";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B harness, reachable from packages/db/test/** through 3B's amendment A21(c).
import {
  assertTieOut,
  readDefinition,
  readEnvelope,
  reportFixture,
  runDefinition,
  type ReportFixture,
} from "../../../../tests/invariants/support/reports";

/**
 * 7B Task 2 — the two financial statements. Each seed file IS `statementDefinition(kind, identity)` over 7A's
 * frozen layout (contracts 7B A6), its rows come from 7A's `statementRows` through `rowsForDefinition` (the
 * harness keeps no code→kind map), and each ties to the ledger's own sum over its account types.
 *
 * The permission catalogue is read from `app.permission`, never from an import of `PERMISSIONS`:
 * `dependency-rule` forbids `packages/db` naming `@dulja/contracts`, test files included.
 */
const MYR = currency("MYR");
const PL = "accounting.profit_and_loss";
const BS = "accounting.balance_sheet";
/** The members `statementDefinition` takes beyond the layout — everything else in the file is 7A's. */
const IDENTITY: Readonly<Record<string, { kind: StatementKind; nameEn: string; nameAr: string }>> =
  {
    [PL]: { kind: "profit_and_loss", nameEn: "Profit and loss", nameAr: "قائمة الأرباح والخسائر" },
    [BS]: { kind: "balance_sheet", nameEn: "Balance sheet", nameAr: "الميزانية العمومية" },
  };
const definitionFor = (code: string) =>
  statementDefinition(IDENTITY[code]!.kind, {
    code,
    nameEn: IDENTITY[code]!.nameEn,
    nameAr: IDENTITY[code]!.nameAr,
    permission: "accounting.report.read",
  });
/** The ledger side of each tie-out: which account types the statement covers. `statementRows` applies the
 *  same split on the report side; the ledger side has no such helper and must be told. */
const PL_TYPES = ["income", "expense"] as const;
const BS_TYPES = ["asset", "liability", "equity"] as const;

function sum(rows: readonly DatasetRow[], field: string): Money<typeof MYR> {
  return rows.reduce(
    (acc, r) => acc.add(Money.of(String(r[field] ?? "0.0000"), MYR)),
    Money.zero(MYR),
  );
}

describe("7B financial statements (§4.16.1, amendment A6; the layout is 7A's, the identity is 7B's)", () => {
  let db: Db;
  let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha");
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const run = (tx: Sql, code: string) =>
    runDefinition(tx, readDefinition(code), {
      companyId: f.s.company,
      fiscalPeriodId: f.s.period,
    });

  // A seed file is not "modelled on" 7A's layout, it IS 7A's layout with a code, two names and a permission
  // on it. Deep equality is the only assertion that cannot drift.
  it("each definition is EXACTLY statementDefinition(kind, identity) — 7A's layout, member for member", () => {
    for (const code of [PL, BS]) {
      expect(readDefinition(code), `${code} is not 7A's frozen layout (amendment A6)`).toEqual(
        definitionFor(code),
      );
      expect(readEnvelope(code).definitionVersion).toBe(1);
    }
    // The frozen pair, not a `statementLayout(..., { perBranch: true })` variant — that one is 7C's.
    expect(readDefinition(PL).columns).toEqual(STATEMENT_LAYOUTS.profit_and_loss.columns);
    expect(readDefinition(BS).columns).toEqual(STATEMENT_LAYOUTS.balance_sheet.columns);
  });

  it("both validate, are gated accounting.report.read and read account_balance", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const code of [PL, BS]) {
      const envelope = readEnvelope(code);
      const result = validateReportDefinition(envelope.definition, sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok).toBe(true);
      expect(envelope.definition.permission).toBe("accounting.report.read");
      expect(envelope.definition.dataset.source).toBe("account_balance");
      expect(envelope.definition.module).toBe("accounting");
    }
  });

  it("one parameter, one filter, no branch and no asOf (amendment A6)", () => {
    for (const code of [PL, BS]) {
      const d = readDefinition(code);
      expect(d.parameters.map((p) => p.name)).toEqual(["fiscalPeriodId"]);
      expect(d.dataset.filters).toEqual([
        { field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" },
      ]);
      expect(d.parameters.map((p) => p.kind)).not.toContain("branch");
      expect(d.parameters.map((p) => p.name)).not.toContain("asOf");
      expect(d.parameters.map((p) => p.name)).not.toContain("accountTypes");
      expect(d.layout.header, "a period statement names its period").not.toContain("asOf");
    }
  });

  it("accounting.profit_and_loss ties to the ledger's own sum over income and expense", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PL), {
        params: { companyId: f.s.company, fiscalPeriodId: f.s.period },
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period, accountTypes: [...PL_TYPES] },
      });
    });
  });

  it("accounting.balance_sheet ties to the ledger's own sum over asset, liability and equity", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(BS), {
        params: { companyId: f.s.company, fiscalPeriodId: f.s.period },
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period, accountTypes: [...BS_TYPES] },
      });
    });
  });

  it("THE IDENTITY: the balance sheet's net plus the profit-and-loss net is exactly zero", async () => {
    // 2026-01: cash 1200 − 300 − 200 = +700 debit; other expense +300; sales 1200 − 200 = 1000 credit.
    // Assets +700, income/expense net −700, and the sum is 0.0000 — read out of the two STATEMENTS, so it
    // fails if `statementRows` drops a row or files one under the wrong statement.
    await read(async (tx) => {
      const bs = sum(await run(tx, BS), "base_balance");
      const pl = sum(await run(tx, PL), "base_balance");
      expect(bs.toString()).toBe("700.0000");
      expect(pl.toString()).toBe("-700.0000");
      expect(bs.add(pl).toString()).toBe("0.0000");
    });
  });

  it("the two statements partition the trial balance: every 1B row appears in exactly one of them", async () => {
    await read(async (tx) => {
      const tb = await trialBalance(tx, {
        companyId: f.s.company,
        fiscalPeriodId: f.s.period,
        limit: 1000,
      });
      const seen = new Set<string>();
      for (const code of [BS, PL]) {
        for (const r of await run(tx, code)) {
          // LEFT: the dataset's snake_case alias (A3). RIGHT (below): `TrialBalanceRow`'s camelCase member.
          const key = `${String(r["account_code"])}|${String(r["currency"])}`;
          expect(seen.has(key), `${key} appears in both statements`).toBe(false);
          seen.add(key);
        }
      }
      expect(tb.length).toBeGreaterThan(0);
      expect([...seen].toSorted()).toEqual(
        tb.map((r) => `${r.accountCode}|${r.currency}`).toSorted(),
      );
    });
  });

  // [7 remediation] — the sections group on their printed heading (`section_label`) and sort in accounting
  // order (`section_rank`); both are annotated by statementRows and carried by no dataset column.
  it("both group on `section_label` and sort on `section_rank`, which statementRows annotates", async () => {
    for (const code of [PL, BS]) {
      const d = readDefinition(code);
      expect(d.groups).toEqual([{ field: "section_label", subtotal: true }]);
      expect(d.totals).toEqual([{ field: "base_balance", fn: "sum" }]);
      expect(d.sort).toEqual([
        { field: "section_rank", dir: "asc" },
        { field: "account_code", dir: "asc" },
      ]);
      expect(d.layout.paper).toBe("A4");
      expect(d.layout.orientation).toBe("portrait");
    }
    // The annotation is there at run time — what catches a harness whose statement branch was never taken.
    await read(async (tx) => {
      const pl = await run(tx, PL);
      expect(pl.length).toBeGreaterThan(0);
      for (const r of pl) {
        expect(typeof r["section"], "statementRows annotates `section`").toBe("string");
        expect(r["section_rank"], String(r["section"])).toBe(r["section"] === "revenue" ? 0 : 1);
        expect(r["section_label"], String(r["section"])).toBe(
          r["section"] === "revenue" ? "Revenue" : "Expenses",
        );
      }
      expect(new Set(pl.map((r) => String(r["account_type"])))).toEqual(
        new Set(["income", "expense"]),
      );
      const bs = await run(tx, BS);
      expect(new Set(bs.map((r) => String(r["section"])))).toEqual(new Set(["asset"]));
    });
  });
});
