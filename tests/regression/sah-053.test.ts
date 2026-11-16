import { thinRegression } from "../support/regression";

thinRegression(
  "SAH-053",
  "Runtime DDL disables integrity machinery mid-transaction",
  "packages/db/test/privileges.test.ts",
  async ({ rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-053" };
    const [create] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ ok: boolean }[]>`select has_schema_privilege('app_rw', 'app', 'create') as ok`,
    );
    expect(create!.ok).toBe(false); // the app role owns nothing and can create nothing

    // Literal tagged templates, one per statement: `sql.unsafe` has exactly three homes and none of them is a
    // test (contracts §3.3, hazard 21), and DDL text cannot be a bind parameter in any case.
    await expect(
      withTenant(rw, ctx, (tx) => tx`alter table app.company disable trigger all`),
    ).rejects.toThrow(/must be owner|permission denied/i);
    await expect(
      withTenant(rw, ctx, (tx) => tx`alter table app.ledger_entry disable row level security`),
    ).rejects.toThrow(/must be owner|permission denied/i);
    await expect(
      withTenant(rw, ctx, (tx) => tx`drop trigger audit_row on app.company`),
    ).rejects.toThrow(/must be owner|permission denied/i);
    await expect(
      withTenant(rw, ctx, (tx) => tx`create table app.sneaky (id uuid)`),
    ).rejects.toThrow(/permission denied/i);
  },
);
