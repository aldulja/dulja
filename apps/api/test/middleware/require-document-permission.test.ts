import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedTenantV2, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { stageCode } from "../../src/middleware/require-document-permission";
import { startApi, type StartedApi } from "../support/app";

describe("requireDocumentPermission — contracts §4.5.4, spec:2173", () => {
  let api: StartedApi;
  let a: Seed;
  let clerk: string;
  let poster: string;

  const draft = async (): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${id}, 1, ${a.cash}, 3.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${id}, 2, ${a.sales}, 3.0000)`;
    });
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a);
    clerk = await uuidv7(api.db.admin);
    poster = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      for (const [id, label] of [
        [clerk, "clerk"],
        [poster, "poster"],
      ] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`${label}:${a.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(api.db, a, { principalId: clerk, codes: ["accounting.journal.create"] });
    await grantCodes(api.db, a, { principalId: poster, codes: ["accounting.journal.post"] });
    await api.loadPrincipals();
  });
  afterAll(async () => {
    await api.stop();
  });

  it("maps every stage exactly as contracts §4.5.4 states", () => {
    const full = {
      required: true,
      approve: "hr.payroll.approve",
      post: "hr.payroll.post",
      create: "hr.payroll.prepare",
    };
    expect(stageCode("create", full)).toBe("hr.payroll.prepare");
    expect(stageCode("submit", full)).toBe("hr.payroll.prepare");
    expect(stageCode("approve", full)).toBe("hr.payroll.approve");
    expect(stageCode("issue", full)).toBe("hr.payroll.post");
    expect(stageCode("post", full)).toBe("hr.payroll.post");
    expect(stageCode("void", full)).toBe("hr.payroll.post");

    // JOURNAL_POLICY_V1 shape: no `create`, no `approve` (contracts §4.3.7 — assumption 3)
    const journal = { required: false, approve: null, post: "accounting.journal.post" };
    expect(stageCode("create", journal)).toBe("accounting.journal.post");
    expect(stageCode("submit", journal)).toBe("accounting.journal.post");
    expect(stageCode("approve", journal)).toBe("accounting.journal.post");
  });

  it("403 ERR_RBAC_FORBIDDEN naming the resolved code when the caller lacks it", async () => {
    const d = await draft();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${d}/transitions`,
      as: clerk,
      body: { to: "posted" },
    });
    expect(res.status).toBe(403);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.journal.post");
  });

  it("lets the request through when the caller holds the resolved code", async () => {
    const d = await draft();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${d}/transitions`,
      as: poster,
      body: { to: "issued" },
    });
    expect(res.status).toBe(200);
  });

  it("404 ERR_NOT_FOUND for a document of another tenant, revealing nothing", async () => {
    const b = await seedTenantV2(api.db, "Beta");
    await grantCodes(api.db, b);
    const bDoc = await uuidv7(api.db.admin);
    await withTenant(
      api.db.rw,
      b.tenant,
      b.human,
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
        values (${bDoc}, ${b.tenant}, ${b.company}, ${b.docType}, 'JV', '2026-01-15', 'MYR', ${b.hq})`,
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${bDoc}/transitions`,
      as: poster,
      body: { to: "issued" },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
  });

  it("422 ERR_POLICY_NOT_FOUND when nothing is effective for the document's date", async () => {
    // POLICY_TEST_2 is §4.14's registered test-only code for "a type whose only policy version is effective
    // after the document's date" (hazard 32 forbids inventing a LATE2). The error is 2A's `resolvePolicy`
    // (contracts §4.3.1) raising ERR_POLICY_NOT_FOUND — the middleware adds no branch.
    const late = await uuidv7(api.db.admin);
    const lateDoc = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en)
               values (${late}, ${a.tenant}, ${a.company}, 'POLICY_TEST_2', 'Late')`;
      await tx`insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
               values (${a.tenant}, ${late}, 1, '2030-01-01', '{"version":1,"documentType":"POLICY_TEST_2","direction":"none","lines":[]}'::jsonb)`;
    });
    await withTenant(
      api.db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
        values (${lateDoc}, ${a.tenant}, ${a.company}, ${late}, 'PT2', '2026-01-15', 'MYR', ${a.hq})`,
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents/${lateDoc}/transitions`,
      as: poster,
      body: { to: "submitted" },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Problem).code).toBe("ERR_POLICY_NOT_FOUND");
  });

  it("resolves PUT …/lines and DELETE …/{id} from the DOCUMENT, not from a body the route has none of", async () => {
    // Both routes mount the `create` stage. An earlier version read `documentTypeCode` from the body for that
    // stage and never fell through to the `:documentId` lookup, so ReplaceLinesBody (`{ lines }` only) and a
    // body-less DELETE resolved a type named "" and 404ed on every call.
    const id = await draft();
    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${a.company}/documents/${id}/lines`,
      as: poster,
      body: {
        lines: [
          { lineNo: 1, accountId: a.cash, debit: "2.0000" },
          { lineNo: 2, accountId: a.sales, credit: "2.0000" },
        ],
      },
    });
    expect(replaced.status).toBe(200);
    // The clerk holds accounting.journal.create only; JOURNAL resolves the create stage to approval.post.
    const refused = await api.request({
      method: "PUT",
      path: `/v1/companies/${a.company}/documents/${id}/lines`,
      as: clerk,
      body: { lines: [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }] },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as Problem).detail).toContain("accounting.journal.post");
    const deleted = await api.request({
      method: "DELETE",
      path: `/v1/companies/${a.company}/documents/${id}`,
      as: poster,
    });
    expect(deleted.status).toBe(200);
  });

  it("asks about the BRANCH the draft names, so a branch-restricted principal can draft there", async () => {
    const hqOnly = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${hqOnly}, 'human', ${`hq-only:${a.tenant}`}, 'HQ only')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${hqOnly})`;
    });
    await grantCodes(api.db, a, {
      principalId: hqOnly,
      codes: ["accounting.journal.post"],
      branchIds: [a.hq],
    });
    await api.loadPrincipals();
    // `actor_has(code, company, NULL)` is false for a principal who holds the code at one branch only; the
    // gate must ask about the body's branch, which is the branch the trigger will later check.
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: hqOnly,
      body: {
        documentTypeCode: "JOURNAL",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, accountId: a.cash, debit: "1.0000" },
          { lineNo: 2, accountId: a.sales, credit: "1.0000" },
        ],
      },
    });
    expect(res.status).toBe(201);
  });

  it("resolves the CREATE stage from the body's documentTypeCode, not from a path id", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/documents`,
      as: clerk,
      body: {
        documentTypeCode: "JOURNAL",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: a.hq,
        lines: [
          { lineNo: 1, accountId: a.cash, debit: "1.0000" },
          { lineNo: 2, accountId: a.sales, credit: "1.0000" },
        ],
      },
    });
    // assumption 3: JOURNAL declares no approval.create, so the create stage resolves to approval.post and the
    // clerk — who holds only accounting.journal.create — is refused.
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).detail).toContain("accounting.journal.post");
  });
});
