import type { Sql } from "postgres";
import { currency, isCalendarDate, Money, type CurrencyCode } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";
import { resolvePolicy } from "../posting/load";
import { PAYROLL_ACCOUNT_CODES } from "./accounts";
import { EMPLOYEE_DIMENSION_CODE, ensureEmployeeDimensionValue } from "./employee-dimension";

/**
 * 8C T6 (spec:2082, §4.14, round 18 B8/B9) — money out on Phase 4's machinery.
 *
 * `PAYROLL_PAYMENT` (one bank batch, one line per employee, clearing salaries payable per employee) and
 * `EMPLOYEE_ADVANCE` (debit staff advances, credit bank) are ordinary `document` rows with ordinary posting policies
 * (Task 5's envelopes). This file DRAFTS them and reads them back; it writes no ledger row. Submit, approve and post
 * go through 2B's shared `…/documents/{documentId}/transitions` route, where R1 and R2 hold
 * (`accounting.payment.approve` / `.post`), and `postDocument` writes the ledger from the policy.
 *
 * Every line is `kind = 'payroll'`, carries its amount in `document_line.amount` (the column the policy addresses,
 * `"amount": "line.amount"`) and the EMPLOYEE'S home branch and EMPLOYEE dimension value in `document_line.dimensions`
 * — the batch is one document for the whole company and its employees are not all in the batch's branch. No
 * `payroll_line` row is written (B9): that table is a 1:1 extension of a RUN's lines.
 */

/** The service's refusal. `packages/db` may not import `AppError` (§3.1); every code is already a row of `ERRORS`,
 *  and `apps/api/src/problem.ts` maps it through `fromDomainError` — the `PayrollRunError` precedent. */
export type MoneyOutErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_VALIDATION_FAILED"
  | "ERR_DOC_STATUS_ILLEGAL"
  | "ERR_POLICY_REQUIRES_MISSING"
  | "ERR_RBAC_FORBIDDEN";

export class MoneyOutError extends Error {
  constructor(
    readonly code: MoneyOutErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "MoneyOutError";
  }
}

export type MoneyOutTypeCode = "PAYROLL_PAYMENT" | "EMPLOYEE_ADVANCE";

export interface MoneyOutLine {
  documentLineId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  amount: Money;
  /** The EMPLOYEE'S home branch (a BRANCH dimension value id), never the batch's (B8). */
  branchId: string;
}

/** `app.document_status`'s seven labels, as text — the union the two route contracts' status enums mirror. */
export type MoneyOutStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "issued"
  | "void"
  | "posted"
  | "reversed";

/** Every field the two wire schemas carry comes from this shape, so a route never writes SQL. */
export interface MoneyOutResult {
  documentId: string;
  typeCode: MoneyOutTypeCode;
  series: string;
  /** Null until `issueDocument` assigns it — numbering is at issue (§4.3.6). */
  number: string | null;
  status: MoneyOutStatus;
  effectiveDate: string;
  /** The batch's (document's) own branch. */
  branchId: string;
  /** `payroll:<run id>` on a batch, `advance:<reason>` on an advance — `draftMoneyOut` writes both. */
  notes: string | null;
  employeeCount: number;
  total: Money;
  lines: MoneyOutLine[];
}

export interface PayrollPaymentInput {
  companyId: string;
  /** The POSTED PAYROLL run whose net pay this batch clears. */
  payrollDocumentId: string;
  /** The accounting date of the batch — never derived from `now()` (spec:2039). */
  effectiveDate: string;
  /** The batch's own branch. Every LINE carries the employee's home branch instead (amendment B8). */
  branchId: string;
  /** Restrict the batch to these employees; omit for every unpaid employee on the run. */
  employeeIds?: readonly string[];
}

export interface EmployeeAdvanceInput {
  companyId: string;
  employeeId: string;
  effectiveDate: string;
  branchId: string;
  amount: Money;
  reason: string;
}

/** Binds a read to one company and one of the two types: RLS bounds the tenant only, so a route that clears a path
 *  company passes it, and another company's document — or a JOURNAL asked for by id — is 404 (the `RunScope`
 *  precedent of 8B). */
export interface MoneyOutScope {
  companyId?: string;
  typeCode?: MoneyOutTypeCode;
}

export interface MoneyOutListFilter {
  companyId: string;
  typeCode: MoneyOutTypeCode;
  /** Matches `document.notes = 'payroll:<id>'` — the same marker `draftMoneyOut` writes. */
  payrollDocumentId?: string;
  employeeId?: string;
  status?: MoneyOutStatus;
  from?: string;
  to?: string;
  limit: number;
  /** Keyset on `(effective_date, id)` descending — newest first — decoded from the §4.2.8 cursor by the route. */
  cursor?: { effectiveDate: string; id: string } | null;
}

const PAYROLL_NOTE = "payroll:";
const ADVANCE_NOTE = "advance:";

interface Candidate {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  homeBranchId: string;
  amount: string;
}

function assertDate(value: string, what: string): void {
  if (!isCalendarDate(value)) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED", `${what} ${value} is not a calendar date`);
  }
}

async function typeIdFor(tx: Sql, companyId: string, code: MoneyOutTypeCode): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.document_type
     where company_id = ${companyId} and code = ${code} and archived_at is null`;
  if (!row) {
    throw new MoneyOutError(
      "ERR_POLICY_REQUIRES_MISSING",
      `document type ${code} is not configured for company ${companyId}; apply the seed pack (bun run seed --only document-types)`,
    );
  }
  return row.id;
}

async function baseCurrencyOf(tx: Sql, companyId: string): Promise<CurrencyCode> {
  const [row] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  if (!row) throw new MoneyOutError("ERR_NOT_FOUND", `company ${companyId} is not visible`);
  return currency(row.base_currency);
}

/**
 * The shared write: one draft document plus one `kind: 'payroll'` line per candidate.
 *
 * `document.series` is `not null` and is written on the draft; it is read from the resolved policy's
 * `numbering.series` rather than repeated as a literal, so `PAYB` and `ADV` are declared once, in Task 5's envelopes.
 * `debit`/`credit` stay 0 and the SIDE comes from the policy rule (§4.4.2 A9).
 */
async function draftMoneyOut(
  tx: Sql,
  ctx: TenantContext,
  opts: {
    companyId: string;
    typeCode: MoneyOutTypeCode;
    effectiveDate: string;
    branchId: string;
    ccy: CurrencyCode;
    candidates: readonly Candidate[];
    notes: string;
  },
): Promise<MoneyOutResult> {
  const documentTypeId = await typeIdFor(tx, opts.companyId, opts.typeCode);
  const { definition } = await resolvePolicy(tx, documentTypeId, opts.effectiveDate);
  const series = definition.numbering.series;

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, status,
                              effective_date, currency, exchange_rate, notes)
    values (${ctx.tenantId}, ${opts.companyId}, ${documentTypeId}, ${series}, ${opts.branchId}, 'draft',
            ${opts.effectiveDate}::date, ${opts.ccy}, '1.00000000', ${opts.notes})
    returning id`;

  let lineNo = 0;
  for (const c of opts.candidates) {
    lineNo += 1;
    const employeeValueId = await ensureEmployeeDimensionValue(tx, opts.companyId, c.employeeId);
    await tx`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, description, amount, dimensions)
      values (${ctx.tenantId}, ${opts.companyId}, ${doc!.id}, ${lineNo}, 'payroll',
              ${`${c.employeeNumber} ${c.employeeName}`}, ${c.amount},
              ${JSON.stringify({ BRANCH: c.homeBranchId, [EMPLOYEE_DIMENSION_CODE]: employeeValueId })}::text::jsonb)`;
  }
  return readMoneyOut(tx, doc!.id, { companyId: opts.companyId, typeCode: opts.typeCode });
}

/**
 * Drafts the bank batch that pays a POSTED run's net pay (spec:2082). The net per employee is read from the run's own
 * net-pay `account` lines — `credit − debit`, so a supplementary run's recovery line nets — and never recomputed, so
 * the batch and the ledger cannot disagree about what net was. An employee whose net is not positive is not paid.
 *
 * An employee already carried by a batch against the same run that is not void (a DRAFT included — an unposted batch
 * is money about to leave) is excluded; when nobody is left the call is refused. Two concurrent calls for one run are
 * serialised on a transaction-scoped advisory lock, so they cannot both pass the exclusion.
 */
export async function createPayrollPayment(
  tx: Sql,
  ctx: TenantContext,
  input: PayrollPaymentInput,
): Promise<MoneyOutResult> {
  assertDate(input.effectiveDate, "effectiveDate");
  await tx`select pg_advisory_xact_lock(hashtextextended(${`payroll_payment:${input.payrollDocumentId}`}, 0))`;

  const [run] = await tx<{ status: string }[]>`
    select d.status::text as status
      from app.payroll_run r join app.document d on d.id = r.document_id
     where r.document_id = ${input.payrollDocumentId} and r.company_id = ${input.companyId}`;
  if (!run) {
    throw new MoneyOutError(
      "ERR_NOT_FOUND",
      `payroll run ${input.payrollDocumentId} is not visible in company ${input.companyId}`,
    );
  }
  if (run.status !== "posted") {
    throw new MoneyOutError(
      "ERR_DOC_STATUS_ILLEGAL",
      `payroll run ${input.payrollDocumentId} is not posted (status ${run.status}); only a posted run is paid`,
    );
  }
  const ccy = await baseCurrencyOf(tx, input.companyId);

  const rows = await tx<(Candidate & { visible: boolean; paid: boolean })[]>`
    with net as (
      select pl.employee_id, sum(dl.credit - dl.debit)::numeric(19,4) as amount
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${input.payrollDocumentId} and dl.kind = 'account'
       group by pl.employee_id
    ),
    paid as (
      -- Every batch against this run that still claims its employees: not void, not reversed, and not itself a
      -- reversal mirror. The marker is the note draftMoneyOut writes.
      select (dl.dimensions ->> ${EMPLOYEE_DIMENSION_CODE}) as employee_value_id
        from app.document d
        join app.document_type t on t.id = d.document_type_id
        join app.document_line dl on dl.document_id = d.id and dl.kind = 'payroll'
       where t.code = 'PAYROLL_PAYMENT'
         and d.company_id = ${input.companyId}
         and d.notes = ${`${PAYROLL_NOTE}${input.payrollDocumentId}`}
         and d.status not in ('void', 'reversed')
         and d.reverses_document_id is null
    )
    select n.employee_id as "employeeId",
           coalesce(e.employee_number, '') as "employeeNumber",
           coalesce(p.name_en, '') as "employeeName",
           coalesce(e.home_branch_id::text, '') as "homeBranchId",
           to_char(n.amount, 'FM999999999999990.0000') as amount,
           e.id is not null as visible,
           exists (select 1 from paid where paid.employee_value_id = dv.id::text) as paid
      from net n
      left join app.employee e on e.id = n.employee_id and e.company_id = ${input.companyId}
      left join app.party p on p.id = e.party_id
      -- The EMPLOYEE value is reached THROUGH its type: app.dimension_value has no company_id.
      left join app.dimension_type dt
             on dt.company_id = ${input.companyId} and dt.code = ${EMPLOYEE_DIMENSION_CODE}
      left join app.dimension_value dv
             on dv.dimension_type_id = dt.id and dv.code = e.employee_number
     where n.amount > 0
     order by e.employee_number, n.employee_id`;

  const hidden = rows.filter((r) => !r.visible);
  if (hidden.length > 0) {
    // A batch silently short of an employee the caller cannot see would underpay them with nobody told; refuse.
    throw new MoneyOutError(
      "ERR_RBAC_FORBIDDEN",
      `payroll run ${input.payrollDocumentId} pays ${hidden.length} employee(s) this principal cannot see; a batch is released by a principal who sees the whole run`,
    );
  }
  let selected: readonly (Candidate & { paid: boolean })[] = rows;
  if (input.employeeIds !== undefined) {
    const onRun = new Set(rows.map((r) => r.employeeId));
    const stranger = input.employeeIds.find((id) => !onRun.has(id));
    if (stranger !== undefined) {
      throw new MoneyOutError(
        "ERR_VALIDATION_FAILED",
        `employee ${stranger} has no positive net pay on payroll run ${input.payrollDocumentId}`,
      );
    }
    const wanted = new Set(input.employeeIds);
    selected = rows.filter((r) => wanted.has(r.employeeId));
  }
  const candidates = selected.filter((r) => !r.paid);
  if (candidates.length === 0) {
    throw new MoneyOutError(
      "ERR_VALIDATION_FAILED",
      input.employeeIds === undefined
        ? `every employee on payroll run ${input.payrollDocumentId} is already paid`
        : `every named employee on payroll run ${input.payrollDocumentId} is already paid`,
    );
  }

  return draftMoneyOut(tx, ctx, {
    companyId: input.companyId,
    typeCode: "PAYROLL_PAYMENT",
    effectiveDate: input.effectiveDate,
    branchId: input.branchId,
    ccy,
    candidates: candidates.map(
      ({ employeeId, employeeNumber, employeeName, homeBranchId, amount }) => ({
        employeeId,
        employeeNumber,
        employeeName,
        homeBranchId,
        amount,
      }),
    ),
    notes: `${PAYROLL_NOTE}${input.payrollDocumentId}`,
  });
}

/** Drafts an advance to one active employee, in the company's base currency (spec:2082). It is recovered by the
 *  advance-recovery pay component in a later run, which credits `1400` with the same EMPLOYEE tag. */
export async function createEmployeeAdvance(
  tx: Sql,
  ctx: TenantContext,
  input: EmployeeAdvanceInput,
): Promise<MoneyOutResult> {
  assertDate(input.effectiveDate, "effectiveDate");
  if (!input.amount.isPositive()) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED", "an advance must be greater than zero");
  }
  if (input.reason.trim().length === 0) {
    throw new MoneyOutError("ERR_VALIDATION_FAILED", "an advance needs a reason");
  }
  const ccy = await baseCurrencyOf(tx, input.companyId);
  if ((input.amount.currency as string) !== (ccy as string)) {
    throw new MoneyOutError(
      "ERR_VALIDATION_FAILED",
      `an advance is paid in the company's base currency ${ccy}, not ${input.amount.currency}`,
    );
  }
  const [e] = await tx<{ employee_number: string; name_en: string; home_branch_id: string }[]>`
    select e.employee_number, p.name_en, e.home_branch_id
      from app.employee e join app.party p on p.id = e.party_id
     where e.id = ${input.employeeId} and e.company_id = ${input.companyId} and e.terminated_on is null`;
  if (!e) {
    throw new MoneyOutError(
      "ERR_NOT_FOUND",
      `employee ${input.employeeId} is not an active employee of company ${input.companyId}`,
    );
  }

  return draftMoneyOut(tx, ctx, {
    companyId: input.companyId,
    typeCode: "EMPLOYEE_ADVANCE",
    effectiveDate: input.effectiveDate,
    branchId: input.branchId,
    ccy,
    candidates: [
      {
        employeeId: input.employeeId,
        employeeNumber: e.employee_number,
        employeeName: e.name_en,
        homeBranchId: e.home_branch_id,
        amount: input.amount.toString(),
      },
    ],
    notes: `${ADVANCE_NOTE}${input.reason}`,
  });
}

/** Reads either type back by document id. `ERR_NOT_FOUND` when invisible, of another company than `scope.companyId`,
 *  or not of `scope.typeCode` (or of neither money-out type). */
export async function readMoneyOut(
  tx: Sql,
  documentId: string,
  scope: MoneyOutScope = {},
): Promise<MoneyOutResult> {
  const [doc] = await tx<
    {
      company_id: string;
      type_code: string;
      series: string;
      number: string | null;
      status: MoneyOutStatus;
      effective_date: string;
      branch_id: string;
      currency: string;
      notes: string | null;
    }[]
  >`
    select d.company_id, t.code as type_code, d.series, d.number::text as number, d.status::text as status,
           to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.branch_id, d.currency, d.notes
      from app.document d join app.document_type t on t.id = d.document_type_id
     where d.id = ${documentId}`;
  const typeCode = doc?.type_code;
  if (
    !doc ||
    (typeCode !== "PAYROLL_PAYMENT" && typeCode !== "EMPLOYEE_ADVANCE") ||
    (scope.companyId !== undefined && doc.company_id !== scope.companyId) ||
    (scope.typeCode !== undefined && typeCode !== scope.typeCode)
  ) {
    throw new MoneyOutError(
      "ERR_NOT_FOUND",
      `no ${scope.typeCode ?? "money-out"} document ${documentId}${scope.companyId === undefined ? "" : ` in company ${scope.companyId}`}`,
    );
  }
  const ccy = currency(doc.currency);

  const rows = await tx<
    {
      documentLineId: string;
      employeeId: string | null;
      employeeNumber: string | null;
      employeeName: string | null;
      amount: string;
      branchId: string | null;
    }[]
  >`
    select dl.id as "documentLineId", e.id as "employeeId", dv.code as "employeeNumber",
           p.name_en as "employeeName", to_char(dl.amount, 'FM999999999999990.0000') as amount,
           (dl.dimensions ->> 'BRANCH') as "branchId"
      from app.document_line dl
      left join app.dimension_value dv on dv.id = (dl.dimensions ->> ${EMPLOYEE_DIMENSION_CODE})::uuid
      left join app.dimension_type dt
             on dt.id = dv.dimension_type_id and dt.company_id = dl.company_id
            and dt.code = ${EMPLOYEE_DIMENSION_CODE}
      left join app.employee e on e.company_id = dt.company_id and e.employee_number = dv.code
      left join app.party p on p.id = e.party_id
     where dl.document_id = ${documentId} and dl.kind = 'payroll'
     order by dl.line_no`;

  const lines: MoneyOutLine[] = rows.map((r) => {
    if (r.employeeId === null || r.branchId === null) {
      throw new MoneyOutError(
        "ERR_RBAC_FORBIDDEN",
        `line ${r.documentLineId} of ${typeCode} ${documentId} names an employee this principal cannot see`,
      );
    }
    return {
      documentLineId: r.documentLineId,
      employeeId: r.employeeId,
      employeeNumber: r.employeeNumber ?? "",
      employeeName: r.employeeName ?? "",
      amount: Money.of(r.amount, ccy),
      branchId: r.branchId,
    };
  });
  return {
    documentId,
    typeCode,
    series: doc.series,
    number: doc.number,
    status: doc.status,
    effectiveDate: doc.effective_date,
    branchId: doc.branch_id,
    notes: doc.notes,
    employeeCount: lines.length,
    total: lines.reduce((a, l) => a.add(l.amount), Money.zero(ccy)),
    lines,
  };
}

/**
 * The list behind both `GET /`s, newest first: keyset on `(effective_date, id)` descending, because
 * `effective_date` alone is not unique and an OFFSET page shifts under a concurrent draft. Every filter is a typed
 * member. Each row is assembled by `readMoneyOut`, so there is one shape of a money-out document.
 */
export async function listMoneyOut(tx: Sql, filter: MoneyOutListFilter): Promise<MoneyOutResult[]> {
  const note =
    filter.payrollDocumentId === undefined ? null : `${PAYROLL_NOTE}${filter.payrollDocumentId}`;
  const status = filter.status ?? null;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const employeeId = filter.employeeId ?? null;
  const afterDate = filter.cursor?.effectiveDate ?? null;
  const afterId = filter.cursor?.id ?? null;
  const rows = await tx<{ id: string }[]>`
    select d.id
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.company_id = ${filter.companyId}
       and t.code = ${filter.typeCode}
       and (${note}::text is null or d.notes = ${note}::text)
       and (${status}::text is null or d.status::text = ${status}::text)
       and (${from}::date is null or d.effective_date >= ${from}::date)
       and (${to}::date is null or d.effective_date <= ${to}::date)
       and (${employeeId}::uuid is null or exists (
             select 1
               from app.document_line dl
               join app.dimension_value dv on dv.id = (dl.dimensions ->> ${EMPLOYEE_DIMENSION_CODE})::uuid
               join app.dimension_type dt
                 on dt.id = dv.dimension_type_id and dt.code = ${EMPLOYEE_DIMENSION_CODE}
               join app.employee e on e.company_id = dt.company_id and e.employee_number = dv.code
              where dl.document_id = d.id and dl.kind = 'payroll' and e.id = ${employeeId}::uuid))
       and (${afterId}::uuid is null
            or (d.effective_date, d.id) < (${afterDate}::date, ${afterId}::uuid))
     order by d.effective_date desc, d.id desc
     limit ${filter.limit}`;

  const out: MoneyOutResult[] = [];
  for (const row of rows) {
    out.push(
      await readMoneyOut(tx, row.id, { companyId: filter.companyId, typeCode: filter.typeCode }),
    );
  }
  return out;
}

/**
 * spec:2082: the outstanding staff-advance balance is a LEDGER PROJECTION, never a loan ledger. Base debits minus
 * base credits on `1400` tagged with the employee's EMPLOYEE value, up to and including `asOf` — an advance debits it,
 * the advance-recovery component of a later PAYROLL run credits it, and nothing here knows about a recovery schedule.
 * `asOf` is required: a balance never defaults to the clock (spec:2039).
 */
export async function advanceBalance(
  tx: Sql,
  input: { companyId: string; employeeId: string; asOf: string },
): Promise<Money> {
  assertDate(input.asOf, "asOf");
  const ccy = await baseCurrencyOf(tx, input.companyId);
  const [employee] = await tx<{ employee_number: string }[]>`
    select employee_number from app.employee
     where id = ${input.employeeId} and company_id = ${input.companyId}`;
  if (!employee) {
    throw new MoneyOutError(
      "ERR_NOT_FOUND",
      `employee ${input.employeeId} is not visible in company ${input.companyId}`,
    );
  }
  const [row] = await tx<{ balance: string }[]>`
    select to_char(coalesce(sum(le.base_debit - le.base_credit), 0), 'FM999999999999990.0000') as balance
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      join app.ledger_entry_dimension led on led.entry_id = le.id
      join app.dimension_value dv on dv.id = led.dimension_value_id
      join app.dimension_type dt on dt.id = led.dimension_type_id and dt.id = dv.dimension_type_id
     where le.company_id = ${input.companyId}
       and a.company_id = ${input.companyId}
       and a.code = ${PAYROLL_ACCOUNT_CODES.staffAdvances}
       and dt.company_id = ${input.companyId}
       and dt.code = ${EMPLOYEE_DIMENSION_CODE}
       and dv.code = ${employee.employee_number}
       and le.effective_date <= ${input.asOf}::date`;
  return Money.of(row!.balance, ccy);
}
