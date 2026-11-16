import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { currency, Money, type CurrencyCode } from "../../src";
import { balanceInBase, evaluatePolicy, parsePolicy, type LineSnapshot } from "../../src/posting";

const MYR = currency("MYR");
const FOREIGN = currency("USD");
const POLICY = parsePolicy(
  (
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./journal-envelope.fixture.json", import.meta.url)),
        "utf8",
      ),
    ) as { policy: unknown }
  ).policy,
);

/** A pair of amounts that sum equal in the DOCUMENT currency: n debits and m credits with the same total.
 *  After per-line base rounding they need not sum equal in BASE — which is exactly the residue balanceInBase
 *  is for (spec:1868). The property is that after balanceInBase the base sums are always equal or the call
 *  threw, and that it never invents more than one fx_rounding line. */
describe("balanceInBase — property (spec:1868, contracts §5 item 23)", () => {
  it("either balances in base with at most one fx_rounding line, or refuses", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 12 }),
        fc.integer({ min: 100_000_000, max: 9_999_999_999 }), // rate at 8 dp, 1.00000000 … 99.99999999
        (parts, rateScaled) => {
          const total = parts.reduce((left, right) => left + right, 0);
          const rate = {
            from: FOREIGN,
            to: MYR,
            rate: (rateScaled / 1e8).toFixed(8),
            effectiveFrom: "2026-01-01",
            source: "test",
          };
          const zero = Money.zero(FOREIGN);
          const base = (lineNo: number): LineSnapshot => ({
            id: `l${lineNo}`,
            lineNo,
            kind: "account",
            description: null,
            accountId: `acct-${lineNo}`,
            itemId: null,
            quantity: null,
            unitPrice: null,
            discount: zero,
            amount: zero,
            taxCodeId: null,
            taxAmount: zero,
            totalInclTax: zero,
            debit: zero,
            credit: zero,
            cost: null,
            warehouseId: null,
            toWarehouseId: null,
            lotId: null,
            unitId: null,
            unitQuantity: null,
            countedQuantity: null,
            expectedQuantity: null,
            tenderMethod: null,
            customFields: {},
            dimensions: {},
            payroll: null,
          });
          const lines: LineSnapshot[] = [
            { ...base(1), debit: Money.of((total / 10_000).toFixed(4), FOREIGN) },
            ...parts.map((part, index) => ({
              ...base(index + 2),
              credit: Money.of((part / 10_000).toFixed(4), FOREIGN),
            })),
          ];
          const plan = evaluatePolicy(POLICY, {
            header: {
              id: "d",
              companyId: "c",
              documentTypeCode: "JOURNAL",
              status: "draft",
              series: "JV",
              fiscalPeriodId: "p",
              number: null,
              effectiveDate: "2026-01-15",
              partyId: null,
              currency: FOREIGN,
              exchangeRate: rate,
              branchId: "b",
              attributedTo: null,
              clientRef: null,
              warehouseId: null,
              toWarehouseId: null,
              taxInclusive: false,
              reversesDocumentId: null,
              customFields: {},
            },
            lines,
            company: {
              id: "c",
              baseCurrency: MYR,
              fxRoundingAccountId: "acct-fx",
              costingMethod: "avco",
            },
            party: null,
            refs: {
              accountsByCode: {},
              items: {},
              taxCodes: {},
              components: {},
              schemes: {},
              dimensionTypesByCode: {},
            },
          });
          let balanced;
          try {
            balanced = balanceInBase(plan, "acct-fx", MYR);
          } catch {
            return true; // a refusal is a legal outcome; it is never a wrong number
          }
          expect(
            balanced.ledgerLines.filter((planned) => planned.role === "fx_rounding").length,
          ).toBeLessThanOrEqual(1);
          // `Money.zero<CurrencyCode>(MYR)` on purpose: `currency` has a `const` type parameter, so a bare
          // `Money.zero(MYR)` is `Money<CurrencyCode & "MYR">`, the reduce accumulator takes its type from
          // the seed, and `a.add(l.base)` — where `base` is the wide `Money<CurrencyCode>` of
          // PlannedLedgerLine — is then a compile error. The explicit argument widens the seed instead.
          const debit = balanced.ledgerLines
            .filter((planned) => planned.side === "debit")
            .reduce((sum, planned) => sum.add(planned.base), Money.zero<CurrencyCode>(MYR));
          const credit = balanced.ledgerLines
            .filter((planned) => planned.side === "credit")
            .reduce((sum, planned) => sum.add(planned.base), Money.zero<CurrencyCode>(MYR));
          expect(debit.equals(credit)).toBe(true);
          return true;
        },
      ),
      { numRuns: 2000 },
    );
  });
});
