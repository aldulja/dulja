// packages/domain/src/tax/side.ts
import type { PostingPolicy } from "../posting/policy";
import type { TaxCodeDef } from "./engine";

/** The side of the return a tax fact belongs to: the supplies a business makes, or the purchases it makes. */
export type TaxSide = "output" | "input";

/**
 * **A document's tax side comes from its posting policy, never from a code's kind** (MON-04, ADR 0050's
 * 2026-11-15 amendment). The pack format states no side on a document type, and `PostingPolicy.direction` is
 * the GOODS' direction — a sales credit note is `inbound` yet its tax is output tax. What does state it is the
 * account every `each_tax` rule posts the tax to: `tax_code.output_account` is a supply's tax and
 * `tax_code.input_account` a purchase's. A policy whose rules name only one of the two is on that side; one
 * that names both (a reverse-charge pair) or neither has no single side, and `null` keeps the kind-only rule.
 */
export function taxSideOf(policy: Pick<PostingPolicy, "lines">): TaxSide | null {
  let output = false;
  let input = false;
  for (const rule of policy.lines) {
    if (rule.for !== "each_tax" || !("from" in rule.account)) continue;
    if (rule.account.from === "tax_code.output_account") output = true;
    if (rule.account.from === "tax_code.input_account") input = true;
  }
  if (output === input) return null;
  return output ? "output" : "input";
}

/** The side a code's KIND declares: `output` and `input` declare one; `zero`, `exempt` and `out_of_scope` do
 *  not, and take their document's. */
export function declaredSideOf(kind: TaxCodeDef["kind"]): TaxSide | null {
  return kind === "output" || kind === "input" ? kind : null;
}

/** True when a code declares a side and its document is on the other one — an input code on a sale, an output
 *  code on a purchase. The one statement of the refusal `computeDocumentTax` (draft) and `evaluatePolicy`
 *  (post) both make. */
export function contradictsSide(kind: TaxCodeDef["kind"], side: TaxSide | null): boolean {
  const declared = declaredSideOf(kind);
  return side !== null && declared !== null && declared !== side;
}
