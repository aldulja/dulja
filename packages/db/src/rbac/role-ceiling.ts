import type { Sql } from "postgres";

/**
 * Runtime copies of three lists whose source is `packages/db/seed/roles.ts`. The serving image ships no file under
 * `packages/db/seed` (infra/test/dockerfile.test.ts), and the `role-seed` lint reads the pairs there as text, so the
 * api cannot import them and the source cannot move. `packages/db/test/roles-ceiling.test.ts` fails if they drift.
 */
export const CEILING_EXEMPT_CODES: readonly string[] = ["pos.ticket.sell"];
export const CEILING_EXEMPT_PREFIXES: readonly string[] = ["pos.sync."];
export const RUNTIME_INCOMPATIBLE_PAIRS: readonly (readonly [string, string])[] = [
  ["accounting.payment.create", "accounting.payment.approve"],
  ["hr.payroll.prepare", "hr.payroll.approve"],
  ["hr.statutory_table.manage", "hr.statutory_table.verify"],
  ["hr.employee.read_sensitive", "pos.ticket.sell"],
];

/**
 * ADR 0091 — the role-administration ceiling (2026-11-15 review, API-03 and API-09).
 *
 * A principal may grant only authority they hold themselves. Two shapes:
 *
 * - **Tenant scope** (editing a role). A role is a tenant-wide row: a change reaches every company where it is,
 *   or later will be, assigned. The actor must hold the code company-wide (no branch rows) in every company of the
 *   tenant that has at least one live role assignment, and in at least one company. A company nobody holds a role
 *   in yet does not count — `POST /v1/companies` assigns no one, so counting it would lock role administration the
 *   moment a second company is created.
 * - **Assignment scope** (assigning a role). The assigner must hold each code at the scope the assignment grants:
 *   company-wide when it carries no branch rows, else at every one of its branches.
 *
 * Codes the seeded `admin` deliberately lacks — the till's `pos.ticket.sell` and the terminal's `pos.sync.*`
 * (spec:2146, `ADMIN_EXCLUDED_*`) — are exempt from the ceiling: they are operational, not administrative, and
 * without the exemption no administrator could assign `cashier` or `branch_manager`. `pos_terminal` stays bound to
 * terminals by `assert_assignment_kind`.
 */
export function isCeilingExempt(code: string): boolean {
  return (
    CEILING_EXEMPT_CODES.includes(code) ||
    CEILING_EXEMPT_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
}

function ceilinged(codes: readonly string[]): string[] {
  return [...new Set(codes)].filter((code) => !isCeilingExempt(code)).toSorted();
}

/** The codes of `codes` the current actor does NOT hold at tenant scope (above). Empty means admitted. */
export async function missingAtTenantScope(tx: Sql, codes: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(codes)].toSorted();
  if (wanted.length === 0) return [];
  const rows = await tx<{ code: string }[]>`
    select w.code from unnest(${wanted}::text[]) as w(code)
     where not exists (select 1 from app.company c where app.actor_has(w.code, c.id))
        or exists (
          select 1 from app.company c
           where exists (select 1 from app.role_assignment ra
                          where ra.company_id = c.id and (ra.expires_at is null or ra.expires_at > now()))
             and not app.actor_has(w.code, c.id))
     order by 1`;
  return rows.map((row) => row.code);
}

/** The ceilinged codes of `codes` the actor lacks at tenant scope (`missingAtTenantScope`, exemptions applied). */
export async function missingCeilingAtTenantScope(
  tx: Sql,
  codes: readonly string[],
): Promise<string[]> {
  return missingAtTenantScope(tx, ceilinged(codes));
}

/**
 * The ceilinged codes of role `roleId` the actor does not hold at the scope an assignment in `companyId`
 * restricted to `branchIds` (none: company-wide) would grant. Empty means the assignment is within the ceiling.
 */
export async function missingCeilingForAssignment(
  tx: Sql,
  roleId: string,
  companyId: string,
  branchIds: readonly string[],
): Promise<string[]> {
  const granted = await tx<{ permission_code: string }[]>`
    select permission_code from app.role_permission where role_id = ${roleId}`;
  const codes = ceilinged(granted.map((row) => row.permission_code));
  if (codes.length === 0) return [];
  const branches = [...new Set(branchIds)];
  const rows = await tx<{ code: string }[]>`
    select w.code from unnest(${codes}::text[]) as w(code)
     where case when cardinality(${branches}::uuid[]) = 0
                then not app.actor_has(w.code, ${companyId}::uuid)
                else exists (select 1 from unnest(${branches}::uuid[]) as b(id)
                              where not app.actor_has(w.code, ${companyId}::uuid, b.id))
           end
     order by 1`;
  return rows.map((row) => row.code);
}

/** R6 (spec:2177): the incompatible pairs `codes` holds both halves of. */
export function incompatiblePairsIn(codes: readonly string[]): (readonly [string, string])[] {
  const held = new Set(codes);
  return RUNTIME_INCOMPATIBLE_PAIRS.filter(([left, right]) => held.has(left) && held.has(right));
}
