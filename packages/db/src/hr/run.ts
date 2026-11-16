import type { Sql } from "postgres";
import { isCalendarDate, Money } from "@dulja/domain";
import { payrollCalculator, type EmployeeResult } from "@dulja/domain/payroll";
import type { TenantContext } from "../with-tenant";
import { PAYROLL_ACCOUNT_CODES } from "./accounts";
import { setEventContext } from "../posting/lifecycle";
import { loadPayrollInputs, shareKey, type PayrollInputs } from "./inputs";
import { listOverrides } from "./override";
import { PayrollRunError } from "./run-error";

export type PayrollRunKind = "regular" | "supplementary" | "final";

export interface CalculateRunInput {
  companyId: string;
  kind: PayrollRunKind;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  effectiveDate: string;
  branchId: string;
  employeeIds?: readonly string[];
}

export interface PayrollRunResult {
  documentId: string;
  employeeCount: number;
  lineCount: number;
  gross: Money;
  net: Money;
  pinnedTables: { schemeId: string; version: number }[];
  overrides: {
    documentLineId: string;
    employeeId: string;
    schemeCode: string;
    share: "employee" | "employer";
    reason: string;
  }[];
}

/** Narrows a read or a recalculation to one company: the route clears `companyId` and must bind every service call
 *  to it, because RLS bounds the tenant only (AGENTS.md, endpoints). Absent, the run is found tenant-wide. */
export interface RunScope {
  companyId?: string;
}

/**
 * Calculates a payroll run and writes it as a DRAFT `PAYROLL` document (spec:2081, §4.12.6).
 *
 * The four tables it writes are `document`, `document_line`, `payroll_run` and `payroll_line`, and it writes nothing
 * else — no ledger row, no projection, no movement (hazard 22). `postDocument` is what posts it, reached through the
 * shared `…/documents/{id}/transitions` route (§4.5.4); `document.posting_policy_id` is written there, never here.
 *
 * The pure calculator runs BEFORE the first insert, so a refused run (ERR_PAYROLL_RATE_TABLE_UNVERIFIED,
 * ERR_PAYROLL_INPUT_MISSING) leaves no document behind.
 *
 * Line order is FIXED, because a golden fixture byte-compares it (test 33): per employee in employee_number order —
 * earnings in component-code order, deductions in component-code order, then each scheme's employee share and
 * employer share, then the net-pay `account` line.
 */
export async function calculatePayrollRun(
  tx: Sql,
  ctx: TenantContext,
  input: CalculateRunInput,
): Promise<PayrollRunResult> {
  assertPeriod(input);
  if (!isCalendarDate(input.effectiveDate)) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `effectiveDate ${input.effectiveDate} is not a calendar date`,
    );
  }
  const inputs = await loadPayrollInputs(tx, {
    companyId: input.companyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    payDate: input.payDate,
    kind: input.kind,
    ...(input.employeeIds === undefined ? {} : { employeeIds: input.employeeIds }),
  });
  if (inputs.employees.length === 0) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `no employee of company ${input.companyId} is employed during ${input.periodStart}..${input.periodEnd}; a payroll run with no employee is not drafted`,
    );
  }
  const { employees: results, pinnedTables } = calculate(inputs);
  if (input.kind === "regular") await refuseSecondRegularRun(tx, input);

  const [type] = await tx<{ id: string }[]>`
    select id from app.document_type
     where company_id = ${input.companyId} and code = 'PAYROLL' and archived_at is null`;
  if (!type) {
    throw new PayrollRunError(
      "ERR_POLICY_REQUIRES_MISSING",
      `document type PAYROLL is not configured for company ${input.companyId}; apply the seed pack (bun run seed --only document-types)`,
    );
  }
  const [period] = await tx<{ id: string }[]>`
    select id from app.fiscal_period
     where company_id = ${input.companyId} and ${input.effectiveDate}::date between starts_on and ends_on`;
  if (!period) {
    throw new PayrollRunError(
      "ERR_PERIOD_NOT_FOUND",
      `no fiscal period of company ${input.companyId} contains ${input.effectiveDate}`,
    );
  }

  const [created] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id,
                              effective_date, currency, exchange_rate, branch_id)
    values (${ctx.tenantId}, ${input.companyId}, ${type.id}, 'PAY', ${period.id},
            ${input.effectiveDate}::date, ${inputs.currency}, '1.00000000', ${input.branchId})
    returning id`;
  const documentId = created!.id;

  await tx`
    insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date,
                                 pinned_tables)
    values (${documentId}, ${ctx.tenantId}, ${input.companyId}, ${input.kind},
            ${input.periodStart}::date, ${input.periodEnd}::date, ${input.payDate}::date,
            ${JSON.stringify(pinnedTables)}::text::jsonb)`;

  const written = await writeLines(tx, ctx, {
    documentId,
    companyId: input.companyId,
    results,
    inputs,
  });
  return {
    documentId,
    employeeCount: results.length,
    lineCount: written.lineCount,
    gross: written.gross,
    net: written.net,
    pinnedTables,
    overrides: written.overrides,
  };
}

/**
 * Re-runs the calculation over an existing DRAFT run, replacing its lines.
 *
 * spec:2081: "A run may be recalculated only while draft or submitted; any recalculation after submit returns it to
 * draft and voids the pending approval." The submitted case is 8B T11's: the run is returned to `draft` first, and
 * THIS function refuses anything that is not already a draft (ERR_DOC_NOT_DRAFT), so a submitted run is never
 * recalculated behind an approver's back.
 *
 * The run keeps its own employees (a `regular` run re-reads the whole master, so a hire made since the last
 * calculation is picked up; a `supplementary` or `final` run keeps the employees it named) and its own manual
 * overrides, read BEFORE the delete that removes the rows carrying them.
 */
export async function recalculatePayrollRun(
  tx: Sql,
  ctx: TenantContext,
  documentId: string,
  scope: RunScope = {},
): Promise<PayrollRunResult> {
  return recalculateWith(tx, ctx, documentId, scope, undefined);
}

/** A manual statutory override applied by `setStatutoryOverride` (8B T11) on top of the run's own stored ones. */
export interface PendingOverride {
  employeeId: string;
  schemeId: string;
  share: "employee" | "employer";
  amount: Money;
  reason: string;
}

/**
 * The one recalculation, shared by `recalculatePayrollRun` and `setStatutoryOverride` (not on the barrel).
 *
 * A SUBMITTED run is first returned to draft (spec:2081: "any recalculation after submit returns it to draft and
 * voids the pending approval"), through 2B's backward edge with reason `recalculated`; R1 then needs a fresh
 * submission before anyone can approve. An approved or later run is refused (ERR_DOC_NOT_DRAFT) — an approved run
 * returns to draft only through R3 (a compensation change) or the shared transitions route with a reason. `pending`
 * is applied only to a run that was ALREADY a draft: the override writer refuses anything else before calling.
 */
export async function recalculateWith(
  tx: Sql,
  ctx: TenantContext,
  documentId: string,
  scope: RunScope,
  pending: PendingOverride | undefined,
): Promise<PayrollRunResult> {
  const [row] = await tx<
    {
      status: string;
      company_id: string;
      kind: PayrollRunKind;
      period_start: string;
      period_end: string;
      pay_date: string;
    }[]
  >`
    select d.status::text as status, d.company_id, r.kind,
           to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end, 'YYYY-MM-DD') as period_end,
           to_char(r.pay_date, 'YYYY-MM-DD') as pay_date
      from app.document d join app.payroll_run r on r.document_id = d.id
     where d.id = ${documentId}
       and (${scope.companyId ?? null}::uuid is null or d.company_id = ${scope.companyId ?? null}::uuid)
       for update of d`;
  if (!row) throw new PayrollRunError("ERR_NOT_FOUND", `no payroll run ${documentId}`);
  if (row.status === "submitted" && pending === undefined) {
    // 2B's BEFORE trigger requires the reason on the backward edge and its AFTER trigger records it on the event.
    await setEventContext(tx, { reason: "recalculated" });
    await tx`update app.document set status = 'draft' where id = ${documentId}`;
    await setEventContext(tx, {});
  } else if (row.status !== "draft") {
    throw new PayrollRunError(
      "ERR_DOC_NOT_DRAFT",
      `payroll run ${documentId} is ${row.status}; only a draft or submitted run is recalculated (spec:2081)`,
    );
  }

  const employeeIds =
    row.kind === "regular"
      ? undefined
      : (
          await tx<{ employee_id: string }[]>`
            select distinct pl.employee_id from app.payroll_line pl
              join app.document_line dl on dl.id = pl.document_line_id
             where dl.document_id = ${documentId}`
        ).map((r) => r.employee_id);

  const inputs = await loadPayrollInputs(tx, {
    companyId: row.company_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    payDate: row.pay_date,
    kind: row.kind,
    documentId,
    ...(employeeIds === undefined ? {} : { employeeIds }),
  });
  if (inputs.employees.length === 0) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `no employee of company ${row.company_id} is employed during ${row.period_start}..${row.period_end}`,
    );
  }
  if (pending !== undefined) {
    const employee = inputs.employees.find((e) => e.employeeId === pending.employeeId);
    if (employee === undefined) {
      throw new PayrollRunError(
        "ERR_VALIDATION_FAILED",
        `employee ${pending.employeeId} is not on payroll run ${documentId}`,
      );
    }
    // The new override REPLACES a stored one on the same (scheme, share): one share has one figure.
    employee.manualOverrides = [
      ...employee.manualOverrides.filter(
        (o) => !(o.schemeId === pending.schemeId && o.share === pending.share),
      ),
      {
        schemeId: pending.schemeId,
        share: pending.share,
        amount: pending.amount,
        reason: pending.reason,
      },
    ];
  }
  const { employees: results, pinnedTables } = calculate(inputs);

  // The CASCADE from document_line removes the payroll_line rows; both draft-only guards admit it because the parent
  // is a draft. The run's header (and its document id, number series and audit trail) is kept.
  await tx`delete from app.document_line where document_id = ${documentId}`;
  await tx`
    update app.payroll_run
       set pinned_tables = ${JSON.stringify(pinnedTables)}::text::jsonb, calculated_at = now()
     where document_id = ${documentId}`;

  const written = await writeLines(tx, ctx, {
    documentId,
    companyId: row.company_id,
    results,
    inputs,
  });
  return {
    documentId,
    employeeCount: results.length,
    lineCount: written.lineCount,
    gross: written.gross,
    net: written.net,
    pinnedTables,
    overrides: written.overrides,
  };
}

/**
 * HRP-08: one `regular` run per company and period. A second regular run over an overlapping span (that is not void)
 * would credit every employee's net pay to 2400 twice, with approval as the only safeguard; a posted period is
 * corrected by a `supplementary` run (ADR 0076). Migration 0128's trigger holds the same rule for every writer under
 * a per-company advisory lock; this read only gives the operator the run's number in the message.
 */
async function refuseSecondRegularRun(
  tx: Sql,
  input: { companyId: string; periodStart: string; periodEnd: string },
): Promise<void> {
  const [other] = await tx<{ id: string; number: string | null; status: string }[]>`
    select d.id, d.number::text as number, d.status::text as status
      from app.payroll_run pr join app.document d on d.id = pr.document_id
     where pr.company_id = ${input.companyId} and pr.kind = 'regular' and d.status <> 'void'
       and pr.period_start <= ${input.periodEnd}::date and pr.period_end >= ${input.periodStart}::date
     limit 1`;
  if (other) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `a regular payroll run (${other.number ?? other.id}, ${other.status}) already covers part of ` +
        `${input.periodStart}..${input.periodEnd} in company ${input.companyId}; correct a posted period with a ` +
        "supplementary run, or void the other run first",
    );
  }
}

function assertPeriod(input: { periodStart: string; periodEnd: string; payDate: string }): void {
  for (const [name, value] of [
    ["periodStart", input.periodStart],
    ["periodEnd", input.periodEnd],
    ["payDate", input.payDate],
  ] as const) {
    if (!isCalendarDate(value)) {
      throw new PayrollRunError("ERR_VALIDATION_FAILED", `${name} ${value} is not a calendar date`);
    }
  }
  if (input.periodEnd < input.periodStart) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `periodEnd ${input.periodEnd} is before periodStart ${input.periodStart}`,
    );
  }
  if (input.payDate < input.periodStart) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `payDate ${input.payDate} is before periodStart ${input.periodStart}`,
    );
  }
}

/** The pure calculator, with its one non-payroll refusal translated: a period in which the configured proration
 *  rule counts no day (a weekend under `working_days`) is a `RangeError` in the domain and a 422 on the wire. */
function calculate(inputs: PayrollInputs): ReturnType<typeof payrollCalculator.calculate> {
  try {
    return payrollCalculator.calculate({
      period: inputs.period,
      employees: inputs.employees,
      rateTables: inputs.rateTables,
      ytdBefore: inputs.ytdBefore,
    });
  } catch (error) {
    if (error instanceof RangeError)
      throw new PayrollRunError("ERR_VALIDATION_FAILED", error.message);
    throw error;
  }
}

/** The ONE writer of a run's lines, shared by calculate and recalculate so the two can never disagree. */
async function writeLines(
  tx: Sql,
  ctx: TenantContext,
  args: { documentId: string; companyId: string; results: EmployeeResult[]; inputs: PayrollInputs },
): Promise<{
  lineCount: number;
  gross: Money;
  net: Money;
  overrides: PayrollRunResult["overrides"];
}> {
  const { documentId, companyId, results, inputs } = args;
  const [payable] = await tx<{ id: string }[]>`
    select id from app.account
     where company_id = ${companyId} and code = ${PAYROLL_ACCOUNT_CODES.salariesPayable}
       and is_group = false and archived_at is null`;
  if (!payable) {
    throw new PayrollRunError(
      "ERR_POLICY_REQUIRES_MISSING",
      `account ${PAYROLL_ACCOUNT_CODES.salariesPayable} (salaries payable) is not in company ${companyId}'s chart; create it (POST /v1/companies/{companyId}/accounts) and link the payroll accounts (POST /v1/companies/{companyId}/payroll-accounts)`,
    );
  }
  const inputByEmployee = new Map(inputs.employees.map((e) => [e.employeeId, e]));

  let lineNo = 0;
  let gross = Money.zero(inputs.currency);
  let net = Money.zero(inputs.currency);
  const overrides: PayrollRunResult["overrides"] = [];

  const insertLine = async (
    kind: "payroll" | "account",
    amount: Money,
    ext: {
      employeeId: string;
      componentId?: string | null;
      schemeId?: string | null;
      share?: "employee" | "employer" | null;
      quantity?: string | null;
      rateTableId?: string | null;
      rateTableVersion?: number | null;
      overrideReason?: string | null;
      accountId?: string | null;
      side?: "debit" | "credit";
    },
  ): Promise<string> => {
    lineNo += 1;
    // BRANCH is the EMPLOYEE's home branch, per line (amendment A3): every PAYROLL rule omits `document.branch`, so
    // the evaluator reads BRANCH from this bag and EMPLOYEE from `line.employee`.
    const [line] = await tx<{ id: string }[]>`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id,
                                     debit, credit, amount, dimensions)
      values (${ctx.tenantId}, ${companyId}, ${documentId}, ${lineNo}, ${kind}, ${ext.accountId ?? null},
              ${ext.side === "debit" ? amount.toString() : "0"},
              ${ext.side === "credit" ? amount.toString() : "0"},
              ${amount.toString()},
              ${JSON.stringify({ BRANCH: inputs.homeBranches[ext.employeeId]! })}::text::jsonb)
      returning id`;
    // `entered_by` is supplied NON-NULL exactly when `override_reason` is: `payroll_line_override_check` (0087)
    // requires both or neither, and `app.stamp_actor` replaces a supplied value with the session actor on INSERT
    // but leaves a NULL NULL — so omitting it would fail the CHECK on every override line a recalculation
    // re-creates. The value is the session's actor and never a payload's (SAH-044).
    await tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id,
                                    scheme_id, share, quantity, amount, rate_table_id, rate_table_version,
                                    override_reason, entered_by)
      values (${line!.id}, ${ctx.tenantId}, ${companyId}, ${ext.employeeId}, ${ext.componentId ?? null},
              ${ext.schemeId ?? null}, ${ext.share ?? null}, ${ext.quantity ?? null}, ${amount.toString()},
              ${ext.rateTableId ?? null}, ${ext.rateTableVersion ?? null}, ${ext.overrideReason ?? null},
              case when ${ext.overrideReason ?? null}::text is null then null else app.current_actor() end)`;
    return line!.id;
  };

  // `EmployeeResult.earnings` / `.deductions` are frozen at `{ componentId; amount }` (§4.12.1), so a component's
  // QUANTITY is read back off the input the calculator was given — without it `payroll_line.quantity` would be NULL
  // on every row ever written (§2.9's unpaid-leave quantity). A fixed component's quantity is null.
  const quantityOf = (employeeId: string, componentId: string): string | null =>
    inputByEmployee
      .get(employeeId)
      ?.compensation.find((c) => c.componentId === componentId)
      ?.quantity?.toString() ?? null;

  /**
   * HRP-02, ADR 0076's amendment: a supplementary run's lines are the period's corrected figures LESS what the
   * period's posted runs already carried, so a correction pays its difference once. A negative difference — an
   * over-payment, on any line — is refused: how an employee repays (a deduction from a later pay, or a receivable)
   * is the owner's to decide (ADR 0076, owner question 2), and `payroll_line.amount >= 0` has no signed line for it.
   */
  const subtractPosted = (
    employeeId: string,
    planned: { key: string; label: string; amount: Money }[],
  ): void => {
    const posted = inputs.postedInPeriod?.[employeeId];
    const prior = new Map<string, Money>();
    if (posted !== undefined) {
      for (const [id, amount] of Object.entries(posted.components)) prior.set(`c:${id}`, amount);
      for (const [k, amount] of Object.entries(posted.shares)) prior.set(`s:${k}`, amount);
      prior.set("net", posted.net);
    }
    const refuse = (label: string, corrected: Money, already: Money): never => {
      throw new PayrollRunError(
        "ERR_VALIDATION_FAILED",
        `employee ${employeeId}'s correction of ${label} is ${corrected.subtract(already).toString()} (posted ` +
          `${already.toString()}, corrected ${corrected.toString()}); a negative correction (an over-payment) is not ` +
          "posted until the owner decides how it is recovered (ADR 0076)",
      );
    };
    for (const l of planned) {
      const already = prior.get(l.key) ?? Money.zero(inputs.currency);
      prior.delete(l.key);
      if (l.amount.subtract(already).isNegative()) refuse(l.label, l.amount, already);
      l.amount = l.amount.subtract(already);
    }
    // A component or share the period posted and the corrected figures no longer carry is a correction to zero.
    for (const [key, already] of prior) {
      if (!already.isPositive()) continue;
      const label = key.startsWith("c:")
        ? (inputs.componentCodes[key.slice(2)] ?? key.slice(2))
        : `${schemeCodeOf(key.slice(2).split(":")[0]!)} ${key.split(":")[2]} share`;
      refuse(label, Money.zero(inputs.currency), already);
    }
  };

  type LineExt = Parameters<typeof insertLine>[2];
  interface PlannedLine {
    kind: "payroll" | "account";
    /** `c:<componentId>`, `s:<schemeId>:<share>` or `net` — the keys `PostedFigures` is summed under. */
    key: string;
    /** What a refusal names: the component's code, the scheme and share, or "net pay". */
    label: string;
    amount: Money;
    ext: LineExt;
    override?: { schemeCode: string; share: "employee" | "employer"; reason: string };
    isEarning?: boolean;
  }
  const schemeCodeOf = (schemeId: string): string =>
    inputs.rateTables.find((r) => r.schemeId === schemeId)?.schemeCode ?? schemeId;
  const supplementary = inputs.postedInPeriod !== undefined;

  for (const e of results) {
    if (e.net.isNegative()) {
      // A negative net cannot be written as a credit to salaries payable (`document_line.credit >= 0`) and an
      // employee who owes the company is not a payroll line. Refuse, naming the employee, before the run is posted.
      throw new PayrollRunError(
        "ERR_VALIDATION_FAILED",
        `employee ${e.employeeId}'s net pay for the period is ${e.net.toString()}; deductions and employee shares exceed gross pay`,
      );
    }
    const employeeInput = inputByEmployee.get(e.employeeId);
    const planned: PlannedLine[] = [];
    for (const earning of e.earnings) {
      planned.push({
        kind: "payroll",
        key: `c:${earning.componentId}`,
        label: inputs.componentCodes[earning.componentId] ?? earning.componentId,
        amount: earning.amount,
        isEarning: true,
        ext: {
          employeeId: e.employeeId,
          componentId: earning.componentId,
          quantity: quantityOf(e.employeeId, earning.componentId),
        },
      });
    }
    for (const deduction of e.deductions) {
      planned.push({
        kind: "payroll",
        key: `c:${deduction.componentId}`,
        label: inputs.componentCodes[deduction.componentId] ?? deduction.componentId,
        amount: deduction.amount,
        ext: {
          employeeId: e.employeeId,
          componentId: deduction.componentId,
          quantity: quantityOf(e.employeeId, deduction.componentId),
        },
      });
    }
    for (const scheme of e.schemes) {
      for (const share of ["employee", "employer"] as const) {
        const override = employeeInput?.manualOverrides.find(
          (o) => o.schemeId === scheme.schemeId && o.share === share,
        );
        planned.push({
          kind: "payroll",
          key: `s:${shareKey(scheme.schemeId, share)}`,
          label: `${scheme.schemeCode} ${share} share`,
          amount: share === "employee" ? scheme.employeeShare : scheme.employerShare,
          ext: {
            employeeId: e.employeeId,
            schemeId: scheme.schemeId,
            share,
            rateTableId: inputs.rateTableIds[scheme.schemeId] ?? null,
            rateTableVersion: scheme.rateTableVersion,
            overrideReason: override?.reason ?? null,
          },
          ...(override === undefined
            ? {}
            : { override: { schemeCode: scheme.schemeCode, share, reason: override.reason } }),
        });
      }
    }
    // The net-pay leg: an `account` line the policy's JOURNAL-shaped rules post, with its own payroll_line so
    // `line.employee` resolves and the credit to 2400 carries the EMPLOYEE dimension (spec:2101).
    planned.push({
      kind: "account",
      key: "net",
      label: "net pay",
      amount: e.net,
      ext: { employeeId: e.employeeId, accountId: payable.id, side: "credit" },
    });

    if (supplementary) subtractPosted(e.employeeId, planned);

    // A scheme with no share of one kind writes no line for it — unless a manual override set it, whose line (and
    // reason) must survive so the next recalculation reads it back (spec:2087). A supplementary run writes no zero
    // line at all: its lines are differences, and a zero difference is nothing to post.
    const toWrite = planned.filter(
      (l) =>
        l.override !== undefined ||
        !l.amount.isZero() ||
        (!supplementary && !l.key.startsWith("s:")),
    );
    if (supplementary && toWrite.every((l) => l.amount.isZero())) {
      throw new PayrollRunError(
        "ERR_VALIDATION_FAILED",
        `employee ${e.employeeId}'s corrected figures for ${inputs.period.start}..${inputs.period.end} equal what ` +
          `the period's posted runs already carried; nothing to correct — leave the employee off the supplementary run`,
      );
    }
    for (const l of toWrite) {
      const lineId = await insertLine(l.kind, l.amount, l.ext);
      if (l.override !== undefined) {
        overrides.push({
          documentLineId: lineId,
          employeeId: e.employeeId,
          schemeCode: l.override.schemeCode,
          share: l.override.share,
          reason: l.override.reason,
        });
      }
      if (l.isEarning === true) gross = gross.add(l.amount);
      if (l.kind === "account") net = net.add(l.amount);
    }
  }

  return { lineCount: lineNo, gross, net, overrides };
}

/** The document statuses `PayrollRunSchema.status` enumerates — ONE union, so the handler's return type and the
 *  declared response schema cannot describe two different bodies. */
export type PayrollRunStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "issued"
  | "void"
  | "posted"
  | "reversed";

export interface PayrollRunLine {
  documentLineId: string;
  employeeId: string;
  employeeNumber: string;
  componentId: string | null;
  /** The component's / scheme's CODE beside its id, so a screen or a register names it without a catalogue read the
   *  approver may not hold (8B T11, additive). */
  componentCode: string | null;
  schemeId: string | null;
  schemeCode: string | null;
  share: "employee" | "employer" | null;
  quantity: string | null;
  /** MoneySchema's shape (§4.2.8): the column's own `numeric(19,4)::text` and the run's currency. */
  amount: { amount: string; currency: string };
  rateTableVersion: number | null;
  overrideReason: string | null;
}

export interface PayrollRunDetail {
  documentId: string;
  number: string | null;
  series: string;
  status: PayrollRunStatus;
  kind: PayrollRunKind;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  pinnedTables: { schemeId: string; version: number }[];
  lines: PayrollRunLine[];
  /** spec:2087 — every manual statutory override, with its reason and who entered it ("flagged, listed on the
   *  approval screen"). `listOverrides`, in the wire's money shape (8B T11). */
  overrides: {
    documentLineId: string;
    employeeId: string;
    employeeNumber: string;
    schemeId: string;
    schemeCode: string;
    share: "employee" | "employer";
    amount: { amount: string; currency: string };
    reason: string;
    enteredBy: string;
    enteredByName: string;
    enteredAt: string;
  }[];
  /** spec:2174 R3 — "the approval screen lists everyone who changed compensation in the period". A read, not a
   *  screen (amendment A12). Read through migration 0090's bounded lookup `app.compensation_changes_in_period`, so a
   *  reader holding `hr.payroll.read` without `hr.compensation.read` (the approver) sees who, for whom and when —
   *  and never an amount. */
  compensationChangedBy: {
    principalId: string;
    displayName: string;
    employeeNumber: string;
    effectiveFrom: string;
  }[];
}

/** The read the approval screen and the API detail route both use (spec:2087 — overrides are LISTED). */
export async function readPayrollRun(
  tx: Sql,
  documentId: string,
  scope: RunScope = {},
): Promise<PayrollRunDetail> {
  const [head] = await tx<
    {
      number: string | null;
      series: string;
      status: PayrollRunStatus;
      currency: string;
      kind: PayrollRunKind;
      period_start: string;
      period_end: string;
      pay_date: string;
      pinned_tables: { schemeId: string; version: number }[];
      company_id: string;
    }[]
  >`
    select d.number::text as number, d.series, d.status::text as status, d.currency, r.kind, d.company_id,
           to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end, 'YYYY-MM-DD') as period_end,
           to_char(r.pay_date, 'YYYY-MM-DD') as pay_date, r.pinned_tables
      from app.document d join app.payroll_run r on r.document_id = d.id
     where d.id = ${documentId}
       and (${scope.companyId ?? null}::uuid is null or d.company_id = ${scope.companyId ?? null}::uuid)`;
  if (!head) throw new PayrollRunError("ERR_NOT_FOUND", `no payroll run ${documentId}`);
  const runCurrency = head.currency.trim();

  const lineRows = await tx<(Omit<PayrollRunLine, "amount"> & { amount: string })[]>`
    select pl.document_line_id as "documentLineId", pl.employee_id as "employeeId",
           e.employee_number as "employeeNumber", pl.component_id as "componentId",
           pc.code as "componentCode", pl.scheme_id as "schemeId", sc.code as "schemeCode",
           pl.share, pl.quantity::text as quantity,
           pl.amount::text as amount, pl.rate_table_version as "rateTableVersion",
           pl.override_reason as "overrideReason"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.employee e on e.id = pl.employee_id
      left join app.pay_component pc on pc.id = pl.component_id
      left join app.statutory_scheme sc on sc.id = pl.scheme_id
     where dl.document_id = ${documentId}
     order by dl.line_no`;
  // `numeric(19,4)::text` is already MoneySchema's `/^-?\d+\.\d{4}$/`; the string goes on the wire as written.
  const lines = lineRows.map((l) => ({
    ...l,
    amount: { amount: l.amount, currency: runCurrency },
  }));

  // spec:2174 R3's list. `compensation_line.entered_by` is 8A's stamped column. The predicate is a change LOCATED in
  // the period (`effective_from` between its ends), deliberately not R3's overlap test: this read has no event, and
  // an overlap test would list every open-ended salary line ever entered on every run. It goes through 0090's
  // bounded lookup, which answers a holder of hr.payroll.read without hr.compensation.read — the approver — and
  // returns no amount; the run's own employees narrow it here.
  const compensationChangedBy = await tx<PayrollRunDetail["compensationChangedBy"]>`
    select distinct c.principal_id as "principalId", p.display_name as "displayName",
           e.employee_number as "employeeNumber", to_char(c.effective_from, 'YYYY-MM-DD') as "effectiveFrom"
      from app.compensation_changes_in_period(${head.company_id}::uuid, ${head.period_start}::date,
                                              ${head.period_end}::date) c
      join app.employee e on e.id = c.employee_id
      join app.principal p on p.id = c.principal_id
     where c.employee_id in (select pl.employee_id from app.payroll_line pl
                               join app.document_line dl on dl.id = pl.document_line_id
                              where dl.document_id = ${documentId})
     order by "employeeNumber", "effectiveFrom", "principalId"`;

  const overrides = (await listOverrides(tx, documentId)).map((o) => ({
    ...o,
    amount: { amount: o.amount, currency: runCurrency },
  }));

  return {
    documentId,
    number: head.number,
    series: head.series,
    status: head.status,
    kind: head.kind,
    periodStart: head.period_start,
    periodEnd: head.period_end,
    payDate: head.pay_date,
    pinnedTables: head.pinned_tables,
    lines,
    overrides,
    compensationChangedBy: [...compensationChangedBy],
  };
}
