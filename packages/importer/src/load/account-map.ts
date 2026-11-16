import { readFileSync } from "node:fs";
import { LoadError } from "./types";

/**
 * What the cut-over does with one legacy account (9B plan N6). `balance` opens through the trial-balance opening
 * (Task 5); `ar_control`/`ap_control` are supplied by the open-item load (Task 7) and `inventory_control` by
 * `OPENING_STOCK` (Task 6), so the trial-balance opening leaves them alone; `exclude` is reported and never loaded.
 */
export type AccountTreatment =
  | "balance"
  | "ar_control"
  | "ap_control"
  | "inventory_control"
  | "exclude";

export interface AccountMapEntry {
  /** The legacy chart code (`Accounts.AccCode`) as a string. */
  readonly legacyCode: string;
  /** The Dulja `account.code` (§4.15's format, `ACCOUNT_CODE_PATTERN`). */
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly type: "asset" | "liability" | "equity" | "income" | "expense";
  readonly treatment: AccountTreatment;
  readonly note: string | null;
}

/** The OWNER's mapping from the legacy chart to Dulja's — the input without which a cut-over is a guess. */
export interface AccountMap {
  /** The 9A scope artefact the map was built from, so a reviewer can trace it. */
  readonly generatedFrom: string;
  readonly entries: readonly AccountMapEntry[];
}

/** §4.15, frozen: four digits, the first being the account_type in the enum's own order. */
export const ACCOUNT_CODE_PATTERN = /^[1-5][0-9]{3}$/;

const TYPE_OF_FIRST_DIGIT: Readonly<Record<string, AccountMapEntry["type"]>> = {
  "1": "asset",
  "2": "liability",
  "3": "equity",
  "4": "income",
  "5": "expense",
};

const TREATMENTS: readonly AccountTreatment[] = [
  "balance",
  "ar_control",
  "ap_control",
  "inventory_control",
  "exclude",
];

/** "code 1000 is an asset" / "code 2100 is a liability": a lookup keeps the article right. */
const ARTICLE: Readonly<Record<AccountMapEntry["type"], string>> = {
  asset: "an asset",
  liability: "a liability",
  equity: "an equity account",
  income: "an income account",
  expense: "an expense account",
};

/** Reads and validates the operator-supplied map. Every failure names the file and, where there is one, the offending
 *  legacy code — never a bare `SyntaxError` or `ENOENT`. */
export function readAccountMap(path: string): AccountMap {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${path}: the account map could not be read. It is the OWNER's mapping of the legacy chart onto Dulja's; build it with 9A's scope report and pass it with --account-map`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new LoadError("ERR_VALIDATION_FAILED", `${path}: the account map is not JSON`);
  }
  return assertAccountMap(parsed, path);
}

const textOf = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const nullableText = (value: unknown): string | null => {
  const text = textOf(value);
  return text === "" ? null : text;
};

export function assertAccountMap(value: unknown, site: string): AccountMap {
  const bad = (detail: string): never => {
    throw new LoadError("ERR_VALIDATION_FAILED", `${site}: ${detail}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return bad("the map is not an object");
  const raw = value as Record<string, unknown>;
  const generatedFrom = textOf(raw["generatedFrom"]);
  if (generatedFrom === "")
    return bad("generatedFrom must name the scope artefact the map was built from");
  const items = raw["entries"];
  if (!Array.isArray(items) || items.length === 0)
    return bad("entries is empty; a cut-over with no mapped account has nothing to open");

  const byCode = new Map<string, AccountMapEntry>();
  const seenLegacy = new Set<string>();
  const entries: AccountMapEntry[] = [];

  for (const item of items as unknown[]) {
    if (typeof item !== "object" || item === null) return bad("an entry is not an object");
    const e = item as Record<string, unknown>;
    const legacyCode = textOf(e["legacyCode"]);
    if (legacyCode === "") return bad("an entry has no legacyCode");
    if (seenLegacy.has(legacyCode)) return bad(`legacy account ${legacyCode} appears twice`);
    seenLegacy.add(legacyCode);

    const code = textOf(e["code"]);
    if (!ACCOUNT_CODE_PATTERN.test(code))
      return bad(
        `legacy account ${legacyCode} maps to code ${JSON.stringify(code)}, which is not ^[1-5][0-9]{3}$ (contracts §4.15)`,
      );
    const type = textOf(e["type"]);
    const implied = TYPE_OF_FIRST_DIGIT[code[0]!]!;
    if (type !== implied)
      return bad(
        `legacy account ${legacyCode} maps to ${code} but is typed ${type || "(nothing)"}; code ${code} is ${ARTICLE[implied]}`,
      );
    const treatment = TREATMENTS.find((t) => t === textOf(e["treatment"]));
    if (treatment === undefined)
      return bad(
        `legacy account ${legacyCode} has treatment ${JSON.stringify(textOf(e["treatment"]))}; expected one of ${TREATMENTS.join(", ")}`,
      );
    const nameEn = textOf(e["nameEn"]);
    if (nameEn === "") return bad(`legacy account ${legacyCode} has no nameEn`);

    const entry: AccountMapEntry = {
      legacyCode,
      code,
      nameEn,
      nameAr: nullableText(e["nameAr"]),
      type: implied,
      treatment,
      note: nullableText(e["note"]),
    };
    // Two legacy codes on one Dulja account is normal (a chart split by branch); they must agree on what it is.
    const prior = byCode.get(code);
    if (prior && prior.nameEn !== entry.nameEn)
      return bad(
        `legacy accounts ${prior.legacyCode} and ${legacyCode} both map to ${code} with different names — pick one name, or map them to different codes`,
      );
    if (prior && prior.treatment !== entry.treatment)
      return bad(
        `legacy accounts ${prior.legacyCode} and ${legacyCode} both map to ${code} with different treatments (${prior.treatment}, ${entry.treatment})`,
      );
    byCode.set(code, entry);
    entries.push(entry);
  }

  for (const control of ["ar_control", "ap_control"] as const) {
    const codes = [...new Set(entries.filter((e) => e.treatment === control).map((e) => e.code))];
    if (codes.length === 0)
      return bad(
        `no account is marked ${control}; the open-item load has no control to tie to (contracts §4.8.2)`,
      );
    if (codes.length > 1)
      return bad(
        `${control} is marked on ${codes.toSorted().join(" and ")}; the ageing ties to ONE control account (contracts §4.8.2)`,
      );
  }
  return { generatedFrom, entries };
}

export function treatmentOf(map: AccountMap, legacyCode: string): AccountTreatment | null {
  return map.entries.find((e) => e.legacyCode === legacyCode)?.treatment ?? null;
}
