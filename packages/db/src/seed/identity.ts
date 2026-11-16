import type { Sql } from "postgres";
import { withTenant } from "../with-tenant";
import type { SeedConfig } from "./config";

export interface IdentityResult {
  readonly systemPrincipalId: string;
  readonly created: boolean;
}

/**
 * Bootstrap steps 1–3 (spec:1997–1999), in **one transaction**.
 *
 * The re-run problem and its answer: on the second run the acting actor must be the *existing* system principal,
 * but `app_migrator` cannot call `app.resolve_principal` (EXECUTE is granted to `app_rw` only) and
 * `FORCE ROW LEVEL SECURITY` hides `app.principal` until a tenant is set. The `principal_in_tenant` policy tests
 * `app.current_tenant()` alone, so: open with the tenant set and a provisional actor, look the system principal up
 * by its `auth_subject`, then re-issue `set_config('app.actor_id', …, true)` **before the first write**. Nothing is
 * written under the provisional value.
 *
 * Every statement below is tagged by `tx`: the seed modules are not on the no-bare-db rule's allow-list.
 */
export async function bootstrapIdentity(
  sql: Sql,
  config: SeedConfig,
  requestId: string,
): Promise<IdentityResult> {
  const tenantId = config.tenantId;
  const authSubject = `system:${tenantId}`;
  // Provisional actor: any uuid. Nothing is written until it has been replaced, three statements below.
  return withTenant(sql, { tenantId, actorId: tenantId, requestId }, async (tx) => {
    const found = await tx<{ id: string }[]>`
      select id::text as id from app.principal where auth_subject = ${authSubject}`;
    const existing = found[0]?.id;
    const [minted] = await tx<{ id: string }[]>`select uuidv7()::text as id`;
    const systemPrincipalId = existing ?? minted!.id;

    // From here on every audit row carries the system principal as its server-supplied actor (spec:2000).
    await tx`select set_config('app.actor_id', ${systemPrincipalId}, true)`;

    // The tenant's own audit row cites a principal inserted two statements later: legal because
    // audit_log.actor_id is deferrable initially deferred and the audit trigger is AFTER ROW.
    await tx`insert into app.tenant (id, name) values (${tenantId}, ${config.tenantName})
             on conflict (id) do nothing`;
    // No RETURNING, and no conflict *target*: either one makes the insert require SELECT on the new row, which
    // puts `principal_in_tenant` in front of it — and a principal with no membership yet fails that policy
    // (v1.1 fix #2). The targetless form still arbitrates the `auth_subject` unique constraint on a re-run.
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${systemPrincipalId}, 'system', ${authSubject}, 'system')
             on conflict do nothing`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${tenantId}, ${systemPrincipalId})
             on conflict (tenant_id, principal_id) do nothing`;

    // §4.2.6: a scheduled job cannot list app.tenant (FORCE RLS, no tenant set), so the registry is its index.
    await tx`insert into pgboss.tenant_registry (tenant_id) values (${tenantId})
             on conflict (tenant_id) do nothing`;

    return { systemPrincipalId, created: existing === undefined };
  });
}
