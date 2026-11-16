import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { listApplied } from "@dulja/db";
import { draftDocument, seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const defs = (seed: Seed) => `/v1/companies/${seed.company}/custom-field-definitions`;
const vals = (seed: Seed, id: string) =>
  `/v1/companies/${seed.company}/custom-fields/document/${id}`;

describe("custom fields through the API", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  let docId: string;
  /** A second company inside tenant A, with a definition and a value of its own. */
  let second: string;
  let secondDefinition: string;
  let secondEntity: string;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
    docId = await draftDocument(api.db, a);
    // `grantAdmin` assigns a.human in a.company only, so a.human is authorised for one company of a
    // tenant and not the other. That is the shape RLS cannot see and the gate alone did not close.
    second = await uuidv7(api.db.admin);
    secondDefinition = await uuidv7(api.db.admin);
    secondEntity = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${second}, ${a.tenant}, 'SECOND', 'Alpha second company', 'MYR')`;
      await tx`insert into app.custom_field_definition
                 (id, tenant_id, company_id, entity, code, name_en, kind)
               values (${secondDefinition}, ${a.tenant}, ${second}, 'document', 'SECRET',
                       'Second company secret', 'text')`;
      await tx`insert into app.custom_field_value (tenant_id, definition_id, entity_id, value)
               values (${a.tenant}, ${secondDefinition}, ${secondEntity}, '"classified"'::jsonb)`;
    });
  });
  afterAll(async () => api.stop());

  it("creates a dimension and custom field through APIs without a migration", async () => {
    const before = await listApplied(api.db.migrator);
    const dim = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/dimension-types`,
      as: a.human,
      body: { code: "PROJECT", nameEn: "Project", nameAr: "مشروع" },
    });
    const { id: typeId } = (await dim.json()) as { id: string };
    expect(
      (
        await api.request({
          method: "POST",
          path: `/v1/companies/${a.company}/dimension-types/${typeId}/values`,
          as: a.human,
          body: { code: "APOLLO", nameEn: "Project Apollo" },
        })
      ).status,
    ).toBe(201);
    const field = await api.request({
      method: "POST",
      path: defs(a),
      as: a.human,
      body: {
        entity: "document",
        code: "PO_NUMBER",
        nameEn: "Customer PO number",
        kind: "text",
        options: { maxLength: 32 },
        indexed: true,
      },
    });
    expect(field.status).toBe(201);
    const { id: definitionId } = (await field.json()) as { id: string };
    const set = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: a.human,
      body: { values: [{ definitionId, value: "PO-9001" }] },
    });
    expect(await set.json()).toEqual({
      values: [{ definitionId, code: "PO_NUMBER", value: "PO-9001" }],
    });
    expect(await listApplied(api.db.migrator)).toEqual(before);
  });

  it("scopes a definition to a document type", async () => {
    const res = await api.request({
      method: "POST",
      path: defs(a),
      as: a.human,
      body: {
        entity: "document",
        documentTypeId: a.docType,
        code: "RISK",
        nameEn: "Risk",
        kind: "enum",
        required: true,
        options: { enumValues: ["low", "high"] },
      },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "RISK",
      required: true,
      documentTypeId: a.docType,
    });
  });

  it("refuses a definition scoped to another company's document type, or reading another company's dimension type — 404", async () => {
    const [bType] = await api.db.admin<{ id: string }[]>`
      select id from app.document_type where company_id = ${b.company} limit 1`;
    const scoped = await api.request({
      method: "POST",
      path: defs(a),
      as: a.human,
      body: {
        entity: "document",
        documentTypeId: bType!.id,
        code: "LEAK",
        nameEn: "Leak",
        kind: "text",
      },
    });
    expect(scoped.status).toBe(404);
    expect(((await scoped.json()) as Problem).code).toBe("ERR_NOT_FOUND");
    const [bDim] = await api.db.admin<{ id: string }[]>`
      select id from app.dimension_type where company_id = ${b.company} limit 1`;
    const reading = await api.request({
      method: "POST",
      path: defs(a),
      as: a.human,
      body: {
        entity: "document",
        code: "LEAK2",
        nameEn: "Leak 2",
        kind: "dimension_value",
        options: { dimensionTypeId: bDim!.id },
      },
    });
    expect(reading.status).toBe(404);
  });

  it("refuses values against another company's document, and a dimension value outside the field's type", async () => {
    // The definition is A's; the document is the second company's. `custom_field_value.entity_id` has no FK,
    // so only the service check stands between A's write and B's posting (loadSnapshot reads these).
    const created = await api.request({
      method: "POST",
      path: defs(a),
      as: a.human,
      body: { entity: "document", code: "NOTE2", nameEn: "Note", kind: "text" },
    });
    const { id: definitionId } = (await created.json()) as { id: string };
    const foreignDoc = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${foreignDoc}, ${a.tenant}, ${second}, ${a.docType}, 'JV', '2026-01-15', 'MYR', ${a.hq})`;
    });
    const written = await api.request({
      method: "PUT",
      path: vals(a, foreignDoc),
      as: a.human,
      body: { values: [{ definitionId, value: "steer" }] },
    });
    expect(written.status).toBe(400);
    expect(((await written.json()) as Problem).errors).toEqual([
      { path: "entityId", message: `no document ${foreignDoc} in this company` },
    ]);

    // A dimension_value field: the uuid must be a live value of the field's own type in this company.
    const [branchType] = await api.db.admin<{ id: string }[]>`
      select id from app.dimension_type where company_id = ${a.company} and code = 'BRANCH'`;
    const dimField = await api.request({
      method: "POST",
      path: defs(a),
      as: a.human,
      body: {
        entity: "document",
        code: "REGION",
        nameEn: "Region",
        kind: "dimension_value",
        options: { dimensionTypeId: branchType!.id },
      },
    });
    const { id: regionId } = (await dimField.json()) as { id: string };
    const ok = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: a.human,
      body: { values: [{ definitionId: regionId, value: a.hq }] },
    });
    expect(ok.status).toBe(200);
    const bad = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: a.human,
      body: { values: [{ definitionId: regionId, value: await uuidv7(api.db.admin) }] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Problem).errors).toEqual([
      {
        path: "REGION",
        message: "must be a live value of the field's dimension type in this company",
      },
    ]);
  });

  it("returns field-addressed validation errors and writes nothing", async () => {
    const list = await api.request({
      method: "GET",
      path: `${defs(a)}?entity=document`,
      as: a.human,
    });
    const risk = ((await list.json()) as { items: { id: string; code: string }[] }).items.find(
      (item) => item.code === "RISK",
    )!;
    const bad = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: a.human,
      body: { values: [{ definitionId: risk.id, value: "medium" }] },
    });
    expect(bad.status).toBe(400);
    const problem = (await bad.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors).toEqual([{ path: "RISK", message: "must be one of: low, high" }]);
  });

  it("rejects unknown kinds and entities before SQL", async () => {
    for (const body of [
      { entity: "document", code: "AA", nameEn: "A", kind: "timestamp" },
      { entity: "invoice", code: "BB", nameEn: "B", kind: "text" },
    ]) {
      const res = await api.request({ method: "POST", path: defs(a), as: a.human, body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("never reads another company's values through a gate held for this one", async () => {
    const response = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/custom-fields/document/${secondEntity}`,
      as: a.human,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ values: [] });
    // The row is really there — the empty list is the company bound, not an empty table. Before the
    // fix the join reached it on `entity_id` and `entity` alone, and it came back under A's gate.
    const [row] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.custom_field_value where entity_id = ${secondEntity}`;
    expect(row!.n).toBe(1);
  });

  it("refuses a definition owned by another company and writes nothing", async () => {
    const response = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: a.human,
      body: { values: [{ definitionId: secondDefinition, value: "stolen" }] },
    });
    expect(response.status).toBe(400);
    const problem = (await response.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    // Word for word what an invented id earns: the refusal must not confirm the other company's row.
    expect(problem.errors).toEqual([
      { path: secondDefinition, message: "no such custom field definition for this entity" },
    ]);
    const [row] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.custom_field_value
       where definition_id = ${secondDefinition} and entity_id = ${docId}`;
    expect(row!.n).toBe(0);
  });

  it("hides another tenant's company", async () => {
    // 403 rather than 404 now that the reads carry a gate: the refusal lands before the handler can
    // look the company up, which is the answer role-assignments has always given on the same forge.
    expect(
      (await api.request({ method: "GET", path: `${defs(a)}?entity=document`, as: b.human }))
        .status,
    ).toBe(403);
    const forge = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: b.human,
      body: { values: [] },
    });
    expect([403, 404]).toContain(forge.status);
  });

  it("requires idempotency on writes", async () => {
    const res = await api.request({
      method: "PUT",
      path: vals(a, docId),
      as: a.human,
      body: { values: [] },
      idempotencyKey: null,
    });
    expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });
});
