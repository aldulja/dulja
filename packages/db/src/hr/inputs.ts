import type { Sql } from "postgres";
import { Money, Quantity, currency, type CurrencyCode } from "@dulja/domain";
import {
  schemeYtdKey,
  ytdKey,
  type EmployeePeriodInput,
  type PayPeriod,
  type RateTableRef,
} from "@dulja/domain/payroll";
import { ensureEmployeeDimensionValue } from "./employee-dimension";
import { PayrollRunError } from "./run-error";
import { ytdFromPostedLines } from "./ytd";

export interface PayrollInputs {
  period: PayPeriod;
  employees: EmployeePeriodInput[];
  rateTables: RateTableRef[];
  ytdBefore: Record<string, Record<string, Money>>;
  /** employeeId → the employee's EMPLOYEE dimension_value id, resolved (and repaired) here. */
  dimensionValues: Record<string, string>;
  /** employeeId → the employee's home BRANCH dimension_value id. */
  homeBranches: Record<string, string>;
  /** schemeId → the `statutory_rate_table.id` of the version offered for this period (additive to the plan's
   *  shape, so `writeLines` pins the row without one query per employee). */
  rateTableIds: Record<string, string>;
  currency: CurrencyCode;
  /** componentId → its code, so a refusal names the component the operator knows (HRP-02). */
  componentCodes: Record<string, string>;
  /**
   * A `supplementary` run only: employeeId → what the period's earlier POSTED runs already carried for that employee
   * (ADR 0076's amendment, HRP-02). `writeLines` posts the corrected figures LESS these, so a correction pays its
   * difference once and never the whole period again. Absent for `regular` and `final`.
   */
  postedInPeriod?: Record<string, PostedFigures>;
}

/** One employee's figures summed over the posted runs of a period, keyed the way `writeLines` keys its lines. */
export interface PostedFigures {
  /** componentId → Σ amount (earnings and deductions alike; the component's kind decides the side). */
  components: Record<string, Money>;
  /** `${schemeId}:${share}` → Σ amount. */
  shares: Record<string, Money>;
  /** Σ (credit − debit) on the net-pay `account` lines — signed, so a hand-drafted recovery line nets. */
  net: Money;
  /** The posted runs that carried them, for the refusal and the post-time guard's message. */
  documentIds: string[];
}

export const shareKey = (schemeId: string, share: "employee" | "employer"): string =>
  `${schemeId}:${share}`;

export interface LoadInputsOptions {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  kind: "regular" | "supplementary" | "final";
  employeeIds?: readonly string[];
  /** The run whose OWN manual overrides are inputs. Absent for a first calculation: a run that does not exist yet
   *  has none, and a period key would let another draft's overrides leak into it. */
  documentId?: string;
}

type ProfileValue = string | number | boolean | null;

/**
 * Every input the pure calculator needs, read once (8B T10, §4.12.6).
 *
 * **Which employees:** everyone employed for at least one day of the period — `hired_on <= period_end` and
 * (`terminated_on is null` or `terminated_on >= period_start`) — and not archived, so a mid-month leaver is on the run
 * they worked and off the next one. `employeeIds` narrows the set (a `supplementary` or `final` run names its
 * employees); the wire refuses it on a `regular` run, because a regular run that silently skipped someone is exactly
 * the failure a payroll register exists to catch.
 *
 * **Which compensation:** per component, the line in force at the END of the period (the latest `effective_from`
 * whose window overlaps it). A mid-period raise is therefore paid at the new figure for the whole period rather than
 * twice; splitting one component across two rates inside a period is not built (recorded in the Phase 8 progress log).
 *
 * The caller must be able to read compensation: `compensation_line` and `employee_statutory_profile` carry 8A's
 * RESTRICTIVE `compensation_gate`, so a session without `hr.compensation.read` would see every employee with no
 * compensation at all. That is refused up front, naming the code, rather than surfacing as a misleading
 * "no compensation" calculator refusal.
 */
export async function loadPayrollInputs(tx: Sql, opts: LoadInputsOptions): Promise<PayrollInputs> {
  const [company] = await tx<{ base_currency: string; can_read: boolean }[]>`
    select base_currency, app.actor_has('hr.compensation.read', id) as can_read
      from app.company where id = ${opts.companyId}`;
  if (!company)
    throw new PayrollRunError("ERR_NOT_FOUND", `no company ${opts.companyId} in this tenant`);
  if (!company.can_read) {
    throw new PayrollRunError(
      "ERR_RBAC_FORBIDDEN",
      `calculating a payroll run reads compensation; the actor does not hold hr.compensation.read company-wide in ${opts.companyId}`,
    );
  }
  const cur = currency(company.base_currency.trim());

  const [setting] = await tx<{ proration_rule: "calendar_days" | "working_days" }[]>`
    select proration_rule from app.company_hr_setting where company_id = ${opts.companyId}`;
  const period: PayPeriod = {
    start: opts.periodStart,
    end: opts.periodEnd,
    payDate: opts.payDate,
    // OD-28's default (8B T7). The column is 8A's and its CHECK admits exactly these two values.
    prorationRule: setting?.proration_rule ?? "calendar_days",
  };

  const named = opts.employeeIds === undefined ? null : [...opts.employeeIds];
  const rows = await tx<
    {
      id: string;
      home_branch_id: string;
      employee_number: string;
      hired_on: string;
      terminated_on: string | null;
    }[]
  >`
    select e.id, e.home_branch_id, e.employee_number,
           to_char(e.hired_on, 'YYYY-MM-DD') as hired_on,
           to_char(e.terminated_on, 'YYYY-MM-DD') as terminated_on
      from app.employee e
     where e.company_id = ${opts.companyId}
       and e.archived_at is null
       and e.hired_on <= ${opts.periodEnd}::date
       and (e.terminated_on is null or e.terminated_on >= ${opts.periodStart}::date)
       and (${named}::uuid[] is null or e.id = any(${named}::uuid[]))
     order by e.employee_number`;
  if (named !== null && rows.length !== new Set(named).size) {
    const found = new Set(rows.map((r) => r.id));
    const absent = named.filter((id) => !found.has(id));
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `employee(s) ${absent.join(", ")} are not employed in company ${opts.companyId} during ${opts.periodStart}..${opts.periodEnd}`,
    );
  }

  const employees: EmployeePeriodInput[] = [];
  const componentCodes: Record<string, string> = {};
  const dimensionValues: Record<string, string> = {};
  const homeBranches: Record<string, string> = {};
  const schemeIds = new Set<string>();

  for (const e of rows) {
    // The repair path of §4.12.7 — an employee inserted before migration 0088 gets its value here, once, rather than
    // refusing at post (hazard 10: a migration cannot backfill a per-tenant row).
    dimensionValues[e.id] = await ensureEmployeeDimensionValue(tx, opts.companyId, e.id);
    homeBranches[e.id] = e.home_branch_id;

    const comp = await tx<
      {
        component_id: string;
        kind: "earning" | "deduction";
        amount: string | null;
        quantity: string | null;
        scheme_ids: string[];
        code: string;
      }[]
    >`
      select c.component_id, c.kind, c.amount, c.quantity, c.code,
             coalesce((select array_agg(pcs.scheme_id order by sc.code)
                         from app.pay_component_scheme pcs
                         join app.statutory_scheme sc on sc.id = pcs.scheme_id
                        where pcs.component_id = c.component_id), '{}')::text[] as scheme_ids
        from (select distinct on (cl.component_id)
                     cl.component_id, pc.kind, pc.code,
                     cl.amount::text as amount, cl.quantity::text as quantity
                from app.compensation_line cl
                join app.pay_component pc on pc.id = cl.component_id
               where cl.employee_id = ${e.id}
                 and pc.company_id = ${opts.companyId}
                 and pc.archived_at is null
                 and cl.effective_from <= ${opts.periodEnd}::date
                 and (cl.effective_to is null or cl.effective_to >= ${opts.periodStart}::date)
               order by cl.component_id, cl.effective_from desc) c
       order by c.code`;

    const profileRows = await tx<{ profile: Record<string, ProfileValue> }[]>`
      select to_jsonb(p) - 'id' - 'tenant_id' - 'employee_id' - 'effective_from' - 'effective_to'
             - 'entered_by' - 'created_at' as profile
        from app.employee_statutory_profile p
       where p.employee_id = ${e.id}
         and p.effective_from <= ${opts.periodEnd}::date
         and (p.effective_to is null or p.effective_to >= ${opts.periodStart}::date)
       order by p.effective_from desc limit 1`;
    // `extra` is a jsonb bag (8A, ⚠️ OD-28); its keys are lifted to the top level so a rate table's
    // `required_profile_fields` can name a verified addition without knowing whether it is a column yet. A column
    // wins over an `extra` key of the same name.
    const base: Record<string, unknown> = { ...profileRows[0]?.profile };
    const extra = (base["extra"] ?? {}) as Record<string, ProfileValue>;
    delete base["extra"];
    const statutoryProfile: Record<string, ProfileValue> = {
      ...extra,
      ...(base as Record<string, ProfileValue>),
    };

    // A manual override is an input a preparer entered on THIS draft run (8B T11's `setStatutoryOverride`), so the
    // read is keyed on the run's OWN document id and nothing else: two supplementary drafts may cover one period,
    // and a brand-new calculation (no `documentId` yet) must not inherit an override entered on another run.
    const overrideRows =
      opts.documentId === undefined
        ? []
        : await tx<
            { scheme_id: string; share: "employee" | "employer"; amount: string; reason: string }[]
          >`
            select pl.scheme_id, pl.share, pl.amount::text as amount, pl.override_reason as reason
              from app.payroll_line pl
              join app.document_line dl on dl.id = pl.document_line_id
              join app.document d on d.id = dl.document_id
             where pl.employee_id = ${e.id} and pl.override_reason is not null
               and pl.scheme_id is not null and pl.share is not null
               and d.id = ${opts.documentId} and d.status = 'draft'
             order by dl.line_no`;

    employees.push({
      employeeId: e.id,
      branchId: e.home_branch_id,
      hiredOn: e.hired_on,
      terminatedOn: e.terminated_on,
      statutoryProfile,
      compensation: comp.map((c) => ({
        componentId: c.component_id,
        kind: c.kind,
        // numeric(19,4)::text and numeric(19,6)::text are exactly the strings Money.of and Quantity.of take. They go
        // in whole: a money figure never touches a float, not even in transit (spec:2041), and Money.of raises if a
        // column's scale ever drifts where rounding here would hide it.
        amount: c.amount === null ? null : Money.of(c.amount, cur),
        quantity: c.quantity === null ? null : Quantity.of(c.quantity),
        schemeIds: c.scheme_ids,
      })),
      manualOverrides: overrideRows.map((o) => ({
        schemeId: o.scheme_id,
        share: o.share,
        amount: Money.of(o.amount, cur),
        reason: o.reason,
      })),
    });
    for (const c of comp) {
      componentCodes[c.component_id] = c.code;
      for (const id of c.scheme_ids) schemeIds.add(id);
    }
  }

  // The rate tables covering the period, for exactly the schemes this run's components name. `verified` is
  // `verified_at is not null` — 8A's trigger already guarantees the verifier differs from the loader.
  const tableRows =
    schemeIds.size === 0
      ? []
      : await tx<
          {
            id: string;
            scheme_id: string;
            scheme_code: string;
            version: number;
            effective_from: string;
            effective_to: string | null;
            definition: Record<string, unknown>;
            verified: boolean;
            rounding_mode: string;
          }[]
        >`
          select rt.id, rt.scheme_id, sc.code as scheme_code, rt.version,
                 to_char(rt.effective_from, 'YYYY-MM-DD') as effective_from,
                 to_char(rt.effective_to, 'YYYY-MM-DD') as effective_to,
                 rt.definition, (rt.verified_at is not null) as verified, sc.rounding_mode
            from app.statutory_rate_table rt
            join app.statutory_scheme sc on sc.id = rt.scheme_id
           where rt.scheme_id = any(${[...schemeIds]}::uuid[])
             and rt.effective_from <= ${opts.periodStart}::date
             and (rt.effective_to is null or rt.effective_to >= ${opts.periodEnd}::date)
           order by rt.scheme_id, rt.version desc`;

  // The HIGHEST version whose range covers the period, one per scheme. spec:2081: run M pins the table effective at
  // M, and a later version inserted afterwards leaves M alone (test 29). An unverified highest version is OFFERED, so
  // the calculator refuses it (ERR_PAYROLL_RATE_TABLE_UNVERIFIED) rather than this read silently falling back.
  const rateTables: RateTableRef[] = [];
  const rateTableIds: Record<string, string> = {};
  for (const r of tableRows) {
    if (rateTableIds[r.scheme_id] !== undefined) continue;
    rateTableIds[r.scheme_id] = r.id;
    rateTables.push({
      schemeId: r.scheme_id,
      schemeCode: r.scheme_code,
      version: r.version,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      // The scheme's own rounding_mode is the fallback when the FILE omits the optional member, so the pure
      // calculator never reaches for a default of its own (ADR 0074).
      definition: {
        rounding_mode: r.rounding_mode,
        ...r.definition,
      } as unknown as RateTableRef["definition"],
      verified: r.verified,
    });
  }

  const year = Number.parseInt(opts.periodEnd.slice(0, 4), 10);
  const ytdBefore = await ytdFromPostedLines(
    tx,
    opts.companyId,
    year,
    rows.map((r) => r.id),
  );

  const postedInPeriod =
    opts.kind === "supplementary"
      ? await loadPostedInPeriod(
          tx,
          opts,
          rows.map((r) => r.id),
          cur,
          year,
          ytdBefore,
          componentCodes,
        )
      : undefined;
  if (postedInPeriod !== undefined) {
    // A manual override on a supplementary run is the PERIOD's figure, but its line carries the delta: read back, the
    // posted share is added to the stored line so the next recalculation applies the figure the operator entered.
    for (const e of employees) {
      const posted = postedInPeriod[e.employeeId];
      if (posted === undefined) continue;
      e.manualOverrides = e.manualOverrides.map((o) => ({
        ...o,
        amount: o.amount.add(posted.shares[shareKey(o.schemeId, o.share)] ?? Money.zero(cur)),
      }));
    }
  }

  return {
    period,
    employees,
    rateTables,
    ytdBefore,
    dimensionValues,
    homeBranches,
    rateTableIds,
    currency: cur,
    componentCodes,
    ...(postedInPeriod === undefined ? {} : { postedInPeriod }),
  };
}

/**
 * What the period's earlier POSTED runs carried per employee (HRP-02, ADR 0076's amendment). A posted run counts when
 * its period lies inside the supplementary run's; one that only partly overlaps it is refused, because netting half a
 * run against a whole period would pay or withhold the other half silently.
 *
 * The same figures are taken out of `ytdBefore` (for the posted runs `ytdFromPostedLines` counted — the tax year of
 * their effective date), so the calculator sees the YTD the period started from and computes the period's corrected
 * figures, not the period stacked on itself.
 */
async function loadPostedInPeriod(
  tx: Sql,
  opts: LoadInputsOptions,
  employeeIds: string[],
  cur: CurrencyCode,
  year: number,
  ytdBefore: Record<string, Record<string, Money>>,
  componentCodes: Record<string, string>,
): Promise<Record<string, PostedFigures>> {
  if (employeeIds.length === 0) return {};
  const [straddling] = await tx<{ id: string; period_start: string; period_end: string }[]>`
    select distinct d.id, to_char(pr.period_start, 'YYYY-MM-DD') as period_start,
           to_char(pr.period_end, 'YYYY-MM-DD') as period_end
      from app.payroll_run pr
      join app.document d on d.id = pr.document_id
      join app.document_line dl on dl.document_id = d.id
      join app.payroll_line pl on pl.document_line_id = dl.id
     where pr.company_id = ${opts.companyId} and d.status = 'posted'
       and pl.employee_id = any(${employeeIds}::uuid[])
       and pr.period_start <= ${opts.periodEnd}::date and pr.period_end >= ${opts.periodStart}::date
       and (pr.period_start < ${opts.periodStart}::date or pr.period_end > ${opts.periodEnd}::date)
     limit 1`;
  if (straddling) {
    throw new PayrollRunError(
      "ERR_VALIDATION_FAILED",
      `posted payroll run ${straddling.id} covers ${straddling.period_start}..${straddling.period_end}, which overlaps ` +
        `${opts.periodStart}..${opts.periodEnd} without lying inside it; a supplementary run corrects whole posted periods`,
    );
  }

  const rows = await tx<
    {
      document_id: string;
      employee_id: string;
      component_id: string | null;
      component_code: string | null;
      component_kind: "earning" | "deduction" | null;
      scheme_id: string | null;
      scheme_code: string | null;
      share: "employee" | "employer" | null;
      is_net: boolean;
      in_year: boolean;
      amount: string;
      signed: string;
    }[]
  >`
    select d.id as document_id, pl.employee_id, pl.component_id, pc.code as component_code,
           pc.kind as component_kind, pl.scheme_id, sc.code as scheme_code, pl.share,
           (pl.component_id is null and pl.scheme_id is null) as is_net,
           (d.effective_date >= make_date(${year}::int, 1, 1)
              and d.effective_date < make_date(${year}::int + 1, 1, 1)) as in_year,
           sum(pl.amount)::text as amount, sum(dl.credit - dl.debit)::text as signed
      from app.payroll_run pr
      join app.document d on d.id = pr.document_id
      join app.document_line dl on dl.document_id = d.id
      join app.payroll_line pl on pl.document_line_id = dl.id
      left join app.pay_component pc on pc.id = pl.component_id
      left join app.statutory_scheme sc on sc.id = pl.scheme_id
     where pr.company_id = ${opts.companyId} and d.status = 'posted'
       and pl.employee_id = any(${employeeIds}::uuid[])
       and pr.period_start >= ${opts.periodStart}::date and pr.period_end <= ${opts.periodEnd}::date
       and (${opts.documentId ?? null}::uuid is null or d.id <> ${opts.documentId ?? null}::uuid)
     group by d.id, pl.employee_id, pl.component_id, pc.code, pc.kind, pl.scheme_id, sc.code, pl.share, is_net,
              in_year
     order by d.id`;

  const out: Record<string, PostedFigures> = {};
  for (const r of rows) {
    const p = (out[r.employee_id] ??= {
      components: {},
      shares: {},
      net: Money.zero(cur),
      documentIds: [],
    });
    if (!p.documentIds.includes(r.document_id)) p.documentIds.push(r.document_id);
    const amount = Money.of(r.amount, cur);
    let ytdKeyName: string | null = null;
    if (r.is_net) {
      p.net = p.net.add(Money.of(r.signed, cur));
      ytdKeyName = ytdKey("net");
    } else if (r.scheme_id !== null && r.share !== null) {
      const k = shareKey(r.scheme_id, r.share);
      p.shares[k] = (p.shares[k] ?? Money.zero(cur)).add(amount);
      ytdKeyName = r.scheme_code === null ? null : schemeYtdKey(r.scheme_code, r.share);
    } else if (r.component_id !== null) {
      p.components[r.component_id] = (p.components[r.component_id] ?? Money.zero(cur)).add(amount);
      if (r.component_code !== null) componentCodes[r.component_id] ??= r.component_code;
      ytdKeyName = r.component_kind === "earning" ? ytdKey("gross") : null;
    }
    // Exactly what ytdFromPostedLines added for this row, taken back out.
    if (r.in_year && ytdKeyName !== null) {
      const bucket = ytdBefore[r.employee_id];
      const before = bucket?.[ytdKeyName];
      if (bucket !== undefined && before !== undefined)
        bucket[ytdKeyName] = before.subtract(amount);
    }
  }
  return out;
}
