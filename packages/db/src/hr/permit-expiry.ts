import type { Sql } from "postgres";
import type { HrKeyRing } from "./keys";
import { openField } from "./sensitive";

// 8D amendment A3 (contracts round 19). spec:2091's "contract and permit expiry list" has two halves that live in two
// places: the CONTRACT half is `app.employee.contract_ends_on` (8D A2) and is served by the `hr.contract_expiry`
// report; the PERMIT half is `employee_sensitive.work_permit_expiry_enc` — ciphertext — so no `DatasetId` can serve it
// (a dataset returns SQL scalars and cannot decrypt, and a report run executes as the system principal).
//
// The gate is RLS, not a branch in this file: `sensitive_gate` is RESTRICTIVE (spec:2076, migration 0081), so a caller
// without `hr.employee.read_sensitive` reads ZERO `employee_sensitive` rows and receives an empty list — never a
// partial row and never an error that reveals how many rows exist (test 32). The route adds the 403 in front of it.

export interface PermitExpiryParams {
  companyId: string;
  /** Rows whose permit expires within this many days of today — a lapsed permit (negative days) always qualifies. */
  withinDays: number;
  /** Default false: a leaver's permit is not the employer's to renew. */
  includeTerminated?: boolean;
}

export interface PermitExpiryRow {
  employeeId: string;
  employeeNumber: string;
  employeeNameEn: string;
  branchCode: string;
  position: string | null;
  /** YYYY-MM-DD, decrypted from `employee_sensitive.work_permit_expiry_enc`. Never null in a returned row. */
  workPermitExpiry: string;
  /** Whole days from today — the company's calendar day — to the expiry; negative once it has lapsed. */
  daysRemaining: number;
}

interface Raw {
  employee_id: string;
  employee_number: string;
  employee_name_en: string;
  branch_code: string;
  position: string | null;
  work_permit_expiry_enc: Buffer;
  today: string;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date as whole days since the epoch — integer arithmetic on a date, never a clock read. */
function dayNumber(isoDate: string): number | null {
  const m = ISO_DATE.exec(isoDate);
  if (m === null) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

export async function permitExpiry(
  tx: Sql,
  ring: HrKeyRing,
  params: PermitExpiryParams,
): Promise<PermitExpiryRow[]> {
  const includeTerminated = params.includeTerminated ?? false;
  // "Today" is the COMPANY's calendar day, read from the database clock in the same statement — so the day count is
  // the one an operator in that timezone means, and two rows of one call can never straddle a midnight.
  const rows = await tx<Raw[]>`
    select e.id                                                   as employee_id,
           e.employee_number                                      as employee_number,
           p.name_en                                              as employee_name_en,
           bv.code                                                as branch_code,
           e.position                                             as position,
           es.work_permit_expiry_enc                              as work_permit_expiry_enc,
           to_char((now() at time zone co.timezone)::date, 'YYYY-MM-DD') as today
      from app.employee_sensitive es
      join app.employee        e  on e.id  = es.employee_id
      join app.company         co on co.id = e.company_id
      join app.party           p  on p.id  = e.party_id
      join app.dimension_value bv on bv.id = e.home_branch_id
     where e.company_id = ${params.companyId}::uuid
       and es.work_permit_expiry_enc is not null
       and (${includeTerminated}::boolean or e.terminated_on is null)
     order by e.employee_number`;

  // The date is decrypted here, so the WINDOW is applied here too — SQL cannot compare against ciphertext, and a
  // plaintext copy kept beside it to make it sortable is exactly the side channel §4.12.5 exists to prevent.
  const out: PermitExpiryRow[] = [];
  for (const r of rows) {
    const expiry = openField(ring, r.employee_id, "work_permit_expiry", r.work_permit_expiry_enc);
    const expiryDay = dayNumber(expiry);
    const today = dayNumber(r.today);
    // A value the writer stored that is not a calendar date is not a permit date this list can order; it is
    // skipped rather than guessed at (the sensitive route stores what the officer typed).
    if (expiryDay === null || today === null) continue;
    const daysRemaining = expiryDay - today;
    if (daysRemaining > params.withinDays) continue;
    out.push({
      employeeId: r.employee_id,
      employeeNumber: r.employee_number,
      employeeNameEn: r.employee_name_en,
      branchCode: r.branch_code,
      position: r.position,
      workPermitExpiry: expiry,
      daysRemaining,
    });
  }
  return out.toSorted(
    (a, b) =>
      a.workPermitExpiry.localeCompare(b.workPermitExpiry) ||
      a.employeeNumber.localeCompare(b.employeeNumber),
  );
}
