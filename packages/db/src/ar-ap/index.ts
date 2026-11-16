// 4A — the AR/AP services, collected behind one barrel so `packages/db/src/index.ts` carries one line for the
// slice (`export * from "./ar-ap"`). Later 4A tasks add their lines here and nothing else.
export * from "./payment-term";
export * from "./credit";
// Task 6. Named, not `export *`: `micro` is shared with `credit-note.ts` inside `ar-ap/` and nothing outside it
// needs the string-to-micro-units conversion.
export {
  convertToInvoice,
  type ConvertLine,
  type ConvertToInvoiceInput,
  type ConvertToInvoiceResult,
} from "./invoice";
// Task 8 — the partial credit note. A full one is `reverseDocument` (§4.3.1) and needs no export here.
export {
  creditNoteFrom,
  type CreditNoteInput,
  type CreditNoteLine,
  type CreditNoteResult,
} from "./credit-note";
// Task 9 — allocation (contracts §4.8.1). `export *` because every name in the file is the contract's, and
// `codedError` stays in invoice.ts, which this line does not reach.
export * from "./allocation";
// Task 10 — RECEIPT and PAYMENT: the one-line settlement draft, posted and allocated in one transaction when
// its type needs no second principal.
export * from "./settlement";
// Code review 2 (M5-X / F7): the refund refusal, the one name `policy-shape.ts` exports past `ar-ap/` —
// `apps/api`'s generic POST …/documents asks it as a pre-flight; `postDocument` imports the file directly.
export { settlementControlViolation } from "./policy-shape";
// 4B T6/T7 — bank reconciliation (contracts §4.8.3, ADR 0048): the statement-import half (T6) and the
// matching half (T7). `ImportError` and `BankMatchError` are named so `apps/api` can write `instanceof`
// against both; `ledgerLegSource` and the module's other helpers stay private.
export {
  BankMatchError,
  ImportError,
  RECONCILABLE_DIRECTION,
  importStatement,
  listStatementLines,
  listStatements,
  match,
  parseDelimited,
  reconcilableSources,
  reconciledBalance,
  registerReconcilableSource,
  unmatch,
  unmatchedStatementLines,
  type BankMatchRow,
  type BankStatementLineRow,
  type BankStatementRow,
  type CsvMapping,
  type Reconcilable,
  type ReconcilableSource,
} from "./reconciliation";
// 6D T11 (⚠️ OD-10, answered yes 2026-11-04): the `till_banking` source. Importing the file registers it.
export { tillBankingSource } from "./reconciliation-till";
// 4B T3 — `party_ageing` (contracts §4.8.2, ADR 0046): the reads over 0048's `app.party_ageing_rows`, the
// MERGE-and-zero rebuild, its compare and the definition-of-done tie-out. 4A's lines above are untouched and
// no 4A name is re-exported a second time (one export path per name, hazard 9).
export {
  ageingRows,
  ageingTieOut,
  comparePartyAgeing,
  outstandingRevaluation,
  rebuildPartyAgeing,
  PARTY_AGEING_BUCKETS,
  type AgeingBucket,
  type AgeingParams,
  type AgeingTieOutRow,
  type PartyAgeingRow,
} from "./ageing";
// 4B T5 — FX on settlement and at period end, as the one FX_REVALUATION type (contracts §4.14, ADR 0047).
export {
  FX_ACCOUNT_CODES,
  FX_REVALUATION_CODE,
  postSettlementFxDifference,
  resolveFxAccounts,
  revalueAtPeriodEnd,
  reverseRevaluation,
  settleWithFx,
  type FxAccounts,
  type RevaluationLine,
  type RevaluationResult,
} from "./fx";
