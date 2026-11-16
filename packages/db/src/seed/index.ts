import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { withTenant } from "../with-tenant";
import type { SeedAuthAdmin } from "./auth-admin";
import type { SeedConfig } from "./config";
import { chartOfAccountsLoader } from "./chart-of-accounts";
import { dimensionsLoader } from "./dimensions";
import { documentTypesLoader } from "./document-types";
import { fiscalPeriodsLoader } from "./fiscal-periods";
import { bootstrapIdentity } from "./identity";
import {
  assertOwnerSubjectFree,
  assertTenantSeeded,
  bootstrapCompany,
  bootstrapOwner,
} from "./owner";
import type { LoaderContext, PackLoader } from "./packs";
import { rolesLoader } from "./roles";
import { reportsLoader } from "./reports";
import { statutoryLoader } from "./statutory";
import { taxLoader } from "./tax";
import { templatesLoader } from "./templates";
import { SUB_PACKS, type SeedSkip, type SubPack } from "./types";

export interface SeedResult {
  readonly tenantId: string;
  readonly companyId: string;
  readonly ownerPrincipalId: string;
  readonly systemPrincipalId: string;
  readonly applied: Readonly<Record<SubPack, number>>;
  /** Every pack file a loader read and deliberately did not apply, in the order the loaders ran — empty when
   *  nothing was left out. The CLI prints it beside `applied`, so a zero count is never the only signal: in
   *  production the `tax` loader skips a synthetic regime (PR 11 review, round 3). */
  readonly skipped: readonly SeedSkip[];
  /** false on a re-run: the tenant already existed. */
  readonly created: boolean;
}

export { SeedError, SUB_PACKS, type SeedSkip, type SubPack } from "./types";
export { appEnvWarning, parseSeedArgs, SeedConfigError, type SeedConfig } from "./config";
export {
  assertPackShape,
  PHASE_0_SUB_PACK_DIRECTORIES,
  readPackFile,
  readPackText,
  SUB_PACK_DIRECTORIES,
  type LoaderContext,
  type PackLoader,
} from "./packs";
export {
  TEMPLATE_BODY_EXTENSION,
  templateFileNames,
  templatesLoader,
  type TemplateManifest,
} from "./templates";
export {
  loadReportDefinitions,
  reportsLoader,
  type ReportSeedEnvelope,
  type ReportSeedResult,
} from "./reports";
export {
  documentTypesLoader,
  loadDocumentTypes,
  type DocumentTypeSeedResult,
} from "./document-types";
// 3C — 0C only IMPORTED this into the private `LOADERS` map below; a suite in `apps/api` cannot reach
// `./chart-of-accounts` by relative path, so the barrel is the only route to it. A re-export of a name 0C
// already owns and already exports from its own module: no new interface, and NOT on `packages/db/src/index.ts`,
// which §3.1 and `tests/regression/legacy-039.test.ts` keep clear of `./seed` at any depth.
export { chartOfAccountsLoader } from "./chart-of-accounts";
// 8B T4 — the payroll account wiring entry point. Not a loader (0C owns `chart-of-accounts`); the seed barrel only.
export { linkPayrollAccountsForTenant } from "./payroll-accounts";
export {
  seedAuthAdminFor,
  StubSeedAuthAdmin,
  SupabaseSeedAuthAdmin,
  type SeedAuthAdmin,
  type SeedAuthUser,
} from "./auth-admin";

/** Complete by type: a slice that adds a `SubPack` member cannot compile without shipping its loader (§3.4.8). */
const LOADERS: Readonly<Record<SubPack, PackLoader>> = {
  roles: rolesLoader,
  dimensions: dimensionsLoader,
  "fiscal-periods": fiscalPeriodsLoader,
  "chart-of-accounts": chartOfAccountsLoader,
  // 1A — contracts §3.4.8's first later sub-pack.
  "document-types": documentTypesLoader,
  // 2C — the print templates (§3.4.8, §4.5.9).
  templates: templatesLoader,
  tax: taxLoader,
  // 7A — the report definitions (§3.4.8, §4.16.1). 7A ships the loader and no definition.
  reports: reportsLoader,
  // 8A — statutory schemes, pay components and (once OD-23 lands) rate tables (§3.4.8, round 16 A12).
  statutory: statutoryLoader,
};

/** Runs the selected sub-packs in application order, one short `withTenant` transaction per sub-pack. */
export async function runLoaders(
  sql: Sql,
  ctx: LoaderContext,
  only: readonly SubPack[] | null,
  requestId: string,
): Promise<Record<SubPack, number>> {
  const applied: Record<SubPack, number> = {
    roles: 0,
    dimensions: 0,
    "fiscal-periods": 0,
    "chart-of-accounts": 0,
    "document-types": 0,
    templates: 0,
    tax: 0,
    reports: 0,
    statutory: 0,
  };
  for (const name of only ?? SUB_PACKS) {
    const loader = LOADERS[name];
    applied[name] = await withTenant(
      sql,
      { tenantId: ctx.tenantId, actorId: ctx.systemPrincipalId, requestId },
      (tx) => loader.load(tx, ctx),
    );
  }
  return applied;
}

export async function seed(
  sql: Sql,
  config: SeedConfig,
  authAdmin: SeedAuthAdmin,
): Promise<SeedResult> {
  const requestId = randomUUID();
  // Both checks read before the first write, so a refused seed leaves no tenant, company or pack behind.
  // DBS-12: an owner whose subject already belongs to another tenant is refused here, not after the packs commit.
  if (config.only === null) {
    const owner =
      (await authAdmin.findByEmail(config.ownerEmail)) ??
      (await authAdmin.createUser(config.ownerEmail));
    await assertOwnerSubjectFree(sql, config, owner.sub, requestId);
  } else if (config.appEnv !== "dev") {
    // DBS-17: `--only` outside dev writes no owner and keeps an existing company's name, so it must not be the
    // run that creates the tenant with the fixture values.
    await assertTenantSeeded(sql, config, requestId);
  }
  const identity = await bootstrapIdentity(sql, config, requestId);
  const { systemPrincipalId } = identity;
  const { companyId } = await bootstrapCompany(sql, config, systemPrincipalId, requestId);
  const skipped: SeedSkip[] = [];
  const ctx: LoaderContext = {
    config,
    tenantId: config.tenantId,
    companyId,
    systemPrincipalId,
    packRoot: config.packRoot,
    reportSkip: (skip) => skipped.push(skip),
  };
  const applied = await runLoaders(sql, ctx, config.only, requestId);
  // The owner is last: their `admin` assignment needs the role the `roles` loader creates. `--only` skips the
  // OWNER step alone. Identity and company always run, above: they are idempotent, and the loaders need a tenant,
  // a system principal to act as, and a company to write into. Skipping the owner keeps `--only` from calling the
  // Supabase admin API on every re-apply.
  const owner = config.only
    ? { ownerPrincipalId: "", authSubject: "" }
    : await bootstrapOwner(sql, config, { systemPrincipalId, companyId }, authAdmin, requestId);
  return {
    tenantId: config.tenantId,
    companyId,
    ownerPrincipalId: owner.ownerPrincipalId,
    systemPrincipalId,
    applied,
    skipped,
    created: identity.created,
  };
}

export { taxLoader, taxFileNames, type TaxRegimeManifest, type TaxCodeManifest } from "./tax";
export {
  loadStatutoryPack,
  statutoryLoader,
  type PayComponentSeed,
  type SchemeSeed,
} from "./statutory";
