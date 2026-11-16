import { describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

/**
 * The FULL regression files of contracts §3.7.3 speak HTTP, so they need an app, not just a pool.
 *
 * `startApi()` opens its OWN Testcontainers database (it calls `startDb()` internally), so the `Seed`s handed out
 * here are NOT the `Seed`s of `tests/support/regression.ts`: they live in a different database. A regression file
 * uses `sharedApi()` or `sharedDb()`, never both. One memoised start serves the whole `tests` run — the workspace
 * is single-threaded with `isolate: false` (tests/vitest.config.ts), so the module instance is shared.
 */
let started: Promise<{ api: StartedApi; a: Seed; b: Seed }> | undefined;

/**
 * Grants the five Phase 0 codes through a real `role` + `role_permission` + `role_assignment` chain, acting as the
 * tenant's SYSTEM principal — `app.forbid_self_grant` (plan0A:1385) refuses a principal granting to itself, and
 * `app.assert_assignment_kind` refuses a non-terminal role on a terminal. Identical to the harness in
 * `tests/invariants/tenant-isolation.test.ts`; duplicated rather than exported from a `.test.ts` file, which would
 * re-run that suite's `describe` on import.
 */
export async function grantAdmin(api: StartedApi, s: Seed): Promise<void> {
  await api.db.migrator.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
    const [role] = await tx<
      { id: string }[]
    >`insert into app.role (tenant_id, code, name_en, is_system)
      values (${s.tenant}, 'admin', 'Administrator', true) returning id`;
    for (const code of [
      "admin.user.manage",
      "admin.role.manage",
      "admin.role.assign",
      "admin.company.manage",
      "admin.audit_log.read",
    ]) {
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${s.tenant}, ${role!.id}, ${code})`;
    }
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
      values (${s.tenant}, ${s.human}, ${role!.id}, ${s.company})`;
  });
}

export function sharedApi(): Promise<{ api: StartedApi; a: Seed; b: Seed }> {
  started ??= (async () => {
    const api = await startApi();
    const a = await seedTenant(api.db, "Alpha");
    const b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
    await api.loadPrincipals();
    return { api, a, b };
  })();
  return started;
}

export async function problemOf(res: Response): Promise<Problem> {
  return (await res.json()) as Problem;
}

export interface FullContext {
  api: StartedApi;
  a: Seed;
  b: Seed;
  expect: typeof expect;
}

/**
 * The shape of every FULL regression file (contracts §3.7.3): one `describe` naming the defect and the slice, one
 * `it` per scenario. The cases object is walked at collection time (synchronously — vitest forbids an async
 * `describe` body); each `it` awaits the memoised app itself.
 */
export function fullRegression(
  sah: string,
  heading: string,
  cases: Record<string, (ctx: FullContext) => Promise<void>>,
): void {
  describe(`${sah} ${heading} — 0B`, () => {
    for (const [name, fn] of Object.entries(cases)) {
      it(name, async () => {
        const { api, a, b } = await sharedApi();
        await fn({ api, a, b, expect });
      });
    }
  });
}
