import type { Sql } from "postgres";
import type { Money } from "@dulja/domain";
import type { TenantContext } from "../with-tenant";

/**
 * 8C T9 — the cut-over openings (spec:2084: "employee_ytd_opening rows are loaded at cut-over so a mid-year switch
 * computes PCB correctly (Phase 9)"). Loaded by **9B's importer** under `systemContext`; there is no route (round 18
 * B10) and no screen.
 *
 * These functions write `app.employee_ytd_opening` and **never `app.employee_ytd`** (B14): the projection is
 * posting-service-only (spec:98, `posting-only-tables`) and Σ posted deltas on both sides of the nightly compare. An
 * opening meets the projection at READ time, in `ytdFromEmployeeYtd`.
 *
 * `packages/db` may not import `AppError` (§3.1), so a refusal carries a literal `code` for the importer to translate.
 */
export type OpeningErrorCode = "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND";

export class OpeningError extends Error {
  constructor(
    readonly code: OpeningErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "OpeningError";
  }
}

export interface EmployeeYtdOpeningInput {
  companyId: string;
  employeeId: string;
  /** `employee_ytd_opening.tax_year` — the calendar year of the pay dates it covers (round 18 B7). Named `year`, not
   *  the plan's `taxYear`, because `no-number-money` reads `tax` as money (the 8C T3 precedent). */
  year: number;
  gross: Money;
  net: Money;
  /** `{ "<pay_component.code>": "<fixed-scale amount>" }`. */
  byComponent: Readonly<Record<string, string>>;
  /** `{ "<statutory_scheme.code>": { employee, employer } }`, fixed-scale amounts. */
  byScheme: Readonly<Record<string, { employee: string; employer: string }>>;
  /** Provenance: `legacy:<run>` from the importer, or `manual:<reason>`. */
  source: string;
}

export interface EmployeeYtdOpeningRow {
  id: string;
  employeeId: string;
  employeeNumber: string;
  year: number;
  gross: string;
  net: string;
  byComponent: Record<string, string>;
  byScheme: Record<string, { employee: string; employer: string }>;
  source: string;
  loadedBy: string;
}

/** The fixed-scale form `app.employee_ytd_delta` writes (`to_char(…, 'FM999999999999990.0000')`). A reading adds the
 *  opening to the projection, so `"500.00"` and `"500.0000"` must not be two spellings of one figure. */
const FIXED_SCALE = /^-?\d{1,15}\.\d{4}$/;

function assertFixedScale(field: string, value: string): void {
  if (!FIXED_SCALE.test(value)) {
    throw new OpeningError(
      "ERR_VALIDATION_FAILED",
      `${field} is "${value}"; an opening figure is a fixed-scale 4-decimal string, as the projection stores it`,
    );
  }
}

/**
 * Insert or replace one (company, employee, year) opening, returning its id. A second load for the same key UPDATES
 * the figures and the source (a corrected cut-over); `loaded_by` keeps the FIRST loader — it is a write-once stamp
 * (LEGACY-044) and `app.audit_log` carries every later correction with its own actor.
 *
 * Refused (`ERR_VALIDATION_FAILED`): a blank source, a figure that is not fixed-scale, a gross or net in a currency
 * other than the company's base currency (the table stores base amounts, as the projection does). Refused
 * (`ERR_NOT_FOUND`): an employee that is not a visible employee of `companyId`.
 */
export async function upsertEmployeeYtdOpening(
  tx: Sql,
  ctx: TenantContext,
  input: EmployeeYtdOpeningInput,
): Promise<string> {
  const source = input.source.trim();
  if (source.length === 0) {
    throw new OpeningError(
      "ERR_VALIDATION_FAILED",
      "an opening carries its provenance: 'legacy:<run>' from the importer, or 'manual:<reason>'",
    );
  }
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2200) {
    throw new OpeningError("ERR_VALIDATION_FAILED", `year ${input.year} is not a tax year`);
  }
  for (const [code, value] of Object.entries(input.byComponent))
    assertFixedScale(`byComponent.${code}`, value);
  for (const [code, share] of Object.entries(input.byScheme)) {
    assertFixedScale(`byScheme.${code}.employee`, share.employee);
    assertFixedScale(`byScheme.${code}.employer`, share.employer);
  }

  const [employee] = await tx<{ base_currency: string }[]>`
    select c.base_currency
      from app.employee e
      join app.company c on c.id = e.company_id
     where e.id = ${input.employeeId} and e.company_id = ${input.companyId}`;
  if (!employee) {
    throw new OpeningError(
      "ERR_NOT_FOUND",
      `employee ${input.employeeId} is not an employee of company ${input.companyId}`,
    );
  }
  const base = employee.base_currency.trim();
  for (const [name, figure] of [
    ["gross", input.gross],
    ["net", input.net],
  ] as const) {
    if (figure.currency !== base) {
      throw new OpeningError(
        "ERR_VALIDATION_FAILED",
        `${name} is in ${figure.currency}; an opening is in the company's base currency ${base}`,
      );
    }
  }

  const [row] = await tx<{ id: string }[]>`
    insert into app.employee_ytd_opening
      (tenant_id, company_id, employee_id, tax_year, gross, net, by_component, by_scheme, source)
    values (${ctx.tenantId}, ${input.companyId}, ${input.employeeId}, ${input.year},
            ${input.gross.toString()}, ${input.net.toString()},
            ${JSON.stringify(input.byComponent)}::text::jsonb, ${JSON.stringify(input.byScheme)}::text::jsonb,
            ${source})
    on conflict (company_id, employee_id, tax_year) do update
       set gross        = excluded.gross,
           net          = excluded.net,
           by_component = excluded.by_component,
           by_scheme    = excluded.by_scheme,
           source       = excluded.source
    returning id`;
  return row!.id;
}

/** The openings of one company and year, with the employee number a report prints, ordered by it. */
export async function listEmployeeYtdOpening(
  tx: Sql,
  input: { companyId: string; year: number },
): Promise<EmployeeYtdOpeningRow[]> {
  const rows = await tx<
    {
      id: string;
      employee_id: string;
      employee_number: string;
      year: number;
      gross: string;
      net: string;
      by_component: Record<string, string>;
      by_scheme: Record<string, { employee: string; employer: string }>;
      source: string;
      loaded_by: string;
    }[]
  >`
    select o.id, o.employee_id, e.employee_number, o.tax_year::int as year,
           to_char(o.gross, 'FM999999999999990.0000') as gross,
           to_char(o.net, 'FM999999999999990.0000')   as net,
           o.by_component, o.by_scheme, o.source, o.loaded_by
      from app.employee_ytd_opening o
      join app.employee e on e.id = o.employee_id
     where o.company_id = ${input.companyId} and o.tax_year = ${input.year}
     order by e.employee_number, o.id`;
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeNumber: r.employee_number,
    year: r.year,
    gross: r.gross,
    net: r.net,
    byComponent: r.by_component,
    byScheme: r.by_scheme,
    source: r.source,
    loadedBy: r.loaded_by,
  }));
}
