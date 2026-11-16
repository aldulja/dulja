import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedParty, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("document.party_id FK and document_type.module — spec:1759, contracts §4.3.4, §4.5.8", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenant(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  it("a document may point at a party of its own tenant", async () => {
    const party = await seedParty(db, a, { code: "FK-OK" });
    const doc = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set party_id = ${party} where id = ${doc}`,
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ party_id: string }[]>`select party_id from app.document where id = ${doc}`,
    );
    expect(row!.party_id).toBe(party);
  });

  it("a document cannot point at another tenant's party — the composite FK, not a tenant_id check", async () => {
    const foreign = await seedParty(db, b, { code: "FK-X" });
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.document set party_id = ${foreign} where id = ${doc}`,
      ),
    ).rejects.toThrow(/document_party_fk/);
  });

  it("party_id stays nullable — a JOURNAL has no party", async () => {
    const [col] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'party_id'`;
    expect(col!.is_nullable).toBe("YES");
  });

  it("document_type.module defaults to accounting on the rows migration 0001 and Plan 0A left behind", async () => {
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ code: string; module: string; archived_at: string | null }[]>`
        select code, module, archived_at::text as archived_at from app.document_type where id = ${a.docType}`,
    );
    expect(row).toEqual({ code: "JOURNAL", module: "accounting", archived_at: null });
  });

  it("document_type.module admits exactly the four modules of the attachment download map", async () => {
    for (const module of ["accounting", "inventory", "hr", "pos"]) {
      const updated = await withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.document_type set module = ${module} where id = ${a.docType}`,
      );
      expect(updated.count).toBe(1);
    }
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.document_type set module = 'admin' where id = ${a.docType}`,
      ),
    ).rejects.toThrow(/document_type_module_check/);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document_type set module = 'accounting' where id = ${a.docType}`,
    );
  });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
