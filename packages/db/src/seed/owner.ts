import type { Sql } from "postgres";
import { withTenant } from "../with-tenant";
import type { SeedAuthAdmin } from "./auth-admin";
import type { SeedConfig } from "./config";
import { SeedError } from "./types";

export interface CompanyResult {
  readonly companyId: string;
}

/** The first company (spec:2000): base currency and timezone are OWNER GATE OD-21 values. */
export async function bootstrapCompany(
  sql: Sql,
  config: SeedConfig,
  systemPrincipalId: string,
  requestId: string,
): Promise<CompanyResult> {
  return withTenant(
    sql,
    { tenantId: config.tenantId, actorId: systemPrincipalId, requestId },
    async (tx) => {
      // The base currency first: 0008 made company.base_currency a foreign key into app.currency, so the
      // code OD-21 supplies has to be a row before it can be a company's. Only the code is known here —
      // minor_units, pos_rounding_increment and rounding_mode take their column defaults, which are the
      // two-decimal HALF_AWAY_FROM_ZERO case. A currency whose cash rounding differs (MYR's five-sen POS
      // increment is the one this seed will actually meet) is the owner's to correct through
      // PATCH /v1/admin/currencies; inventing it here would bake a POS policy into the bootstrap that no
      // gate has approved. Idempotent, like the company insert it precedes: re-seeding must not fail.
      await tx`insert into app.currency (tenant_id, code, name_en)
               values (${config.tenantId}, ${config.baseCurrency}, ${config.baseCurrency})
               on conflict (tenant_id, code) do nothing`;
      await tx`insert into app.company (tenant_id, code, name, base_currency, timezone)
               values (${config.tenantId}, ${config.companyCode}, ${config.companyName}, ${config.baseCurrency}, ${config.timezone})
               on conflict (tenant_id, code) do nothing`;
      const [row] = await tx<{ id: string }[]>`
        select id::text as id from app.company where tenant_id = ${config.tenantId} and code = ${config.companyCode}`;
      return { companyId: row!.id };
    },
  );
}

/** Thrown inside a probe transaction to roll it back and carry its answer out. */
class ProbeResult {
  constructor(readonly taken: boolean) {}
}

/**
 * DBS-12 (2026-11-15 full review). `app.principal.auth_subject` is globally unique, but the seed sees only the
 * principals of its own tenant (`principal_in_tenant`, FORCE RLS; `app_migrator` may not call
 * `app.resolve_principal`). So a subject that already owns another tenant looked free, a fresh id was minted, the
 * targetless `on conflict do nothing` skipped the insert, and the membership insert then failed its foreign key —
 * after the tenant, its company and every pack had committed. This asks first, in a transaction it always rolls
 * back: a subject visible here is this tenant's own (a re-run); otherwise a trial insert that inserts nothing has
 * met another tenant's principal. One person in two tenants is refused, as `membership.principal_id` is unique.
 */
export async function assertOwnerSubjectFree(
  sql: Sql,
  config: SeedConfig,
  sub: string,
  requestId: string,
): Promise<void> {
  try {
    // Provisional actor, as bootstrapIdentity's: every write below is rolled back.
    await withTenant(
      sql,
      { tenantId: config.tenantId, actorId: config.tenantId, requestId },
      async (tx) => {
        const own = await tx`select 1 from app.principal where auth_subject = ${sub}`;
        if (own.length > 0) throw new ProbeResult(false);
        // The tenant row first, as bootstrapIdentity writes it: the principal's audit row names the tenant.
        await tx`insert into app.tenant (id, name) values (${config.tenantId}, ${config.tenantName})
                 on conflict (id) do nothing`;
        const inserted = await tx`
          insert into app.principal (id, kind, auth_subject, email, display_name)
          values (uuidv7(), 'human', ${sub}, ${config.ownerEmail}, ${config.ownerEmail})
          on conflict do nothing`;
        throw new ProbeResult(inserted.count === 0);
      },
    );
  } catch (error) {
    if (!(error instanceof ProbeResult)) throw error;
    if (error.taken) throw ownerTaken(config.ownerEmail);
  }
}

function ownerTaken(email: string): SeedError {
  return new SeedError(
    `the owner ${email} already belongs to another tenant — a principal is a member of one tenant ` +
      `(membership.principal_id is unique); seed this tenant with a different --owner-email`,
  );
}

/** Refuses an `--only` run outside dev on a tenant that does not exist yet (DBS-17). Reads only. */
export async function assertTenantSeeded(
  sql: Sql,
  config: SeedConfig,
  requestId: string,
): Promise<void> {
  const rows = await withTenant(
    sql,
    { tenantId: config.tenantId, actorId: config.tenantId, requestId },
    (tx) => tx`select 1 from app.tenant where id = ${config.tenantId}`,
  );
  if (rows.length === 0)
    throw new SeedError(
      `tenant ${config.tenantId} is not seeded — with APP_ENV=${config.appEnv}, --only re-applies sub-packs to a ` +
        `seeded tenant; run the full seed (with --owner-email and --company-name) first`,
    );
}

export interface OwnerResult {
  readonly ownerPrincipalId: string;
  readonly authSubject: string;
}

/**
 * Step 4's identity half. The Supabase user is created through the admin API **before** the principal, because
 * spec:2132 fixes the rule: "Inviting a user creates the `principal` from the `sub` returned by the Supabase admin
 * invite call, never from a subject supplied by the client." `findByEmail` runs first, so a second seed run adopts
 * the existing user rather than creating a second owner.
 *
 * The `admin` assignment is granted with the **system principal** as the actor, which is what makes it legal:
 * `forbid_self_grant` (R5) rejects a principal granting a role to themselves.
 *
 * **The lookup happens BEFORE the insert, never between the principal insert and the membership insert.**
 * `principal_in_tenant`, the only SELECT policy on `app.principal`, admits a row only through a membership in the
 * current tenant, and the table is FORCE ROW LEVEL SECURITY, which binds `app_migrator` too. A brand-new principal
 * has no membership yet, so a SELECT placed after the insert returns zero rows on the first run — and the same
 * policy is why the insert carries neither RETURNING nor a conflict target (see `bootstrapIdentity`).
 */
export async function bootstrapOwner(
  sql: Sql,
  config: SeedConfig,
  ids: { systemPrincipalId: string; companyId: string },
  authAdmin: SeedAuthAdmin,
  requestId: string,
): Promise<OwnerResult> {
  const user =
    (await authAdmin.findByEmail(config.ownerEmail)) ??
    (await authAdmin.createUser(config.ownerEmail));

  return withTenant(
    sql,
    { tenantId: config.tenantId, actorId: ids.systemPrincipalId, requestId },
    async (tx) => {
      // Look first: this succeeds only on a re-run, where the membership already exists and the policy admits it.
      const found = await tx<{ id: string }[]>`
        select id::text as id from app.principal where auth_subject = ${user.sub}`;
      const [minted] = await tx<{ id: string }[]>`select uuidv7()::text as id`;
      const ownerPrincipalId = found[0]?.id ?? minted!.id;

      const inserted =
        await tx`insert into app.principal (id, kind, auth_subject, email, display_name)
               values (${ownerPrincipalId}, 'human', ${user.sub}, ${user.email}, ${config.ownerEmail})
               on conflict do nothing`;
      // DBS-12's backstop for a direct caller: nothing visible and nothing inserted is another tenant's subject.
      if (found.length === 0 && inserted.count === 0) throw ownerTaken(config.ownerEmail);
      await tx`insert into app.membership (tenant_id, principal_id) values (${config.tenantId}, ${ownerPrincipalId})
               on conflict (tenant_id, principal_id) do nothing`;

      const [adminRole] = await tx<{ id: string }[]>`
        select id::text as id from app.role where tenant_id = ${config.tenantId} and code = 'admin'`;
      if (!adminRole)
        throw new SeedError(
          "the `admin` role is not seeded — run the `roles` loader before the owner step (§3.6.4)",
        );
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${config.tenantId}, ${ownerPrincipalId}, ${adminRole.id}, ${ids.companyId})
               on conflict (principal_id, role_id, company_id) do nothing`;
      return { ownerPrincipalId, authSubject: user.sub };
    },
  );
}
