import type { PostingPolicy } from "@dulja/domain";

/**
 * Which leg of a transfer a policy posts, and so which kind of warehouse each of its two legs stands at —
 * decided by policy SHAPE and never by document-type code (3C's rule; `ar-ap/policy-shape.ts` decides a
 * settlement the same way). This file imports only types, so `posting/post.ts` reaches it with no cycle
 * through `transfer.ts`; its two callers are `transfer.ts` (the early refusals, at draft) and
 * `postDocument` step 6f (the control).
 */
export type TransferLeg = "dispatch" | "receipt";

/**
 * A transfer moves stock between a `stock` warehouse and the receiving branch's in-transit corridor, and
 * `item.inventory_account` is the stock warehouse's account: a DISPATCH takes the goods out of it, so every
 * `each_line` rule naming it credits; a RECEIPT puts them into it, so every such rule debits. A policy that
 * moves no stock by transfer, or names that account on both sides or on none, is neither.
 *
 * Code review 3 (Phase 4), the verification of R3. Both drafting services took `documentTypeId` from their
 * caller and asked nothing of it, and both routes take the type's code from the body. A receipt drafted as a
 * TRANSFER therefore posted Dr 1310 / Cr 1300 beside a movement out of transit and into the branch, and a
 * dispatch drafted as a TRANSFER_RECEIPT posted Dr 1300 / Cr 1310 beside one out of the source and into
 * transit — each account moving against its own stock, and the corridor never clearing.
 */
export function transferLegOf(policy: PostingPolicy): TransferLeg | null {
  if (policy.inventory.effect !== "transfer") return null;
  const sides = new Set(
    policy.lines.flatMap((rule) =>
      rule.for === "each_line" &&
      "from" in rule.account &&
      rule.account.from === "item.inventory_account"
        ? [rule.side]
        : [],
    ),
  );
  if (sides.size !== 1) return null;
  return sides.has("credit") ? "dispatch" : "receipt";
}

/** The kind of warehouse a movement of `leg` stands at when it `effect`s: a dispatch issues from `stock`
 *  into `in_transit`, a receipt issues from `in_transit` into `stock`. */
export function transferWarehouseKind(
  leg: TransferLeg,
  effect: "issue" | "receipt",
): "stock" | "in_transit" {
  return (leg === "dispatch") === (effect === "issue") ? "stock" : "in_transit";
}
