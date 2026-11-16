import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

const SOURCE =
  '---dulja-template-v1\n{"labels":{"en":{},"ar":{}}}\n---\n<h1>{{ document.typeName }}</h1>\n';

describe("app.print_template — contracts §4.5.9, spec:1240", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the schema linter reports zero violations after 0026", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("stores a versioned template against a document type", async () => {
    const id = await uuidv7(db.admin);
    const row = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source)
               values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'standard', 1, 'Journal Voucher', 'قيد يومية', 'chromium', ${SOURCE})`;
      const [r] = await tx<
        { code: string; version: number; engine: string; paper: string; source: string }[]
      >`select code, version, engine, paper, source from app.print_template where id = ${id}`;
      return r!;
    });
    expect(row).toMatchObject({ code: "standard", version: 1, engine: "chromium", paper: "A4" });
    expect(row.source).toBe(SOURCE);
  });

  it("refuses a second row with the same (document_type_id, code, version)", async () => {
    const first = await uuidv7(db.admin);
    const second = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
        values (${first}, ${a.tenant}, ${a.company}, ${a.docType}, 'dup', 1, 'Dup', 'chromium', ${SOURCE})`,
    );
    // postgres.js fails the whole transaction on any statement error, caught or not, so the refused insert
    // gets a transaction of its own and the rejection is asserted on it.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
          values (${second}, ${a.tenant}, ${a.company}, ${a.docType}, 'dup', 1, 'Dup again', 'chromium', ${SOURCE})`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("admits exactly ADR 0016's engine value set — {chromium} — and refuses anything else", async () => {
    // ADR 0016 (accepted, 0E) closes the set at `chromium`: typst and react-pdf were measured and NOT
    // admitted; widening the set is a later migration plus an adapter, never a plan decision (hazard 30).
    const ok = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
        values (${ok}, ${a.tenant}, ${a.company}, ${a.docType}, 'e-chromium', 1, 'E', 'chromium', ${SOURCE})`,
    );
    for (const engine of ["typst", "react-pdf", "wkhtmltopdf"]) {
      const bad = await uuidv7(db.admin);
      await expect(
        withTenant(
          db.rw,
          a.tenant,
          a.human,
          (tx) => tx`
            insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
            values (${bad}, ${a.tenant}, ${a.company}, ${a.docType}, ${`e-${engine}`}, 1, 'Bad', ${engine}, ${SOURCE})`,
        ),
        engine,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("refuses a version below one and a paper outside A4 | A5 | receipt (§4.5.9's two CHECKs)", async () => {
    const zero = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
          values (${zero}, ${a.tenant}, ${a.company}, ${a.docType}, 'zero', 0, 'Zero', 'chromium', ${SOURCE})`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const letter = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source, paper)
          values (${letter}, ${a.tenant}, ${a.company}, ${a.docType}, 'letter', 1, 'Letter', 'chromium', ${SOURCE}, 'Letter')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const id = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
        values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'isolated', 1, 'Isolated', 'chromium', ${SOURCE})`,
    );
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.print_template`,
    );
    expect(seen[0]!.n).toBe(0);
  });

  it("cannot reference another tenant's document type — the composite FK refuses it", async () => {
    const id = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
          values (${id}, ${a.tenant}, ${a.company}, ${b.docType}, 'x', 1, 'X', 'chromium', ${SOURCE})`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("every write is audited and app_rw holds no DELETE — a version is superseded, never removed", async () => {
    const id = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
        insert into app.print_template (id, tenant_id, company_id, document_type_id, code, version, name_en, engine, source)
        values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, 'audited', 1, 'Audited', 'chromium', ${SOURCE})`,
    );
    // app.audit_log's discriminator is `action` with lowercase labels (migration 0001 §8).
    const [audit] = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'print_template' and row_id = ${id}`;
    expect(audit).toMatchObject({ action: "insert", actor_id: a.human });

    const [grant] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'print_template' and privilege_type = 'DELETE'`;
    expect(grant!.n).toBe(0);
  });
});
