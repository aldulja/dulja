import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { draftDocument, grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

const problemOf = async (res: Response) => (await res.json()) as Problem;

/** A `File` part over exactly these bytes. `Uint8Array<ArrayBufferLike>` is not a `BlobPart` under TS 5.7's
 *  generic typed arrays, so the view's own ArrayBuffer slice is handed over instead. */
function upload(
  documentId: string,
  name: string,
  bytes: Uint8Array,
  type = "application/pdf",
): FormData {
  const form = new FormData();
  form.set("documentId", documentId);
  const part = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.set("file", new File([part], name, { type }));
  return form;
}

// MODULE SCOPE, deliberately — not inside a `describe` callback. The two top-level describes below share one
// container, one API and two seeded tenants; vitest runs file-level beforeAll/afterAll once around both.
let api: StartedApi;
let a: Seed;
let b: Seed;

/** A tenant member holding nothing: the shape every "refused" case below needs. */
const member = async (s: Seed, label: string): Promise<string> => {
  const id = await uuidv7(api.db.admin);
  await api.db.migrator.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${s.tenant}, true), set_config('app.actor_id', ${s.system}, true)`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${id}, 'human', ${`${label}:${id}`}, ${label})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
  });
  await api.loadPrincipals();
  return id;
};

beforeAll(async () => {
  api = await startApi();
  a = await seedTenantV2(api.db, "Alpha");
  b = await seedTenantV2(api.db, "Beta");
  // The upload gate is JOURNAL's `approval.create ?? approval.post` = accounting.journal.post (assumption 3
  // of 2B), and the list/download gate is the accounting module's read code.
  await grantCodes(api.db, a, { codes: ["accounting.journal.post", "accounting.ledger.read"] });
  await grantCodes(api.db, b, { codes: ["accounting.journal.post", "accounting.ledger.read"] });
}, 180_000);
afterAll(async () => {
  await api.stop();
});

describe("POST /v1/companies/{companyId}/attachments — contracts §4.5.8, spec:1067, test 13", () => {
  it("stores the bytes under a server-derived key and returns the row", async () => {
    const documentId = await draftDocument(api.db, a);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "permit.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      objectKey: string;
      sha256: string;
      byteSize: number;
    };
    expect(body.objectKey).toBe(`${a.tenant}/${body.id}`);
    expect(body.byteSize).toBe(4);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(api.objectStore.objects.has(body.objectKey)).toBe(true);
  });

  it("stores non-UTF-8 bytes byte for byte — a multipart body is not text (SAH-038 sibling: silent corruption)", async () => {
    const documentId = await draftDocument(api.db, a);
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0xff, 0x00, 0xfe,
    ]);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "logo.png", bytes, "image/png"),
    });
    expect(res.status).toBe(201);
    const { objectKey } = (await res.json()) as { objectKey: string };
    expect(Array.from(api.objectStore.objects.get(objectKey)!.bytes)).toEqual(Array.from(bytes));
  });

  it("refuses an upload naming another tenant's document with 404, never 403 (no existence leak)", async () => {
    const foreign = await draftDocument(api.db, b);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(foreign, "x.pdf", new Uint8Array([1])),
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("refuses a principal who may not edit the document — the policy's approval.create ?? approval.post is the gate", async () => {
    const documentId = await draftDocument(api.db, a);
    const strangerId = await member(a, "stranger");
    // A member of the company holding no code: a caller with NO role in the path company is refused on the
    // company before the document is read (S3, code review 2), and this case is about which code is asked.
    await grantCodes(api.db, a, { principalId: strangerId, roleCode: "attach-stranger" });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: strangerId,
      form: upload(documentId, "x.pdf", new Uint8Array([1])),
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    // JOURNAL_POLICY_V1 ships no `create` member, so `approval.create ?? approval.post` is the post code.
    expect(problem.detail).toContain("accounting.journal.post");
  });

  it("refuses a file over MAX_ATTACHMENT_BYTES with ERR_VALIDATION_FAILED", async () => {
    const documentId = await draftDocument(api.db, a);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "big.bin", new Uint8Array(26_214_401), "application/octet-stream"),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("requires Idempotency-Key and replays the same key with the same body", async () => {
    const documentId = await draftDocument(api.db, a);
    // Two SEPARATELY BUILT forms with identical parts. Their wire bytes differ — every FormData gets a fresh
    // random multipart boundary — so this case is exactly what the parts-based digest exists to make work; a
    // raw-byte hash would answer 409 ERR_IDEMPOTENCY_KEY_REUSED here.
    const form = () => upload(documentId, "once.pdf", new Uint8Array([5, 6, 7]));

    const missing = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: form(),
      idempotencyKey: null,
    });
    expect((await problemOf(missing)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const key = "attachment-replay-1";
    const first = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: form(),
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const again = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: form(),
      idempotencyKey: key,
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
  });

  it("writes an audit row for every upload (test 13)", async () => {
    const documentId = await draftDocument(api.db, a);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "audited.pdf", new Uint8Array([1, 2])),
    });
    const { id } = (await res.json()) as { id: string };
    // app.audit_log's discriminator is `action` with lowercase labels (migration 0001 §8).
    const [audit] = await api.db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'attachment' and row_id = ${id}`;
    expect(audit).toMatchObject({ action: "insert", actor_id: a.human });
  });
});

describe("GET /v1/companies/{companyId}/attachments — list and content", () => {
  it("serves the bytes with the recorded content type and the stored file name", async () => {
    const documentId = await draftDocument(api.db, a);
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "invoice ملف.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments/${id}/content`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // RFC 5987 — the Arabic name survives without ever reaching a path
    expect(res.headers.get("content-disposition")).toMatch(/filename\*=UTF-8''/);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("refuses a principal without the owning module's read code", async () => {
    const documentId = await draftDocument(api.db, a);
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "gated.pdf", new Uint8Array([1])),
    });
    const { id } = (await created.json()) as { id: string };
    const stranger = await member(a, "reader");
    // A member of the company holding no code, for the reason the upload case above gives (S3).
    await grantCodes(api.db, a, { principalId: stranger, roleCode: "attach-reader" });
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments/${id}/content`,
      as: stranger,
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.ledger.read");
  });

  it("answers 404, never 403, for another tenant's attachment", async () => {
    const foreignDoc = await draftDocument(api.db, b);
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/attachments`,
      as: b.human,
      form: upload(foreignDoc, "theirs.pdf", new Uint8Array([1])),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments/${id}/content`,
      as: a.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("lists a document's attachments in the ListEnvelope shape", async () => {
    const documentId = await draftDocument(api.db, a);
    for (const name of ["one.pdf", "two.pdf"]) {
      await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/attachments`,
        as: a.human,
        form: upload(documentId, name, new Uint8Array([1])),
      });
    }
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments?documentId=${documentId}`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { fileName: string }[];
      next_cursor: string | null;
    };
    expect(body.items.map((i) => i.fileName).toSorted()).toEqual(["one.pdf", "two.pdf"]);
    expect(body.next_cursor).toBeNull();
  });

  it("admits a reader whose read code is restricted to the document's branch — list and download alike", async () => {
    // The download, list, print and events gates all ask `actor_has(code, company, branch)` at the OWNING
    // DOCUMENT's branch. A reader restricted to HQ could print an HQ document but, until this was fixed, was
    // refused its attachment list and download because those two asked with a NULL branch.
    const documentId = await draftDocument(api.db, a); // at a.hq
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "hq.pdf", new Uint8Array([9])),
    });
    const { id } = (await created.json()) as { id: string };
    const hqReader = await member(a, "hq-reader");
    await grantCodes(api.db, a, {
      principalId: hqReader,
      codes: ["accounting.ledger.read"],
      branchIds: [a.hq],
    });
    const listed = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments?documentId=${documentId}`,
      as: hqReader,
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
      id,
    ]);
    const content = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments/${id}/content`,
      as: hqReader,
    });
    expect(content.status).toBe(200);
  });

  it("refuses the LIST to a member who holds no read code — identity is a side channel too", async () => {
    const documentId = await draftDocument(api.db, a);
    await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "listed.pdf", new Uint8Array([1])),
    });
    const nobodyId = await member(a, "nobody");
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments`,
      as: nobodyId,
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.ledger.read");
  });

  it("refuses a companyId outside the caller's tenant with 403 at the gate, before any row is read", async () => {
    // `requirePermission({ company: "path:companyId" })` evaluates `app.actor_has(code, <B's company>)`
    // for A, which is false — so the answer is 403, the same answer every other company-scoped module in
    // §4.2.7's register gives, and no row is touched. The 404-not-403 rule applies to the *download*
    // sub-path, where the id names a row; here the path names a company the caller has no authority in.
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}/attachments`,
      as: a.human,
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("refuses to serve an object whose bytes no longer match the recorded sha256 (ADR 0031)", async () => {
    const documentId = await draftDocument(api.db, a);
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/attachments`,
      as: a.human,
      form: upload(documentId, "tamper.pdf", new Uint8Array([1, 2, 3])),
    });
    const { id, objectKey } = (await created.json()) as { id: string; objectKey: string };
    await api.objectStore.put(objectKey, new Uint8Array([9, 9, 9]), "application/pdf");

    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/attachments/${id}/content`,
      as: a.human,
    });
    expect(res.status).toBe(500);
    expect((await problemOf(res)).code).toBe("ERR_INTERNAL");
  });
});
