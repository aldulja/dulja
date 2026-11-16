import { AppError } from "@dulja/contracts";
import { FX_REVALUATION_CODE } from "@dulja/db";

/**
 * Code review 2, F8. FX_REVALUATION is produced ONLY by the FX services (§4.14, ADR 0047): `draftAndPostFx`
 * behind `POST …/documents/revaluations` for the unrealised half and the allocation, unallocate and
 * settlement routes for the realised half, and `reverseRevaluation`. Its lines carry the markers
 * (`custom_fields.fxKind`, `settlementDocumentId`, `revaluedAccountId`, …) that `ageingTieOut`,
 * `revalueAtPeriodEnd` and the realised path trust, and the generic writer copies `customFields` straight
 * into `custom_fields`. So a hand-made FX_REVALUATION of 1.0000 on 1200 marked 'unrealised' hid itself from
 * the Phase 4 tie-out and made the period's real revaluation a no-op.
 *
 * Every route that takes a document-type code from its BODY refuses the type, before any read: the generic
 * create route, 3D's `…/convert` (its target type, code review 3, R6), the three 3D drafting sub-paths
 * `…/transfers`, `…/{id}/receipt` and `…/count-sheet` (R6's verification: each drafted an FX_REVALUATION-typed
 * document on c7d26b4), and 4A's `…/settlements` (code review 4: `draftSettlement` refused it by policy
 * shape, but only after the type lookup). The line-replace route takes no type code; it asks the helper of
 * the draft's own type, after reading the draft. `reverseDocument` already refuses its generic reversal. Here,
 * outside `routes/accounting/documents.ts`, because that file mounts the 3D handlers and a handler importing
 * it back would be a cycle. Not moved into `postDocument`: `draftAndPostFx` posts through it.
 *
 * **Phase 8 review (2026-11-08): the three `hr` types are service-only too.** A PAYROLL's lines are the calculator's,
 * each with its `payroll_line` (employee, component, pinned rate table); the approval screen and `employee_ytd` read
 * them through `payroll_line`. The generic routes resolve their gate from the PAYROLL policy (`hr.payroll.prepare`),
 * so the preparer could replace a draft run's lines with hand-keyed ones that the approver never sees and the
 * projection never counts — R1's second person approving what they cannot see. A PAYROLL_PAYMENT's lines are the
 * run's per-employee nets (`createPayrollPayment`, which excludes an employee already paid) and an EMPLOYEE_ADVANCE
 * is one employee's advance in base currency (`createEmployeeAdvance`); a hand-made one skips both rules.
 *
 * **9B Task 5: OPENING_BALANCE is service-only too.** The cut-over's ledger opening is posted once, by the load
 * (`admin.import.run` / `legacy load`, through `draftAndPost`), in the series `OB` that no other type uses and that is
 * never re-used after cut-over (contracts round 20 C1); the cut-over reconciliation (9B Task 10) reads every posted
 * OPENING_BALANCE as the import's. A hand-made one — its gate resolves to `accounting.journal.post` — would be a journal
 * in the opening's series that the reconciliation counts as legacy. A correction after cut-over is a JOURNAL; the
 * generic reversal is not refused here, because reversing the load IS its undo (9B Global Constraint 5).
 *
 * **9B Task 6: OPENING_STOCK is service-only for the same reason.** Its lines are positions the load RECOMPUTED from the
 * legacy movement history with 3B's engine (§5.1 #6), credited to `3900`; its gate resolves to `inventory.receipt.post`,
 * so a hand-made one would be a receipt at a cost nobody recomputed, in series `OS`, that the reconciliation counts as
 * the legacy valuation. Stock found after cut-over is a STOCK_COUNT; the generic reversal stays the load's undo.
 */
const SERVICE_ONLY: Readonly<Record<string, string>> = {
  [FX_REVALUATION_CODE]: `${FX_REVALUATION_CODE} is posted only by the FX services: POST …/documents/revaluations for the unrealised half, and the allocation, unallocate and settlement routes for the realised half`,
  PAYROLL:
    "PAYROLL is written only by the payroll run service: POST …/payroll-runs, …/{documentId}/recalculate and …/{documentId}/overrides",
  PAYROLL_PAYMENT: "PAYROLL_PAYMENT is drafted only by POST …/payroll-payments, from a posted run",
  EMPLOYEE_ADVANCE: "EMPLOYEE_ADVANCE is drafted only by POST …/employee-advances",
  OPENING_BALANCE:
    "OPENING_BALANCE is posted only by the cut-over load (admin.import.run); correct an opening with a JOURNAL",
  OPENING_STOCK:
    "OPENING_STOCK is posted only by the cut-over load (admin.import.run), at a recomputed cost; correct stock with a STOCK_COUNT",
};

export function refuseServiceOnlyType(documentTypeCode: string): void {
  const message = Object.prototype.hasOwnProperty.call(SERVICE_ONLY, documentTypeCode)
    ? SERVICE_ONLY[documentTypeCode]
    : undefined;
  if (message !== undefined) throw new AppError("ERR_VALIDATION_FAILED", message);
}
