import { grantCodes } from "./fixtures";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import {
  createDefinition,
  getValues,
  listDefinitions,
  setValues,
} from "../src/custom-fields/service";
import { createItem } from "../src/inventory/items";
import { createUnit } from "../src/inventory/units";
import { draftDocument, seedAccount, seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

describe("migration 0006 typed custom fields", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let docId: string;
  let poNumber: string;
  let risk: string;
  let batchDoc: string;
  let batchDefs: string[];
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenant(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
    docId = await draftDocument(db, a);
  });
  afterAll(async () => db.stop());

  it("keeps schema lint clean", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("creates typed definitions scoped to an entity", async () => {
    poNumber = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDefinition(tx, {
        companyId: a.company,
        entity: "document",
        code: "PO_NUMBER",
        nameEn: "Customer PO number",
        nameAr: "رقم أمر الشراء",
        kind: "text",
        options: { maxLength: 32 },
        indexed: true,
      }),
    );
    risk = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDefinition(tx, {
        companyId: a.company,
        entity: "document",
        documentTypeId: a.docType,
        code: "RISK",
        nameEn: "Risk",
        kind: "enum",
        required: true,
        options: { enumValues: ["low", "high"] },
      }),
    );
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listDefinitions(tx, a.company, "document"),
    );
    expect(rows.map((row) => [row.code, row.kind, row.required, row.documentTypeId])).toEqual([
      ["PO_NUMBER", "text", false, null],
      ["RISK", "enum", true, a.docType],
    ]);
  });

  it("closes entity names and definition codes", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.custom_field_definition (tenant_id, company_id, entity, code, name_en, kind)
      values (${a.tenant}, ${a.company}, 'invoice', 'X', 'X', 'text')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createDefinition(tx, {
          companyId: a.company,
          entity: "document",
          code: "PO_NUMBER",
          nameEn: "dup",
          kind: "text",
        }),
      ),
    ).rejects.toThrow(/unique|duplicate key/);
  });

  it("closes kinds to the validator's eight", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.custom_field_definition (tenant_id, company_id, entity, code, name_en, kind)
      values (${a.tenant}, ${a.company}, 'document', 'Y', 'Y', 'timestamp')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("validates and stores values", async () => {
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "document", docId, [
          { definitionId: poNumber, value: "PO-9001" },
          { definitionId: risk, value: "high" },
        ]),
      ),
    ).toEqual({ ok: true, written: 2 });
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        getValues(tx, a.company, "document", docId),
      ),
    ).toEqual([
      { definitionId: poNumber, code: "PO_NUMBER", value: "PO-9001" },
      { definitionId: risk, code: "RISK", value: "high" },
    ]);
  });

  it("rejects a whole invalid batch", async () => {
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "document", docId, [{ definitionId: risk, value: "medium" }]),
      ),
    ).toEqual({ ok: false, errors: [{ path: "RISK", message: "must be one of: low, high" }] });
  });

  it("upserts one value per definition and entity", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setValues(tx, a.company, "document", docId, [{ definitionId: poNumber, value: "PO-9002" }]),
    );
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      getValues(tx, a.company, "document", docId),
    );
    expect(values.find((value) => value.code === "PO_NUMBER")?.value).toBe("PO-9002");
  });

  it("stores normalised money wire values", async () => {
    const fee = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createDefinition(tx, {
        companyId: a.company,
        entity: "document",
        code: "HANDLING_FEE",
        nameEn: "Handling fee",
        kind: "money",
      }),
    );
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setValues(tx, a.company, "document", docId, [
        { definitionId: fee, value: { amount: "12.5", currency: "MYR" } },
      ]),
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ value: unknown }[]>`
      select value from app.custom_field_value where definition_id = ${fee} and entity_id = ${docId}`,
    );
    expect(row?.value).toEqual({ amount: "12.5000", currency: "MYR" });
  });

  it("stores item custom fields once the inventory item exists, with tenant and company bounds", async () => {
    await seedAccount(db, a, { code: "5900", nameEn: "Expense", type: "expense" });
    const { item, definitionId } = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const unit = await createUnit(tx, { companyId: a.company, code: "CF-PCS", nameEn: "Piece" });
      const createdItem = await createItem(
        tx,
        { tenantId: a.tenant, actorId: a.human, requestId: "item-custom-field" },
        {
          companyId: a.company,
          code: "CF-ITEM",
          nameEn: "Item with custom field",
          kind: "service",
          baseUnitId: unit.id,
          trackLots: false,
        },
      );
      const createdDefinitionId = await createDefinition(tx, {
        companyId: a.company,
        entity: "item",
        code: "ITEM_NOTE",
        nameEn: "Item note",
        kind: "text",
      });
      return { item: createdItem, definitionId: createdDefinitionId };
    });
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "item", item.id, [{ definitionId, value: "Shelf A" }]),
      ),
    ).toEqual({ ok: true, written: 1 });
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) => getValues(tx, a.company, "item", item.id)),
    ).toEqual([{ definitionId, code: "ITEM_NOTE", value: "Shelf A" }]);
    for (const [tenant, actor, company] of [
      [a.tenant, a.human, b.company],
      [b.tenant, b.human, a.company],
    ] as const) {
      const result = await withTenant(db.rw, tenant, actor, (tx) =>
        setValues(tx, company, "item", item.id, [{ definitionId, value: "Wrong company" }]),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("isolates and audits definitions and values", async () => {
    expect(
      await withTenant(db.rw, b.tenant, b.human, (tx) =>
        listDefinitions(tx, a.company, "document"),
      ),
    ).toEqual([]);
    expect(
      await withTenant(db.rw, b.tenant, b.human, (tx) =>
        getValues(tx, a.company, "document", docId),
      ),
    ).toEqual([]);
    const audits = await withTenant(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx<{ actor_id: string }[]>`
      select actor_id from app.audit_log where table_name in ('custom_field_definition', 'custom_field_value')`,
    );
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.every((row) => row.actor_id === a.human)).toBe(true);
  });

  it("writes a whole batch in one statement", async () => {
    batchDoc = await draftDocument(db, a);
    batchDefs = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const ids: string[] = [];
      for (const code of ["B1", "B2", "B3", "B4", "B5"])
        ids.push(
          await createDefinition(tx, {
            companyId: a.company,
            entity: "document",
            code,
            nameEn: code,
            kind: "text",
          }),
        );
      return ids;
    });
    // A connection of its own, because `debug` is per-pool and the shared `db.rw` is what every other
    // test in this file runs through. The count is the point: the loop this replaced issued one insert
    // per value, so five values were five round trips inside the caller's open transaction.
    const statements: string[] = [];
    const observed = postgres(db.url("app_rw"), {
      max: 1,
      onnotice: () => {},
      debug: (_connection, query) => statements.push(query),
    });
    try {
      expect(
        await withTenant(observed, a.tenant, a.human, (tx) =>
          setValues(
            tx,
            a.company,
            "document",
            batchDoc,
            batchDefs.map((definitionId, index) => ({ definitionId, value: `v${index}` })),
          ),
        ),
      ).toEqual({ ok: true, written: 5 });
    } finally {
      await observed.end();
    }
    expect(
      statements.filter((query) => /insert into app\.custom_field_value/i.test(query)),
    ).toHaveLength(1);
    expect(
      (
        await withTenant(db.rw, a.tenant, a.human, (tx) =>
          getValues(tx, a.company, "document", batchDoc),
        )
      ).map((row) => [row.code, row.value]),
    ).toEqual([
      ["B1", "v0"],
      ["B2", "v1"],
      ["B3", "v2"],
      ["B4", "v3"],
      ["B5", "v4"],
    ]);
  });

  it("updates a repeated batch rather than duplicating its rows", async () => {
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(
          tx,
          a.company,
          "document",
          batchDoc,
          batchDefs.map((definitionId, index) => ({ definitionId, value: `w${index}` })),
        ),
      ),
    ).toEqual({ ok: true, written: 5 });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ count: string }[]>`
      select count(*)::text as count from app.custom_field_value where entity_id = ${batchDoc}`,
    );
    expect(row?.count).toBe("5");
    expect(
      (
        await withTenant(db.rw, a.tenant, a.human, (tx) =>
          getValues(tx, a.company, "document", batchDoc),
        )
      ).map((value) => value.value),
    ).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });

  it("keeps the last value when one batch names a definition twice", async () => {
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "document", batchDoc, [
          { definitionId: batchDefs[0]!, value: "first" },
          { definitionId: batchDefs[0]!, value: "second" },
        ]),
      ),
    ).toEqual({ ok: true, written: 2 });
    const values = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      getValues(tx, a.company, "document", batchDoc),
    );
    expect(values.find((value) => value.code === "B1")?.value).toBe("second");
    expect(values).toHaveLength(5);
  });

  it("round-trips every kind as jsonb, not as its JSON source", async () => {
    const kindsDoc = await draftDocument(db, a);
    const defs = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const made: Record<string, string> = {};
      const specs = [
        { code: "K_BOOL", kind: "boolean" as const },
        { code: "K_DATE", kind: "date" as const },
        { code: "K_DEC", kind: "decimal" as const },
        // Names its dimension type since the review pass: setValues now refuses a dimension_value field
        // whose value is not a live value of `options.dimensionTypeId` in this company.
        {
          code: "K_DIM",
          kind: "dimension_value" as const,
          options: { dimensionTypeId: a.branchType },
        },
        { code: "K_ENUM", kind: "enum" as const, options: { enumValues: ["x", "y"] } },
        { code: "K_INT", kind: "integer" as const },
        { code: "K_MONEY", kind: "money" as const },
        { code: "K_NULL", kind: "text" as const },
        { code: "K_TEXT", kind: "text" as const },
      ];
      for (const spec of specs)
        made[spec.code] = await createDefinition(tx, {
          companyId: a.company,
          entity: "document",
          code: spec.code,
          nameEn: spec.code,
          kind: spec.kind,
          options: spec.options ?? {},
        });
      return made;
    });
    // The whole batch now travels as one JSON parameter, so the text value carries the characters
    // that escaping has to survive twice over — a quote, a backslash, braces and a comma. K_NULL is
    // the empty optional field: it validates to null, and the column is `not null`, so jsonb null is
    // the only thing it can be — the per-row insert bound SQL NULL there and failed the whole batch.
    const messy = 'a"b\\c{d,e} مرحبا';
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "document", kindsDoc, [
          { definitionId: defs.K_BOOL!, value: false },
          { definitionId: defs.K_DATE!, value: "2026-03-04" },
          { definitionId: defs.K_DEC!, value: "12.34" },
          { definitionId: defs.K_DIM!, value: a.hq },
          { definitionId: defs.K_ENUM!, value: "y" },
          { definitionId: defs.K_INT!, value: 42 },
          { definitionId: defs.K_MONEY!, value: { amount: "7.5", currency: "MYR" } },
          { definitionId: defs.K_NULL!, value: null },
          { definitionId: defs.K_TEXT!, value: messy },
        ]),
      ),
    ).toEqual({ ok: true, written: 9 });
    // `jsonb_typeof` is the assertion that matters: a value written as the JSON *source* rather than
    // parsed jsonb reads back as 'string' for every one of these, whatever the driver then parses.
    const stored = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ code: string; type: string; value: unknown }[]>`
      select definition.code, jsonb_typeof(value.value) as type, value.value
        from app.custom_field_value value
        join app.custom_field_definition definition on definition.id = value.definition_id
       where value.entity_id = ${kindsDoc}
       order by definition.code`,
    );
    expect(stored).toEqual([
      { code: "K_BOOL", type: "boolean", value: false },
      { code: "K_DATE", type: "string", value: "2026-03-04" },
      { code: "K_DEC", type: "string", value: "12.34" },
      { code: "K_DIM", type: "string", value: a.hq },
      { code: "K_ENUM", type: "string", value: "y" },
      { code: "K_INT", type: "number", value: 42 },
      { code: "K_MONEY", type: "object", value: { amount: "7.5000", currency: "MYR" } },
      { code: "K_NULL", type: "null", value: null },
      { code: "K_TEXT", type: "string", value: messy },
    ]);
  });

  it("writes nothing for an empty batch, and nothing when any value is invalid", async () => {
    const fresh = await draftDocument(db, a);
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "document", fresh, []),
      ),
    ).toEqual({ ok: true, written: 0 });
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        setValues(tx, a.company, "document", fresh, [
          { definitionId: poNumber, value: "PO-7" },
          { definitionId: risk, value: "medium" },
        ]),
      ),
    ).toEqual({ ok: false, errors: [{ path: "RISK", message: "must be one of: low, high" }] });
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) =>
        getValues(tx, a.company, "document", fresh),
      ),
    ).toEqual([]);
  });
});
