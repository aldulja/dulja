import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Money, currency, validateReportDefinition } from "@dulja/domain";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { accountLedger, accountOpeningBalance } from "../../src/reports/ledger";
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
 * 7B Task 4 — 1B's two minimal-set codes re-expressed at `definitionVersion = 2` (§4.16.1, spec:2300).
 *
 * Amendment A2: 1B's JSON list routes, DTOs and read functions stand byte for byte. The definition gives the
 * code a render path (7A's runs route) and a designer entry; the PARITY cases below prove the definition's
 * rows equal `trialBalance` / `accountLedger` row for row and figure for figure, and 1B's own route test is
 * re-run unchanged.
 */
const MYR = currency("MYR");
const TB = "accounting.trial_balance";
const LEDGER = "accounting.ledger";
/** The two vocabularies this file joins (A3): LEFT is a `DatasetRow`'s snake_case column alias, RIGHT is 1B's
 *  camelCase read-function row member. Written once, so no case decides it again. */
const FIGURES = [
  ["debit", "debit"],
  ["credit", "credit"],
  ["base_debit", "baseDebit"],
  ["base_credit", "baseCredit"],
] as const;

const money = (value: unknown): string => Money.of(String(value), MYR).toString();
function sum(rows: readonly DatasetRow[], field: string): string {
  return rows
    .reduce((acc, r) => acc.add(Money.of(String(r[field] ?? "0.0000"), MYR)), Money.zero(MYR))
    .toString();
}

describe("7B re-expresses 1B's two minimal-set codes (§4.16.1, spec:2300, amendment A2)", () => {
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
  const ledgerParams = () => ({
    companyId: f.s.company,
    accountId: f.s.cash,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
  });

  it("both are seeded at definitionVersion 2 and keep 1B's code and permission exactly", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const code of [TB, LEDGER]) {
      const envelope = readEnvelope(code);
      expect(envelope.definitionVersion).toBe(2);
      expect(envelope.definition.version).toBe(1);
      expect(envelope.definition.code).toBe(code);
      expect(envelope.definition.permission).toBe("accounting.report.read");
      expect(envelope.definition.module).toBe("accounting");
      const result = validateReportDefinition(envelope.definition, sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
  });

  it("PARITY: accounting.trial_balance's definition returns exactly what trialBalance returns", async () => {
    await read(async (tx) => {
      for (const period of [f.s.period, f.s.closedPeriod]) {
        const fn = await trialBalance(tx, {
          companyId: f.s.company,
          fiscalPeriodId: period,
          limit: 1000,
        });
        const def = await runDefinition(tx, readDefinition(TB), {
          companyId: f.s.company,
          fiscalPeriodId: period,
          currency: null,
        });
        expect(fn.length).toBeGreaterThan(0);
        expect(def.length).toBe(fn.length);
        // The definition's own sort (account_code, currency) is 1B's ORDER BY, so the rows align by index.
        for (const [i, row] of fn.entries()) {
          const got = def[i]!;
          expect(`${String(got["account_code"])}|${String(got["currency"])}`).toBe(
            `${row.accountCode}|${row.currency}`,
          );
          for (const [column, member] of FIGURES) {
            expect(money(got[column]), `${row.accountCode} ${column}`).toBe(money(row[member]));
          }
          expect(String(got["account_id"])).toBe(row.accountId);
          expect(String(got["account_type"])).toBe(row.accountType);
          expect(String(got["account_name_en"])).toBe(row.accountNameEn);
        }
      }
      // The optional currency filter narrows exactly as 1B's `currency` parameter does.
      const myr = await runDefinition(tx, readDefinition(TB), {
        companyId: f.s.company,
        fiscalPeriodId: f.s.period,
        currency: "MYR",
      });
      const fnMyr = await trialBalance(tx, {
        companyId: f.s.company,
        fiscalPeriodId: f.s.period,
        currency: "MYR",
        limit: 1000,
      });
      expect(myr.map((r) => String(r["account_code"]))).toEqual(fnMyr.map((r) => r.accountCode));
      const none = await runDefinition(tx, readDefinition(TB), {
        companyId: f.s.company,
        fiscalPeriodId: f.s.period,
        currency: "USD",
      });
      expect(none).toEqual([]);
    });
  });

  it("PARITY: accounting.ledger's definition returns 1B's rows for one account, minus the running balance", async () => {
    await read(async (tx) => {
      const fn = await accountLedger(tx, { ...ledgerParams(), limit: 1000 });
      const def = await runDefinition(tx, readDefinition(LEDGER), ledgerParams());
      expect(fn.length).toBe(3);
      expect(def.map((r) => String(r["entry_id"]))).toEqual(fn.map((r) => r.entryId));
      for (const [i, row] of fn.entries()) {
        const got = def[i]!;
        for (const [column, member] of FIGURES) {
          expect(money(got[column]), `${row.entryId} ${column}`).toBe(money(row[member]));
        }
        expect(String(got["effective_date"])).toBe(row.effectiveDate);
        expect(String(got["document_type_code"])).toBe(row.documentTypeCode);
        expect(String(got["series"])).toBe(row.series);
        expect(String(got["number"])).toBe(String(row.number));
        expect(got["line_no"]).toBe(row.lineNo);
        expect(String(got["posting_seq"])).toBe(row.postingSeq);
      }
      // `running_base_balance` is 1B's route arithmetic over an ordered page and is deliberately NOT a dataset
      // field (A3); a renderer wanting one would be a second implementation of what `accountOpeningBalance`
      // and 1B's window sum already define.
      expect(readDefinition(LEDGER).columns.map((c) => c.field)).not.toContain(
        "running_base_balance",
      );
      const opening = await accountOpeningBalance(tx, {
        companyId: f.s.company,
        accountId: f.s.cash,
        beforeDate: "2026-01-01",
      });
      expect(money(opening)).toBe("0.0000");
      // With a zero opening, the last running balance is the page's own net — the two paths agree.
      expect(money(fn.at(-1)!.runningBaseBalance)).toBe(
        Money.of(sum(def, "base_debit"), MYR)
          .subtract(Money.of(sum(def, "base_credit"), MYR))
          .toString(),
      );
    });
  });

  it("accounting.trial_balance ties: Σ debit = Σ credit, and the total equals the ledger's own", async () => {
    await read(async (tx) => {
      const params = { companyId: f.s.company, fiscalPeriodId: f.s.period, currency: null };
      await assertTieOut(tx, readDefinition(TB), {
        params,
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period },
      });
      const rows = await runDefinition(tx, readDefinition(TB), params);
      expect(sum(rows, "base_debit")).toBe(sum(rows, "base_credit"));
      expect(sum(rows, "base_debit")).toBe("1700.0000");
    });
  });

  // `window.accountCode` is REQUIRED: the report is filtered to one account, so the stored side is narrowed to
  // the same one — without it the branch would ask this report to account for 4000 and 5900 as well.
  it("accounting.ledger ties to account_balance for the account it reports", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(LEDGER), {
        params: ledgerParams(),
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period, accountCode: "1000" },
      });
    });
  });
});
