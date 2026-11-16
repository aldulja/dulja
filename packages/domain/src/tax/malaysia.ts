// packages/domain/src/tax/malaysia.ts
import { currency, type CurrencyCode } from "../money/money";
import {
  buildReturnFrom,
  validateReturnAgainst,
  type JurisdictionPack,
  type RegimeDefinition,
  type TaxTransactionRow,
} from "./jurisdiction";

/**
 * **The only regime definition that ships, and it is deliberately synthetic.**
 *
 * Contracts hazard 1 and §2.6's 5A card forbid a published Malaysian rate, code name, box name, threshold
 * or deadline in any plan, test, fixture, seed file or comment; hazard 2 forbids any LHDN or MyInvois
 * detail until an ADR records it from the authority's own current documentation. Each box's `side` is what its
 * own label already says — "supplies" or "purchases" (MON-04) — not a new fact about any real regime. `SYNTH-MY-v1` is therefore
 * a complete, testable regime whose every literal is invented: five generic boxes, four synthetic code
 * names, and the two rates `0.11000000` and `0.00000000` that `SYNTH-MY-v1.codes.json` ships — an
 * eleven-per-cent figure chosen so it cannot be mistaken for a published one (Global Constraint 15).
 *
 * **OD-15 is the only door the verified definition comes through** (this slice's Task 10, ADR 0049). When it
 * lands, a second `RegimeDefinition` joins `MALAYSIA_REGIMES` and a second pair of files joins
 * `packages/db/seed/my/tax/`. No interface, no signature and no test in this file changes: `buildReturn`
 * matches the tenant's regime row to a definition by `(code, version)` and a tenant on the verified regime
 * simply matches the other entry.
 */
export const SYNTH_MY_V1: RegimeDefinition = {
  code: "SYNTH-MY-v1",
  version: 1,
  jurisdiction: "MY",
  boxes: [
    {
      code: "S1",
      label: "Standard-rated supplies (value)",
      kinds: ["output"],
      measure: "base",
      side: "output",
    },
    {
      code: "S2",
      label: "Tax on standard-rated supplies",
      kinds: ["output"],
      measure: "tax",
      side: "output",
    },
    {
      code: "S3",
      label: "Zero-rated and exempt supplies (value)",
      kinds: ["zero", "exempt"],
      measure: "base",
      side: "output",
    },
    {
      code: "P1",
      label: "Taxable purchases (value)",
      kinds: ["input"],
      measure: "base",
      side: "input",
    },
    {
      code: "P2",
      label: "Tax on taxable purchases",
      kinds: ["input"],
      measure: "tax",
      side: "input",
    },
  ],
};

/** Grown by Task 10 (OD-15) and by nothing else. */
export const MALAYSIA_REGIMES: readonly RegimeDefinition[] = [SYNTH_MY_V1];

/** Every transaction of one return is in the company's base currency (`baseBase` / `taxBase`), so the
 *  currency is one value. **Only the fallback**: `buildReturnFrom` calls this when the caller names no
 *  `currency`, and `generateTaxReturn` always names the company's base currency — an empty quarter of a
 *  company that does not keep MYR books said `"currency":"MYR"` before it did. An empty period with no
 *  named currency still needs one for `Money.zero`, and MYR is the first customer's base (spec:2039's
 *  `Asia/Kuala_Lumpur` company). */
function returnCurrency(rows: readonly TaxTransactionRow[]): CurrencyCode {
  return rows[0]?.baseBase.currency ?? currency("MYR");
}

/** §4.9.1's one v1 pack. The GCC pack is deferred until a customer there exists (D21, spec:2226). */
export const malaysiaPack: JurisdictionPack = {
  jurisdiction: "MY",
  regimes: MALAYSIA_REGIMES,
  buildReturn: (input) => buildReturnFrom(MALAYSIA_REGIMES, input, returnCurrency),
  validateReturn: (payload) => validateReturnAgainst(MALAYSIA_REGIMES, payload),
};
