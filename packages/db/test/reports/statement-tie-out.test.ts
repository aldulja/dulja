import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  Money,
  currency,
  intlFormatters,
  renderReport,
  statementDefinition,
  statementSectionFor,
  type ReportDefinition,
  type StatementKind,
} from "@dulja/domain";
import { postDocument } from "../../src/posting";
import { ReportError } from "../../src/reports/errors";
import {
  assertDefinitionFields,
  reportDisplayParameters,
  rowsForDefinition,
  statementRows,
} from "../../src/reports/statement";
import { trialBalance } from "../../src/reports/trial-balance";
import { withTenant as withContext } from "../../src/with-tenant";
// §4.17.1's shared helper, reachable here through 3B's amendment A21(c) (Task 5's datasets.test.ts uses it
// the same way). Four dots: this file is packages/db/test/reports/, the target is repo-root tests/.
import { postJournal, type JournalLine } from "../../../../tests/invariants/support/post-journal";
import { grantCodes, seedAccount, seedBranch, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const MYR = currency("MYR");
/** A stored `numeric(19,4)` string as `Money` — exact, never a float (spec:2041). */
const m = (value: string): Money<typeof MYR> => Money.of(value, MYR);
const identity = (code: string) => ({
  code,
  nameEn: code,
  nameAr: code,
  permission: "accounting.report.read",
});
const BS = statementDefinition("balance_sheet", identity("accounting.balance_sheet"));
const PL = statementDefinition("profit_and_loss", identity("accounting.profit_and_loss"));
const BRANCH_PL = statementDefinition(
  "profit_and_loss",
  identity("accounting.branch_profit_and_loss"),
  { perBranch: true },
);

const byAccount = (rows: readonly Record<string, unknown>[]) =>
  rows
    .map((r) => [String(r["account_code"]), String(r["base_balance"])] as const)
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

describe("the statement layouts tie to account_balance to the cent", () => {
  let db: Db;
  let s: Seed;
  let br2: string;

  /** A JOURNAL drafted at `branchId` and posted through the real `postDocument` — `postJournal` always drafts
   *  at `s.hq` (`draftDocument`), and the per-BRANCH read needs a second branch to prove anything. */
  const postAtBranch = async (branchId: string, lines: JournalLine[]): Promise<string> => {
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const id = await uuidv7(db.admin);
    await withContext(db.rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, posting_policy_id, series,
                                          fiscal_period_id, effective_date, currency, branch_id)
               values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, ${s.policy}, 'JV', ${s.period},
                       '2026-01-20', 'MYR', ${branchId})`;
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
                 values (${s.tenant}, ${s.company}, ${id}, ${lineNo}, ${line.account},
                         ${line.debit ?? "0"}, ${line.credit ?? "0"})`;
      }
      await postDocument(tx, ctx, { documentId: id });
    });
    return id;
  };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "statement-tie");
    await grantCodes(db, s, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    const cash = await seedAccount(db, s, { code: "1000", nameEn: "Cash", type: "asset" });
    const payables = await seedAccount(db, s, {
      code: "2100",
      nameEn: "Trade payables",
      type: "liability",
    });
    const capital = await seedAccount(db, s, {
      code: "3000",
      nameEn: "Share capital",
      type: "equity",
    });
    const sales = await seedAccount(db, s, { code: "4000", nameEn: "Sales", type: "income" });
    const cogs = await seedAccount(db, s, {
      code: "5000",
      nameEn: "Cost of goods sold",
      type: "expense",
    });
    br2 = await seedBranch(db, s, { code: "BR2", nameEn: "Second branch" });
    // `postJournal` drafts a JOURNAL and posts it through the real `postDocument` (§4.3.1), so every figure
    // below is one the posting service wrote; nothing in this file writes `ledger_entry` or `account_balance`.
    // Head office: capital in, a sale, cost of goods sold paid out of cash, and a supplier bill.
    const post = (lines: JournalLine[]) => postJournal(db, s, lines);
    await post([
      { account: cash, debit: "4000.0000" },
      { account: capital, credit: "4000.0000" },
    ]);
    await post([
      { account: cash, debit: "6000.0000" },
      { account: sales, credit: "6000.0000" },
    ]);
    await post([
      { account: cogs, debit: "4000.0000" },
      { account: cash, credit: "4000.0000" },
    ]);
    await post([
      { account: cogs, debit: "250.5000" },
      { account: payables, credit: "250.5000" },
    ]);
    // The second branch: one sale and its cost, so the per-BRANCH cut has two values to separate.
    await postAtBranch(br2, [
      { account: cash, debit: "1000.2500" },
      { account: sales, credit: "1000.2500" },
    ]);
    await postAtBranch(br2, [
      { account: cogs, debit: "600.0000" },
      { account: cash, credit: "600.0000" },
    ]);
  });
  afterAll(async () => {
    await db.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, s.tenant, s.human, fn);
  const f = intlFormatters("en", { currency: "MYR" });
  const totalOf = (definition: ReportDefinition, rows: readonly Record<string, unknown>[]) => {
    const r = renderReport(definition, rows as never, { format: "csv", lang: "en", formatters: f });
    return m(
      String(
        r.rows.find((row) => row.kind === "total")!.cells.find((c) => c.field === "base_balance")!
          .raw,
      ),
    );
  };
  it("Σ balance-sheet sections + Σ P&L net = 0, and both come from account_balance", async () => {
    const { bs, pl, tb } = await read(async (tx) => ({
      bs: await statementRows(tx, "balance_sheet", {
        companyId: s.company,
        fiscalPeriodId: s.period,
      }),
      pl: await statementRows(tx, "profit_and_loss", {
        companyId: s.company,
        fiscalPeriodId: s.period,
      }),
      tb: await trialBalance(tx, { companyId: s.company, fiscalPeriodId: s.period, limit: 1000 }),
    }));

    // Σdebit = Σcredit over the whole ledger, so balance-sheet net + P&L net = 0 exactly (spec:2419 test 1).
    expect(totalOf(BS, bs).add(totalOf(PL, pl)).toString()).toBe("0.0000");
    // Sales 7000.2500 against COGS 4850.5000: a 2149.7500 profit, negative under the ledger's sign.
    expect(totalOf(PL, pl).toString()).toBe("-2149.7500");

    // And the statements read the SAME projection 1B's trial balance reads, row for row — never a
    // re-aggregation of ledger_entry, because a report that recomputed would hide the drift the integrity
    // job finds.
    const tbNet = tb.reduce(
      (acc, row) => acc.add(m(row.baseDebit)).subtract(m(row.baseCredit)),
      Money.zero(MYR),
    );
    expect(tbNet.toString()).toBe("0.0000");
    expect(bs.length + pl.length).toBe(tb.length);
    const tbByAccount = tb
      .map(
        (row) =>
          [row.accountCode, m(row.baseDebit).subtract(m(row.baseCredit)).toString()] as const,
      )
      .toSorted((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(byAccount([...bs, ...pl])).toEqual(tbByAccount);
  });

  it("statementRows annotates every row with its section and filters the other statement's types out", async () => {
    const bs = await read((tx) =>
      statementRows(tx, "balance_sheet", { companyId: s.company, fiscalPeriodId: s.period }),
    );
    expect(new Set(bs.map((r) => r["section"]))).toEqual(new Set(["asset", "liability", "equity"]));
    for (const row of bs) {
      expect(statementSectionFor("balance_sheet", String(row["account_type"]))).toBe(
        row["section"],
      );
      // The company-level read is account_balance's shape, with the branch fields present and null.
      expect(row["branch_id"]).toBeNull();
      expect(row["branch_code"]).toBeNull();
    }
  });

  it("the posting service tags every line's BRANCH dimension with its document's branch", async () => {
    // The attribution the per-BRANCH read relies on: `d.branch_id` and the line's BRANCH dimension agree on
    // every posted line, so reading the document join IS reading the mandatory dimension (spec:1066).
    const mismatched = await read(
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n
          from app.ledger_entry l
          join app.document d on d.id = l.document_id
          left join app.ledger_entry_dimension led
                 on led.entry_id = l.id and led.dimension_type_id = ${s.branchType}
         where l.company_id = ${s.company}
           and led.dimension_value_id is distinct from d.branch_id`,
    );
    expect(mismatched[0]!.n).toBe(0);
  });

  it("a branch filter narrows the P&L to that branch's ledger, and the branches sum to the company", async () => {
    const { all, hq, other } = await read(async (tx) => ({
      all: await statementRows(tx, "profit_and_loss", {
        companyId: s.company,
        fiscalPeriodId: s.period,
      }),
      hq: await statementRows(tx, "profit_and_loss", {
        companyId: s.company,
        fiscalPeriodId: s.period,
        branchId: s.hq,
      }),
      other: await statementRows(tx, "profit_and_loss", {
        companyId: s.company,
        fiscalPeriodId: s.period,
        branchId: br2,
      }),
    }));
    expect(byAccount(hq)).toEqual([
      ["4000", "-6000.0000"],
      ["5000", "4250.5000"],
    ]);
    expect(byAccount(other)).toEqual([
      ["4000", "-1000.2500"],
      ["5000", "600.0000"],
    ]);
    expect(new Set(hq.map((r) => r["branch_code"]))).toEqual(new Set(["HQ"]));
    expect(new Set(other.map((r) => r["branch_id"]))).toEqual(new Set([br2]));
    expect(totalOf(BRANCH_PL, hq).add(totalOf(BRANCH_PL, other)).toString()).toBe(
      totalOf(PL, all).toString(),
    );
  });

  it("perBranch with no branchId returns every branch's rows, which sum to account_balance per account", async () => {
    const { perBranch, company } = await read(async (tx) => ({
      perBranch: await statementRows(tx, "balance_sheet", {
        companyId: s.company,
        fiscalPeriodId: s.period,
        perBranch: true,
      }),
      company: await statementRows(tx, "balance_sheet", {
        companyId: s.company,
        fiscalPeriodId: s.period,
      }),
    }));
    expect(new Set(perBranch.map((r) => r["branch_code"]))).toEqual(new Set(["HQ", "BR2"]));
    const summed = new Map<string, Money<typeof MYR>>();
    for (const r of perBranch) {
      const code = String(r["account_code"]);
      summed.set(code, (summed.get(code) ?? Money.zero(MYR)).add(m(String(r["base_balance"]))));
    }
    expect(
      [...summed.entries()]
        .map(([code, v]) => [code, v.toString()] as const)
        .toSorted((a, b) => (a[0] < b[0] ? -1 : 1)),
    ).toEqual(byAccount(company));
  });

  it("rowsForDefinition routes a STATEMENT code to statementRows and every other code to its dataset", async () => {
    const plainDefinition: ReportDefinition = {
      ...BS,
      code: "accounting.trial_balance",
      nameEn: "Trial balance",
      nameAr: "ميزان المراجعة",
      columns: [
        {
          field: "account_code",
          labelEn: "Code",
          labelAr: "الرمز",
          format: "text",
          align: "start",
        },
      ],
      groups: [],
      totals: [],
      sort: [],
      tieOut: { kind: "none" },
    };

    const { statement, plain, branched, oneBranch } = await read(async (tx) => ({
      statement: await rowsForDefinition(tx, BS, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
      }),
      plain: await rowsForDefinition(tx, plainDefinition, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
      }),
      // The per-BRANCH fragment lays out by branch, so its rows carry real branches with or without a filter.
      branched: await rowsForDefinition(tx, BRANCH_PL, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
      }),
      oneBranch: await rowsForDefinition(tx, BRANCH_PL, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period, branchId: br2 },
      }),
    }));

    // The statement path annotates `section`; the plain dataset read cannot, because `account_balance`
    // declares no such column — which is precisely the difference the binding exists to make.
    expect(statement.every((r) => r["section"] !== undefined)).toBe(true);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((r) => r["section"] === undefined)).toBe(true);
    expect(new Set(statement.map((r) => r["section"]))).toEqual(
      new Set(["asset", "liability", "equity"]),
    );
    expect(new Set(branched.map((r) => r["branch_code"]))).toEqual(new Set(["HQ", "BR2"]));
    expect(new Set(oneBranch.map((r) => r["branch_code"]))).toEqual(new Set(["BR2"]));
  });

  // [7 remediation] — a statement printed its sections as raw tokens in alphabetical order and its header as
  // the fiscal period's uuid. The rows now carry the heading in the run's language and the accounting rank,
  // and the header prints the period's `YYYY-MM` code.
  it("labels and orders the sections in the run's language, and the header prints the period's code", async () => {
    const { en, ar, shown, code, foreign } = await read(async (tx) => ({
      en: await rowsForDefinition(tx, BS, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
      }),
      ar: await rowsForDefinition(tx, BS, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
        lang: "ar",
      }),
      shown: await reportDisplayParameters(tx, BS, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period, note: "kept" },
      }),
      code: (
        await tx<{ code: string }[]>`
          select to_char(starts_on, 'YYYY-MM') as code from app.fiscal_period where id = ${s.period}`
      )[0]!.code,
      // A period id the run's company does not hold prints as given — never another company's code.
      foreign: await reportDisplayParameters(tx, BS, {
        companyId: s.company,
        parameters: { fiscalPeriodId: "00000000-0000-7000-8000-000000000000" },
      }),
    }));
    expect(new Set(en.map((r) => r["section_label"]))).toEqual(
      new Set(["Assets", "Liabilities", "Equity"]),
    );
    expect(new Set(ar.map((r) => r["section_label"]))).toEqual(
      new Set(["الأصول", "الالتزامات", "حقوق الملكية"]),
    );
    expect(code).toMatch(/^\d{4}-\d{2}$/);
    expect(shown).toEqual({ fiscalPeriodId: code, note: "kept" });
    expect(foreign).toEqual({ fiscalPeriodId: "00000000-0000-7000-8000-000000000000" });

    // Rendered, in the order the dataset's alphabetical tokens would never give.
    for (const [lang, rows, headings] of [
      ["en", en, ["Assets", "Liabilities", "Equity"]],
      ["ar", ar, ["الأصول", "الالتزامات", "حقوق الملكية"]],
    ] as const) {
      const r = renderReport(BS, rows, {
        format: "csv",
        lang,
        formatters: intlFormatters(lang, { currency: "MYR" }),
        parameters: shown,
        generatedAt: "2026-03-31T00:00:00Z",
      });
      expect(r.rows.filter((row) => row.kind === "subtotal").map((row) => row.label)).toEqual(
        headings,
      );
      expect(r.header, lang).toBe(`${r.title} — ${code}`);
      expect(r.header, lang).not.toContain(s.period);
    }
  });

  it("rowsForDefinition refuses a statement run with no fiscalPeriodId, and statementRows a malformed id", async () => {
    await expect(
      read((tx) => rowsForDefinition(tx, PL, { companyId: s.company, parameters: {} })),
    ).rejects.toThrowError(/requires the parameter 'fiscalPeriodId'/);
    await expect(
      read((tx) =>
        statementRows(tx, "profit_and_loss", {
          companyId: s.company,
          fiscalPeriodId: s.period,
          branchId: "not-a-uuid",
        }),
      ),
    ).rejects.toBeInstanceOf(ReportError);
  });

  it("a statement that would exceed its limit is refused, never returned short", async () => {
    for (const kind of ["balance_sheet", "profit_and_loss"] as StatementKind[]) {
      for (const perBranch of [false, true]) {
        await expect(
          read((tx) =>
            statementRows(tx, kind, {
              companyId: s.company,
              fiscalPeriodId: s.period,
              perBranch,
              limit: 1,
            }),
          ),
          `${kind} ${perBranch}`,
        ).rejects.toThrowError(/is never truncated/);
      }
    }
  });

  it("a DATASET run that would exceed its limit is refused like a statement, never rendered short (7 review)", async () => {
    // The trial balance over `account_balance` has more than one row in this period. Before the fix the plain
    // branch clamped to `limit` and returned a short page whose totals still added up — a partial report that
    // looked complete. Every run now reads one row past its cap and refuses instead.
    const trial: ReportDefinition = {
      ...BS,
      code: "accounting.trial_balance",
      nameEn: "Trial balance",
      nameAr: "ميزان المراجعة",
      columns: [
        {
          field: "account_code",
          labelEn: "Code",
          labelAr: "الرمز",
          format: "text",
          align: "start",
        },
      ],
      groups: [],
      totals: [],
      sort: [{ field: "account_code", dir: "asc" }],
      tieOut: { kind: "none" },
    };
    const all = await read((tx) =>
      rowsForDefinition(tx, trial, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
      }),
    );
    expect(all.length).toBeGreaterThan(1);
    await expect(
      read((tx) =>
        rowsForDefinition(tx, trial, {
          companyId: s.company,
          parameters: { fiscalPeriodId: s.period },
          limit: all.length - 1,
        }),
      ),
    ).rejects.toMatchObject({
      code: "ERR_VALIDATION_FAILED",
      message: expect.stringMatching(/narrow the parameters/),
    });
    // Exactly at the cap is complete, so it is returned whole.
    const exact = await read((tx) =>
      rowsForDefinition(tx, trial, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
        limit: all.length,
      }),
    );
    expect(exact).toEqual(all);
  });

  it("assertDefinitionFields accepts a statement's five extra fields and still refuses a typo", () => {
    // `section` is annotated, not selected; the per-BRANCH variant's `branch_code`/`branch_id` come from the
    // ledger read. Without the union, EVERY statement definition would be unstorable and unseedable.
    expect(() => assertDefinitionFields(BS)).not.toThrow();
    expect(() => assertDefinitionFields(PL)).not.toThrow();
    expect(() => assertDefinitionFields(BRANCH_PL)).not.toThrow();

    // The same three fields on a NON-statement code are still a typo, and are still named in the message.
    const notAStatement = { ...BS, code: "accounting.trial_balance" };
    expect(() => assertDefinitionFields(notAStatement)).toThrowError(/has no such field: section/);
    const typo: ReportDefinition = {
      ...BS,
      columns: [...BS.columns, { ...BS.columns[0], field: "acount_code" }],
    };
    expect(() => assertDefinitionFields(typo)).toThrowError(/has no such field: acount_code/);
    expect(() =>
      assertDefinitionFields({ ...BS, dataset: { source: "nope", filters: [] } }),
    ).toThrow(ReportError);
  });
});
