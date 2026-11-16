import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STATEMENT_CODES,
  STATEMENT_EXTRA_FIELDS,
  STATEMENT_LAYOUTS,
  STATEMENT_SECTION_LABELS,
  STATEMENT_SECTION_RANK,
  intlFormatters,
  renderReport,
  statementDefinition,
  statementKindFor,
  statementLayout,
  statementSectionFields,
  statementSectionFor,
  validateReportDefinition,
  type RenderedReport,
  type ReportSourceRow,
  type StatementKind,
} from "../../src/reports";

const rows = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixture/statement-rows.json", import.meta.url)), "utf8"),
) as ReportSourceRow[];

const SETS = {
  datasets: new Set(["account_balance", "ledger_entry"]),
  permissions: new Set(["accounting.report.read"]),
};
const PL = {
  code: "accounting.profit_and_loss",
  nameEn: "Profit and loss",
  nameAr: "الأرباح والخسائر",
  permission: "accounting.report.read",
};
const BS = {
  code: "accounting.balance_sheet",
  nameEn: "Balance sheet",
  nameAr: "الميزانية العمومية",
  permission: "accounting.report.read",
};
const AT = "2026-03-31T08:00:00Z";

const totalOf = (r: RenderedReport): Decimal =>
  new Decimal(
    String(
      r.rows.find((row) => row.kind === "total")!.cells.find((c) => c.field === "base_balance")!
        .raw,
    ),
  );
const subtotalOf = (r: RenderedReport, label: string, level = 1): Decimal =>
  new Decimal(
    String(
      r.rows
        .find((row) => row.kind === "subtotal" && row.level === level && row.label === label)!
        .cells.find((c) => c.field === "base_balance")!.raw,
    ),
  );

/** The sections of `types`, in `section_rank` order. */
const rankOrder = (kind: StatementKind, types: string[]) =>
  types
    .map((t) => statementSectionFields(kind, t, "en")!)
    .toSorted((a, b) => a.section_rank - b.section_rank)
    .map((f) => f.section);
/** A rendered statement's subtotal headings, in print order. */
const subtotalHeadings = (r: RenderedReport) =>
  r.rows.filter((row) => row.kind === "subtotal").map((row) => row.label);

describe("statementSectionFor — a total function over the five account_type labels", () => {
  it("maps every label for both statements, and null where a label does not belong", () => {
    expect(statementSectionFor("profit_and_loss", "income")).toBe("revenue");
    expect(statementSectionFor("profit_and_loss", "expense")).toBe("expense");
    for (const t of ["asset", "liability", "equity"]) {
      expect(statementSectionFor("profit_and_loss", t), t).toBeNull();
    }
    expect(statementSectionFor("balance_sheet", "asset")).toBe("asset");
    expect(statementSectionFor("balance_sheet", "liability")).toBe("liability");
    expect(statementSectionFor("balance_sheet", "equity")).toBe("equity");
    for (const t of ["income", "expense"]) {
      expect(statementSectionFor("balance_sheet", t), t).toBeNull();
    }
  });

  it("files a label outside the enum under neither statement", () => {
    for (const kind of ["profit_and_loss", "balance_sheet"] as const) {
      expect(statementSectionFor(kind, "revenue"), kind).toBeNull();
      expect(statementSectionFor(kind, ""), kind).toBeNull();
    }
  });

  it("every section the classifier can return has an English and an Arabic heading", () => {
    for (const kind of ["profit_and_loss", "balance_sheet"] as const) {
      for (const t of ["asset", "liability", "equity", "income", "expense"]) {
        const section = statementSectionFor(kind, t);
        if (section === null) continue;
        expect(STATEMENT_SECTION_LABELS[section].en.length, section).toBeGreaterThan(0);
        expect(STATEMENT_SECTION_LABELS[section].ar.length, section).toBeGreaterThan(0);
      }
    }
  });

  // [7 remediation] — the sections printed alphabetically by token (asset, equity, liability; expense before
  // revenue) and as the raw token. The rank is accounting order and the label is the heading.
  it("ranks the sections in accounting order and labels them in the run's language", () => {
    expect(rankOrder("balance_sheet", ["equity", "asset", "liability"])).toEqual([
      "asset",
      "liability",
      "equity",
    ]);
    expect(rankOrder("profit_and_loss", ["expense", "income"])).toEqual(["revenue", "expense"]);
    expect(statementSectionFields("balance_sheet", "liability", "en")).toEqual({
      section: "liability",
      section_rank: STATEMENT_SECTION_RANK.liability,
      section_label: "Liabilities",
    });
    expect(statementSectionFields("profit_and_loss", "income", "ar")).toEqual({
      section: "revenue",
      section_rank: 0,
      section_label: "الإيرادات",
    });
    expect(statementSectionFields("profit_and_loss", "asset", "en")).toBeNull();
  });
});

describe("STATEMENT_LAYOUTS", () => {
  it("both layouts, plain and per BRANCH, produce a definition validateReportDefinition accepts", () => {
    for (const [kind, identity] of [
      ["profit_and_loss", PL],
      ["balance_sheet", BS],
    ] as const) {
      for (const perBranch of [false, true]) {
        const def = statementDefinition(kind, identity, { perBranch });
        expect(validateReportDefinition(def, SETS), `${kind} ${perBranch}`).toEqual({
          ok: true,
          errors: [],
        });
      }
    }
  });

  it("reads account_balance — the synchronous projection — and declares its tie-out", () => {
    expect(STATEMENT_LAYOUTS.balance_sheet.dataset.source).toBe("account_balance");
    expect(STATEMENT_LAYOUTS.profit_and_loss.dataset.source).toBe("account_balance");
    expect(STATEMENT_LAYOUTS.balance_sheet.tieOut).toEqual({ kind: "ledger_sum" });
    expect(STATEMENT_LAYOUTS.profit_and_loss.tieOut).toEqual({ kind: "ledger_sum" });
  });

  it("perBranch adds the BRANCH group ABOVE the section group and a branchId parameter (spec:1066)", () => {
    const plain = statementLayout("profit_and_loss");
    expect(plain.groups.map((g) => g.field)).toEqual(["section_label"]);
    expect(plain.sort.map((k) => k.field)).toEqual(["section_rank", "account_code"]);
    expect(plain.parameters.map((p) => p.name)).toEqual(["fiscalPeriodId"]);
    expect(plain.columns.map((c) => c.field)).toEqual([
      "section_label",
      "account_code",
      "account_name_en",
      "base_balance",
    ]);
    expect(plain.layout.orientation).toBe("portrait");

    const branched = statementLayout("profit_and_loss", { perBranch: true });
    expect(branched.groups.map((g) => g.field)).toEqual(["branch_code", "section_label"]);
    expect(branched.sort.map((k) => k.field)).toEqual([
      "branch_code",
      "section_rank",
      "account_code",
    ]);
    expect(branched.parameters.map((p) => p.name)).toEqual(["fiscalPeriodId", "branchId"]);
    expect(branched.parameters[1]).toEqual({ name: "branchId", kind: "branch", required: false });
    expect(branched.dataset.filters.map((f) => f.param)).toEqual(["fiscalPeriodId", "branchId"]);
    expect(branched.columns[0]!.field).toBe("branch_code");
    expect(branched.layout.orientation).toBe("landscape"); // a branch column needs the width
  });

  it("paper and orientation options override the defaults", () => {
    const l = statementLayout("balance_sheet", { paper: "A5", orientation: "landscape" });
    expect(l.layout.paper).toBe("A5");
    expect(l.layout.orientation).toBe("landscape");
    expect(statementLayout("balance_sheet").layout.paper).toBe("A4");
  });

  it("the layout is a fragment pair, not a definition: it carries no code, name or module", () => {
    // §4.16.1 splits the ownership — the LAYOUT is 7A's, the DEFINITION is 7B's — and this assertion is what
    // stops 7A from seeding a report by accident.
    expect(Object.keys(STATEMENT_LAYOUTS.balance_sheet).toSorted()).toEqual([
      "columns",
      "dataset",
      "groups",
      "layout",
      "parameters",
      "sort",
      "tieOut",
      "totals",
    ]);
  });

  it("statementLayout returns a fresh copy, so a caller cannot mutate the frozen pair", () => {
    const copy = statementLayout("balance_sheet");
    copy.columns[0]!.labelEn = "Changed";
    copy.groups.push({ field: "account_code", subtotal: false });
    expect(STATEMENT_LAYOUTS.balance_sheet.columns[0]!.labelEn).toBe("Section");
    expect(STATEMENT_LAYOUTS.balance_sheet.groups).toHaveLength(1);
    expect(statementLayout("balance_sheet")).toEqual(STATEMENT_LAYOUTS.balance_sheet);
  });

  it("statementDefinition takes the module from the code and refuses a code outside the grammar", () => {
    expect(statementDefinition("balance_sheet", BS).module).toBe("accounting");
    expect(() => statementDefinition("balance_sheet", { ...BS, code: "balance_sheet" })).toThrow();
  });
});

describe("STATEMENT_CODES — the run path's statement binding", () => {
  it("carries exactly §4.16.1's three statement codes and maps each to its kind", () => {
    expect(Object.keys(STATEMENT_CODES).toSorted()).toEqual([
      "accounting.balance_sheet",
      "accounting.branch_profit_and_loss",
      "accounting.profit_and_loss",
    ]);
    expect(statementKindFor("accounting.balance_sheet")).toBe("balance_sheet");
    expect(statementKindFor("accounting.profit_and_loss")).toBe("profit_and_loss");
    expect(statementKindFor("accounting.branch_profit_and_loss")).toBe("profit_and_loss");
  });

  it("returns null for every other code, so a plain report never takes the statement path", () => {
    for (const code of [
      "accounting.trial_balance",
      "accounting.ledger",
      "inventory.stock_on_hand",
      "pos.z_report",
      "constructor",
      "toString",
    ]) {
      expect(statementKindFor(code), code).toBeNull();
    }
  });

  it("every key is a §4.16.1 accounting row, and the extras are the five annotated fields", () => {
    // Naming three of §4.16.1's own rows is not seeding them: 7A ships the layouts and this binding, 7B ships
    // the two `accounting.*` definitions and 7C the branch one.
    expect([...STATEMENT_EXTRA_FIELDS]).toEqual([
      "section",
      "section_rank",
      "section_label",
      "branch_code",
      "branch_id",
    ]);
    for (const code of Object.keys(STATEMENT_CODES)) {
      expect(code.startsWith("accounting."), code).toBe(true);
    }
  });
});

describe("the rendered statements", () => {
  const f = intlFormatters("en", { currency: "MYR" });
  // The rows as `statementRows` hands them over: annotated by `statementSectionFields` in the run's language.
  const sourceFor = (kind: StatementKind, lang: "en" | "ar" = "en"): ReportSourceRow[] =>
    rows.flatMap((r) => {
      const fields = statementSectionFields(kind, String(r["account_type"]), lang);
      return fields === null ? [] : [{ ...r, ...fields }];
    });
  const render = (kind: StatementKind, identity: typeof PL, perBranch = false) =>
    renderReport(statementDefinition(kind, identity, { perBranch }), sourceFor(kind), {
      format: "csv",
      lang: "en",
      formatters: f,
      generatedAt: AT,
    });

  it("the balance sheet balances once the period result is folded in: balance-sheet net + P&L net = 0", () => {
    const bs = render("balance_sheet", BS);
    const pl = render("profit_and_loss", PL);
    // account_balance stores debit and credit; base_balance is debit − credit, so a liability, an equity and
    // a revenue line carries a NEGATIVE figure (spec:2041 — the sign is the ledger's, never flipped in a
    // report). The fixture is a PRE-CLOSING trial balance: Σ over ALL six rows is 0, and the three
    // balance-sheet sections alone therefore sum to +2000.0000 — exactly the negation of the P&L's
    // −2000.0000 — because the period result has not yet been closed into an equity account.
    expect(totalOf(bs).plus(totalOf(pl)).toFixed(4)).toBe("0.0000");
    expect(totalOf(bs).toFixed(4)).toBe("2000.0000");
    expect(subtotalOf(bs, "Assets").toFixed(4)).toBe("8000.0000");
    expect(subtotalOf(bs, "Liabilities").plus(subtotalOf(bs, "Equity")).toFixed(4)).toBe(
      "-6000.0000",
    );
  });

  it("the P&L nets revenue against expense: income − expense = the grand total", () => {
    const r = render("profit_and_loss", PL);
    // revenue −6000 (credit) + expense +4000 (debit) = −2000, i.e. a 2000 profit under the ledger's sign.
    expect(totalOf(r).toFixed(4)).toBe("-2000.0000");
    expect(subtotalOf(r, "Revenue").toFixed(4)).toBe("-6000.0000");
    expect(subtotalOf(r, "Expenses").toFixed(4)).toBe("4000.0000");
    expect(r.rowCount).toBe(2);
  });

  it("prints the sections in accounting order, by heading, whatever order the rows arrive in", () => {
    const shuffled = (kind: StatementKind) => sourceFor(kind).toReversed();
    const opts = { format: "csv" as const, lang: "en" as const, formatters: f, generatedAt: AT };
    const bs = renderReport(
      statementDefinition("balance_sheet", BS),
      shuffled("balance_sheet"),
      opts,
    );
    expect(subtotalHeadings(bs)).toEqual(["Assets", "Liabilities", "Equity"]);
    expect(bs.rows.find((row) => row.kind === "subtotal")!.cells[0]!.text).toBe("Subtotal Assets");
    const pl = renderReport(
      statementDefinition("profit_and_loss", PL),
      shuffled("profit_and_loss"),
      opts,
    );
    expect(subtotalHeadings(pl)).toEqual(["Revenue", "Expenses"]);
    // The data rows print the heading, never the token.
    expect(
      bs.rows.filter((row) => row.kind === "data").map((row) => row.cells[0]!.text),
    ).not.toContain("asset");
  });

  it("per BRANCH, each branch subtotal covers its sections and the grand total is unchanged", () => {
    const two = [
      ...sourceFor("profit_and_loss"),
      {
        ...statementSectionFields("profit_and_loss", "income", "en"),
        account_type: "income",
        account_code: "4000",
        account_name_en: "Sales",
        base_balance: "-500.0000",
        branch_code: "BR2",
        currency: "MYR",
      },
    ];
    const r = renderReport(statementDefinition("profit_and_loss", PL, { perBranch: true }), two, {
      format: "csv",
      lang: "en",
      formatters: f,
      generatedAt: AT,
    });
    expect(subtotalOf(r, "HQ").toFixed(4)).toBe("-2000.0000");
    expect(subtotalOf(r, "BR2").toFixed(4)).toBe("-500.0000");
    expect(totalOf(r).toFixed(4)).toBe("-2500.0000");
    // The inner level is the section within each branch.
    const inner = r.rows.filter((row) => row.kind === "subtotal" && row.level === 2);
    // Branches in code order (BR2 before HQ), and within each, revenue before expense.
    expect(r.rows.filter((row) => row.level === 1).map((row) => row.label)).toEqual(["BR2", "HQ"]);
    expect(inner.map((row) => row.label)).toEqual(["Revenue", "Revenue", "Expenses"]);
  });

  it("renders in Arabic with the Arabic labels and dir rtl", () => {
    const r = renderReport(
      statementDefinition("balance_sheet", BS),
      sourceFor("balance_sheet", "ar"),
      {
        format: "pdf",
        lang: "ar",
        formatters: intlFormatters("ar", { currency: "MYR" }),
        generatedAt: AT,
      },
    );
    expect(r.dir).toBe("rtl");
    expect(r.title).toBe("الميزانية العمومية");
    expect(r.columns.map((c) => c.label)).toEqual(["القسم", "الرمز", "الاسم", "الرصيد"]);
    expect(r.rows.filter((row) => row.kind === "subtotal").map((row) => row.label)).toEqual([
      "الأصول",
      "الالتزامات",
      "حقوق الملكية",
    ]);
  });
});
