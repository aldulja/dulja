// packages/db/src/sync/authority.ts
/**
 * The `pos.*` codes `applyBatch` re-verifies against the SERVER's current assignments (spec:1324), named once.
 *
 * **Why literals in `packages/db` and not `PERMISSION[...]`:** §3.1 pins `packages/db` to `@dulja/domain`, so
 * `@dulja/contracts`'s `PERMISSION` is unreachable here — exactly the constraint 3A met with
 * `INVENTORY_PERMISSION` (phase-3a:1882) and 1A met with `PostingError`. The `permission-catalogue` lint
 * counts a bare string literal in this scope, and `packages/db/test/sync/accounts-and-codes.test.ts` asserts
 * every value here is in the catalogue, so a typo cannot survive the build in either direction.
 */
export const POS_PERMISSION = {
  shiftOwn: "pos.shift.own",
  shiftCloseAny: "pos.shift.close_any",
  ticketSell: "pos.ticket.sell",
  ticketDiscount: "pos.ticket.discount",
  ticketReturn: "pos.ticket.return",
  ticketReturnBlind: "pos.ticket.return_blind",
  ticketVoid: "pos.ticket.void",
  ticketOverride: "pos.ticket.override",
  customerCreate: "pos.customer.create",
  needsAttentionResolve: "pos.needs_attention.resolve",
} as const;
export type PosPermissionCode = (typeof POS_PERMISSION)[keyof typeof POS_PERMISSION];

/** Compatibility code registry: a supervisor lifts limits, never a missing cashier grant. */
export const OVERRIDE_SUBJECT_FOR: Readonly<Record<PosPermissionCode, null>> = {
  "pos.shift.own": null,
  "pos.shift.close_any": null,
  "pos.ticket.sell": null,
  "pos.ticket.discount": null,
  "pos.ticket.return": null,
  "pos.ticket.return_blind": null,
  "pos.ticket.void": null,
  "pos.ticket.override": null,
  "pos.customer.create": null,
  "pos.needs_attention.resolve": null,
};
