import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createDb } from "../client";
import { linkPayrollAccounts, type PayrollAccountLinkage } from "../hr/accounts";
import { systemContext, withTenant } from "../with-tenant";

/**
 * Wires one company's pay components and statutory schemes to the §4.15 codes `8b-payroll.json` seeds.
 *
 * It is NOT a `PackLoader`: `LOADERS` is keyed by `SubPack` and 0C already owns `chart-of-accounts`, so this runs
 * as its own step after `bun run seed --tenant <id> --only chart-of-accounts` (§3.4.8: add a file, never a
 * loader). It opens its own tenant transaction as **the tenant's system principal** — the wiring is reference
 * data nobody signs for, and a human actor stamped on it would be a lie the audit trail then carries (LEGACY-044).
 * Exported from the SEED barrel only (§3.1, legacy-039), never from the main barrel.
 */
export async function linkPayrollAccountsForTenant(
  sql: Sql,
  tenantId: string,
  companyId: string,
): Promise<PayrollAccountLinkage> {
  // `systemContext` resolves `system:<tenantId>` through `app.resolve_principal`, callable on a bare pool before
  // any tenant is set — which is what lets it be the first statement of a CLI entry point.
  const ctx = await systemContext(sql, tenantId, randomUUID());
  const result = await withTenant(sql, ctx, (tx) => linkPayrollAccounts(tx, companyId));
  if (result.missingCodes.length > 0) {
    // Hazard 33: an unresolvable account code is NAMED and the step fails. A silent skip would leave a NULL account
    // that only surfaces at the first post, in 8C, in the slice that did not write it.
    throw new Error(
      `ERR_POLICY_REQUIRES_MISSING: company ${companyId} cannot resolve the payroll account code(s) ` +
        `${result.missingCodes.join(", ")}; apply packages/db/seed/my/chart-of-accounts/8b-payroll.json first`,
    );
  }
  return result;
}

/** `bun run --cwd packages/db seed:payroll-accounts --tenant <uuid> --company <uuid>` (DATABASE_URL, app_rw).
 *  Exit codes are §4.2.13's: 0 done, 1 the database refused or a code is missing, 2 a configuration error. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tenantId = flag("tenant");
  const companyId = flag("company");
  const url = env["DATABASE_URL"];
  if (tenantId === undefined || companyId === undefined || url === undefined) {
    process.stderr.write(
      "usage: seed:payroll-accounts --tenant <uuid> --company <uuid> (DATABASE_URL required)\n",
    );
    return 2;
  }
  const pool = createDb(url);
  try {
    const result = await linkPayrollAccountsForTenant(pool, tenantId, companyId);
    process.stdout.write(
      `linked ${result.componentsLinked} pay component(s) and ${result.schemesLinked} scheme(s)\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
