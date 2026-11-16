import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, type Db, uuidv7, withTenant } from "./harness";

describe("documents, numbering tables, dimensions — spec §3.8 (SAH-013, 051)", () => {
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

  it("a draft carries created_by from the session, status draft, and no number", async () => {
    const id = await draftDocument(db, a);
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { created_by: string; status: string; number: number | null }[]
        >`select created_by, status, number from app.document where id = ${id}`,
    );
    expect(row).toEqual({ created_by: a.human, status: "draft", number: null });
  });

  it("several drafts may share a null number; two issued numbers in one series and period cannot collide", async () => {
    await draftDocument(db, a);
    await draftDocument(db, a);
    const first = await draftDocument(db, a);
    const second = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set number = 1, status = 'issued' where id = ${first}`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.document set number = 1, status = 'issued' where id = ${second}`,
      ),
    ).rejects.toThrow(/unique/);
  });

  it("client_ref is unique per company — re-sending a POS batch cannot create a second document", async () => {
    const reference = await uuidv7(db.admin);
    await draftDocument(db, a, { clientRef: reference });
    await expect(draftDocument(db, a, { clientRef: reference })).rejects.toThrow(/unique/);
  });

  it("a document cannot reference another tenant's document type even when the uuid is known", async () => {
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
        insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, branch_id)
        values (${b.tenant}, ${b.company}, ${a.docType}, 'JV', ${b.period}, '2026-01-10', 'MYR', ${b.hq})`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("posting policies are versioned per document type", async () => {
    await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx`
      insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
      values (${a.tenant}, ${a.docType}, 2, '2026-06-01', '{"version":2}'::jsonb)`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`
        insert into app.posting_policy (tenant_id, document_type_id, version, effective_from, definition)
        values (${a.tenant}, ${a.docType}, 2, '2026-07-01', '{"version":2}'::jsonb)`,
      ),
    ).rejects.toThrow(/unique/);
  });

  it("document_series counter rows are keyed per company, series, and period; voids record the actor", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id) values (${a.tenant}, ${a.company}, 'INV', ${a.period})`;
      await tx`insert into app.document_series (tenant_id, company_id, series, fiscal_period_id) values (${a.tenant}, ${a.company}, 'INV', ${a.period}) on conflict do nothing`;
      const [count] = await tx<
        { n: number }[]
      >`select count(*)::int as n from app.document_series where series = 'INV'`;
      expect(count!.n).toBe(1);
      await tx`insert into app.document_number_void (tenant_id, company_id, series, fiscal_period_id, number, reason) values (${a.tenant}, ${a.company}, 'INV', ${a.period}, 7, 'printer jam; reissued')`;
      const [voided] = await tx<
        { voided_by: string }[]
      >`select voided_by from app.document_number_void where number = 7`;
      expect(voided!.voided_by).toBe(a.human);
    });
  });

  it("dimension values form a tree within one tenant; a parent from another tenant is rejected", async () => {
    const typeA = await uuidv7(db.admin);
    const root = await uuidv7(db.admin);
    const typeB = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.system, async (tx) => {
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${typeA}, ${a.tenant}, ${a.company}, 'REGION', 'Region')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values (${root}, ${a.tenant}, ${typeA}, 'CENTRAL', 'Central')`;
      await tx`insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en, parent_id) values (${a.tenant}, ${typeA}, 'KL', 'Kuala Lumpur', ${root})`;
    });
    await withTenant(
      db.rw,
      b.tenant,
      b.system,
      (tx) =>
        tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${typeB}, ${b.tenant}, ${b.company}, 'REGION', 'Region')`,
    );
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.system,
        (tx) =>
          tx`insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en, parent_id) values (${b.tenant}, ${typeB}, 'X', 'X', ${root})`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("document and role assignment branches must be BRANCH values of the same tenant, and branch is required", async () => {
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
        insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, branch_id)
        values (${b.tenant}, ${b.company}, ${b.docType}, 'JV', ${b.period}, '2026-01-10', 'MYR', ${a.hq})`,
      ),
    ).rejects.toThrow(/document_branch_fk/);
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
        insert into app.document (tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency)
        values (${b.tenant}, ${b.company}, ${b.docType}, 'JV', ${b.period}, '2026-01-10', 'MYR')`,
      ),
    ).rejects.toThrow(/null value in column "branch_id"/);
    const role = await uuidv7(db.admin);
    await withTenant(db.migrator, b.tenant, b.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${role}, ${b.tenant}, 'BM', 'Branch manager')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${b.tenant}, ${b.human}, ${role}, ${b.company})`;
    });
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.system,
        (tx) => tx`
        insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
        values (${b.tenant}, ${b.human}, ${role}, ${b.company}, ${a.hq})`,
      ),
    ).rejects.toThrow(/role_assignment_branch_dim_fk/);
  });
});
