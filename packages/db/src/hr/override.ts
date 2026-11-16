import type { Sql } from "postgres";
import { currency as currencyCode, Money } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import { recalculateWith, type RunScope } from "./run";
import { PayrollRunError } from "./run-error";

export interface SetOverrideInput {
  documentId: string;
  /** spec:2087: the override is a **per-employee** line. Without it the override would match one line per employee
   *  on the run and a correction meant for one person would silently restate everybody's. */
  employeeId: string;
  schemeId: string;
  share: "employee" | "employer";
  amount: { amount: string; currency: string };
  reason: string;
}

export interface OverrideRow {
  documentLineId: string;
  employeeId: string;
  employeeNumber: string;
  schemeId: string;
  schemeCode: string;
  share: "employee" | "employer";
  /** `numeric(19,4)::text`, the run's currency. */
  amount: string;
  reason: string;
  /** The principal accountable for the override (spec:2087), stamped from the session (SAH-044). */
  enteredBy: string;
  enteredByName: string;
  enteredAt: string;
}

/**
 * spec:2087: "a per-employee override line (PCB in particular) is allowed only with a reason and `entered_by`, is
 * flagged, is listed on the approval screen and stays in the audit trail; the engine never guesses, the operator is
 * accountable."
 *
 * The override is an INPUT to the draft's own recalculation, not an edit of an output: the run is recalculated at
 * once with the override applied, so the figures the approver sees are the ones the override produced (an override
 * that only took effect at the next calculation would be approved unseen). The line it lands on carries the reason
 * and `entered_by` (stamped from the session, never a parameter — SAH-044), and `loadPayrollInputs` reads it back out
 * of the draft's own `payroll_line` rows as `manualOverrides`, which is why it survives every later recalculation.
 *
 * Refused: a run that is not a draft (`ERR_DOC_NOT_DRAFT` — "the approver approves what will post", spec:2081), a run
 * of another company (`ERR_NOT_FOUND` under `scope.companyId`), an employee not on the run (`ERR_VALIDATION_FAILED`),
 * a scheme none of the employee's components feeds (`ERR_VALIDATION_FAILED`; the calculator holds the same rule for
 * the period as `ERR_PAYROLL_INPUT_MISSING` — an override
 * replaces a computed share, possibly a zero one with no line yet, HRP-15, and never invents a contribution), a
 * currency other than the run's, a negative amount, and an empty reason. On a supplementary run the amount is the
 * PERIOD's figure; its line carries the difference from what the period already posted (ADR 0076's amendment).
 */
export async function setStatutoryOverride(
  tx: Sql,
  ctx: TenantContext,
  input: SetOverrideInput,
  scope: RunScope = {},
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      "a manual statutory override needs a reason (spec:2087)",
    );
  }
  const [doc] = await tx<{ status: string; currency: string }[]>`
    select d.status::text as status, d.currency from app.document d
      join app.payroll_run r on r.document_id = d.id
     where d.id = ${input.documentId}
       and (${scope.companyId ?? null}::uuid is null or d.company_id = ${scope.companyId ?? null}::uuid)
       for update of d`;
  if (!doc) throw new PayrollRunError("ERR_NOT_FOUND", `no payroll run ${input.documentId}`);
  if (doc.status !== "draft") {
    throw new PayrollRunError(
      "ERR_DOC_NOT_DRAFT",
      `payroll run ${input.documentId} is ${doc.status}; a statutory override is entered before submission so the approver approves what will post (spec:2081)`,
    );
  }
  const currency = doc.currency.trim();
  if (input.amount.currency !== currency) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `the override is in ${input.amount.currency} and payroll run ${input.documentId} is in ${currency}`,
    );
  }
  let amount: Money;
  try {
    amount = Money.of(input.amount.amount, currencyCode(currency));
  } catch (error) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `override amount ${input.amount.amount} is not a money figure: ${(error as Error).message}`,
    );
  }
  if (amount.isNegative()) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `override amount ${input.amount.amount} is negative; a statutory share is a magnitude`,
    );
  }

  // The (run, employee, scheme, share) the operator names must be a line the calculation produced. `employee_id` is
  // part of the predicate, not an afterthought: a run carries one (scheme, share) line for EVERY employee.
  const targets = await tx<{ document_line_id: string }[]>`
    select pl.document_line_id
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
     where dl.document_id = ${input.documentId}
       and pl.employee_id = ${input.employeeId}
       and pl.scheme_id = ${input.schemeId}
       and pl.share = ${input.share}`;
  if (targets.length === 0) {
    // HRP-15: a share the calculator computed as zero has no line (`writeLines` writes none), and spec:2087 names
    // exactly that case — a PCB below the threshold the accountant says is owed. The override then CREATES the line,
    // provided the employee is on the run and one of their components feeds the scheme (the calculator re-checks that
    // for the period), so the engine still never invents a contribution to a scheme nobody joins.
    const [found] = await tx<{ on_run: boolean; fed: boolean }[]>`
      select exists (select 1 from app.payroll_line pl
                       join app.document_line dl on dl.id = pl.document_line_id
                      where dl.document_id = ${input.documentId} and pl.employee_id = ${input.employeeId}) as on_run,
             exists (select 1 from app.compensation_line cl
                       join app.pay_component_scheme pcs on pcs.component_id = cl.component_id
                      where cl.employee_id = ${input.employeeId} and pcs.scheme_id = ${input.schemeId}) as fed`;
    if (!found!.on_run) {
      throw new PayrollRunError(
        "ERR_VALIDATION_FAILED",
        `employee ${input.employeeId} is not on payroll run ${input.documentId}`,
      );
    }
    if (!found!.fed) {
      throw new PayrollRunError(
        "ERR_VALIDATION_FAILED",
        `payroll run ${input.documentId} has no ${input.share} line for employee ${input.employeeId} and scheme ${input.schemeId}, and no earning feeding that scheme; an override replaces a computed share and never invents a contribution`,
      );
    }
  }
  if (targets.length > 1) {
    // One (run, employee, scheme, share) is one payroll_line by construction — the run service's single writer
    // says so. More than one means the invariant moved, and guessing which line was meant is what SAH-011 punishes.
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `payroll run ${input.documentId} has ${targets.length} ${input.share} lines for employee ${input.employeeId} and scheme ${input.schemeId}; one was expected`,
    );
  }

  await recalculateWith(tx, ctx, input.documentId, scope, {
    employeeId: input.employeeId,
    schemeId: input.schemeId,
    share: input.share,
    amount,
    reason,
  });
}

/** The overrides on one run, in line order, for the approval screen and the audit trail (spec:2087 — "listed"). */
export async function listOverrides(
  tx: Sql,
  documentId: string,
  scope: RunScope = {},
): Promise<OverrideRow[]> {
  const rows = await tx<OverrideRow[]>`
    select pl.document_line_id as "documentLineId", pl.employee_id as "employeeId",
           e.employee_number as "employeeNumber", pl.scheme_id as "schemeId", sc.code as "schemeCode",
           pl.share, pl.amount::text as amount, pl.override_reason as reason,
           pl.entered_by::text as "enteredBy", p.display_name as "enteredByName",
           to_char(pl.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "enteredAt"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.document d on d.id = dl.document_id
      join app.employee e on e.id = pl.employee_id
      join app.statutory_scheme sc on sc.id = pl.scheme_id
      join app.principal p on p.id = pl.entered_by
     where dl.document_id = ${documentId} and pl.override_reason is not null
       and (${scope.companyId ?? null}::uuid is null or d.company_id = ${scope.companyId ?? null}::uuid)
     order by dl.line_no`;
  return [...rows];
}
