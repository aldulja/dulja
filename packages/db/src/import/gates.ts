import type { Sql } from "postgres";

/**
 * 9B review, finding 4 — what each cut-over loader WRITES, as the permission a person would need to write it through
 * the product, keyed by the loader's target table (its identity in `@dulja/importer`'s registry and in `only`).
 *
 * The load runs as the tenant's system principal (spec:2179), which `app.actor_has` admits for every code, so the
 * import route's own gate (`admin.company.manage`) was the only authority a run was ever asked for: a principal holding
 * that code alone posted an `OPENING_BALANCE` (whose policy posts under `accounting.journal.post`), an `OPENING_STOCK`
 * (`inventory.receipt.post`) and employees' sealed fields. 7A's rule for report definitions — the WRITER must hold
 * the permission (`assertDatasetGate`, `DATASET_READ_CODES`) — is applied to the requester instead: every code of every
 * loader the run will execute, at company scope (`app.principal_has(…, company, null)`, so a branch-narrowed
 * assignment never clears one), checked when the run is requested AND again when the job claims it.
 *
 * Each row is the gate of the route or policy that writes the same rows: units, warehouses, items and lots are
 * `inventory.item.manage` (their routes' manage gate); accounts `accounting.account.manage`; parties
 * `accounting.party.manage`; the employee master `hr.employee.manage`, with `hr.compensation.manage` and
 * `hr.employee.read_sensitive` for the sealed fields (`PUT …/employees/{id}/sensitive`'s gate and migration 0081's
 * `sensitive_gate`); the two opening documents their seeded policies' `approval.post`; and the YTD opening, which no
 * route writes (8C B10), `hr.payroll.post` — the code whose posting writes the `employee_ytd` projection the opening
 * is added to at read time. `@dulja/importer`'s registry test pins one row per registered loader.
 */
export const IMPORT_LOADER_WRITE_CODES: Readonly<Record<string, readonly string[]>> = {
  unit_of_measure: ["inventory.item.manage"],
  warehouse: ["inventory.item.manage"],
  account: ["accounting.account.manage"],
  party: ["accounting.party.manage"],
  employee: ["hr.employee.manage", "hr.compensation.manage", "hr.employee.read_sensitive"],
  item: ["inventory.item.manage"],
  opening_balance: ["accounting.journal.post"],
  open_item: ["accounting.journal.post"],
  employee_ytd_opening: ["hr.payroll.post"],
  lot: ["inventory.item.manage"],
  opening_stock: ["inventory.receipt.post"],
};

/** Every code a run restricted to `only` (or, with none, of every loader) writes under, sorted and distinct. A target
 *  with no row contributes nothing here — `runLoad` refuses a name no loader targets, and the worker refuses a
 *  registered loader with no row (`unmappedImportTargets`) before it loads. */
export function importWriteCodes(only: readonly string[] | null | undefined): string[] {
  const targets = only ?? Object.keys(IMPORT_LOADER_WRITE_CODES);
  return [...new Set(targets.flatMap((t) => IMPORT_LOADER_WRITE_CODES[t] ?? []))].toSorted();
}

/** The targets among `targets` that have no row above — a loader registered without its write codes. */
export function unmappedImportTargets(targets: readonly string[]): string[] {
  return targets.filter((t) => !Object.hasOwn(IMPORT_LOADER_WRITE_CODES, t));
}

/**
 * The codes of `importWriteCodes(only)` that `principalId` does NOT hold in `companyId` at company scope, through
 * `app.principal_has` (2B, §4.5.3) — the predicate the export's gate snapshot and the override guard use, so "may this
 * person write this" has one answer. Empty when the principal may request the run.
 */
export async function missingImportWriteCodes(
  tx: Sql,
  input: { principalId: string; companyId: string; only: readonly string[] | null | undefined },
): Promise<string[]> {
  const codes = importWriteCodes(input.only);
  if (codes.length === 0) return [];
  const answers = await tx<{ code: string; held: boolean }[]>`
    select g.code, app.principal_has(${input.principalId}::uuid, g.code, ${input.companyId}::uuid, null) as held
      from unnest(${codes}::text[]) as g(code)`;
  return answers
    .filter((a) => !a.held)
    .map((a) => a.code)
    .toSorted();
}
