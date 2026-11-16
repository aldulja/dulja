import type { Sql } from "postgres";
import { SyncError } from "../sync/enrolment";

export interface CashierLimits {
  maxLineDiscountPct: string;
  maxTicketDiscountPct: string;
  maxVoidAmount: string;
  maxPriceOverridePct: string;
  blindReturnAllowed: boolean;
  maxBlindReturnAmount: string;
  roundingIncrement: string;
  requireCustomerOver: string | null;
  maxCashInDrawer: string | null;
}

/** `revision` is a decimal STRING: a bigint has no safe JS number form (§4.10.2). */
export interface CashierSnapshot {
  codes: string[];
  limits: CashierLimits;
  revision: string;
}

/**
 * Recomputes a cashier's snapshot WITHOUT writing it — the nightly comparison's half of ADR 0061.
 * It runs the identical SQL `app.refresh_pos_cashier` runs, so a difference is a trigger fault and never
 * a difference between two implementations of the same rule.
 */
export async function computeSnapshot(
  tx: Sql,
  principalId: string,
): Promise<CashierSnapshot | null> {
  const [row] = await tx<{ snapshot: CashierSnapshot }[]>`
    select jsonb_build_object(
      'codes', case when c.revoked_at is not null then '[]'::jsonb else coalesce((
                 select jsonb_agg(pm.code order by pm.code) from app.permission pm
                  where pm.module = 'pos' and pm.code not like 'pos.sync.%'
                    and app.principal_has(c.principal_id, pm.code, c.company_id, c.branch_id)), '[]'::jsonb) end,
      'limits', (select jsonb_build_object(
                   'maxLineDiscountPct',   coalesce(b.max_line_discount_pct,   0::numeric(9,6))::text,
                   'maxTicketDiscountPct', coalesce(b.max_ticket_discount_pct, 0::numeric(9,6))::text,
                   'maxVoidAmount',        coalesce(b.max_void_amount,         0::numeric(19,4))::text,
                   'maxPriceOverridePct',  coalesce(b.max_price_override_pct,  0::numeric(9,6))::text,
                   'blindReturnAllowed',   coalesce(b.blind_return_allowed,    false),
                   'maxBlindReturnAmount', coalesce(b.max_blind_return_amount, 0::numeric(19,4))::text,
                   'roundingIncrement',    coalesce(b.rounding_increment,      0.05::numeric(19,4))::text,
                   'requireCustomerOver',  b.require_customer_over::text,
                   'maxCashInDrawer',      b.max_cash_in_drawer::text)
                   from (select 1) one
                   left join app.branch_pos_policy b on b.company_id = c.company_id and b.branch_id = c.branch_id),
      'revision', c.revision::text) as snapshot
      from app.pos_cashier c where c.principal_id = ${principalId}`;
  return row?.snapshot ?? null;
}

export interface SnapshotDrift {
  principalId: string;
  companyId: string;
  branchId: string;
  stored: CashierSnapshot;
  fresh: CashierSnapshot;
}

/** Every cashier whose stored snapshot differs from a fresh computation. Reads only. */
export async function findSnapshotDrift(
  tx: Sql,
  opts: { companyId?: string } = {},
): Promise<SnapshotDrift[]> {
  const rows = await tx<
    { principalId: string; companyId: string; branchId: string; stored: CashierSnapshot }[]
  >`
    select principal_id as "principalId", company_id as "companyId", branch_id as "branchId", snapshot as stored
      from app.pos_cashier
     where (${opts.companyId ?? null}::uuid is null or company_id = ${opts.companyId ?? null}::uuid)
     order by principal_id`;
  const drift: SnapshotDrift[] = [];
  for (const row of rows) {
    const fresh = await computeSnapshot(tx, row.principalId);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(row.stored))
      drift.push({ ...row, fresh });
  }
  return drift;
}

/** Test-tier convenience; also what 6B's catalogue mirror reads through the sync endpoint. */
export async function readSnapshot(tx: Sql, principalId: string): Promise<CashierSnapshot> {
  const [row] = await tx<
    { snapshot: CashierSnapshot }[]
  >`select snapshot from app.pos_cashier where principal_id = ${principalId}`;
  return row!.snapshot;
}

export interface CashierRow {
  principalId: string;
  employeeId: string;
  employeeNumber: string | null;
  branchId: string;
  pinUpdatedAt: string;
  revokedAt: string | null;
  revision: string;
  snapshot: CashierSnapshot;
}
const SELECT = (tx: Sql) =>
  tx`select c.principal_id as "principalId",c.employee_id as "employeeId",identity.employee_number as "employeeNumber",c.branch_id as "branchId",to_char(c.pin_updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "pinUpdatedAt",to_char(c.revoked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "revokedAt",c.revision::text as revision,c.snapshot from app.pos_cashier c left join lateral app.resolve_cashier_employee(c.company_id,c.branch_id,c.principal_id) identity on true`;
export async function getCashier(
  tx: Sql,
  companyId: string,
  principalId: string,
): Promise<CashierRow | null> {
  const [row] = await tx<
    CashierRow[]
  >`${SELECT(tx)} where c.company_id=${companyId} and c.principal_id=${principalId}`;
  return row ?? null;
}
export async function listCashiers(
  tx: Sql,
  companyId: string,
  opts: { limit: number; cursor?: { id: string }; branchId?: string },
): Promise<{ rows: CashierRow[]; nextCursor: string | null }> {
  const rows = await tx<
    CashierRow[]
  >`${SELECT(tx)} where c.company_id=${companyId} and app.actor_has('pos.cashier.manage_pin',c.company_id,c.branch_id) and (${opts.branchId ?? null}::uuid is null or c.branch_id=${opts.branchId ?? null}::uuid) and (${opts.cursor?.id ?? null}::uuid is null or c.principal_id>${opts.cursor?.id ?? null}::uuid) order by c.principal_id limit ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit);
  return { rows: page, nextCursor: rows.length > opts.limit ? page.at(-1)!.principalId : null };
}
export async function createCashier(
  tx: Sql,
  companyId: string,
  input: { principalId: string; employeeId: string; branchId: string; pinHash: string },
): Promise<CashierRow> {
  const [row] = await tx<
    { principal_id: string }[]
  >`insert into app.pos_cashier(principal_id,tenant_id,company_id,employee_id,branch_id,pin_hash) select ${input.principalId},app.current_tenant(),${companyId},e.id,v.id,${input.pinHash} from app.employee e join app.dimension_value v on v.id=${input.branchId} and v.tenant_id=e.tenant_id join app.dimension_type t on t.id=v.dimension_type_id and t.tenant_id=v.tenant_id where e.id=${input.employeeId} and e.company_id=${companyId} and e.principal_id=${input.principalId} and e.terminated_on is null and t.company_id=${companyId} and t.code='BRANCH' and v.archived_at is null returning principal_id`;
  if (!row) throw new SyncError("ERR_NOT_FOUND", "employee or branch is not visible");
  await tx`select app.refresh_pos_cashier(${input.principalId})`;
  return (await getCashier(tx, companyId, input.principalId))!;
}
export async function setCashierPin(
  tx: Sql,
  companyId: string,
  principalId: string,
  pinHash: string,
): Promise<CashierRow | null> {
  const rows =
    await tx`update app.pos_cashier set pin_hash=${pinHash},pin_updated_at=now() where company_id=${companyId} and principal_id=${principalId} and revoked_at is null`;
  return rows.count === 0 ? null : getCashier(tx, companyId, principalId);
}
export async function revokeCashier(
  tx: Sql,
  companyId: string,
  principalId: string,
): Promise<CashierRow | null> {
  if (!(await getCashier(tx, companyId, principalId))) return null;
  const rows =
    await tx`update app.pos_cashier set revoked_at=now() where company_id=${companyId} and principal_id=${principalId} and revoked_at is null`;
  if (rows.count > 0) await tx`select app.refresh_pos_cashier(${principalId})`;
  return getCashier(tx, companyId, principalId);
}
