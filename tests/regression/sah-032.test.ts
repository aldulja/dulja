import { uuidv7, grantCodes, seedTenantV2 } from "@dulja/db/test";
import { thinRegression, sliceRegression } from "../support/regression";
import { postDocument, transitionDocument } from "@dulja/db";

thinRegression(
  "SAH-032",
  "A user can raise a document's approval level above their own",
  "packages/db/test/tenant-isolation.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-032" };
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'sah032', 'SAH-032')`;
    });

    await expect(
      withTenant(
        rw,
        ctx,
        (tx) =>
          tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
         values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SELF_GRANT/); // a principal cannot widen its own authority
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "SAH-032",
  "A user can raise a document's approval level above their own",
  "2B",
  "the authority check is in the data layer, so there is no second door to find",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH032-2B");
    await grantCodes(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah032" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${s.tenant}, ${s.company}, ${doc}, 1, ${s.cash}, 3.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${s.tenant}, ${s.company}, ${doc}, 2, ${s.sales}, 3.0000)`;
    });
    // s.human holds no posting permission: seedTenant grants no permission (contracts §4.1). The legacy check looked only
    // at the OLD level, so a user at sign 1 could write sign 9. Here the NEW state is authorised.
    await withTenant(rw, ctx, (tx) =>
      transitionDocument(tx, ctx, { documentId: doc, to: "issued" }),
    );
    await expect(
      withTenant(rw, ctx, (tx) => tx`update app.document set status = 'posted' where id = ${doc}`),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post/);
    // and the "side door" shape — flipping a column to promote the document — does not exist: status is the
    // only path to posted, and it is the column the trigger watches.
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "sah032-post" });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    const [row] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ status: string; posted_by: string }[]>`
        select status::text as status, posted_by from app.document where id = ${doc}`,
    );
    expect(row).toEqual({ status: "posted", posted_by: s.human });
  },
);

// 8B Task 14 — the PAYROLL approval levels are three different codes, and the seeded preparer holds only one.
import { repoFile } from "../support/regression";

sliceRegression(
  "SAH-032",
  "A user can raise a document's approval level above their own",
  "8B",
  "PAYROLL names three different codes and the seeded hr_payroll role holds prepare, never approve or post (R6)",
  async ({ expect }) => {
    const envelope = JSON.parse(repoFile("packages/db/seed/my/document-types/PAYROLL.json")) as {
      policy: { approval: { required: boolean; create: string; approve: string; post: string } };
    };
    const a = envelope.policy.approval;
    expect(a.required).toBe(true);
    expect([a.create, a.approve, a.post]).toEqual([
      "hr.payroll.prepare",
      "hr.payroll.approve",
      "hr.payroll.post",
    ]);
    const roles = repoFile("packages/db/seed/roles.ts");
    const hr = roles.slice(roles.indexOf('code: "hr_payroll"'), roles.indexOf('code: "auditor"'));
    expect(hr).toContain('"hr.payroll.prepare"');
    expect(hr).not.toContain('"hr.payroll.approve"');
    expect(hr).not.toContain('"hr.payroll.post"');
  },
);

// ─── 2026-11-15 review (API-03, ADR 0091) ──────────────────────────────────────────────────────────────────
// The legacy check looked at the OLD level only; Dulja's role administration had the same shape one layer up: a
// holder of admin.role.manage could raise the seeded `user` role — held in every company — above their own
// authority. The data layer now refuses any app_rw change to a system role (migration 0124); the API's ceiling
// (missingCeilingAtTenantScope, missingCeilingForAssignment) is covered in apps/api/test/routes/admin/role-ceiling.
sliceRegression(
  "SAH-032",
  "A user can raise a document's approval level above their own",
  "2026-11-15 review",
  "no app_rw session can widen a system role, whoever the actor is (0124, spec:2152)",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH032-0124");
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
               values (${roleId}, ${s.tenant}, 'user', 'User', true)`;
    });
    // s.human holds admin.role.manage — and does not hold the role, so forbid_self_grant (0001) would not stop it.
    await grantCodes(db, s, { codes: ["admin.role.manage"], roleCode: "sah032-manage" });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah032-0124" };
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                   values (${s.tenant}, ${roleId}, 'accounting.payment.approve')`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SYSTEM_ROLE/);
  },
);
