import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedTenantV2, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi, type ApiRequest } from "../support/app";

/**
 * Code review 2, S3 — the document gates are asked COMPANY FIRST.
 *
 * `requireDocumentPermission`, `requireDocumentModuleRead`, `requireAttachmentRead`, the upload gate and the
 * override gate each looked the row up before asking any authority question: a real id answered 403 naming
 * the resolved code, the document's type or its branch, and a random id answered 404. So a principal with no
 * role in the path company — a bare tenant member, or one who holds every code in a SIBLING company of the
 * same tenant — learnt that an id exists in the company, what type it is and which branch it sits in. The
 * module's own read gate says no fact about a document may leak to a caller outside the company
 * (`routes/accounting/documents.ts`, on `read`).
 *
 * Each gate now asks first whether the caller holds a live role in the path company, and refuses with one
 * message that names no id, type or branch. A member of the company is unaffected: still 403 naming the code
 * for a real id and 404 for an unknown one (the last case pins that residue — it is by design, and Phase 6's
 * `branch_isolation` narrows it further).
 */
/** A one-byte upload naming `documentId` as its owner. */
function form(documentId: string): FormData {
  const f = new FormData();
  f.set("documentId", documentId);
  f.set("file", new File([new Uint8Array([0x25]).buffer], "x.pdf", { type: "application/pdf" }));
  return f;
}

describe("the document gates refuse a caller outside the company before any lookup (S3)", () => {
  let api: StartedApi;
  let a: Seed;
  let member: string;
  let sibling: string;
  let insider: string;
  let documentId: string;
  let attachmentId: string;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "CompanyFirst");
    documentId = await uuidv7(api.db.admin);
    attachmentId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${documentId}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${a.tenant}, ${a.company}, ${documentId}, 1, ${a.cash}, 3.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${a.tenant}, ${a.company}, ${documentId}, 2, ${a.sales}, 3.0000)`;
      await tx`
        insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name,
                                    mime_type, byte_size, sha256)
        values (${attachmentId}, ${a.tenant}, ${a.company}, ${documentId},
                ${`${a.tenant}/${attachmentId}`}, 'probe.pdf', 'application/pdf', 1, decode('00', 'hex'))`;
    });

    // A tenant member with no role anywhere.
    member = await secondPrincipal(api.db, a, "company-first-member");
    // Every code a human may hold (the admin set), but in a SIBLING company of the same tenant only.
    sibling = await secondPrincipal(api.db, a, "company-first-sibling");
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${a.tenant}, 'CF-SIBLING', 'Sibling company', 'MYR') returning id`;
      const [role] = await tx<{ id: string }[]>`
        insert into app.role (tenant_id, code, name_en)
        values (${a.tenant}, 'company-first-everything', 'Everything, elsewhere') returning id`;
      await tx`
        insert into app.role_permission (tenant_id, role_id, permission_code)
        select ${a.tenant}, ${role!.id}, code from app.permission
         where code <> 'pos.ticket.sell' and code not like 'pos.sync.%'`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${sibling}, ${role!.id}, ${company!.id})`;
    });
    // A member of the company who holds none of the codes these routes ask.
    insider = await secondPrincipal(api.db, a, "company-first-insider");
    await grantCodes(api.db, a, {
      principalId: insider,
      codes: ["admin.audit_log.read"],
      roleCode: "company-first-insider",
    });
    await api.loadPrincipals();
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  /** Every gated route that resolves a document, a type or an attachment from the request, for one id. */
  const routes = (
    id: string,
    attachment: string,
  ): (Omit<ApiRequest, "as"> & { name: string })[] => {
    const base = `/v1/companies/${a.company}`;
    return [
      {
        name: "POST transitions",
        method: "POST",
        path: `${base}/documents/${id}/transitions`,
        body: { to: "posted" },
      },
      {
        name: "PUT lines",
        method: "PUT",
        path: `${base}/documents/${id}/lines`,
        body: { lines: [{ lineNo: 1, accountId: a.cash, debit: "1.0000" }] },
      },
      { name: "DELETE document", method: "DELETE", path: `${base}/documents/${id}` },
      {
        name: "POST overrides",
        method: "POST",
        path: `${base}/documents/${id}/overrides`,
        body: { code: "inventory.negative_stock.override", reason: "probe" },
      },
      { name: "GET events", method: "GET", path: `${base}/documents/${id}/events` },
      { name: "GET open-balance", method: "GET", path: `${base}/documents/${id}/open-balance` },
      { name: "GET allocations", method: "GET", path: `${base}/documents/${id}/allocations` },
      {
        name: "POST print",
        method: "POST",
        path: `${base}/documents/${id}/print`,
        body: { lang: "en" },
      },
      {
        name: "GET attachment content",
        method: "GET",
        path: `${base}/attachments/${attachment}/content`,
      },
    ];
  };

  for (const who of ["member", "sibling"] as const) {
    it(`a ${who === "member" ? "bare tenant member" : "holder of every code in a sibling company"} gets one 403 for a real id and a random one`, async () => {
      const as = who === "member" ? member : sibling;
      const randomDoc = await uuidv7(api.db.admin);
      const randomAttachment = await uuidv7(api.db.admin);
      const real = routes(documentId, attachmentId);
      const random = routes(randomDoc, randomAttachment);
      for (const [i, route] of real.entries()) {
        const { name, ...request } = route;
        const r1 = await api.request({ ...request, as });
        const r2 = await api.request({ ...random[i]!, as });
        const p1 = (await r1.json()) as Problem;
        const p2 = (await r2.json()) as Problem;
        expect([r1.status, p1.code], `${name}: real id`).toEqual([403, "ERR_RBAC_FORBIDDEN"]);
        expect([r2.status, p2.code], `${name}: random id`).toEqual([403, "ERR_RBAC_FORBIDDEN"]);
        // The same words for both ids, and none of them is a fact about the document.
        expect(p1.detail, name).toBe(p2.detail);
        for (const fact of ["JOURNAL", a.hq, documentId, attachmentId, "accounting."])
          expect(p1.detail, `${name} leaks ${fact}`).not.toContain(fact);
      }
    });
  }

  it("the upload gate refuses a caller outside the company before it looks the document up", async () => {
    for (const as of [member, sibling]) {
      const real = await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/attachments`,
        as,
        form: form(documentId),
      });
      const random = await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/attachments`,
        as,
        form: form(await uuidv7(api.db.admin)),
      });
      const [p1, p2] = [(await real.json()) as Problem, (await random.json()) as Problem];
      expect([real.status, p1.code]).toEqual([403, "ERR_RBAC_FORBIDDEN"]);
      expect([random.status, p2.code]).toEqual([403, "ERR_RBAC_FORBIDDEN"]);
      expect(p1.detail).toBe(p2.detail);
      expect(p1.detail).not.toContain(documentId);
    }
  });

  it("the create gate refuses a caller outside the company before it looks the type up", async () => {
    const body = (documentTypeCode: string) => ({
      documentTypeCode,
      effectiveDate: "2026-01-15",
      currency: "MYR",
      branchId: a.hq,
      lines: [
        { lineNo: 1, accountId: a.cash, debit: "1.0000" },
        { lineNo: 2, accountId: a.sales, credit: "1.0000" },
      ],
    });
    for (const as of [member, sibling]) {
      const known = await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/documents`,
        as,
        body: body("JOURNAL"),
      });
      const unknown = await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/documents`,
        as,
        body: body("NO_SUCH_TYPE"),
      });
      const [p1, p2] = [(await known.json()) as Problem, (await unknown.json()) as Problem];
      expect([known.status, p1.code]).toEqual([403, "ERR_RBAC_FORBIDDEN"]);
      expect([unknown.status, p2.code]).toEqual([403, "ERR_RBAC_FORBIDDEN"]);
      expect(p1.detail).toBe(p2.detail);
    }
  });

  it("a member of the company still gets 403 naming the code for a real id, and 404 for an unknown one", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${documentId}/events`,
      as: insider,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).detail).toContain("accounting.ledger.read");
    const missing = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/documents/${await uuidv7(api.db.admin)}/events`,
      as: insider,
    });
    expect(missing.status).toBe(404);
  });
});
