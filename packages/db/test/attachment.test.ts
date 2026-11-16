import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.attachment — contracts §4.5.8, spec:1067, SAH-038", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the schema linter reports zero violations after 0025", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "attachment")).toEqual([]);
    expect(violations).toEqual([]);
  });

  it("stores a row whose object_key is derived from the id, and stamps uploaded_by", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    const row = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256, uploaded_by)
               values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'permit.pdf', 'application/pdf', 1024,
                       decode('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex'), ${a.system})`;
      const [r] = await tx<{ object_key: string; uploaded_by: string; byte_size: string }[]>`
        select object_key, uploaded_by, byte_size from app.attachment where id = ${id}`;
      return r!;
    });
    expect(row.object_key).toBe(`${a.tenant}/${id}`);
    // stamp_uploaded_by overwrites whatever the insert supplied with app.current_actor()
    expect(row.uploaded_by).toBe(a.human);
    expect(row.byte_size).toBe("1024");
  });

  it("refuses a second row with the same object_key — the key is globally unique (SAH-038)", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    const other = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
        values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'a.pdf', 'application/pdf', 1, decode('00', 'hex'))`,
    );
    // postgres.js fails the whole transaction on any statement error, caught or not, so the refused insert
    // gets a transaction of its own and the rejection is asserted on it.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
          values (${other}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'b.pdf', 'application/pdf', 1, decode('00', 'hex'))`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a negative byte_size", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
          values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'a.pdf', 'application/pdf', -1, decode('00', 'hex'))`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
        values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'permit.pdf', 'application/pdf', 4, decode('00', 'hex'))`,
    );
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.attachment`,
    );
    expect(seen[0]!.n).toBe(0);
  });

  it("cannot be attached to another tenant's document — the composite FK refuses it", async () => {
    const foreignDoc = await draftDocument(db, b);
    const id = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
          values (${id}, ${a.tenant}, ${a.company}, ${foreignDoc}, ${`${a.tenant}/${id}`}, 'x.pdf', 'application/pdf', 1, decode('00', 'hex'))`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("every write produces an audit row with a server-supplied actor (test 13)", async () => {
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
        values (${id}, ${a.tenant}, ${a.company}, ${docId}, ${`${a.tenant}/${id}`}, 'permit.pdf', 'application/pdf', 4, decode('00', 'hex'))`,
    );
    // app.audit_log's discriminator is `action` with lowercase labels (migration 0001 §8).
    const [audit] = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'attachment' and row_id = ${id}`;
    expect(audit).toMatchObject({ action: "insert", actor_id: a.human });
  });

  it("archives rather than deletes — app_rw holds no DELETE on it (§3.5.4)", async () => {
    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'attachment' and privilege_type = 'DELETE'`;
    expect(grant!.n).toBe(0);
  });
});
