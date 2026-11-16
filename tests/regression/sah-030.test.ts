import { thinRegression } from "../support/regression";

thinRegression(
  "SAH-030",
  "A login parameter switches the audit trail off",
  "packages/db/test/audit.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-030" };
    const [before] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;

    await withTenant(rw, ctx, async (tx) => {
      // Every off-switch the legacy system had, invented back inside the transaction. None exists; all are inert
      // — an unknown `app.*` GUC is just a string nothing reads.
      await tx`select set_config('app.silent', '1', true), set_config('app.audit', 'off', true),
                      set_config('app.no_audit', 'true', true), set_config('app.login_silent', '1', true)`;
      await tx`insert into app.company (tenant_id, code, name, base_currency) values (${a.tenant}, 'SAH030', 'SAH-030', 'MYR')`;
    });

    const [after] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant}`;
    expect(after!.n).toBe(before!.n + 1);

    // The one setting Postgres really does have for silencing triggers is superuser-only, and `app_rw` is not
    // one — so the legacy design (an off-switch the caller supplies) has no equivalent here at all. This is a
    // separate statement because the refusal aborts its transaction; folding it into the block above would stop
    // the insert before the audit assertion could run.
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`select set_config('session_replication_role', 'replica', true)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  },
);

// ─── 8A ──────────────────────────────────────────────────────────────────────────────────────────────────
// No flag, query parameter, header or session setting suppresses an HR audit row. The block builds its OWN API
// (hrFixture takes the running API, A6) and stops it, so the memoised shared API is never stopped under another file.
import {
  createHrKeyRing as ringOf,
  DEV_HR_KEY as DEV_KEY_030,
  writeSensitive as seal030,
} from "@dulja/db";
import { startApi } from "../../apps/api/test/support/app";
import { hrFixture } from "../invariants/support/hr";
import { sliceRegression } from "../support/regression";

sliceRegression(
  "SAH-030",
  "A login parameter switches the audit trail off",
  "8A",
  "no query parameter, header or session setting suppresses an HR audit row",
  async ({ withTenant, expect }) => {
    const f = await hrFixture(await startApi(), "sah-030");
    try {
      const ring = ringOf({ current: DEV_KEY_030, currentVersion: 1 });
      const target = f.employees[0]!.id;
      const path = `/v1/companies/${f.companyId}/employees/${target}/sensitive`;
      const count = async () =>
        Number(
          (
            await f.db.admin<{ n: string }[]>`
              select count(*)::text as n from app.audit_log
               where tenant_id = ${f.seed.tenant} and table_name = 'employee_sensitive'`
          )[0]!.n,
        );
      const attempts: { label: string; run: () => Promise<unknown> }[] = [
        {
          label: "plain",
          run: async () =>
            expect(
              (
                await f.api.request({
                  method: "PUT",
                  path,
                  as: f.officer,
                  body: { passport: "SYNTHETIC-PP-1" },
                })
              ).status,
            ).toBe(200),
        },
        {
          label: "query parameter",
          run: async () =>
            expect(
              (
                await f.api.request({
                  method: "PUT",
                  path: `${path}?audit=false`,
                  as: f.officer,
                  body: { passport: "SYNTHETIC-PP-2" },
                })
              ).status,
            ).toBe(200),
        },
        {
          label: "header",
          run: async () =>
            expect(
              (
                await f.api.request({
                  method: "PUT",
                  path,
                  as: f.officer,
                  body: { passport: "SYNTHETIC-PP-3" },
                  headers: { "X-Audit": "off" },
                })
              ).status,
            ).toBe(200),
        },
        {
          label: "set_config inside the transaction",
          run: () =>
            withTenant(
              f.db.rw,
              {
                tenantId: f.seed.tenant,
                actorId: f.officer,
                requestId: "00000000-0000-7000-8000-0000000dd030",
              },
              async (tx) => {
                await tx`select set_config('app.audit', 'off', true)`;
                await seal030(tx, ring, target, { passport: "SYNTHETIC-PP-4" });
              },
            ),
        },
      ];
      for (const attempt of attempts) {
        const before = await count();
        await attempt.run();
        expect(await count(), `${attempt.label} suppressed an audit row`).toBe(before + 1);
      }
    } finally {
      await f.api.stop();
    }
  },
);
