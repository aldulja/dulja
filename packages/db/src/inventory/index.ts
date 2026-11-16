// The barrel `packages/db/src/index.ts` re-exports. 3A's inventory modules (`items.ts`, `units.ts`,
// `warehouses.ts`, `lots.ts`, `prices.ts`, `promotions.ts`, `stock.ts`, `expiry.ts` — there is no
// `fefo.ts`) are already exported individually from the main barrel; this file collects only
// 3D's services so one line in the main barrel covers the slice.
export { convertOrderToDelivery } from "./fulfilment";
export type { ConvertResult, ConvertResultLine, ConvertToDeliveryInput } from "./fulfilment";
// 3D T7 — the dispatch leg of the two-step transfer (ADR 0043).
export {
  draftTransfer,
  finalWarehouseOf,
  resolveInTransitWarehouse,
  FINAL_WAREHOUSE_FIELD,
} from "./transfer";
export type { TransferInput, TransferResult } from "./transfer";
// 3D T8 — the receive leg, whose lines carry the signed variance (spec:1053).
export { draftTransferReceipt } from "./transfer";
export type { TransferReceiptInput, TransferReceiptResult } from "./transfer";
// 3D T8 — the stock-count sheet: snapshot, enter counts, read back (spec:1052, 2026).
export { readCountSheet, recordCounts, snapshotCountSheet } from "./count";
export type { CountSheetLine, SnapshotCountSheetInput } from "./count";
// 3D T9 — the expiry write-off: a branch drafts, an accountant approves (spec:1054).
export { draftExpiryWriteOff, WRITE_OFF_REASON_FIELD } from "./write-off";
export type { ExpiryWriteOffInput, ExpiryWriteOffResult } from "./write-off";
