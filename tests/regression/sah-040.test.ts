import { grantCodes } from "@dulja/db/test";
import { uuidv7, seedTenantV2 } from "@dulja/db/test";
import { thinRegression, sliceRegression } from "../support/regression";

thinRegression(
  "SAH-040",
  "Deletions are logged less reliably than inserts, and can erase the document header",
  "packages/db/test/audit.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-040" };
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'sah040', 'SAH-040')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'admin.audit_log.read')`;
    });

    // role_permission is one of the three tables app_rw may DELETE (contracts §3.5.4) — so the delete path is
    // reachable, and it is audited exactly as the insert was, with the row's prior image.
    await withTenant(
      rw,
      ctx,
      (tx) =>
        tx`delete from app.role_permission where tenant_id = ${a.tenant} and role_id = ${roleId}`,
    );

    const [row] = await db.admin<{ action: string; before: unknown; actor_id: string }[]>`
      select action, before, actor_id from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'role_permission' order by seq desc limit 1`;
    expect(row!.action).toBe("delete");
    expect(row!.before).not.toBeNull();
    expect(row!.actor_id).toBe(a.human);
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "SAH-040",
  "Deletions are logged less reliably than inserts, and can erase the document header",
  "2B",
  "deleting a draft audits the header and every line, with the before-image, and no flag suppresses it",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH040-2B");
    await grantCodes(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah040" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 2.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 2.0000)`;
    });
    await withTenant(rw, ctx, (tx) => tx`delete from app.document where id = ${doc}`);
    // The legacy put the tombstone inside a `Silent` gate, so a delete could leave a header pointing at a
    // vanished transaction — and the archive module deleted with no logging call at all. app.audit_log's
    // discriminator is `action` with lowercase labels (migration 0001 §8).
    const rows = await db.admin<{ table_name: string; n: number }[]>`
      select table_name, count(*)::int as n from app.audit_log
       where action = 'delete' and tenant_id = ${s.tenant}
         and (before ->> 'id' = ${doc} or before ->> 'document_id' = ${doc})
       group by table_name order by table_name`;
    expect(rows).toEqual([
      { table_name: "document", n: 1 },
      { table_name: "document_line", n: 2 }, // the cascade is audited too, row by row
    ]);
    const [image] = await db.admin<{ series: string; status: string }[]>`
      select before ->> 'series' as series, before ->> 'status' as status from app.audit_log
       where table_name = 'document' and action = 'delete' and before ->> 'id' = ${doc}`;
    expect(image).toEqual({ series: "JV", status: "draft" });
  },
);
