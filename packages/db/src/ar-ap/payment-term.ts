import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

/**
 * contracts §4.6.1 — `app.payment_term` (4A, migration 0044), the terms an invoice is aged on (spec:1042).
 * Master data: created, edited, ARCHIVED, never deleted (spec:2049). `code` is never renamed.
 *
 * `discountPct` is a 6-dp decimal STRING — a fraction, `0.020000` is two per cent — and nothing in 4A computes
 * with it: the early-settlement discount is a later capability, and 4B ages on `due_days` alone (§4.8.2).
 */
export interface PaymentTermRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  dueDays: number;
  discountDays: number | null;
  discountPct: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface CreatePaymentTermInput {
  companyId: string;
  code: string;
  nameEn: string;
  nameAr?: string | null | undefined;
  dueDays: number;
  discountDays?: number | null | undefined;
  discountPct?: string | null | undefined;
}

/**
 * `code` is deliberately absent: renaming an identifier is forbidden (§3.4.7 applied to data). `companyId` is
 * required, not optional: RLS bounds the tenant and nothing else, so an id alone would reach a sibling
 * company's term inside the same tenant (AGENTS.md, the endpoint rule) — the caller passes the company its
 * permission gate cleared and the row is matched on both.
 */
export interface UpdatePaymentTermInput {
  companyId: string;
  paymentTermId: string;
  nameEn?: string | undefined;
  nameAr?: string | null | undefined;
  dueDays?: number | undefined;
  discountDays?: number | null | undefined;
  discountPct?: string | null | undefined;
}

export interface ListPaymentTermsInput {
  companyId: string;
  includeArchived?: boolean;
  cursor?: { code: string } | null;
  limit: number;
}

interface DbPaymentTerm {
  id: string;
  company_id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  due_days: number;
  discount_days: number | null;
  discount_pct: string | null;
  archived_at: Date | null;
  created_at: Date;
}

/**
 * `packages/db` may not import `@dulja/contracts` (contracts §3.1), so it cannot throw `AppError`. A thrown
 * error carrying an existing ErrCode as `code` is what the API's `fromDomainError` lifts into one — the same
 * declared shape `ItemAccountUnresolvedError` and `LandedCostError` use. It introduces no new error code.
 */
function codedError(
  code: "ERR_NOT_FOUND" | "ERR_CONFLICT_UNIQUE" | "ERR_VALIDATION_FAILED",
  detail: string,
): Error {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

/** The three CHECKs of migration 0044. A bare 23514 carries no ERR_ token and would surface as a 500. */
const CHECKS: Readonly<Record<string, string>> = {
  payment_term_due_days_check: "dueDays cannot be negative",
  payment_term_discount_pct_check: "discountPct must lie strictly between 0 and 1",
  payment_term_discount_window_check:
    "discountDays and discountPct travel together, and discountDays cannot exceed dueDays",
};

/**
 * Lifts the table's own constraint violations into coded errors with FIXED details — the driver's text
 * quotes the rejected value straight back (SAH-083). Anything else is rethrown untouched.
 */
function translate(error: unknown): never {
  const constraint = (error as { constraint_name?: unknown }).constraint_name;
  if (constraint === "payment_term_company_id_code_key")
    throw codedError("ERR_CONFLICT_UNIQUE", "a payment term with this code already exists");
  if (typeof constraint === "string" && constraint in CHECKS)
    throw codedError("ERR_VALIDATION_FAILED", CHECKS[constraint]!);
  throw error;
}

/** The one projection every reader of this table uses, so `discount_pct` is text in exactly one place. */
const COLUMNS = (tx: Sql) => tx`
  id, company_id, code, name_en, name_ar, due_days::int as due_days,
  discount_days::int as discount_days, discount_pct::text as discount_pct, archived_at, created_at`;

const toRow = (r: DbPaymentTerm): PaymentTermRow => ({
  id: r.id,
  companyId: r.company_id,
  code: r.code,
  nameEn: r.name_en,
  nameAr: r.name_ar,
  dueDays: r.due_days,
  discountDays: r.discount_days,
  discountPct: r.discount_pct,
  // ISO 8601 here, once, so the row is what `TimestampSchema` on the wire says it is.
  archivedAt: r.archived_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export async function createPaymentTerm(
  tx: Sql,
  _ctx: TenantContext,
  input: CreatePaymentTermInput,
): Promise<PaymentTermRow> {
  try {
    const [row] = await tx<DbPaymentTerm[]>`
      insert into app.payment_term
        (tenant_id, company_id, code, name_en, name_ar, due_days, discount_days, discount_pct)
      values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn},
              ${input.nameAr ?? null}, ${input.dueDays}, ${input.discountDays ?? null},
              ${input.discountPct ?? null})
      returning ${COLUMNS(tx)}`;
    return toRow(row!);
  } catch (error) {
    return translate(error);
  }
}

export async function updatePaymentTerm(
  tx: Sql,
  _ctx: TenantContext,
  input: UpdatePaymentTermInput,
): Promise<PaymentTermRow> {
  let row: DbPaymentTerm | undefined;
  try {
    [row] = await tx<DbPaymentTerm[]>`
      update app.payment_term set
        name_en       = coalesce(${input.nameEn ?? null}, name_en),
        name_ar       = case when ${input.nameAr !== undefined} then ${input.nameAr ?? null} else name_ar end,
        due_days      = coalesce(${input.dueDays ?? null}::int, due_days),
        discount_days = case when ${input.discountDays !== undefined} then ${input.discountDays ?? null}::int
                             else discount_days end,
        discount_pct  = case when ${input.discountPct !== undefined} then ${input.discountPct ?? null}::numeric
                             else discount_pct end
       where id = ${input.paymentTermId} and company_id = ${input.companyId}
      returning ${COLUMNS(tx)}`;
  } catch (error) {
    return translate(error);
  }
  if (row === undefined)
    throw codedError("ERR_NOT_FOUND", `payment term ${input.paymentTermId} is not visible`);
  return toRow(row);
}

/** spec:2049 — archived, never deleted. Idempotent: a second call keeps the first `archived_at`. */
export async function archivePaymentTerm(
  tx: Sql,
  _ctx: TenantContext,
  input: { companyId: string; paymentTermId: string },
): Promise<PaymentTermRow> {
  const [row] = await tx<DbPaymentTerm[]>`
    update app.payment_term set archived_at = coalesce(archived_at, now())
     where id = ${input.paymentTermId} and company_id = ${input.companyId}
    returning ${COLUMNS(tx)}`;
  if (row === undefined)
    throw codedError("ERR_NOT_FOUND", `payment term ${input.paymentTermId} is not visible`);
  return toRow(row);
}

/** Keyset-paged on `code`, which `unique (company_id, code)` makes a total order within a company. */
export async function listPaymentTerms(
  tx: Sql,
  input: ListPaymentTermsInput,
): Promise<PaymentTermRow[]> {
  const rows = await tx<DbPaymentTerm[]>`
    select ${COLUMNS(tx)} from app.payment_term
     where company_id = ${input.companyId}
       and (${input.includeArchived ?? false} or archived_at is null)
       and (${input.cursor?.code ?? null}::text is null or code > ${input.cursor?.code ?? null})
     order by code
     limit ${input.limit}`;
  return rows.map(toRow);
}

/**
 * The party's current term. Read at DRAFT time only; the document pins the id (§4.3.4, SAH-013).
 *
 * **This is the only reader of `app.party.payment_term_id` in the slice** — `convertToInvoice` (Task 6) and
 * `draftSettlement` (Task 10) both call it instead of carrying an inline subquery, because two spellings of
 * one fact is what §4.17's register exists to prevent. `null` means "the party has no term"; an invisible
 * party RAISES, so a caller that needs to know the party exists needs no probe of its own.
 *
 * The column arrives with Task 3's migration 0045; the read is a tagged template, not the Drizzle mirror, so
 * it typechecks before then, and its DB-tier case is in Task 3's `credit-control.test.ts`.
 */
export async function resolvePartyTerm(
  tx: Sql,
  input: { partyId: string },
): Promise<string | null> {
  const [row] = await tx<{ paymentTermId: string | null }[]>`
    select payment_term_id as "paymentTermId" from app.party where id = ${input.partyId}`;
  if (row === undefined) throw codedError("ERR_NOT_FOUND", `party ${input.partyId} is not visible`);
  return row.paymentTermId;
}

/**
 * `effective_date + due_days` through `app.payment_due_date` — one implementation, in SQL, so no JavaScript
 * date arithmetic and no timezone can enter it (§4.8.2). A null `paymentTermId` returns `effectiveDate`
 * unchanged — due on the day. A term the caller cannot see is ERR_NOT_FOUND, never a null date.
 */
export async function dueDateFor(
  tx: Sql,
  input: { paymentTermId: string | null; effectiveDate: string },
): Promise<string> {
  const [row] = await tx<{ due: string | null }[]>`
    select to_char(app.payment_due_date(${input.paymentTermId}::uuid, ${input.effectiveDate}::date),
                   'YYYY-MM-DD') as due`;
  if (row?.due == null)
    throw codedError("ERR_NOT_FOUND", `payment term ${input.paymentTermId} is not visible`);
  return row.due;
}
