// packages/domain/src/tax/jurisdiction.ts
import { Money } from "../money/money";
import type { CurrencyCode } from "../money/money";
import { canonicalJson } from "./canonical";
import { TaxError, type TaxCodeDef, type TaxRegime } from "./engine";
import { declaredSideOf, type TaxSide } from "./side";

export interface ReturnBox {
  readonly code: string;
  readonly label: string;
  readonly amount: Money;
}

/** A box's RULE lives in the DEFINITION, not in code: which code kinds feed it, which measure it sums, and
 *  optionally which specific codes. `codes` omitted means "every code of those kinds". A box whose rule is
 *  in TypeScript is SAH-020's hardcoded 0.06 in a different coat. */
export interface ReturnBoxDef {
  readonly code: string;
  readonly label: string;
  readonly kinds: readonly TaxCodeDef["kind"][];
  readonly measure: "base" | "tax";
  readonly codes?: readonly string[];
  /** MON-04 (ADR 0050, 2026-11-15, additive). The side of the return the box is on — supplies (`output`) or
   *  purchases (`input`). Set, the box takes only facts of that side; a zero-rated or exempt code declares no
   *  side, so without it an exempt PURCHASE was summed into a supplies box by its kind alone. Omitted, the box
   *  sums by kind only, as before. */
  readonly side?: TaxSide;
}

/** Amendment A3. A pack is a pure const and `TaxRegime.id` is a per-tenant uuid, so the pack holds
 *  DEFINITIONS keyed `(code, version)` and `buildReturn` matches the tenant's row to one of them. */
export interface RegimeDefinition {
  readonly code: string;
  readonly version: number;
  readonly jurisdiction: "MY";
  readonly boxes: readonly ReturnBoxDef[];
}

/** Amendment A5. `packages/db/src/tax/returns.ts` builds these from the §4.9.2 table. */
export interface TaxTransactionRow {
  readonly documentId: string;
  readonly documentTypeCode: string;
  readonly lineNo: number;
  readonly taxCodeId: string;
  readonly taxCode: string;
  readonly regimeId: string;
  readonly kind: TaxCodeDef["kind"];
  readonly rate: string;
  readonly base: Money;
  readonly tax: Money;
  readonly baseBase: Money;
  readonly taxBase: Money;
  readonly effectiveDate: string;
  readonly postingSeq: string;
  /** MON-04 (ADR 0050, 2026-11-15, additive). The DOCUMENT's tax side (`taxSideOf` its posting policy):
   *  `output` for a sales-side document, `input` for a purchase-side one, `null` when its policy names both
   *  (reverse charge) or neither. Omitted or null, the code's own kind decides, which is right for `output`
   *  and `input` codes and leaves a zero-rated or exempt fact to every box of its kind, as before. */
  readonly side?: TaxSide | null;
}

export interface JurisdictionPack {
  readonly jurisdiction: "MY";
  readonly regimes: readonly RegimeDefinition[];
  /** Deterministic: the same `tax_transaction` rows produce a byte-identical return (test 26).
   *  `currency` is the currency the return is filed in — the company's base currency. Optional (PR 11
   *  review, round 3, additive): when given, every box is in it, an empty period included, and a row whose
   *  base twins are in another currency is refused; when omitted, the pack's own fallback decides. */
  buildReturn(input: {
    regime: TaxRegime;
    periodStart: string;
    periodEnd: string;
    transactions: readonly TaxTransactionRow[];
    currency?: CurrencyCode;
  }): { boxes: ReturnBox[]; payload: string };
  validateReturn(payload: string): { ok: boolean; errors: string[] };
}

const AMOUNT_4DP = /^-?\d+\.\d{4}$/;

/**
 * The shared implementation every jurisdiction pack uses. Exported inside the module only — a pack is the
 * public surface (§4.9.1 names `malaysiaPack`), and a second jurisdiction (GCC, deferred by D21) would call
 * this with its own definitions rather than writing a second summing loop.
 *
 * **The three refusals, all of them SAH-020 or SAH-059:** a regime the pack does not define; a transaction
 * carrying another regime's id; a transaction dated outside the requested period. Every one is a
 * `TaxError("ERR_TAX_REGIME_MISMATCH")` naming the document and line — never a filtered-out row, because a
 * silently dropped transaction is exactly the "valid query with the period filter missing" of SAH-059 in
 * reverse, and the caller's own SQL is what bounds the period (§4.9.2's index).
 *
 * **The currency is the caller's when it names one** (`input.currency`, the company's base currency) and
 * `currencyOf` decides only when it does not. A fourth refusal comes with it: a row whose base twins are in
 * another currency, which would otherwise be summed into — or, on the first row, would choose — the
 * currency of a return the company files in its own.
 */
export function buildReturnFrom(
  definitions: readonly RegimeDefinition[],
  input: {
    regime: TaxRegime;
    periodStart: string;
    periodEnd: string;
    transactions: readonly TaxTransactionRow[];
    currency?: CurrencyCode;
  },
  currencyOf: (rows: readonly TaxTransactionRow[]) => CurrencyCode,
): { boxes: ReturnBox[]; payload: string } {
  const { regime, periodStart, periodEnd, transactions } = input;
  const def = definitions.find((d) => d.code === regime.code && d.version === regime.version);
  if (!def) {
    throw new TaxError(
      "ERR_TAX_REGIME_MISMATCH",
      `this pack has no definition for ${regime.code} v${regime.version} — ` +
        `it defines ${definitions.map((d) => `${d.code} v${d.version}`).join(", ") || "nothing"}`,
    );
  }
  for (const t of transactions) {
    if (t.regimeId !== regime.id) {
      throw new TaxError(
        "ERR_TAX_REGIME_MISMATCH",
        `document ${t.documentId} line ${t.lineNo} carries regime ${t.regimeId}, not ${regime.id}`,
      );
    }
    if (t.effectiveDate < periodStart || t.effectiveDate > periodEnd) {
      throw new TaxError(
        "ERR_TAX_REGIME_MISMATCH",
        `document ${t.documentId} line ${t.lineNo} is dated ${t.effectiveDate}, ` +
          `outside ${periodStart}..${periodEnd}`,
      );
    }
    for (const m of [t.baseBase, t.taxBase]) {
      if (input.currency !== undefined && m.currency !== input.currency) {
        throw new TaxError(
          "ERR_TAX_REGIME_MISMATCH",
          `document ${t.documentId} line ${t.lineNo} is in ${m.currency}, not the return's ${input.currency}`,
        );
      }
    }
  }
  const ccy = input.currency ?? currencyOf(transactions);
  const boxes: ReturnBox[] = def.boxes.map((b) => {
    let sum = Money.zero(ccy);
    for (const t of transactions) {
      if (!b.kinds.includes(t.kind)) continue;
      if (b.codes && !b.codes.includes(t.taxCode)) continue;
      const side = t.side ?? declaredSideOf(t.kind);
      if (b.side !== undefined && side !== null && side !== b.side) continue;
      // The BASE-currency measure is what a return is filed in: baseBase / taxBase, never the document
      // currency's base / tax, which would add MYR to EUR (spec:2041 makes that a compile error anyway).
      sum = sum.add(b.measure === "base" ? t.baseBase : t.taxBase);
    }
    return { code: b.code, label: b.label, amount: sum };
  });
  const payload = canonicalJson({
    regimeCode: regime.code,
    regimeVersion: regime.version,
    jurisdiction: def.jurisdiction,
    periodStart,
    periodEnd,
    currency: ccy,
    boxes: boxes.map((b) => ({ code: b.code, label: b.label, amount: b.amount.toString() })),
  });
  return { boxes, payload };
}

/** The other half: re-parse a payload and check it against the definitions. Returns a REPORT rather than
 *  throwing, because the caller names every fault at once (the `validatePolicy` shape of §4.4.2). */
export function validateReturnAgainst(
  definitions: readonly RegimeDefinition[],
  payload: string,
): { ok: boolean; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (e) {
    return { ok: false, errors: [`payload is not JSON: ${String(e)}`] };
  }
  const p = parsed as {
    regimeCode?: unknown;
    regimeVersion?: unknown;
    periodStart?: unknown;
    periodEnd?: unknown;
    currency?: unknown;
    boxes?: unknown;
  };
  const errors: string[] = [];
  if (typeof p.regimeCode !== "string") errors.push("regimeCode is missing");
  if (typeof p.regimeVersion !== "number") errors.push("regimeVersion is missing");
  for (const k of ["periodStart", "periodEnd", "currency"] as const) {
    if (typeof p[k] !== "string") errors.push(`${k} is missing`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const def = definitions.find((d) => d.code === p.regimeCode && d.version === p.regimeVersion);
  if (!def)
    return {
      ok: false,
      errors: [`no definition for ${String(p.regimeCode)} v${String(p.regimeVersion)}`],
    };
  if (!Array.isArray(p.boxes)) return { ok: false, errors: ["boxes is not an array"] };
  const seen = new Map(
    (p.boxes as { code?: unknown; amount?: unknown }[]).map((b) => [String(b.code), b] as const),
  );
  for (const b of def.boxes) {
    const got = seen.get(b.code);
    if (!got) {
      errors.push(`box ${b.code} is missing`);
      continue;
    }
    if (typeof got.amount !== "string" || !AMOUNT_4DP.test(got.amount)) {
      errors.push(`box ${b.code} amount ${JSON.stringify(got.amount)} is not a 4-dp figure`);
    }
  }
  for (const code of seen.keys()) {
    if (!def.boxes.some((b) => b.code === code))
      errors.push(`box ${code} is not in ${def.code} v${def.version}`);
  }
  return { ok: errors.length === 0, errors };
}
