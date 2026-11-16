import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AttachmentIntegrityError,
  createAttachment,
  getAttachment,
  listAttachments,
  readAttachmentContent,
} from "../src/attachment";
import { MemoryObjectStore, objectKeyFor } from "../src/attachment/object-store";
import { withTenant as prodWithTenant } from "../src/with-tenant";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, type Db } from "./harness";

const ctx = (s: Seed, requestId: string) => ({ tenantId: s.tenant, actorId: s.human, requestId });
/** The §4.5.8 map's one row at 2C, as the API passes it. */
const ACCOUNTING = { accounting: "accounting.ledger.read" } as const;

describe("the attachment service — contracts §4.5.8, ADR 0031", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
    // listAttachments evaluates the read code per row (`app.actor_has`), so the listing actor must hold it.
    await grantCodes(db, a, { codes: ["accounting.ledger.read"] });
    await grantCodes(db, b, { codes: ["accounting.ledger.read"] });
    store = new MemoryObjectStore();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("writes the object under the derived key and the row with its sha256", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company,
        documentId,
        fileName: "permit.pdf",
        mimeType: "application/pdf",
        bytes,
      }),
    );

    expect(row.objectKey).toBe(objectKeyFor(a.tenant, row.id));
    expect(row.byteSize).toBe(5);
    // The digest is computed here from the same bytes, so the assertion pins a VALUE and not a shape:
    // ADR 0031's claim is that the server hashes what it received, and only this line proves it.
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.uploadedBy).toBe(a.human);
    expect(Array.from((await store.get(row.objectKey))!.bytes)).toEqual(Array.from(bytes));
  });

  it("reads the content back and refuses a tampered object", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company,
        documentId,
        fileName: "cert.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(Array.from(await readAttachmentContent(store, row))).toEqual([1, 2, 3]);

    await store.put(row.objectKey, new Uint8Array([9, 9, 9]), row.mimeType);
    await expect(readAttachmentContent(store, row)).rejects.toBeInstanceOf(
      AttachmentIntegrityError,
    );
  });

  it("getAttachment returns the owning document type's module", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company,
        documentId,
        fileName: "n.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array([65]),
      }),
    );
    const found = await prodWithTenant(db.rw, ctx(a, requestId), (tx) => getAttachment(tx, row.id));
    expect(found?.module).toBe("accounting"); // JOURNAL's document_type.module (§4.14)
    expect(found?.branchId).toBe(a.hq); // the owning document's branch, for the branch-aware gate
    expect(found?.row.fileName).toBe("n.txt");
  });

  it("is invisible to another tenant through the service, not merely through the route", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    const row = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company,
        documentId,
        fileName: "secret.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([7]),
      }),
    );
    const seen = await prodWithTenant(db.rw, ctx(b, requestId), (tx) => getAttachment(tx, row.id));
    expect(seen).toBeNull();
    const listed = await prodWithTenant(db.rw, ctx(b, requestId), (tx) =>
      listAttachments(tx, { companyId: b.company, limit: 100, readCodes: ACCOUNTING }),
    );
    expect(listed).toEqual([]);
  });

  it("lists nothing when the caller may read no module — the row filter, not just RLS", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company,
        documentId,
        fileName: "gated.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([2]),
      }),
    );
    const withAccounting = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, { companyId: a.company, limit: 100, readCodes: ACCOUNTING }),
    );
    expect(withAccounting.length).toBeGreaterThan(0);
    const withNone = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, { companyId: a.company, limit: 100, readCodes: {} }),
    );
    expect(withNone).toEqual([]);
    // A map row for a module none of the rows carries selects nothing; a code the actor does not hold
    // (here, a code no slice has seeded) selects nothing either — `actor_has` is the filter.
    const withOther = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, {
        companyId: a.company,
        limit: 100,
        readCodes: { hr: "hr.payroll.read" },
      }),
    );
    expect(withOther).toEqual([]);
    const withUnheld = await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      listAttachments(tx, {
        companyId: a.company,
        limit: 100,
        readCodes: { accounting: "accounting.journal.post" },
      }),
    );
    expect(withUnheld).toEqual([]);
  });

  it("a draft document cannot be deleted while an attachment references it (2B's DELETE grant)", async () => {
    const documentId = await draftDocument(db, a);
    const requestId = await uuidv7(db.admin);
    await prodWithTenant(db.rw, ctx(a, requestId), (tx) =>
      createAttachment(tx, ctx(a, requestId), store, {
        companyId: a.company,
        documentId,
        fileName: "d.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1]),
      }),
    );
    // attachment.document_id has NO `on delete cascade` (§4.5.8), so the FK refuses the delete 2B granted.
    // Archiving does NOT unblock it — `archived_at` leaves the reference in place; the row must go, which
    // is a later slice's erasure workflow (spec:2049), not something this test offers a remedy for.
    await expect(
      prodWithTenant(
        db.rw,
        ctx(a, requestId),
        (tx) => tx`delete from app.document where id = ${documentId}`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
