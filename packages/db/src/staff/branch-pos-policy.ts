import type { Sql } from "postgres";
import { SyncError } from "../sync/enrolment";

export interface BranchPosPolicyRow {
  id: string;
  companyId: string;
  branchId: string;
  maxLineDiscountPct: string;
  maxTicketDiscountPct: string;
  maxVoidAmount: string;
  maxPriceOverridePct: string;
  blindReturnAllowed: boolean;
  maxBlindReturnAmount: string;
  maxCashInDrawer: string | null;
  requireCustomerOver: string | null;
  roundingIncrement: string;
  paidOutAllowed: boolean;
  maxPaidOutAmount: string;
  revision: string;
  createdAt: string;
}

export interface BranchPosPolicyInput {
  branchId: string;
  maxLineDiscountPct?: string;
  maxTicketDiscountPct?: string;
  maxVoidAmount?: string;
  maxPriceOverridePct?: string;
  blindReturnAllowed?: boolean;
  maxBlindReturnAmount?: string;
  maxCashInDrawer?: string | null;
  requireCustomerOver?: string | null;
  roundingIncrement?: string;
  paidOutAllowed?: boolean;
  maxPaidOutAmount?: string;
}

const SELECT = (tx: Sql) => tx`
  select id, company_id as "companyId", branch_id as "branchId",
         max_line_discount_pct::text   as "maxLineDiscountPct",
         max_ticket_discount_pct::text as "maxTicketDiscountPct",
         max_void_amount::text         as "maxVoidAmount",
         max_price_override_pct::text  as "maxPriceOverridePct",
         blind_return_allowed          as "blindReturnAllowed",
         max_blind_return_amount::text as "maxBlindReturnAmount",
         max_cash_in_drawer::text      as "maxCashInDrawer",
         require_customer_over::text   as "requireCustomerOver",
         rounding_increment::text      as "roundingIncrement",
         paid_out_allowed              as "paidOutAllowed",
         max_paid_out_amount::text     as "maxPaidOutAmount",
         revision::text                as "revision",
         to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
    from app.branch_pos_policy`;

/** One policy per branch. A second PUT for the same branch edits the row and bumps its revision. */
export async function upsertBranchPosPolicy(
  tx: Sql,
  companyId: string,
  input: BranchPosPolicyInput,
): Promise<BranchPosPolicyRow> {
  const [branch] =
    await tx`select 1 from app.dimension_value v join app.dimension_type t on t.id=v.dimension_type_id and t.tenant_id=v.tenant_id where v.id=${input.branchId} and t.company_id=${companyId} and t.code='BRANCH'`;
  if (!branch) throw new SyncError("ERR_NOT_FOUND", "branch is not visible");
  const [row] = await tx<BranchPosPolicyRow[]>`
    insert into app.branch_pos_policy
      (tenant_id, company_id, branch_id, max_line_discount_pct, max_ticket_discount_pct, max_void_amount,
       max_price_override_pct, blind_return_allowed, max_blind_return_amount, max_cash_in_drawer,
       require_customer_over, rounding_increment, paid_out_allowed, max_paid_out_amount)
    values (app.current_tenant(), ${companyId}, ${input.branchId},
            coalesce(${input.maxLineDiscountPct ?? null}::numeric, 0),
            coalesce(${input.maxTicketDiscountPct ?? null}::numeric, 0),
            coalesce(${input.maxVoidAmount ?? null}::numeric, 0),
            coalesce(${input.maxPriceOverridePct ?? null}::numeric, 0),
            coalesce(${input.blindReturnAllowed ?? null}::boolean, false),
            coalesce(${input.maxBlindReturnAmount ?? null}::numeric, 0),
            ${input.maxCashInDrawer ?? null}::numeric,
            ${input.requireCustomerOver ?? null}::numeric,
            coalesce(${input.roundingIncrement ?? null}::numeric, 0.05),
            coalesce(${input.paidOutAllowed ?? null}::boolean, false),
            coalesce(${input.maxPaidOutAmount ?? null}::numeric, 0))
    on conflict (company_id, branch_id) do update set
      max_line_discount_pct   = coalesce(${input.maxLineDiscountPct ?? null}::numeric, app.branch_pos_policy.max_line_discount_pct),
      max_ticket_discount_pct = coalesce(${input.maxTicketDiscountPct ?? null}::numeric, app.branch_pos_policy.max_ticket_discount_pct),
      max_void_amount         = coalesce(${input.maxVoidAmount ?? null}::numeric, app.branch_pos_policy.max_void_amount),
      max_price_override_pct  = coalesce(${input.maxPriceOverridePct ?? null}::numeric, app.branch_pos_policy.max_price_override_pct),
      blind_return_allowed    = coalesce(${input.blindReturnAllowed ?? null}::boolean, app.branch_pos_policy.blind_return_allowed),
      max_blind_return_amount = coalesce(${input.maxBlindReturnAmount ?? null}::numeric, app.branch_pos_policy.max_blind_return_amount),
      max_cash_in_drawer      = case when ${Object.hasOwn(input, "maxCashInDrawer")} then ${input.maxCashInDrawer ?? null}::numeric else app.branch_pos_policy.max_cash_in_drawer end,
      require_customer_over   = case when ${Object.hasOwn(input, "requireCustomerOver")} then ${input.requireCustomerOver ?? null}::numeric else app.branch_pos_policy.require_customer_over end,
      rounding_increment      = coalesce(${input.roundingIncrement ?? null}::numeric, app.branch_pos_policy.rounding_increment),
      paid_out_allowed        = coalesce(${input.paidOutAllowed ?? null}::boolean, app.branch_pos_policy.paid_out_allowed),
      max_paid_out_amount     = coalesce(${input.maxPaidOutAmount ?? null}::numeric, app.branch_pos_policy.max_paid_out_amount)
    returning id, company_id as "companyId", branch_id as "branchId",
              max_line_discount_pct::text as "maxLineDiscountPct", max_ticket_discount_pct::text as "maxTicketDiscountPct",
              max_void_amount::text as "maxVoidAmount", max_price_override_pct::text as "maxPriceOverridePct",
              blind_return_allowed as "blindReturnAllowed", max_blind_return_amount::text as "maxBlindReturnAmount",
              max_cash_in_drawer::text as "maxCashInDrawer", require_customer_over::text as "requireCustomerOver",
              rounding_increment::text as "roundingIncrement", paid_out_allowed as "paidOutAllowed",
              max_paid_out_amount::text as "maxPaidOutAmount", revision::text as "revision", to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`;
  return row!;
}

/**
 * `SELECT(tx)` returns a postgres.js **query object**, not a function, so it can only be INTERPOLATED into
 * another tagged template — `` tx`${SELECT(tx)} where …` `` — never called as a tag itself. The earlier
 * form, `` SELECT(tx)`where …` ``, is a `TypeError: SELECT(...) is not a function` at the first call, and
 * an `as unknown as BranchPosPolicyRow[]` cast is what would hide it from `typecheck`. There is no cast
 * here for exactly that reason: the tag's own type parameter carries the shape.
 */
export async function getBranchPosPolicy(
  tx: Sql,
  companyId: string,
  branchId: string,
): Promise<BranchPosPolicyRow | null> {
  const rows = await tx<BranchPosPolicyRow[]>`
    ${SELECT(tx)} where company_id = ${companyId} and branch_id = ${branchId}`;
  return rows[0] ?? null;
}

export async function listBranchPosPolicies(
  tx: Sql,
  companyId: string,
  opts: { limit: number; cursor?: { id: string }; branchId?: string },
): Promise<{ rows: BranchPosPolicyRow[]; nextCursor: string | null }> {
  const rows = await tx<BranchPosPolicyRow[]>`
    ${SELECT(tx)}
     where company_id = ${companyId}
       and app.actor_has('admin.company.manage',company_id,branch_id)
       and (${opts.branchId ?? null}::uuid is null or branch_id = ${opts.branchId ?? null}::uuid)
       and (${opts.cursor?.id ?? null}::uuid is null or id > ${opts.cursor?.id ?? null}::uuid)
     order by id
     limit ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit);
  return { rows: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}
