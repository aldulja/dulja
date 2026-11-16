import {
  moduleOfReportCode,
  type ReportLang,
  type ReportOrientation,
  type ReportPaper,
} from "./codes";
import type { ReportDefinition } from "./definition";

export type StatementKind = "profit_and_loss" | "balance_sheet";
export type StatementSection =
  | "revenue"
  | "expense"
  | "net_result" // profit_and_loss
  | "asset"
  | "liability"
  | "equity"; // balance_sheet

/**
 * `app.account_type` → the statement section. Total over the five enum labels migration 0001 defines
 * (`asset`, `liability`, `equity`, `income`, `expense` — 0001_foundations.sql:307; no later migration adds
 * one). `null` means "this label belongs to the other statement", which is what lets one classifier drive
 * both — and it is also the answer for a label that is not one of the five, so an unknown type is left out
 * of both statements rather than silently filed under one of them.
 */
export function statementSectionFor(
  kind: StatementKind,
  accountType: string,
): StatementSection | null {
  if (kind === "profit_and_loss") {
    return accountType === "income" ? "revenue" : accountType === "expense" ? "expense" : null;
  }
  return accountType === "asset"
    ? "asset"
    : accountType === "liability"
      ? "liability"
      : accountType === "equity"
        ? "equity"
        : null;
}

/** The bilingual section headings. `net_result` is the P&L's grand-total label. The `section` field carries the
 *  raw token (`asset`, …) for a CSV reader and a tie-out; what a statement PRINTS is `section_label`, the
 *  heading in the run's language (`statementSectionFields`). */
export const STATEMENT_SECTION_LABELS: Readonly<
  Record<StatementSection, { en: string; ar: string }>
> = {
  revenue: { en: "Revenue", ar: "الإيرادات" },
  expense: { en: "Expenses", ar: "المصروفات" },
  net_result: { en: "Net result", ar: "النتيجة الصافية" },
  asset: { en: "Assets", ar: "الأصول" },
  liability: { en: "Liabilities", ar: "الالتزامات" },
  equity: { en: "Equity", ar: "حقوق الملكية" },
};

/** Accounting order within each statement — never the tokens' alphabetical order, which would print equity
 *  before liability and expense before revenue. A statement sorts on this (`section_rank`). */
export const STATEMENT_SECTION_RANK: Readonly<Record<StatementSection, number>> = {
  asset: 0,
  liability: 1,
  equity: 2,
  revenue: 0,
  expense: 1,
  net_result: 2,
};

/** The three section fields a statement row carries, or null when `accountType` belongs to the other
 *  statement. `statementRows` annotates every row with these, so the classification, its order and its
 *  printed heading come from this one function. `lang` picks the heading; the token and rank never vary. */
export function statementSectionFields(
  kind: StatementKind,
  accountType: string,
  lang: ReportLang,
): { section: StatementSection; section_rank: number; section_label: string } | null {
  const section = statementSectionFor(kind, accountType);
  if (section === null) return null;
  const label = STATEMENT_SECTION_LABELS[section];
  return {
    section,
    section_rank: STATEMENT_SECTION_RANK[section],
    section_label: lang === "ar" ? label.ar : label.en,
  };
}

export interface StatementLayoutOptions {
  /** true adds the BRANCH group above the section group (spec:1066 — BRANCH is the mandatory dimension). */
  perBranch?: boolean;
  paper?: ReportPaper;
  orientation?: ReportOrientation;
}

export interface StatementLayout {
  columns: ReportDefinition["columns"];
  groups: ReportDefinition["groups"];
  totals: ReportDefinition["totals"];
  sort: ReportDefinition["sort"];
  layout: ReportDefinition["layout"];
  parameters: ReportDefinition["parameters"];
  dataset: ReportDefinition["dataset"];
  tieOut: ReportDefinition["tieOut"];
}

type StatementColumn = ReportDefinition["columns"][number];

/**
 * The four columns both statements share (`SECTION_COLUMN` and `ACCOUNT_COLUMNS`). The section column prints
 * `section_label`, the heading in the run's language, never the raw token. `base_balance` is
 * `base_debit − base_credit` as `account_balance` stores it (§4.3.3), so a liability, equity and revenue
 * line carries a NEGATIVE figure. The sign is the
 * ledger's; a statement never flips it, because a flipped sign in a report is how a reader loses the ability
 * to add two reports together (spec:2041).
 */
const SECTION_COLUMN: StatementColumn = {
  field: "section_label",
  labelEn: "Section",
  labelAr: "القسم",
  format: "text",
  align: "start",
  width: 120,
};
const ACCOUNT_COLUMNS: readonly StatementColumn[] = [
  {
    field: "account_code",
    labelEn: "Code",
    labelAr: "الرمز",
    format: "text",
    align: "start",
    width: 80,
  },
  { field: "account_name_en", labelEn: "Name", labelAr: "الاسم", format: "text", align: "start" },
  {
    field: "base_balance",
    labelEn: "Balance",
    labelAr: "الرصيد",
    format: "money",
    align: "end",
    width: 120,
  },
];

const BRANCH_COLUMN: StatementColumn = {
  field: "branch_code",
  labelEn: "Branch",
  labelAr: "الفرع",
  format: "text",
  align: "start",
  width: 100,
};

const copy = (c: StatementColumn): StatementColumn => ({ ...c });

function build(opts: StatementLayoutOptions): StatementLayout {
  const perBranch = opts.perBranch === true;
  const columns: ReportDefinition["columns"] = perBranch
    ? [copy(BRANCH_COLUMN), copy(SECTION_COLUMN), ...ACCOUNT_COLUMNS.map(copy)]
    : [copy(SECTION_COLUMN), ...ACCOUNT_COLUMNS.map(copy)];
  // The section group partitions on its printed heading, so a subtotal reads "Subtotal Assets" /
  // "مجموع الأصول": one heading per token in either language, so the partition is the token's.
  const groups: ReportDefinition["groups"] = perBranch
    ? [
        { field: "branch_code", subtotal: true },
        { field: "section_label", subtotal: true },
      ]
    : [{ field: "section_label", subtotal: true }];
  const parameters: ReportDefinition["parameters"] = [
    { name: "fiscalPeriodId", kind: "period", required: true },
    ...(perBranch ? [{ name: "branchId", kind: "branch" as const, required: false }] : []),
  ];
  const filters: ReportDefinition["dataset"]["filters"] = [
    { field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" },
    ...(perBranch ? [{ field: "branch_id", op: "eq" as const, param: "branchId" }] : []),
  ];
  return {
    columns,
    groups,
    totals: [{ field: "base_balance", fn: "sum" }],
    // Accounting order (STATEMENT_SECTION_RANK), and per BRANCH the branches in code order first, so the
    // branch groups do not fall in whichever order a branch's first section happened to sort.
    sort: [
      ...(perBranch ? [{ field: "branch_code", dir: "asc" as const }] : []),
      { field: "section_rank", dir: "asc" },
      { field: "account_code", dir: "asc" },
    ],
    parameters,
    dataset: { source: "account_balance", filters },
    layout: {
      orientation: opts.orientation ?? (perBranch ? "landscape" : "portrait"),
      paper: opts.paper ?? "A4",
      header: "{title} — {fiscalPeriodId}",
      footer: "{rowCount} accounts · {generatedAt}",
    },
    // Both statements are read from `account_balance`, which the posting service MERGEs in the same
    // transaction as the ledger (§4.3.3, D14), so `ledger_sum` is the tie-out kind: the statement's grand
    // total is compared with the ledger's own sum, not one account code.
    tieOut: { kind: "ledger_sum" },
  };
}

/** The frozen pair. 7B builds `accounting.profit_and_loss` and `accounting.balance_sheet` from these and
 *  7C builds `accounting.branch_profit_and_loss` from `statementLayout("profit_and_loss", { perBranch: true })`.
 *  The two kinds share one fragment shape; what tells them apart is the rows `statementRows` hands them. */
export const STATEMENT_LAYOUTS: Readonly<Record<StatementKind, StatementLayout>> = {
  profit_and_loss: build({}),
  balance_sheet: build({}),
};

/** A fresh fragment for `kind` — never a shared reference, so a caller may extend its copy freely. */
export function statementLayout(
  _kind: StatementKind,
  opts: StatementLayoutOptions = {},
): StatementLayout {
  return build(opts);
}

/** Composes a layout with the identity a code carries. 7B calls this in its seed-file generator. The module
 *  is the code's own first segment (§4.16.1), so a code outside the grammar is refused here. */
export function statementDefinition(
  kind: StatementKind,
  identity: { code: string; nameEn: string; nameAr: string; permission: string },
  opts: StatementLayoutOptions = {},
): ReportDefinition {
  return {
    version: 1,
    code: identity.code,
    nameEn: identity.nameEn,
    nameAr: identity.nameAr,
    module: moduleOfReportCode(identity.code),
    permission: identity.permission,
    ...statementLayout(kind, opts),
  };
}

/**
 * The three §4.16.1 codes whose definitions are STATEMENTS, and which statement each is. This map is the one
 * binding that tells the run path, the definition store and the seed loader that a definition's rows come
 * from `statementRows` rather than from a plain `datasetFor(source).run(...)`.
 *
 * It is not a fourth register: every key is a row §4.16.1 already carries — `accounting.profit_and_loss` and
 * `accounting.balance_sheet` (7B's definitions, 7A's layouts) and `accounting.branch_profit_and_loss` (7C's).
 * 7A seeds none of the three; it ships the layouts and this binding.
 */
export const STATEMENT_CODES: Readonly<Record<string, StatementKind>> = {
  "accounting.profit_and_loss": "profit_and_loss",
  "accounting.balance_sheet": "balance_sheet",
  "accounting.branch_profit_and_loss": "profit_and_loss",
};

/** `null` for every code that is not one of the three, so a caller never indexes the map and gets an
 *  `undefined` typed as `StatementKind`. Same total-function shape as `statementSectionFor`. */
export function statementKindFor(code: string): StatementKind | null {
  return Object.hasOwn(STATEMENT_CODES, code) ? (STATEMENT_CODES[code] ?? null) : null;
}

/**
 * The five fields a statement's ROWS carry that its dataset's declared `DatasetColumn` list does not.
 *
 * - `section`, `section_rank` and `section_label` are annotated in TypeScript by `statementRows` from
 *   `statementSectionFields`, deliberately rather than as a SQL `case` over `ac.type`, so the classification,
 *   its accounting order and its bilingual heading live in one function.
 * - `branch_code` / `branch_id` exist because `account_balance`'s key is
 *   `(company_id, account_id, fiscal_period_id, currency)` and carries **no branch** (§4.3.3): the
 *   per-BRANCH statement of spec:1066 is served by `statementRows` reading the ledger — whose branch is the
 *   posting document's `branch_id`, the value the posting service also writes as every line's BRANCH
 *   dimension — and collapsing it to the `account_balance` row shape. The definition's `dataset.source`
 *   therefore names the row SHAPE both paths produce, and `rowsForDefinition` is what picks the query.
 *
 * `assertDefinitionFields` unions these into the known set **only** for a `STATEMENT_CODES` key, so a typo in
 * any other definition is still refused with the field's name.
 */
export const STATEMENT_EXTRA_FIELDS = [
  "section",
  "section_rank",
  "section_label",
  "branch_code",
  "branch_id",
] as const;
