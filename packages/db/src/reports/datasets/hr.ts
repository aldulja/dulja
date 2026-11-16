import type { Sql } from "postgres";
import { defineDataset, type Dataset, type DatasetColumn } from "../query";
import type { SqlFragment } from "../sql-fragment";

/**
 * The Phase 8 datasets (§4.16.2; contracts round 19). 7A could not ship them: `app.employee` and
 * `app.attendance_event` arrive with 6C's migrations 0064 and 0067, `app.payroll_line` with 8B's 0087,
 * `app.statutory_schedule` and `app.employee_ytd` with 8C's 0091–0092 — all past the ≤ 0058 bound 7A's registry was
 * cut at. §4.16.2's rule puts the two 6C tables here anyway: the FIRST report that reads a table owns its row. Five
 * members ship in 8D Task 2; the sixth, `leave_record`, is 8D Task 8's (OD-13 answered build, round 19 A14).
 *
 * Same rules as `accounting.ts` and `pos.ts`: every `ref` is a literal tagged template, dates and timestamps leave SQL
 * as strings (`to_char`, UTC for instants), numerics stay postgres.js strings so no `number` ever holds money, and
 * the only value a file here interpolates is the bound company id (test 27).
 *
 * **Test 32 — no side channel.** No dataset here joins the encrypted identity table, the compensation lines or the
 * statutory profiles (the three tables 8A gates behind `hr.employee.read_sensitive` / `hr.compensation.read`):
 * a run executes as the tenant's system principal, so a join would hand gated rows to every holder of the dataset's
 * read code. `packages/db/test/reports/hr-datasets.test.ts` asserts the absence over this file's text. Posted
 * `payroll_line` amounts are `hr.payroll.read`'s by spec (Part VI test 32's own parenthesis), which is the code
 * `DATASET_READ_CODES` admits for the three payroll datasets.
 *
 * **Branch isolation is RLS's.** `employee` (Form A′, home branch) and `attendance_event` (Form A) carry the
 * restrictive `branch_isolation`, so a branch-restricted reader sees only its branches with no predicate of ours.
 */

/** The run's company timezone for `attendance_event.occurred_on`'s sargable bounds — 7C's `companyTimezone`. */
const companyTimezone = (tx: Sql, companyId: string): SqlFragment =>
  tx`(select tzc.timezone from app.company tzc where tzc.id = ${companyId}::uuid)`;

// ── employee — the establishment list (spec:2091 "employee list by branch", "contract … expiry list") ────────────
const EMPLOYEE_COLUMNS: readonly DatasetColumn[] = [
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`e.id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "employee_name_ar", kind: "text", ref: (tx) => tx`p.name_ar` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "branch_name_en", kind: "text", ref: (tx) => tx`bv.name_en` },
  { field: "position", kind: "text", ref: (tx) => tx`e.position` },
  { field: "employment_type", kind: "text", ref: (tx) => tx`e.employment_type` },
  { field: "hired_on", kind: "date", ref: (tx) => tx`e.hired_on` },
  { field: "terminated_on", kind: "date", ref: (tx) => tx`e.terminated_on` },
  // 8D's own column, migration 0098 (8D A2). The PERMIT half of spec:2091's "contract and permit expiry" is NOT
  // here: the permit date is ciphertext, so it is served by GET …/employees/permit-expiry (8D A3).
  { field: "contract_ends_on", kind: "date", ref: (tx) => tx`e.contract_ends_on` },
  {
    field: "active",
    kind: "boolean",
    ref: (tx) => tx`(e.terminated_on is null and e.archived_at is null)`,
  },
  { field: "has_login", kind: "boolean", ref: (tx) => tx`(e.principal_id is not null)` },
];

export const employeeDataset: Dataset = defineDataset({
  id: "employee",
  columns: EMPLOYEE_COLUMNS,
  company: (tx, companyId) => tx`e.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.employee e
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id`,
  select: (tx) => tx`e.id as employee_id, e.employee_number as employee_number,
         p.name_en as employee_name_en, p.name_ar as employee_name_ar,
         e.home_branch_id as branch_id, bv.code as branch_code, bv.name_en as branch_name_en,
         e.position as position, e.employment_type as employment_type,
         to_char(e.hired_on, 'YYYY-MM-DD') as hired_on,
         to_char(e.terminated_on, 'YYYY-MM-DD') as terminated_on,
         to_char(e.contract_ends_on, 'YYYY-MM-DD') as contract_ends_on,
         (e.terminated_on is null and e.archived_at is null) as active,
         (e.principal_id is not null) as has_login`,
  defaultOrder: (tx) => tx`e.employee_number asc, e.id asc`,
});

// ── attendance_event — spec:2089: readable by HR as a report, NEVER an automatic pay input ───────────────────────
// Nothing in packages/domain/payroll reads this dataset. `occurred_on` is the DATE COMPANION: §4.11.1 has no
// timestamp parameter kind, so a date-range filter over attendance names this field and never `occurred_at`. It is
// the date in the COMPANY's timezone (7C's `shift.opened_on`, round 15 A16 item 3; round 19 A13 item 5) — a shift that
// clocks in at 23:30 local belongs to that local day, not to the UTC one — and compiles to bounds on the instant.
const ATTENDANCE_COLUMNS: readonly DatasetColumn[] = [
  { field: "attendance_event_id", kind: "uuid", ref: (tx) => tx`ae.id` },
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`ae.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`ae.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "kind", kind: "text", ref: (tx) => tx`ae.kind` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`ae.occurred_at` },
  {
    field: "occurred_on",
    kind: "date",
    ref: (tx) => tx`(ae.occurred_at at time zone co.timezone)::date`,
    localDateOf: { instant: (tx) => tx`ae.occurred_at`, timezone: companyTimezone },
  },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`ae.terminal_id` },
  { field: "corrects_event_id", kind: "uuid", ref: (tx) => tx`ae.corrects_event_id` },
  { field: "note", kind: "text", ref: (tx) => tx`ae.note` },
];

export const attendanceEventDataset: Dataset = defineDataset({
  id: "attendance_event",
  columns: ATTENDANCE_COLUMNS,
  company: (tx, companyId) => tx`ae.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.attendance_event ae
        join app.company         co on co.id = ae.company_id
        join app.employee        e  on e.id  = ae.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = ae.branch_id`,
  select: (tx) => tx`ae.id as attendance_event_id, ae.employee_id as employee_id,
         e.employee_number as employee_number, p.name_en as employee_name_en,
         ae.branch_id as branch_id, bv.code as branch_code, ae.kind as kind,
         to_char(ae.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
         to_char((ae.occurred_at at time zone co.timezone)::date, 'YYYY-MM-DD') as occurred_on,
         ae.terminal_id as terminal_id, ae.corrects_event_id as corrects_event_id, ae.note as note`,
  defaultOrder: (tx) => tx`ae.occurred_at desc, ae.id desc`,
});

// ── payroll_line — a run's lines as the posting produced them ─────────────────────────────────────────────────────
// POSTED and REVERSED documents only. A draft or submitted run's lines are working figures R3 may return to draft
// (spec:2174); a report over them would show numbers that never reached the ledger, and a ledger tie-out over this
// dataset could not hold (§2.9's 8B card: payslip and YTD figures come from POSTED `payroll_line` rows). The
// `payroll_run` join admits only a run's lines, so 8C's PAYROLL_PAYMENT and EMPLOYEE_ADVANCE lines (which carry no
// `payroll_line` row, round 18 B9) are outside it entirely.
//
// `tax_year` is the calendar year of the run's PAY DATE — the year `employee_ytd` files the same line under (round 18
// B7, ADR 0077; round 19 A13 item 4).
//
// The two SIGNED measures (8D A10). A report cannot tie to the ledger by summing `amount`: a run's lines are
// earnings, deductions and BOTH scheme shares, and their naive sum is nothing the ledger holds. Each measure is the
// signed contribution of one line to ONE §4.15 account, computed in SQL:
//
//   net_contribution     → the credit to 2400 salaries payable: an earning +, a deduction −, an employee share −,
//                          an employer share 0 (the company's cost, never the employee's net), and the NET-PAY
//                          LEG ITSELF 0 (the first arm).
//   payable_contribution → the credit to the scheme's own 241n payable: BOTH shares +, every other line 0.
//
// THE FIRST ARM IS LOAD-BEARING. 8B writes a `payroll_line` beside the net-pay `account` line with component, scheme
// and share ALL NULL and `amount = net` (`packages/db/src/hr/run.ts`, `payroll_line_shape_check`'s third shape). For
// that row `pc.kind` is NULL, so without the arm it would fall to `else pl.amount` and the measure would total
// 2 × Σnet. The measure BUILDS net from the component and scheme lines instead, which is what keeps a tie-out's two
// sides independent: the report re-derives net from its parts, the ledger side reads what the posting wrote.
//
// Each CASE is written out twice — once as the column's `ref` (filters, sort) and once in the `select` list —
// because the only value a dataset file may interpolate into a template is the bound company id (test 27's
// mechanical scan in `datasets.test.ts`); `hr-datasets.test.ts` filters on both measures to prove the two agree.
const NET_CONTRIBUTION = (tx: Sql): SqlFragment =>
  tx`(case when pl.component_id is null and pl.scheme_id is null   then 0
           when pl.scheme_id is not null and pl.share = 'employer' then 0
           when pl.scheme_id is not null and pl.share = 'employee' then -pl.amount
           when pc.kind = 'deduction'                              then -pl.amount
           else pl.amount end)::numeric(19,4)`;
const PAYABLE_CONTRIBUTION = (tx: Sql): SqlFragment =>
  tx`(case when pl.scheme_id is not null then pl.amount else 0 end)::numeric(19,4)`;

const PAYROLL_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "payroll_line_id", kind: "uuid", ref: (tx) => tx`pl.document_line_id` },
  { field: "payroll_document_id", kind: "uuid", ref: (tx) => tx`d.id` },
  { field: "document_series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "document_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "document_status", kind: "text", ref: (tx) => tx`d.status::text` },
  { field: "run_kind", kind: "text", ref: (tx) => tx`pr.kind` },
  { field: "period_start", kind: "date", ref: (tx) => tx`pr.period_start` },
  { field: "period_end", kind: "date", ref: (tx) => tx`pr.period_end` },
  { field: "pay_date", kind: "date", ref: (tx) => tx`pr.pay_date` },
  { field: "tax_year", kind: "integer", ref: (tx) => tx`extract(year from pr.pay_date)::int` },
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`pl.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "component_id", kind: "uuid", ref: (tx) => tx`pl.component_id` },
  { field: "component_code", kind: "text", ref: (tx) => tx`pc.code` },
  { field: "component_kind", kind: "text", ref: (tx) => tx`pc.kind` },
  { field: "scheme_id", kind: "uuid", ref: (tx) => tx`pl.scheme_id` },
  { field: "scheme_code", kind: "text", ref: (tx) => tx`sc.code` },
  { field: "share", kind: "text", ref: (tx) => tx`pl.share` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`pl.quantity` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`pl.amount` },
  { field: "rate_table_version", kind: "integer", ref: (tx) => tx`pl.rate_table_version` },
  { field: "override_reason", kind: "text", ref: (tx) => tx`pl.override_reason` },
  { field: "net_contribution", kind: "numeric", ref: NET_CONTRIBUTION },
  { field: "payable_contribution", kind: "numeric", ref: PAYABLE_CONTRIBUTION },
];

export const payrollLineDataset: Dataset = defineDataset({
  id: "payroll_line",
  columns: PAYROLL_LINE_COLUMNS,
  company: (tx, companyId) => tx`pl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.payroll_line pl
        join app.document_line   dl on dl.id = pl.document_line_id
        join app.document        d  on d.id  = dl.document_id and d.status in ('posted', 'reversed')
        join app.payroll_run     pr on pr.document_id = d.id
        join app.employee        e  on e.id  = pl.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id
        left join app.pay_component    pc on pc.id = pl.component_id
        left join app.statutory_scheme sc on sc.id = pl.scheme_id`,
  select: (tx) => tx`pl.document_line_id as payroll_line_id, d.id as payroll_document_id,
         d.series as document_series, d.number::int as document_number,
         d.status::text as document_status, pr.kind as run_kind,
         to_char(pr.period_start, 'YYYY-MM-DD') as period_start,
         to_char(pr.period_end, 'YYYY-MM-DD') as period_end,
         to_char(pr.pay_date, 'YYYY-MM-DD') as pay_date,
         extract(year from pr.pay_date)::int as tax_year,
         pl.employee_id as employee_id, e.employee_number as employee_number,
         p.name_en as employee_name_en, e.home_branch_id as branch_id, bv.code as branch_code,
         pl.component_id as component_id, pc.code as component_code, pc.kind as component_kind,
         pl.scheme_id as scheme_id, sc.code as scheme_code, pl.share as share,
         pl.quantity as quantity, pl.amount as amount,
         pl.rate_table_version as rate_table_version, pl.override_reason as override_reason,
         (case when pl.component_id is null and pl.scheme_id is null   then 0
               when pl.scheme_id is not null and pl.share = 'employer' then 0
               when pl.scheme_id is not null and pl.share = 'employee' then -pl.amount
               when pc.kind = 'deduction'                              then -pl.amount
               else pl.amount end)::numeric(19,4) as net_contribution,
         (case when pl.scheme_id is not null then pl.amount else 0 end)::numeric(19,4) as payable_contribution`,
  defaultOrder: (tx) =>
    tx`pr.period_end desc, e.employee_number asc, dl.line_no asc, pl.document_line_id asc`,
});

// ── employee_ytd — the posting-service projection PLUS the cut-over opening, read and never written (hazard 22) ──
// Grain: (employee, tax_year, scheme_code). `app.employee_ytd` stores ONE row per employee per year with a `by_scheme`
// jsonb bag; a DatasetRow value is a scalar, so the bag is unnested — and an employee with no scheme still yields one
// row (left join, null scheme). `gross` and `net` REPEAT across one employee's scheme rows, so a tie-out over this
// dataset compares DISTINCT (employee, tax_year) pairs and never sums the column.
//
// **The cut-over opening is added here, at read time** (9B, the Phase 8 raise; contracts round 18 B14, round 19 item
// 16). `app.employee_ytd` covers posted deltas only and is written solely by `postDocument` step 12; 8C's
// `app.employee_ytd_opening` holds the figures a mid-year switch starts from (9B's loader writes them at cut-over), and
// B14 forbids merging them into the projection. So the dataset reads both and adds them, exactly as
// `ytdFromEmployeeYtd` does for gross and net — and, beyond it, per scheme: each scheme's employee and employer shares
// are the projection's plus the opening's, over the union of both bags' keys. The keys are the union of both tables'
// (company, employee, year), so an employee with an opening and no posted run in that year is listed too. A company
// with no openings reads exactly the projection. `hr.payroll.read` gates both tables alike (`DATASET_READ_CODES`, and
// 7C's export registry for `employee_ytd_opening`); the opening's `by_component`, `source` and `loaded_by` are not read.
const EMPLOYEE_YTD_COLUMNS: readonly DatasetColumn[] = [
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`y.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "tax_year", kind: "integer", ref: (tx) => tx`y.tax_year::int` },
  { field: "gross", kind: "numeric", ref: (tx) => tx`y.gross` },
  { field: "net", kind: "numeric", ref: (tx) => tx`y.net` },
  { field: "scheme_code", kind: "text", ref: (tx) => tx`sh.key` },
  {
    field: "scheme_employee",
    kind: "numeric",
    ref: (tx) => tx`coalesce(sh.employee, 0)::numeric(19,4)`,
  },
  {
    field: "scheme_employer",
    kind: "numeric",
    ref: (tx) => tx`coalesce(sh.employer, 0)::numeric(19,4)`,
  },
];

export const employeeYtdDataset: Dataset = defineDataset({
  id: "employee_ytd",
  columns: EMPLOYEE_YTD_COLUMNS,
  company: (tx, companyId) => tx`y.company_id = ${companyId}::uuid`,
  from: (tx) => tx`(select k.company_id, k.employee_id, k.tax_year,
                (coalesce(py.gross, 0) + coalesce(op.gross, 0))::numeric(19,4) as gross,
                (coalesce(py.net, 0) + coalesce(op.net, 0))::numeric(19,4) as net,
                coalesce(py.by_scheme, '{}'::jsonb) as posted_scheme,
                coalesce(op.by_scheme, '{}'::jsonb) as opening_scheme
           from (select company_id, employee_id, tax_year from app.employee_ytd
                 union
                 select company_id, employee_id, tax_year from app.employee_ytd_opening) k
           left join app.employee_ytd py
                  on py.company_id = k.company_id and py.employee_id = k.employee_id and py.tax_year = k.tax_year
           left join app.employee_ytd_opening op
                  on op.company_id = k.company_id and op.employee_id = k.employee_id and op.tax_year = k.tax_year
        ) y
        join app.employee        e  on e.id  = y.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id
        left join lateral (
          select ks.key,
                 (coalesce((y.posted_scheme -> ks.key ->> 'employee')::numeric(19,4), 0)
                  + coalesce((y.opening_scheme -> ks.key ->> 'employee')::numeric(19,4), 0))::numeric(19,4) as employee,
                 (coalesce((y.posted_scheme -> ks.key ->> 'employer')::numeric(19,4), 0)
                  + coalesce((y.opening_scheme -> ks.key ->> 'employer')::numeric(19,4), 0))::numeric(19,4) as employer
            from (select jsonb_object_keys(y.posted_scheme) as key
                  union
                  select jsonb_object_keys(y.opening_scheme)) ks
        ) sh on true`,
  select: (tx) => tx`y.employee_id as employee_id, e.employee_number as employee_number,
         p.name_en as employee_name_en, e.home_branch_id as branch_id, bv.code as branch_code,
         y.tax_year::int as tax_year, y.gross as gross, y.net as net,
         sh.key as scheme_code,
         coalesce(sh.employee, 0)::numeric(19,4) as scheme_employee,
         coalesce(sh.employer, 0)::numeric(19,4) as scheme_employer`,
  defaultOrder: (tx) => tx`y.tax_year desc, e.employee_number asc, sh.key asc nulls first`,
});

// ── statutory_schedule — 8C's per-scheme, per-run record and whether a remittance settled it ─────────────────────
const STATUTORY_SCHEDULE_COLUMNS: readonly DatasetColumn[] = [
  { field: "statutory_schedule_id", kind: "uuid", ref: (tx) => tx`ss.id` },
  { field: "scheme_id", kind: "uuid", ref: (tx) => tx`ss.scheme_id` },
  { field: "scheme_code", kind: "text", ref: (tx) => tx`sc.code` },
  { field: "scheme_name_en", kind: "text", ref: (tx) => tx`sc.name_en` },
  { field: "scheme_name_ar", kind: "text", ref: (tx) => tx`sc.name_ar` },
  { field: "period_start", kind: "date", ref: (tx) => tx`ss.period_start` },
  { field: "period_end", kind: "date", ref: (tx) => tx`ss.period_end` },
  { field: "payroll_document_id", kind: "uuid", ref: (tx) => tx`ss.payroll_document_id` },
  { field: "payroll_number", kind: "integer", ref: (tx) => tx`pd.number` },
  { field: "currency", kind: "text", ref: (tx) => tx`ss.currency::text` },
  { field: "total_employee", kind: "numeric", ref: (tx) => tx`ss.total_employee` },
  { field: "total_employer", kind: "numeric", ref: (tx) => tx`ss.total_employer` },
  {
    field: "total",
    kind: "numeric",
    ref: (tx) => tx`(ss.total_employee + ss.total_employer)::numeric(19,4)`,
  },
  { field: "payable_account_code", kind: "text", ref: (tx) => tx`pa.code` },
  { field: "attachment_id", kind: "uuid", ref: (tx) => tx`ss.attachment_id` },
  { field: "remittance_document_id", kind: "uuid", ref: (tx) => tx`ss.remittance_document_id` },
  { field: "remittance_number", kind: "integer", ref: (tx) => tx`rd.number` },
  { field: "remitted", kind: "boolean", ref: (tx) => tx`(ss.remittance_document_id is not null)` },
];

export const statutoryScheduleDataset: Dataset = defineDataset({
  id: "statutory_schedule",
  columns: STATUTORY_SCHEDULE_COLUMNS,
  company: (tx, companyId) => tx`ss.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.statutory_schedule ss
        join app.statutory_scheme sc on sc.id = ss.scheme_id
        join app.document         pd on pd.id = ss.payroll_document_id
        left join app.account     pa on pa.id = sc.payable_account_id
        left join app.document    rd on rd.id = ss.remittance_document_id`,
  select: (tx) => tx`ss.id as statutory_schedule_id, ss.scheme_id as scheme_id,
         sc.code as scheme_code, sc.name_en as scheme_name_en, sc.name_ar as scheme_name_ar,
         to_char(ss.period_start, 'YYYY-MM-DD') as period_start,
         to_char(ss.period_end, 'YYYY-MM-DD') as period_end,
         ss.payroll_document_id as payroll_document_id, pd.number::int as payroll_number,
         ss.currency::text as currency,
         ss.total_employee as total_employee, ss.total_employer as total_employer,
         (ss.total_employee + ss.total_employer)::numeric(19,4) as total,
         pa.code as payable_account_code, ss.attachment_id as attachment_id,
         ss.remittance_document_id as remittance_document_id, rd.number::int as remittance_number,
         (ss.remittance_document_id is not null) as remitted`,
  defaultOrder: (tx) => tx`ss.period_end desc, sc.code asc, ss.id asc`,
});

// ── leave_record — ⚠️ OD-13 answered build (8D Task 8, round 19 A14): spec:2085's register ───────────────────────
// A record, never a posting, so a definition over it ties out `none` (a row witness), never to the ledger. The run
// executes as the tenant's system principal: `employee_parent_visibility` and branch isolation do not bound it, and
// `DATASET_READ_CODES` (`hr.employee.read`, the register route's own code) is the gate. `approved_by` names whoever
// DECIDED the record — an approval or a rejection.
const LEAVE_RECORD_COLUMNS: readonly DatasetColumn[] = [
  { field: "leave_record_id", kind: "uuid", ref: (tx) => tx`lr.id` },
  { field: "employee_id", kind: "uuid", ref: (tx) => tx`lr.employee_id` },
  { field: "employee_number", kind: "text", ref: (tx) => tx`e.employee_number` },
  { field: "employee_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "employee_name_ar", kind: "text", ref: (tx) => tx`p.name_ar` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`e.home_branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "leave_type_id", kind: "uuid", ref: (tx) => tx`lr.leave_type_id` },
  { field: "leave_type_code", kind: "text", ref: (tx) => tx`lt.code` },
  { field: "leave_type_name_en", kind: "text", ref: (tx) => tx`lt.name_en` },
  { field: "leave_type_name_ar", kind: "text", ref: (tx) => tx`lt.name_ar` },
  { field: "paid", kind: "boolean", ref: (tx) => tx`lt.paid` },
  { field: "starts_on", kind: "date", ref: (tx) => tx`lr.starts_on` },
  { field: "ends_on", kind: "date", ref: (tx) => tx`lr.ends_on` },
  { field: "days", kind: "numeric", ref: (tx) => tx`lr.days` },
  { field: "status", kind: "text", ref: (tx) => tx`lr.status` },
  { field: "approved_by", kind: "uuid", ref: (tx) => tx`lr.approved_by` },
  { field: "reason", kind: "text", ref: (tx) => tx`lr.reason` },
];

export const leaveRecordDataset: Dataset = defineDataset({
  id: "leave_record",
  columns: LEAVE_RECORD_COLUMNS,
  company: (tx, companyId) => tx`lr.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.leave_record lr
        join app.leave_type      lt on lt.id = lr.leave_type_id
        join app.employee        e  on e.id  = lr.employee_id
        join app.party           p  on p.id  = e.party_id
        join app.dimension_value bv on bv.id = e.home_branch_id`,
  select: (tx) => tx`lr.id as leave_record_id, lr.employee_id as employee_id,
         e.employee_number as employee_number, p.name_en as employee_name_en, p.name_ar as employee_name_ar,
         e.home_branch_id as branch_id, bv.code as branch_code,
         lr.leave_type_id as leave_type_id, lt.code as leave_type_code,
         lt.name_en as leave_type_name_en, lt.name_ar as leave_type_name_ar, lt.paid as paid,
         to_char(lr.starts_on, 'YYYY-MM-DD') as starts_on,
         to_char(lr.ends_on, 'YYYY-MM-DD') as ends_on,
         lr.days as days, lr.status as status, lr.approved_by as approved_by, lr.reason as reason`,
  defaultOrder: (tx) => tx`lr.starts_on desc, e.employee_number asc, lr.id asc`,
});
