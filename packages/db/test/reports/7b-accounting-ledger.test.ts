import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { Money, currency, validateReportDefinition } from "@dulja/domain";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import type { DatasetRow } from "../../src/reports/query";
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
 * 7B Task 1 — the four accounting ledger definitions, each executed through 7A's `rowsForDefinition` and
 * tied to the ledger or to `account_balance` by the shared harness (ADR 0068; contracts 7B A5).
 *
 * The permission catalogue is read from `app.permission` rows, never from an import of `PERMISSIONS`:
 * `dependency-rule` forbids `packages/db` naming `@dulja/contracts`, test files included (3B's precedent).
 */
const MYR = currency("MYR");
const CODES = [
  "accounting.general_ledger",
  "accounting.journal_register",
  "accounting.account_statement",
  "accounting.period_comparison",
] as const;

/** Σ of one money field as a fixed 4-dp string, through `Money` — never `Number()` (Global Constraint 3). */
function sum(rows: readonly DatasetRow[], field: string): string {
  return rows
    .reduce((acc, r) => acc.add(Money.of(String(r[field] ?? "0.0000"), MYR)), Money.zero(MYR))
    .toString();
}

describe("7B accounting ledger definitions (§4.16.1, DoD: numbers tie to the ledger)", () => {
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

  /** Parameters and ledger window per code — one place, so a case never disagrees with its tie-out window. */
  const paramsFor = (code: string): Record<string, string | null> => {
    const range = { companyId: f.s.company, fromDate: "2026-01-01", toDate: "2026-01-31" };
    if (code === "accounting.account_statement") return { ...range, accountId: f.s.cash };
    if (code === "accounting.period_comparison") {
      return { companyId: f.s.company, fiscalPeriodId: f.s.period, accountType: "income" };
    }
    if (code === "accounting.general_ledger") return { ...range, accountId: null, branchId: null };
    return { ...range, documentTypeCode: null };
  };
  const windowFor = (code: string) => {
    if (code === "accounting.account_statement")
      return { fiscalPeriodId: f.s.period, accountCode: "1000" };
    if (code === "accounting.period_comparison")
      return { fiscalPeriodId: f.s.period, accountCode: "4000" };
    if (code === "accounting.general_ledger") return { fiscalPeriodId: f.s.period };
    return { fromDate: "2026-01-01", toDate: "2026-01-31" };
  };

  it("the thirteen §4.15 accounts this catalogue names all resolve for the seeded company, and none was re-seeded", async () => {
    const rows = await read(
      (tx) => tx<{ code: string; n: number }[]>`
      select code, count(*)::int as n from app.account where company_id = ${f.s.company} group by code`,
    );
    const byCode = new Map(rows.map((r) => [r.code, r.n]));
    for (const code of [
      "1000",
      "1100",
      "1200",
      "1250",
      "1300",
      "1310",
      "2100",
      "2150",
      "4000",
      "5000",
      "5100",
      "5110",
      "5900",
    ]) {
      expect(byCode.get(code), `account ${code} must resolve (hazard 33)`).toBe(1);
    }
  });

  it("all four definitions validate, and each file name equals its definition.code (amendment A1)", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const code of CODES) {
      const envelope = readEnvelope(code);
      expect(envelope.definitionVersion).toBe(1);
      expect(envelope.definition.version).toBe(1);
      const result = validateReportDefinition(envelope.definition, sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("each definition's permission is the code §4.16.1 assigns it, and every one is non-mutating", async () => {
    const rows = await db.admin<{ code: string; mutating: boolean }[]>`
      select code, mutating from app.permission`;
    const mutating = new Map(rows.map((r) => [r.code, r.mutating]));
    for (const code of CODES) {
      const d = readDefinition(code);
      expect(d.permission).toBe("accounting.report.read");
      expect(mutating.get(d.permission)).toBe(false);
      expect(d.module).toBe("accounting");
    }
  });

  it("every field every definition references exists in its dataset's rows, and every declared tie-out holds", async () => {
    await read(async (tx) => {
      for (const code of CODES) {
        await assertTieOut(tx, readDefinition(code), {
          params: paramsFor(code),
          baseCurrency: MYR,
          window: windowFor(code),
        });
      }
    });
  });

  it("accounting.general_ledger ties to account_balance for every account and currency", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.general_ledger");
      const params = paramsFor("accounting.general_ledger");
      await assertTieOut(tx, d, {
        params,
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period },
      });
      const rows = await runDefinition(tx, d, params);
      // The three January journals touch 1000, 4000 and 5900; February's is outside the range.
      expect([...new Set(rows.map((r) => String(r["account_code"])))].toSorted()).toEqual([
        "1000",
        "4000",
        "5900",
      ]);
    });
  });

  it("accounting.journal_register's debit total equals the ledger's own, and debits equal credits", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.journal_register");
      const params = paramsFor("accounting.journal_register");
      await assertTieOut(tx, d, {
        params,
        baseCurrency: MYR,
        window: { fromDate: "2026-01-01", toDate: "2026-01-31" },
      });
      const rows = await runDefinition(tx, d, params);
      expect(sum(rows, "base_debit")).toBe("1700.0000");
      expect(sum(rows, "base_debit")).toBe(sum(rows, "base_credit"));
      expect(rows.length).toBe(6); // three journals, two lines each
      // The document-type filter narrows to JOURNAL — every fixture document here is one.
      const journals = await runDefinition(tx, d, { ...params, documentTypeCode: "JOURNAL" });
      expect(journals.length).toBe(6);
      const none = await runDefinition(tx, d, { ...params, documentTypeCode: "NO_SUCH_TYPE" });
      expect(none.length).toBe(0); // an unknown code returns no rows (amendment A10's rule)
    });
  });

  it("accounting.account_statement over 1000 Cash ties to account_balance, and its rows are chronological", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.account_statement");
      const params = paramsFor("accounting.account_statement");
      await assertTieOut(tx, d, {
        params,
        baseCurrency: MYR,
        window: { fiscalPeriodId: f.s.period, accountCode: "1000" },
      });
      const rows = await runDefinition(tx, d, params);
      expect(rows.map((r) => String(r["effective_date"]))).toEqual([
        "2026-01-05",
        "2026-01-12",
        "2026-01-20",
      ]);
      expect(rows.every((r) => r["fiscal_period_code"] === "2026-01")).toBe(true);
    });
  });

  // `accountType` is "income", never null: over EVERY account Σ base_balance is zero by the ledger
  // invariant, so a null type would compare 0.0000 with 0.0000 and pass whatever the dataset returned (ADR
  // 0068 rule 1). The ledger side is narrowed by `accountCode` 4000, and the case asserts the fixture's income
  // accounts are exactly {4000}, so the two restrictions name the same set. One `fiscalPeriodId` (amendment
  // A15), run once per period: 2026-01 nets −1000.0000 on 4000, 2026-02 −450.0000.
  it("accounting.period_comparison, run once per period, equals the ledger's own sum for that period", async () => {
    await read(async (tx) => {
      const d = readDefinition("accounting.period_comparison");
      expect(d.parameters.filter((p) => p.kind === "period").map((p) => p.name)).toEqual([
        "fiscalPeriodId",
      ]);
      const expected = new Map([
        [f.s.period, "-1000.0000"],
        [f.s.closedPeriod, "-450.0000"],
      ]);
      for (const [periodId, net] of expected) {
        const params = { companyId: f.s.company, fiscalPeriodId: periodId, accountType: "income" };
        const rows = await runDefinition(tx, d, params);
        expect([...new Set(rows.map((r) => String(r["account_code"])))]).toEqual(["4000"]);
        expect(sum(rows, "base_balance")).toBe(net);
        await assertTieOut(tx, d, {
          params,
          baseCurrency: MYR,
          window: { fiscalPeriodId: periodId, accountCode: "4000" },
        });
      }
    });
  });

  // Not a definition's case: the proof that the harness's three option-gated chains — which Tasks 5–8 build
  // their tie-outs on — post through the real services on this tree and land the arithmetic the harness's
  // doc comments state. A separate tenant, so the four ledger cases above keep their own figures.
  it("the shared fixture's inventory, sales and catalogue chains post and land the stated arithmetic", async () => {
    const g = await reportFixture(db, "Beta", { inventory: true, sales: true, catalogue: true });
    const inv = g.inventory!;
    await withTenant(db.rw, g.s.tenant, g.reader, async (tx) => {
      const docs = await tx<{ id: string; status: string }[]>`
        select id, status::text as status from app.document
         where id = any(${[
           inv.receiptId,
           inv.deliveryId,
           inv.transferId,
           g.sales!.invoiceId,
           g.sales!.creditNoteId,
           g.catalogue!.countDocumentId,
         ]}::uuid[])`;
      expect(docs.map((d) => d.status)).toEqual(Array.from({ length: 6 }, () => "posted"));

      const stock = await tx<{ code: string; quantity: string }[]>`
        select w.code, sum(h.quantity)::numeric(19,6)::text as quantity
          from app.stock_on_hand h join app.warehouse w on w.id = h.warehouse_id
         where h.company_id = ${g.s.company} and h.item_id = ${inv.itemId}
         group by w.code order by w.code`;
      // 40 received − 6 delivered − 4 dispatched = 30 at WH-HQ, counted as 29; 4 in transit at WH-TR.
      expect(stock).toEqual([
        { code: "WH-HQ", quantity: "29.000000" },
        { code: "WH-TR", quantity: "4.000000" },
      ]);

      const balances = await tx<{ code: string; net: string }[]>`
        select a.code, sum(le.base_debit - le.base_credit)::numeric(19,4)::text as net
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.company_id = ${g.s.company}
           and a.code = any(${["1250", "1300", "1310", "5110"]}::text[])
         group by a.code order by a.code`;
      // 1300: 200 − 30 − 20 − 5 (the count's variance); 1310: the dispatch; 5110: the variance. 1250: the
      // delivery's 30 is relieved by the invoice's copied 30, and the partial credit note's one unit puts its
      // 5.0000 cost BACK on 1250 — AGENTS.md's recorded defect ("a partial credit note on delivered goods that
      // are not returned strands its cost in `1250`", an ADR 0044 question). Pinned, not fixed, here.
      expect(balances).toEqual([
        { code: "1250", net: "5.0000" },
        { code: "1300", net: "145.0000" },
        { code: "1310", net: "20.0000" },
        { code: "5110", net: "5.0000" },
      ]);

      const [revenue] = await tx<{ net: string }[]>`
        select sum(le.base_credit - le.base_debit)::numeric(19,4)::text as net
          from app.ledger_entry le join app.account a on a.id = le.account_id
          join app.document d on d.id = le.document_id
          join app.document_type dt on dt.id = d.document_type_id
         where le.company_id = ${g.s.company} and a.code = '4000'
           and dt.code = any(${["SALES_INVOICE", "SALES_CREDIT_NOTE"]}::text[])`;
      expect(revenue!.net).toBe("55.0000"); // 66.0000 invoiced − 11.0000 credited

      const [catalogue] = await tx<{ lines: number; promotions: number }[]>`
        select (select count(*)::int from app.price_list_line where price_list_id = ${g.catalogue!.priceListId}) as lines,
               (select count(*)::int from app.promotion where id = ${g.catalogue!.promotionId}) as promotions`;
      expect(catalogue).toEqual({ lines: 1, promotions: 1 });
    });
  }, 180_000);
});
