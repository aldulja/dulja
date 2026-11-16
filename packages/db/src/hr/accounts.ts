import type { Sql } from "postgres";

/**
 * The eleven §4.15 codes 8B seeds (`packages/db/seed/my/chart-of-accounts/8b-payroll.json`), as ONE exported
 * literal. Hazard 32: an account code has no build check behind it and a wrong one fails only at post, in the
 * slice that did not write it — so the linker, the seed-file test and 8C's consumers read the same object rather
 * than three copies of eleven strings.
 *
 * The scheme order EPF, SOCSO, EIS, PCB and the shared last digit are §4.15's, not a choice made here. These are
 * account NAMES; no rate, threshold or ceiling of any scheme appears in this slice (hazard 1).
 */
export const PAYROLL_ACCOUNT_CODES = {
  staffAdvances: "1400",
  salariesPayable: "2400",
  salariesExpense: "5300",
  schemePayable: { EPF: "2411", SOCSO: "2412", EIS: "2413", PCB: "2414" },
  schemeEmployerExpense: { EPF: "5311", SOCSO: "5312", EIS: "5313", PCB: "5314" },
} as const;

export interface PayrollAccountLinkage {
  componentsLinked: number;
  schemesLinked: number;
  /** Codes a scheme or component needed that the company's chart does not have. Never silently skipped. */
  missingCodes: string[];
}

/**
 * Sets `pay_component.expense_account_id`, `statutory_scheme.payable_account_id` and
 * `statutory_scheme.employer_expense_account_id` from the codes above, for one company.
 *
 * §4.12.2: "the same seed task sets [them] from those codes, so no plan writes a payroll account literal of its
 * own" — and so 8C's `PAYROLL_PAYMENT` and `EMPLOYEE_ADVANCE` resolve `2400` and `1400` without seeding anything.
 *
 * **It never overwrites a value a tenant already chose.** The `… is null` predicates are what make it idempotent
 * AND make a per-component choice (an overtime component on `5900`, the advance-recovery component on `1400`)
 * survive a re-run. Which component is the advance-recovery one is an operator/seed decision: no code here
 * matches a component code. A scheme whose statutory payable account cannot be resolved is skipped WHOLE (never
 * half-wired) and the code is named in `missingCodes`; a scheme code §4.15 has no row for is named
 * `scheme:<CODE>` (an OD-14 levy that needs its accounts allocated first).
 */
export async function linkPayrollAccounts(
  tx: Sql,
  companyId: string,
): Promise<PayrollAccountLinkage> {
  const accounts = await tx<{ code: string; id: string }[]>`
    select code, id::text as id from app.account where company_id = ${companyId}::uuid and not is_group`;
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const missing: string[] = [];

  const salaries = byCode.get(PAYROLL_ACCOUNT_CODES.salariesExpense) ?? null;
  let componentsLinked = 0;
  if (salaries === null) {
    missing.push(PAYROLL_ACCOUNT_CODES.salariesExpense);
  } else {
    const linked = await tx<{ id: string }[]>`
      update app.pay_component set expense_account_id = ${salaries}::uuid
       where company_id = ${companyId}::uuid and expense_account_id is null
       returning id`;
    componentsLinked = linked.length;
  }

  const schemes = await tx<{ id: string; code: string }[]>`
    select id::text as id, code from app.statutory_scheme
     where company_id = ${companyId}::uuid order by code`;
  const payableCodes: Readonly<Record<string, string>> = PAYROLL_ACCOUNT_CODES.schemePayable;
  const employerCodes: Readonly<Record<string, string>> =
    PAYROLL_ACCOUNT_CODES.schemeEmployerExpense;
  let schemesLinked = 0;
  for (const scheme of schemes) {
    const payableCode = payableCodes[scheme.code];
    const employerCode = employerCodes[scheme.code];
    if (payableCode === undefined || employerCode === undefined) {
      // A scheme §4.15 has not allocated a code to yet (a levy confirmed under OD-14, or the SYNTH test scheme).
      // Naming it is the point: hazard 33 forbids a fallback to a null account.
      missing.push(`scheme:${scheme.code}`);
      continue;
    }
    const payableId = byCode.get(payableCode) ?? null;
    const employerId = byCode.get(employerCode) ?? null;
    if (payableId === null) {
      missing.push(payableCode);
      continue;
    }
    if (employerId === null) missing.push(employerCode);

    const changed = await tx<{ id: string }[]>`
      update app.statutory_scheme
         set payable_account_id = coalesce(payable_account_id, ${payableId}::uuid),
             employer_expense_account_id = coalesce(employer_expense_account_id, ${employerId}::uuid)
       where id = ${scheme.id}::uuid
         and (payable_account_id is null or (employer_expense_account_id is null and ${employerId}::uuid is not null))
       returning id`;
    schemesLinked += changed.length;
  }

  return { componentsLinked, schemesLinked, missingCodes: [...new Set(missing)].toSorted() };
}
