import { Money, Quantity, currency } from "@dulja/domain";
import type { Sql } from "postgres";

export type PayComponentKind = "earning" | "deduction";

export interface PayComponent {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: PayComponentKind;
  expenseAccountId: string | null;
  payableAccountId: string | null;
  quantityBased: boolean;
  schemeIds: string[];
  archivedAt: string | null;
}
export interface CompensationLine {
  id: string;
  employeeId: string;
  componentId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  amount: Money | null;
  quantity: Quantity | null;
  enteredBy: string;
}

interface RawComponent {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  kind: PayComponentKind;
  expense_account_id: string | null;
  payable_account_id: string | null;
  quantity_based: boolean;
  archived_at: string | null;
  scheme_ids: string[];
}

/** The catalogue of one company, by kind then code. Archived rows only when asked for (spec:2049). */
export async function listPayComponents(
  tx: Sql,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<PayComponent[]> {
  const rows = await tx<RawComponent[]>`
    select c.id, c.code, c.name_en, c.name_ar, c.kind, c.expense_account_id, c.payable_account_id,
           c.quantity_based,
           to_char(c.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as archived_at,
           coalesce(array_agg(s.scheme_id order by s.scheme_id) filter (where s.scheme_id is not null),
                    '{}')::text[] as scheme_ids
      from app.pay_component c
      left join app.pay_component_scheme s on s.component_id = c.id
     where c.company_id = ${companyId}::uuid
       and (${opts.includeArchived ?? false}::boolean or c.archived_at is null)
     group by c.id
     order by c.kind, c.code`;
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    kind: r.kind,
    expenseAccountId: r.expense_account_id,
    payableAccountId: r.payable_account_id,
    quantityBased: r.quantity_based,
    schemeIds: r.scheme_ids,
    archivedAt: r.archived_at,
  }));
}

/**
 * Adds the missing joins, idempotently. **Removing one is not possible and must not be**: `app_rw` holds DELETE on
 * a pinned list of tables (§3.5.4) and spec:2049 admits deletion for drafts and the erasure workflow alone. A
 * component whose statutory applicability changes is ARCHIVED and replaced by a new component, exactly as an
 * account is — which keeps a posted payroll line's applicability legible years later (amendment A14).
 * Applicability is data, never a "subject to X" boolean (spec:2078, RC-3).
 */
export async function setComponentSchemes(
  tx: Sql,
  componentId: string,
  schemeIds: readonly string[],
): Promise<void> {
  if (schemeIds.length === 0) return;
  await tx`
    insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
    select c.tenant_id, c.id, s.scheme_id
      from app.pay_component c
      cross join unnest(${[...schemeIds]}::uuid[]) as s(scheme_id)
     where c.id = ${componentId}::uuid
    on conflict (component_id, scheme_id) do nothing`;
}

interface RawLine {
  id: string;
  employee_id: string;
  component_id: string;
  effective_from: string;
  effective_to: string | null;
  amount: string | null;
  quantity: string | null;
  entered_by: string;
  base_currency: string;
}

/** `base_currency` is read from `app.company` rather than hard-coded: v1 payroll is single-currency (spec:2093) and
 *  reading it keeps the one currency literal out of this file. */
const toLine = (r: RawLine): CompensationLine => ({
  id: r.id,
  employeeId: r.employee_id,
  componentId: r.component_id,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  amount: r.amount === null ? null : Money.of(r.amount, currency(r.base_currency)),
  quantity: r.quantity === null ? null : Quantity.of(r.quantity),
  enteredBy: r.entered_by,
});

/** Every line of one employee, newest first. Empty without the compensation read code — RLS (`compensation_gate`). */
export async function listCompensation(tx: Sql, employeeId: string): Promise<CompensationLine[]> {
  const rows = await tx<RawLine[]>`
    select l.id, l.employee_id, l.component_id, l.effective_from::text as effective_from,
           l.effective_to::text as effective_to, l.amount::text as amount, l.quantity::text as quantity,
           l.entered_by, co.base_currency
      from app.compensation_line l
      join app.employee e on e.id = l.employee_id
      join app.company co on co.id = e.company_id
     where l.employee_id = ${employeeId}::uuid
     order by l.effective_from desc, l.component_id`;
  return rows.map(toLine);
}

/** The lines in force on `on`. 8B builds `EmployeePeriodInput.compensation` (§4.12.1) from this. */
export async function compensationOn(
  tx: Sql,
  employeeId: string,
  on: string,
): Promise<CompensationLine[]> {
  const rows = await tx<RawLine[]>`
    select l.id, l.employee_id, l.component_id, l.effective_from::text as effective_from,
           l.effective_to::text as effective_to, l.amount::text as amount, l.quantity::text as quantity,
           l.entered_by, co.base_currency
      from app.compensation_line l
      join app.employee e on e.id = l.employee_id
      join app.company co on co.id = e.company_id
     where l.employee_id = ${employeeId}::uuid and l.effective_from <= ${on}::date
       and (l.effective_to is null or l.effective_to >= ${on}::date)
     order by l.component_id`;
  return rows.map(toLine);
}

/**
 * Close-then-open per (employee, component), one transaction (ADR 0072): the previous open line of the SAME
 * component is closed at `effectiveFrom - 1 day` and the new one inserted. Returns the new line's id. The component
 * must belong to the employee's company — the composite FK bounds only the tenant, so the insert joins on it and a
 * component of another company inserts nothing and throws.
 */
export async function openCompensation(
  tx: Sql,
  input: {
    employeeId: string;
    componentId: string;
    effectiveFrom: string;
    amount: Money | null;
    quantity: Quantity | null;
  },
): Promise<string> {
  await tx`
    update app.compensation_line
       set effective_to = (${input.effectiveFrom}::date - 1)
     where employee_id = ${input.employeeId}::uuid and component_id = ${input.componentId}::uuid
       and effective_to is null and effective_from < ${input.effectiveFrom}::date`;
  const [row] = await tx<{ id: string }[]>`
    insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, quantity)
    select e.tenant_id, e.id, c.id, ${input.effectiveFrom}::date,
           ${input.amount === null ? null : input.amount.toString()}::numeric,
           ${input.quantity === null ? null : input.quantity.toString()}::numeric
      from app.employee e
      join app.pay_component c on c.company_id = e.company_id and c.id = ${input.componentId}::uuid
     where e.id = ${input.employeeId}::uuid
    returning id`;
  if (row === undefined)
    throw new Error(
      `employee ${input.employeeId} or pay component ${input.componentId} is not visible to this transaction, or they belong to different companies`,
    );
  return row.id;
}

/**
 * Creates one catalogue row. `tenant_id` comes from `app.company`, never from the caller (§3.3). A duplicate
 * `(company_id, code)` raises SQLSTATE 23505, which `fromDatabaseError` maps to ERR_CONFLICT_UNIQUE — no pre-check,
 * because a second place deciding uniqueness is a second place to get it wrong. The two account columns are not
 * parameters: 8B's chart seed sets them (amendment A2, hazard 33).
 */
export async function createPayComponent(
  tx: Sql,
  companyId: string,
  input: {
    code: string;
    nameEn: string;
    nameAr: string | null;
    kind: PayComponentKind;
    quantityBased: boolean;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.pay_component (tenant_id, company_id, code, name_en, name_ar, kind, quantity_based)
    select c.tenant_id, c.id, ${input.code}, ${input.nameEn}, ${input.nameAr}::text, ${input.kind},
           ${input.quantityBased}::boolean
      from app.company c where c.id = ${companyId}::uuid
    returning id`;
  if (row === undefined) throw new Error(`company ${companyId} is not visible to this transaction`);
  return row.id;
}

/** Renames a component. `code` and `kind` are NOT renameable: a posted payroll line's component is read back by
 *  code years later (8D's payslip reprint), and changing `kind` would reverse the sign of every historical line. A
 *  component that is wrong is archived and replaced. */
export async function renamePayComponent(
  tx: Sql,
  componentId: string,
  input: { nameEn?: string; nameAr?: string | null },
): Promise<void> {
  const res = await tx`
    update app.pay_component
       set name_en = coalesce(${input.nameEn ?? null}::text, name_en),
           name_ar = case when ${input.nameAr !== undefined}::boolean then ${input.nameAr ?? null}::text
                          else name_ar end
     where id = ${componentId}::uuid`;
  if (res.count === 0)
    throw new Error(`pay component ${componentId} is not visible to this transaction`);
}

/** spec:2049 — HR master data is archived, never deleted. Archiving twice is idempotent and is not an error. */
export async function archivePayComponent(tx: Sql, componentId: string): Promise<void> {
  const res = await tx`
    update app.pay_component set archived_at = coalesce(archived_at, now()) where id = ${componentId}::uuid`;
  if (res.count === 0)
    throw new Error(`pay component ${componentId} is not visible to this transaction`);
}
