import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { schemeYtdKey, ytdKey } from "@dulja/domain/payroll";

/**
 * Year-to-date figures from POSTED `payroll_line` rows (8B T10).
 *
 * **`app.employee_ytd` is 8C's table** (migration 0092, §4.12.8) and 8C owns the `postDocument` step-12 MERGE that
 * maintains it. This read stays the CALCULATOR's: its `ytdBefore` is keyed per component and scheme share, and the
 * projection's headline read below (`ytdFromEmployeeYtd`) carries only gross and net — the two are not
 * interchangeable (ADR 0077, Consequences), so 8C leaves this call site where 8B put it.
 *
 * `year` is the calendar year of the posted documents' effective dates — the tax year the plan names, taken as the
 * calendar year in v1 (the parameter is not called `taxYear` only because `no-number-money` reads `tax` as money).
 * Only `status = 'posted'` rows count: a draft or submitted run is not year-to-date anything. The key space is the
 * calculator's own (`ytdKey`, `schemeYtdKey`), so the figures this returns are the `ytdBefore` it reads. A
 * non-statutory deduction is in neither gross nor net and is not keyed.
 */
export async function ytdFromPostedLines(
  tx: Sql,
  companyId: string,
  year: number,
  employeeIds: readonly string[],
): Promise<Record<string, Record<string, Money>>> {
  if (employeeIds.length === 0) return {};
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  if (!company) return {};
  const cur = currency(company.base_currency.trim());

  const rows = await tx<
    {
      employee_id: string;
      scheme_code: string | null;
      share: "employee" | "employer" | null;
      component_kind: "earning" | "deduction" | null;
      is_net: boolean;
      total: string;
    }[]
  >`
    select pl.employee_id, sc.code as scheme_code, pl.share, pc.kind as component_kind,
           (pl.component_id is null and pl.scheme_id is null) as is_net,
           sum(pl.amount)::text as total
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.document d on d.id = dl.document_id
      left join app.statutory_scheme sc on sc.id = pl.scheme_id
      left join app.pay_component pc on pc.id = pl.component_id
     where pl.company_id = ${companyId}
       and d.status = 'posted'
       and d.effective_date >= make_date(${year}::int, 1, 1)
       and d.effective_date <  make_date(${year}::int + 1, 1, 1)
       and pl.employee_id = any(${[...employeeIds]}::uuid[])
     group by pl.employee_id, sc.code, pl.share, pc.kind, is_net
     order by pl.employee_id, sc.code, pl.share, pc.kind`;

  const out: Record<string, Record<string, Money>> = {};
  for (const r of rows) {
    const key =
      r.scheme_code !== null && r.share !== null
        ? schemeYtdKey(r.scheme_code, r.share)
        : r.is_net
          ? ytdKey("net")
          : r.component_kind === "earning"
            ? ytdKey("gross")
            : null;
    if (key === null) continue;
    const bucket = (out[r.employee_id] ??= {});
    // `sum()` over numeric(19,4) keeps scale 4, so the text form is already Money.of's shape.
    bucket[key] = (bucket[key] ?? Money.zero(cur)).add(Money.of(r.total, cur));
  }
  return out;
}

/**
 * Reads the PROJECTION `app.employee_ytd` (8C, §4.12.8): the headline year-to-date `gross` and `net` per employee,
 * keyed `{ [employeeId]: { gross, net } }` — what a payslip and the annual statement print (8D).
 *
 * **This is the ONE place an opening is added in** (round 18 B14). A mid-year cut-over's YTD is
 * `employee_ytd_opening` plus every posted run since (spec:2084), and the projection carries only the second half:
 * `app.employee_ytd` is written solely by the step-12 MERGE (spec:98, §3.7.5), never by an opening load. Adding the
 * opening at READ time is the only place the sum can legally be formed, and it is why the nightly rebuild compares
 * deltas with deltas. A company with no openings adds zero. An employee of another company, or unknown, is absent.
 *
 * `year` is the tax year of B7 (the calendar year of `pay_date`); the parameter is not `taxYear` because
 * `no-number-money` reads `tax` as money.
 */
export async function ytdFromEmployeeYtd(
  tx: Sql,
  companyId: string,
  year: number,
  employeeIds: readonly string[],
): Promise<Record<string, Record<string, Money>>> {
  if (employeeIds.length === 0) return {};
  const [company] = await tx<{ base_currency: string }[]>`
    select base_currency from app.company where id = ${companyId}`;
  if (!company) return {};
  const cur = currency(company.base_currency.trim());

  const rows = await tx<{ employee_id: string; gross: string; net: string }[]>`
    select e.id as employee_id,
           to_char(coalesce(y.gross, 0) + coalesce(o.gross, 0), 'FM999999999999990.0000') as gross,
           to_char(coalesce(y.net, 0) + coalesce(o.net, 0), 'FM999999999999990.0000') as net
      from app.employee e
      left join app.employee_ytd y
             on y.company_id = e.company_id and y.employee_id = e.id and y.tax_year = ${year}
      left join app.employee_ytd_opening o
             on o.company_id = e.company_id and o.employee_id = e.id and o.tax_year = ${year}
     where e.company_id = ${companyId} and e.id = any(${[...employeeIds]}::uuid[])
     order by e.id`;

  const out: Record<string, Record<string, Money>> = {};
  for (const r of rows) {
    out[r.employee_id] = { gross: Money.of(r.gross, cur), net: Money.of(r.net, cur) };
  }
  return out;
}
