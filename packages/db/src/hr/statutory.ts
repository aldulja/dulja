import type { RoundingMode } from "@dulja/domain";
import type { Sql } from "postgres";

/** 8A, migration 0084 — §3.10.1 "Statutory schemes as data" (spec:2080). A scheme is a ROW, never an enum. */
export interface StatutoryScheme {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  payableAccountId: string | null;
  employerExpenseAccountId: string | null;
  authorityPartyId: string | null;
  employerRegistration: string | null;
  roundingMode: RoundingMode;
}

/** One version of one scheme's rate table. `definition` is `unknown` on purpose: `packages/db` may not narrow a
 *  shape that lives in `packages/domain/payroll`, and every reader parses it with `parseRateTable` (8A Task 9). */
export interface RateTableRow {
  id: string;
  schemeId: string;
  schemeCode: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  definition: unknown;
  source: string;
  loadedBy: string;
  verifiedBy: string | null;
  /** RFC 3339 UTC, or null while the table awaits its second principal. */
  verifiedAt: string | null;
}

interface RawScheme {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  payable_account_id: string | null;
  employer_expense_account_id: string | null;
  authority_party_id: string | null;
  employer_registration: string | null;
  rounding_mode: RoundingMode;
}

/** Every scheme of one company, by code. The company is a parameter, never inferred: RLS bounds the tenant only. */
export async function listSchemes(tx: Sql, companyId: string): Promise<StatutoryScheme[]> {
  const rows = await tx<RawScheme[]>`
    select id, code, name_en, name_ar, payable_account_id, employer_expense_account_id,
           authority_party_id, employer_registration, rounding_mode
      from app.statutory_scheme where company_id = ${companyId}::uuid order by code`;
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    payableAccountId: r.payable_account_id,
    employerExpenseAccountId: r.employer_expense_account_id,
    authorityPartyId: r.authority_party_id,
    employerRegistration: r.employer_registration,
    roundingMode: r.rounding_mode,
  }));
}

interface RawTable {
  id: string;
  scheme_id: string;
  scheme_code: string;
  version: number;
  effective_from: string;
  effective_to: string | null;
  definition: unknown;
  source: string;
  loaded_by: string;
  verified_by: string | null;
  verified_at: string | null;
}

const toTable = (r: RawTable): RateTableRow => ({
  id: r.id,
  schemeId: r.scheme_id,
  schemeCode: r.scheme_code,
  version: r.version,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  definition: r.definition,
  source: r.source,
  loadedBy: r.loaded_by,
  verifiedBy: r.verified_by,
  verifiedAt: r.verified_at,
});

/** Every version of one scheme's table, newest version first. */
export async function listRateTables(tx: Sql, schemeId: string): Promise<RateTableRow[]> {
  const rows = await tx<RawTable[]>`
    select t.id, t.scheme_id, s.code as scheme_code, t.version,
           t.effective_from::text as effective_from, t.effective_to::text as effective_to,
           t.definition, t.source, t.loaded_by, t.verified_by,
           to_char(t.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as verified_at
      from app.statutory_rate_table t join app.statutory_scheme s on s.id = t.scheme_id
     where t.scheme_id = ${schemeId}::uuid order by t.version desc`;
  return rows.map(toTable);
}

/** Only a VERIFIED table covering `on` (spec:2080, LEGACY-020). 8B's RateTableRef is built from this, and 8B's
 *  unverified-table refusal is what it raises when this returns null — 8B does not re-check `verified_at`. */
export async function rateTableOn(
  tx: Sql,
  schemeId: string,
  on: string,
): Promise<RateTableRow | null> {
  const [row] = await tx<RawTable[]>`
    select t.id, t.scheme_id, s.code as scheme_code, t.version,
           t.effective_from::text as effective_from, t.effective_to::text as effective_to,
           t.definition, t.source, t.loaded_by, t.verified_by,
           to_char(t.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as verified_at
      from app.statutory_rate_table t join app.statutory_scheme s on s.id = t.scheme_id
     where t.scheme_id = ${schemeId}::uuid and t.verified_at is not null
       and t.effective_from <= ${on}::date and (t.effective_to is null or t.effective_to >= ${on}::date)
     order by t.effective_from desc, t.version desc limit 1`;
  return row === undefined ? null : toTable(row);
}

/** Stores a table UNVERIFIED; `loaded_by` is stamped from the session (LEGACY-044). The caller has already validated
 *  `definition` against the rate-table schema — this function writes a row and decides nothing about its shape. */
export async function loadRateTable(
  tx: Sql,
  input: {
    schemeId: string;
    version: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    definition: unknown;
    source: string;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, effective_to, definition, source)
    select s.tenant_id, s.id, ${input.version}::int, ${input.effectiveFrom}::date,
           ${input.effectiveTo}::date, ${tx.json(input.definition as never)}, ${input.source}
      from app.statutory_scheme s where s.id = ${input.schemeId}::uuid
    returning id`;
  if (row === undefined)
    throw new Error(`statutory scheme ${input.schemeId} is not visible to this transaction`);
  return row.id;
}

/** Thrown by `verifyRateTable` when there is nothing left to verify: the id is not visible, or it already carries a
 *  verification. A distinct class so a route can answer 404/409 rather than 500. */
export class RateTableNotVerifiableError extends Error {
  constructor(readonly rateTableId: string) {
    super(`rate table ${rateTableId} is not visible, or is already verified`);
    this.name = "RateTableNotVerifiableError";
  }
}

/** `verified_by` is written as `app.current_actor()`, and `stamp_verified_by` would overwrite any other value with the
 *  same one (LEGACY-044). The trigger compares the session's actor to `OLD.loaded_by` and raises ERR_HR_SELF_VERIFY when
 *  they match; `where verified_at is null` makes a second verification a refusal the caller is told about rather than a
 *  silent success. */
export async function verifyRateTable(tx: Sql, rateTableId: string): Promise<void> {
  const res = await tx`
    update app.statutory_rate_table
       set verified_at = now(), verified_by = app.current_actor()
     where id = ${rateTableId}::uuid and verified_at is null`;
  if (res.count === 0) throw new RateTableNotVerifiableError(rateTableId);
}

/** spec:2109's sixty-day warning. A table is lapsing when it is verified, its effective_to falls inside
 *  [asOf, asOf + horizonDays], and NO later verified version of the same scheme starts on or before the day after
 *  it. `companyId` narrows the read to one company's schemes; omitted, the whole tenant is read. */
export async function lapsingTables(
  tx: Sql,
  asOf: string,
  horizonDays: number,
  opts: { companyId?: string } = {},
): Promise<RateTableRow[]> {
  const rows = await tx<RawTable[]>`
    select t.id, t.scheme_id, s.code as scheme_code, t.version,
           t.effective_from::text as effective_from, t.effective_to::text as effective_to,
           t.definition, t.source, t.loaded_by, t.verified_by,
           to_char(t.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as verified_at
      from app.statutory_rate_table t join app.statutory_scheme s on s.id = t.scheme_id
     where t.verified_at is not null
       and t.effective_to is not null
       and t.effective_to >= ${asOf}::date
       and t.effective_to <= ${asOf}::date + ${horizonDays}::int
       and (${opts.companyId ?? null}::uuid is null or s.company_id = ${opts.companyId ?? null}::uuid)
       and not exists (
         select 1 from app.statutory_rate_table n
          where n.scheme_id = t.scheme_id and n.verified_at is not null
            and n.version > t.version
            and n.effective_from <= t.effective_to + 1)
     order by t.effective_to, s.code`;
  return rows.map(toTable);
}
