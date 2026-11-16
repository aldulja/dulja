import type { LegacyPredicate } from "../legacy/predicate";
import type { LegacyReader } from "../reader";
import type { ReconciliationReport } from "./index";

export type EmployeeMatchStatus =
  | "matched_by_account"
  | "matched_by_name"
  | "hr_only"
  | "account_only"
  | "ambiguous_name";

export interface EmployeeMatchStrategy {
  readonly id: "account_column" | "normalised_name";
  readonly derivation: string;
  readonly confidence: "verified" | "hypothesis" | "not_derivable";
}

/**
 * Applied in this order, the first strategy over every HR row before the second over any. Both are `hypothesis`
 * and neither is promoted by this plan: spec §0.4 fixes the *target* ("Employee — a Party of kind employee,
 * optional principal, home branch") and the dossier lists both source tables, but **no shipped file names a link
 * column** between `Salaries.Employees` and an `Accounts` row flagged `IsEmployee`. Assumption 8's rule applies
 * unchanged — the derivation is stated in English on the row, the confidence travels with it, and the owner
 * confirms or corrects it. 9B is what finally maps; a `hypothesis` that survives the owner's review is the input
 * it maps from.
 */
export const EMPLOYEE_MATCH_STRATEGIES: readonly [EmployeeMatchStrategy, EmployeeMatchStrategy] = [
  {
    id: "account_column",
    confidence: "hypothesis",
    derivation:
      "EMPLOYEES.ACCOUNT, when present and neither 0 nor null, is read as ACCOUNTS.ID within the same SITE. The column exists in the shipped schema; that it holds an account id rather than an account code is the hypothesis.",
  },
  {
    id: "normalised_name",
    confidence: "hypothesis",
    derivation:
      "EMPLOYEES.NAME equals ACCOUNTS.NAME after normaliseLegacyName, among accounts flagged IsEmployee. A name is not a key; a match here is evidence, and two HR rows normalising onto one account are reported as ambiguous_name rather than resolved.",
  },
];

const [BY_ACCOUNT, BY_NAME] = EMPLOYEE_MATCH_STRATEGIES;

const ARABIC_FOLD: readonly (readonly [RegExp, string])[] = [
  // harakat (U+064B–U+0652), the superscript alef (U+0670) and the Quranic marks (U+06D6–U+06ED): decorative,
  // inconsistently typed
  [/[ً-ْٰۖ-ۭ]/g, ""],
  // tatweel: a stretching glyph with no phonetic value
  [/ـ/g, ""],
  // آ أ إ ٱ → ا
  [/[آأإٱ]/g, "ا"],
  // ى → ي
  [/ى/g, "ي"],
  // ة → ه
  [/ة/g, "ه"],
  // ؤ → و
  [/ؤ/g, "و"],
];

/**
 * The one place a legacy name is folded, so the rule is testable on its own and identical on both sides of the
 * join. Arabic master data in this source was typed over two decades by many hands: the same person appears as
 * `أحمد` and `احمد`, `فاطمة` and `فاطمه`, with tatweel padding and double spaces. Folding those forms is not a
 * guess about *this* customer's data; not folding them would report every such pair as two unmatched rows and
 * bury the real exceptions. NFC first, so a decomposed hamza composes before the fold sees it. Latin text is
 * upper-cased with the invariant locale so a Turkish `i` cannot change the answer depending on where the
 * extraction runs.
 */
export function normaliseLegacyName(value: string): string {
  let out = value.normalize("NFC");
  for (const [pattern, replacement] of ARABIC_FOLD) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim().toLocaleUpperCase("en-US");
}

interface Employee {
  readonly ref: string;
  readonly name: string;
  /** `SITE|ACCOUNT` as EMPLOYEES declares it, or null for a NULL or `0` ("not set") account. */
  readonly declared: string | null;
}

interface Account {
  readonly ref: string;
  readonly name: string;
  readonly code: string | null;
}

type Flat = Record<string, string | null>;

/**
 * Only the columns the match needs are read — no salary, no national identifier, nothing else an HR row holds —
 * and only the accounts flagged IsEmployee, so the names of customers and suppliers (natural persons too) never
 * leave the legacy database for this report (ADR 0083: an artefact carries customer data, so it carries no more
 * than its question needs).
 */
async function collect(
  reader: LegacyReader,
  table: string,
  columns: string[],
  where?: LegacyPredicate,
): Promise<Flat[]> {
  const out: Flat[] = [];
  for await (const batch of reader.read<Record<string, string | boolean | null>>(table, {
    columns,
    ...(where === undefined ? {} : { where }),
    batch: 500,
  })) {
    for (const row of batch) {
      const flat: Flat = {};
      for (const column of columns) {
        const value = row[column];
        flat[column] = value === null || value === undefined ? null : String(value);
      }
      out.push(flat);
    }
  }
  return out;
}

/**
 * `SITE|ID`, the key form every other reconciliation report writes. Never `SITE/ID`: the owner opens the CSV in
 * Excel (ADR 0083), which reads `1/12` as the twelfth of January.
 */
const refOf = (site: string | null | undefined, id: string | null | undefined): string =>
  [site ?? "", id ?? ""].join("|");

const FLAGGED: LegacyPredicate = { op: "eq", column: "ISEMPLOYEE", value: "1" };

/**
 * §5.1 #12 (spec:2344): "Employees exist twice in the legacy data — Salaries.Employees and Accounts rows
 * flagged IsEmployee. Map both to one party of kind employee plus one employee; **report the rows that do not
 * match rather than guessing**." This function does the reporting half and none of the mapping half.
 *
 * The account column is tried for every HR row before any name is compared, so a declared link is never lost to
 * an earlier row's name match. A declared account named by two HR rows links neither (each falls to the name
 * strategy); a name links only when it is unique on both sides among the rows still open — one HR row, one
 * flagged account — and otherwise every HR row sharing it is `ambiguous_name`, naming every candidate, and no
 * candidate is claimed. Every row carries `declaredAccount`, so an HR row pointing at an account that is not
 * flagged IsEmployee shows the link the owner must judge instead of losing it.
 *
 * A row appears exactly once. The order is: matched pairs in HR-row order, then the HR rows that matched nothing
 * (ambiguous or HR-only, in HR-row order), then the accounts that matched nothing — so the file reads as "these
 * are settled, these two lists are your decisions". Part VII #13 (is the Salaries module live at all?) is
 * answered by Task 13's probe, not here: this report is correct and useful when `EMPLOYEES` is empty or absent,
 * and then every flagged account is `account_only`, which is exactly the picture a customer who never used the
 * Salaries module should see.
 */
export async function employeeMapping(reader: LegacyReader): Promise<ReconciliationReport> {
  const present = new Set(await reader.tables());

  const hr: Employee[] = present.has("EMPLOYEES")
    ? (await collect(reader, "EMPLOYEES", ["SITE", "ID", "NAME", "ACCOUNT"])).map((r) => ({
        ref: refOf(r.SITE, r.ID),
        name: (r.NAME ?? "").trim(),
        declared: r.ACCOUNT === null || r.ACCOUNT === "0" ? null : refOf(r.SITE, r.ACCOUNT),
      }))
    : [];

  const accounts: Account[] = present.has("ACCOUNTS")
    ? (await collect(reader, "ACCOUNTS", ["SITE", "ID", "CODE", "NAME"], FLAGGED)).map((r) => ({
        ref: refOf(r.SITE, r.ID),
        name: (r.NAME ?? "").trim(),
        code: r.CODE ?? null,
      }))
    : [];

  const byRef = new Map(accounts.map((a) => [a.ref, a] as const));
  const declaredBy = new Map<string, number>();
  for (const employee of hr)
    if (employee.declared !== null)
      declaredBy.set(employee.declared, (declaredBy.get(employee.declared) ?? 0) + 1);

  const claimed = new Set<string>();
  const matched = new Map<Employee, { account: Account; strategy: EmployeeMatchStrategy }>();

  // Strategy 1 over every HR row.
  for (const employee of hr) {
    if (employee.declared === null || declaredBy.get(employee.declared) !== 1) continue;
    const account = byRef.get(employee.declared);
    if (account === undefined) continue;
    claimed.add(account.ref);
    matched.set(employee, { account, strategy: BY_ACCOUNT });
  }

  // Strategy 2 over the HR rows still open, against the accounts still open.
  const open = hr.filter((e) => !matched.has(e));
  const hrByName = new Map<string, Employee[]>();
  for (const employee of open) {
    const key = normaliseLegacyName(employee.name);
    hrByName.set(key, [...(hrByName.get(key) ?? []), employee]);
  }
  const accountsByName = new Map<string, Account[]>();
  for (const account of accounts) {
    if (claimed.has(account.ref)) continue;
    const key = normaliseLegacyName(account.name);
    accountsByName.set(key, [...(accountsByName.get(key) ?? []), account]);
  }
  const ambiguous = new Map<Employee, readonly Account[]>();
  for (const [key, employees] of hrByName) {
    const candidates = key === "" ? [] : (accountsByName.get(key) ?? []);
    const [only] = candidates;
    if (employees.length === 1 && candidates.length === 1 && only !== undefined) {
      const [employee] = employees;
      if (employee === undefined) continue;
      claimed.add(only.ref);
      matched.set(employee, { account: only, strategy: BY_NAME });
      continue;
    }
    // Two or more flagged accounts share this name, or two or more HR rows do. Resolving it by picking the
    // lowest id is precisely the "guessing" §5.1 #12 forbids: the file names every candidate and the owner says
    // which is which.
    if (candidates.length > 0)
      for (const employee of employees) ambiguous.set(employee, candidates);
  }

  const rows: Record<string, unknown>[] = [];
  const counters: Record<EmployeeMatchStatus, number> = {
    matched_by_account: 0,
    matched_by_name: 0,
    hr_only: 0,
    account_only: 0,
    ambiguous_name: 0,
  };
  const emit = (
    employee: Employee | null,
    account: { ref: string; code: string | null; name: string } | null,
    status: EmployeeMatchStatus,
    strategy: EmployeeMatchStrategy | null,
  ): void => {
    counters[status] += 1;
    rows.push({
      employeeId: employee?.ref ?? null,
      employeeName: employee?.name ?? null,
      declaredAccount: employee?.declared ?? null,
      accountId: account?.ref ?? null,
      accountCode: account?.code ?? null,
      accountName: account?.name ?? null,
      status,
      strategy: strategy?.id ?? null,
      confidence: strategy?.confidence ?? null,
    });
  };

  for (const employee of hr) {
    const pair = matched.get(employee);
    if (pair === undefined) continue;
    emit(
      employee,
      pair.account,
      pair.strategy.id === "account_column" ? "matched_by_account" : "matched_by_name",
      pair.strategy,
    );
  }
  for (const employee of hr) {
    if (matched.has(employee)) continue;
    const candidates = ambiguous.get(employee);
    if (candidates === undefined) {
      emit(employee, null, "hr_only", null);
      continue;
    }
    emit(
      employee,
      {
        ref: candidates.map((a) => a.ref).join(" "),
        code: candidates.map((a) => a.code ?? "").join(" "),
        name: candidates.map((a) => a.name).join(" | "),
      },
      "ambiguous_name",
      BY_NAME,
    );
  }
  for (const account of accounts) {
    if (!claimed.has(account.ref)) emit(null, account, "account_only", null);
  }

  return {
    kind: "employee_mapping",
    rows,
    summary: {
      hrRows: String(hr.length),
      accountRows: String(accounts.length),
      matchedByAccount: String(counters.matched_by_account),
      matchedByName: String(counters.matched_by_name),
      hrOnly: String(counters.hr_only),
      accountOnly: String(counters.account_only),
      ambiguousNames: String(counters.ambiguous_name),
      note: "Every unmatched row is a decision for the owner: 9B maps a matched pair to one party of kind employee plus one employee, and refuses to guess for the rest (§5.1 #12).",
    },
  };
}
