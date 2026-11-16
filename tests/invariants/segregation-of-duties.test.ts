import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordOverride,
  systemContext,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedDocumentType,
  seedTenantV2,
  uuidv7,
  withTenant as testWithTenant,
  type Seed,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";

/** contracts §4.14's SOD_TEST — the only registered shape in which approval.approve and approval.post DIFFER,
 *  which is what makes "above their own authority" testable. Test only; never seeded into a pack. */
const SOD_TEST = {
  version: 1,
  documentType: "SOD_TEST",
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "SD", assignAt: "issue" },
  reversal: { allowed: true, producesType: "SOD_TEST" },
  // approve and post are DIFFERENT codes on purpose: that is what makes "above their own authority" testable.
  approval: {
    required: true,
    approve: "accounting.journal.create",
    post: "accounting.journal.post",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

const ctx = (s: Seed, actorId: string): TenantContext => ({
  tenantId: s.tenant,
  actorId,
  requestId: "sod",
});

/**
 * Acceptance tests 10 (spec:2428) and 31 (spec:2449). SAH-032: the legacy trigger checked only the OLD
 * approval level and never that the new one was within the actor's own authority, then stamped an approval
 * date to make the forgery look genuine. A second door promoted a document when a boolean was flipped, with
 * no check of the actor at all.
 *
 * The fix is that both controls live in ONE place — the BEFORE UPDATE OF status trigger of migration 0022
 * (ADR 0029) — so there is no "other door" to find. This file proves that by asserting the identical
 * behaviour on three paths that share no application code:
 *   the HTTP route, where the middleware pre-flights and returns 403 with a remedy;
 *   the job path, under the tenant's system principal — the context `runJob` hands every handler (§4.2.6),
 *     built with the production `systemContext` because at 2B no registered handler changes document status;
 *   a bare UPDATE as `app_rw`, which is what an admin at a psql prompt, the importer and a future handler
 *     that forgets the helper all reduce to.
 */
describe("acceptance tests 10 and 31 — approval authority and segregation of duties", () => {
  let api: StartedApi;
  let a: Seed;
  let sodType: string;
  let maker: string; // holds approve + post, and submits
  let checker: string; // holds approve + post, and does not submit
  let approverOnly: string; // holds approve and NOT post — test 10's "above their own authority"
  let outsider: string; // holds nothing

  const person = async (label: string, codes: readonly string[]): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    });
    if (codes.length > 0) {
      await grantCodes(api.db, a, { principalId: id, codes, roleCode: `sod-${label}` });
    }
    await api.loadPrincipals();
    return id;
  };

  /**
   * A SOD_TEST document with two balanced lines, INSERTED DIRECTLY at `status`. Both status triggers are
   * `... update of status` triggers, so an INSERT fires neither and the row carries no `document_event`
   * history: `draftAt("submitted")` is the only way to reach a submitted document with no submitted event,
   * which is the one state in which R1's first clause can speak. Reaching `submitted` by UPDATE would have
   * written that event, and starting from `draft` never reaches R1 at all — the matrix refuses
   * `draft → approved` as an illegal pair first (migration 0022, block 2a before block 2b).
   *
   * Lines are written only when `status` is `draft`: since migration 0113 a line can be added only to a draft
   * (ERR_DOC_NOT_DRAFT), and R1's first case, the one caller that starts at `submitted`, needs none.
   */
  const draftAt = async (status: string, on = "2026-01-15"): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await testWithTenant(api.db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, status, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${sodType}, 'SD', ${status}::app.document_status, ${on}, 'MYR', ${a.hq})`;
      if (status !== "draft") return;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 8.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 8.0000)`;
    });
    return id;
  };

  /** A draft of SOD_TEST — the ordinary starting point for every case but R1's first. */
  const draft = (on = "2026-01-15"): Promise<string> => draftAt("draft", on);

  /** One status change as `actor`, by bare app_rw UPDATE — the lowest path there is. */
  const bySql = (documentId: string, to: string, actor: string, reason: string | null = null) =>
    withTenant(api.db.rw, ctx(a, actor), async (tx) => {
      await tx`select set_config('app.event_reason', ${reason ?? ""}, true),
                      set_config('app.event_attributed_to', '', true)`;
      await tx`update app.document set status = ${to}::app.document_status where id = ${documentId}`;
    });

  /** The same change through the service seam, as a job would. */
  const byJob = async (documentId: string, to: "submitted" | "approved" | "draft") => {
    const sys = await systemContext(api.db.rw, a.tenant, "sod-job");
    return withTenant(api.db.rw, sys, (tx) =>
      transitionDocument(tx, sys, { documentId, to, reason: "job" }),
    );
  };

  /** And through HTTP. */
  const byApi = (documentId: string, to: string, actor: string, reason?: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${documentId}/transitions`,
      as: actor,
      body: { to, ...(reason === undefined ? {} : { reason }) },
    });

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a, {
      codes: ["accounting.journal.create", "accounting.journal.post"],
    });
    maker = a.human;
    checker = await person("checker", ["accounting.journal.create", "accounting.journal.post"]);
    approverOnly = await person("approver-only", ["accounting.journal.create"]);
    outsider = await person("outsider", []);
    // A member of the company holding no code: since code review 2 (S3) a caller with NO role in the path
    // company is refused on the company before the policy is resolved, and R2's case below is about the
    // code the policy resolves.
    await grantCodes(api.db, a, { principalId: outsider, roleCode: "sod-outsider" });
    // effectiveFrom is passed explicitly so app.effective_policy picks this row for the 2026-01-15 documents.
    sodType = await seedDocumentType(api.db, a, {
      code: "SOD_TEST",
      policy: SOD_TEST,
      effectiveFrom: "2026-01-01",
    });
  });
  afterAll(async () => {
    await api.stop();
  });

  it("R1 — approving a submitted document with no submitted event is ERR_SOD_NO_SUBMISSION on all three paths", async () => {
    // Each row is INSERTED at `submitted` (see draftAt): a document moved there by any of the three paths
    // would carry the submitted event the AFTER trigger wrote, and a document still in `draft` never reaches
    // R1 at all — the matrix refuses `draft → approved` first. This is the state R1's first clause exists for.
    const forApi = await draftAt("submitted");
    const forJob = await draftAt("submitted");
    const forSql = await draftAt("submitted");

    const res = await byApi(forApi, "approved", checker);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "ERR_SOD_NO_SUBMISSION" });

    await expect(byJob(forJob, "approved")).rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
    await expect(bySql(forSql, "approved", checker)).rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
  });

  // The job path is NOT in this loop: the acting principal there is the tenant's system principal, so
  // "submitter approves their own document" needs the job to have submitted it too — which is precisely the
  // next case, where byJob submits and byJob approves. Naming a third path here and then skipping its
  // maker-is-checker assertion would overstate what runs (a vacuous iteration).
  it("R1 — the submitter can neither approve nor post their own document, on the API and SQL paths", async () => {
    for (const path of ["api", "sql"] as const) {
      const doc = await draft();
      await bySql(doc, "submitted", maker, "mine");

      if (path === "api") {
        const res = await byApi(doc, "approved", maker);
        expect(res.status).toBe(409);
        expect((await res.json()) as { code: string; detail: string }).toMatchObject({
          code: "ERR_SOD_MAKER_IS_CHECKER",
        });
      } else {
        await expect(bySql(doc, "approved", maker)).rejects.toThrow(
          /ERR_SOD_MAKER_IS_CHECKER: principal .* cannot approve it/,
        );
      }

      // …and the same at the posting edge, once a genuine second principal has approved and issued it.
      await bySql(doc, "approved", checker, "checked");
      await bySql(doc, "issued", checker);
      await expect(bySql(doc, "posted", maker)).rejects.toThrow(
        /ERR_SOD_MAKER_IS_CHECKER: principal .* cannot post it/,
      );
      await bySql(doc, "posted", checker);
    }
  });

  /** The job path's R1 binding, which the loop above deliberately leaves to this case. */
  it("R1 binds the system principal too: a job cannot approve what the same job submitted", async () => {
    const doc = await draft();
    await byJob(doc, "submitted");
    await expect(byJob(doc, "approved")).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    // A human second principal can, because the submitted actor was the system principal and not this one.
    await bySql(doc, "approved", checker, "checked by a human");
    const [row] = await withTenant(
      api.db.rw,
      ctx(a, checker),
      (tx) =>
        tx<{ status: string }[]>`select status::text as status from app.document where id = ${doc}`,
    );
    expect(row!.status).toBe("approved");
  });

  it("R2 — a principal without the policy's code is refused, and the API's 403 is not the control", async () => {
    const doc = await draft();
    await bySql(doc, "submitted", maker, "for review");

    // The HTTP path stops at the pre-flight: 403, naming the code the policy resolved.
    const res = await byApi(doc, "approved", outsider);
    expect(res.status).toBe(403);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.journal.create"); // approval.approve, not .post

    // Remove the pre-flight from the picture entirely and the answer is identical — 409 from the trigger.
    // This assertion is the whole point of ADR 0029: deleting the middleware would not weaken the control.
    await expect(bySql(doc, "approved", outsider)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.create/,
    );
  });

  it("test 10 — a principal cannot act above their own authority: approve yes, post no", async () => {
    const doc = await draft();
    await bySql(doc, "submitted", maker, "for review");
    await bySql(doc, "approved", approverOnly, "within my authority");
    await bySql(doc, "issued", approverOnly);
    // `approverOnly` holds approval.approve and not approval.post. Issuing consumes a number and commits
    // nothing (ADR 0029), so it is admitted; posting is refused.
    await expect(bySql(doc, "posted", approverOnly)).rejects.toThrow(
      /ERR_RBAC_FORBIDDEN: principal .* does not hold accounting\.journal\.post/,
    );
    const [row] = await withTenant(
      api.db.rw,
      ctx(a, checker),
      (tx) =>
        tx<{ status: string }[]>`select status::text as status from app.document where id = ${doc}`,
    );
    expect(row!.status).toBe("issued");
  });

  it("test 10 — there is no side effect that raises the state: every illegal pair is refused", async () => {
    const doc = await draft();
    // draft → approved / posted / void / reversed, with a reason and a fully authorised actor. Each is
    // ERR_DOC_STATUS_ILLEGAL and nothing else: the matrix runs before R1 and R2, and it names no pair out of
    // `draft` but `submitted` and `issued`. (`ERR_SOD_NO_SUBMISSION` belongs to the first case in this file,
    // which starts from a row INSERTED at `submitted` — it is not reachable from a draft.)
    for (const to of ["approved", "posted", "void", "reversed"]) {
      await expect(bySql(doc, to, checker, "trying"), `draft → ${to}`).rejects.toThrow(
        /ERR_DOC_STATUS_ILLEGAL/,
      );
    }
    // and no event was written for any of them, so nothing "looks like" an approval afterwards (SAH-032)
    const events = await withTenant(
      api.db.rw,
      ctx(a, checker),
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.document_event where document_id = ${doc}`,
    );
    expect(events[0]!.n).toBe(0);
  });

  it("R2 does not bind the system principal — asserted, so nobody 'fixes' it by accident", async () => {
    // spec:2179: "the system principal holds no role, but app.actor_has() returns true for it so server-side
    // jobs can read RLS-gated rows — it is reachable only from jobs and the seed CLI, never from a request
    // path (RC-1)". The matrix and R1 still bind it (the two cases above); R2 deliberately does not. If this
    // assertion ever fails, every scheduled job in the system has stopped working, which is the intended
    // alarm — it is not a licence to weaken R1.
    const sys = await systemContext(api.db.rw, a.tenant, "sod-authority");
    const [row] = await withTenant(
      api.db.rw,
      sys,
      (tx) =>
        tx<
          { ok: boolean }[]
        >`select app.actor_has('accounting.journal.post', ${a.company}, ${a.hq}) as ok`,
    );
    expect(row!.ok).toBe(true);
  });

  it("the override door cannot launder authority: a job's blanket authority does not carry to the attributed principal", async () => {
    const doc = await draft();
    await api.db.migrator`insert into app.permission (code, module, mutating, description)
      values ('accounting.credit_limit.override', 'accounting', true, 'test-local stand-in for 4A''s code')
      on conflict (code) do nothing`;
    const sys = await systemContext(api.db.rw, a.tenant, "sod-override");
    // The guard checks principal_has(attributed_to ?? actor_id, …) — NOT actor_has — so attributing an
    // override to a principal who does not hold the code is refused even though the acting principal is the
    // system one, for which actor_has is unconditionally true. This is the assertion 6C's sync apply and 4A's
    // credit control both depend on (contracts §4.5.3, R8 spec:2179).
    await expect(
      withTenant(api.db.rw, sys, (tx) =>
        recordOverride(tx, sys, {
          documentId: doc,
          code: "accounting.credit_limit.override",
          reason: "job says so",
          attributedTo: outsider,
        }),
      ),
    ).rejects.toThrow(
      /ERR_OVERRIDE_NOT_AUTHORISED: principal .* does not hold accounting\.credit_limit\.override/,
    );
  });

  it("test 31's R5 clause still holds: no self-grant, no self-escalation (Plan 0A, re-asserted)", async () => {
    // Plan 0A's forbid_self_grant proved this and 0B re-ran it through the API; it is re-asserted here so this
    // file is a complete statement of what segregation of duties means at this release.
    const roleId = await uuidv7(api.db.admin);
    await testWithTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'sod-self', 'Self')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${checker}, ${roleId}, ${a.company})`;
    });
    await expect(
      withTenant(
        api.db.rw,
        ctx(a, checker),
        (tx) => tx`
          insert into app.role_permission (tenant_id, role_id, permission_code)
          values (${a.tenant}, ${roleId}, 'accounting.period.close')`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SELF_ESCALATION|ERR_RBAC_SELF_GRANT/);
  });
});
