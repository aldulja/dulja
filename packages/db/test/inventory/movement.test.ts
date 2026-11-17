import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { sentinelLotId } from "../../src/inventory/lots";
import { recordOverride } from "../../src/posting";
import {
  draftDocument,
  grantCodes,
  seedItem,
  seedTenant,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** The one place this suite writes a movement by hand. Production code may not: `posting-only-tables`
 *  (§3.7.5) allows app.inventory_movement DML only under packages/db/src/posting/**,
 *  packages/db/src/costing/**, packages/db/test/** and scripts/lint/rules/**. This file is the third. */
async function insertMovement(
  tx: import("postgres").Sql,
  s: Seed,
  m: {
    documentId: string;
    lineNo?: number;
    movementNo?: number;
    itemId: string;
    warehouseId: string;
    lotId: string;
    unitId: string;
    quantity: string;
    value?: string;
    effectiveDate?: string;
    postingSeq?: string;
  },
) {
  const [row] = await tx<{ id: string }[]>`
    insert into app.inventory_movement
      (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
       quantity, value, effective_date, posting_seq)
    values (${s.tenant}, ${s.company}, ${m.documentId}, ${m.lineNo ?? 1}, ${m.movementNo ?? 1}, ${m.itemId},
            ${m.warehouseId}, ${m.lotId}, ${m.unitId}, ${m.quantity}, ${m.value ?? "10.0000"},
            ${m.effectiveDate ?? "2026-01-15"}, ${m.postingSeq ?? "1"})
    returning id`;
  return row!.id;
}

describe("app.inventory_movement / app.stock_on_hand — migration 0031 (contracts §4.7.3)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;
  let lotId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Mv A");
    await grantCodes(db, a);
    b = await seedTenant(db, "Mv B");
    await grantCodes(db, b);
    ({ itemId, baseUnitId: unitId } = await seedItem(db, a, { code: "RICE-5KG" }));
    warehouseId = await seedWarehouse(db, a, { code: "HQ-MAIN" });
    lotId = await withTenant(db.rw, a.tenant, a.human, (tx) => sentinelLotId(tx, itemId));
  });
  afterAll(async () => {
    await db.stop();
  });

  it("a receipt is accepted; quantity 0 is refused (§4.7.3 check (quantity <> 0))", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, {
        documentId: doc,
        itemId,
        warehouseId,
        lotId,
        unitId,
        quantity: "100.000000",
      }),
    );
    const doc2 = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        insertMovement(tx, a, {
          documentId: doc2,
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: "0",
        }),
      ),
    ).rejects.toThrow(/inventory_movement_quantity_check/);
  });

  it("movement_no is unique per document, so a transfer line's two legs both fit", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await insertMovement(tx, a, {
        documentId: doc,
        lineNo: 1,
        movementNo: 1,
        itemId,
        warehouseId,
        lotId,
        unitId,
        quantity: "-5.000000",
      });
      await insertMovement(tx, a, {
        documentId: doc,
        lineNo: 1,
        movementNo: 2,
        itemId,
        warehouseId,
        lotId,
        unitId,
        quantity: "5.000000",
      });
    });
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        insertMovement(tx, a, {
          documentId: doc,
          lineNo: 1,
          movementNo: 2,
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: "1.000000",
        }),
      ),
    ).rejects.toThrow(/inventory_movement_document_id_movement_no_key/);
  });

  it("movement_no must be positive, and lot_id is NOT NULL (LEGACY-050, ADR 0034)", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        insertMovement(tx, a, {
          documentId: doc,
          movementNo: 0,
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: "1.000000",
        }),
      ),
    ).rejects.toThrow(/inventory_movement_movement_no_check/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, value, effective_date, posting_seq)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 9, ${itemId}, ${warehouseId}, null, ${unitId},
              1.0, 1.0, '2026-01-15', 1)`,
      ),
    ).rejects.toThrow(/lot_id/);
  });

  it("value is mandatory — a movement without one is rejected at write time (LEGACY-007)", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.inventory_movement
        (tenant_id, company_id, document_id, line_no, movement_no, item_id, warehouse_id, lot_id, unit_id,
         quantity, effective_date, posting_seq)
      values (${a.tenant}, ${a.company}, ${doc}, 1, 1, ${itemId}, ${warehouseId}, ${lotId}, ${unitId},
              1.0, '2026-01-15', 1)`,
      ),
    ).rejects.toThrow(/value/);
  });

  it("the table is immutable: app_rw holds no UPDATE or DELETE and the trigger refuses both", async () => {
    const doc = await draftDocument(db, a);
    const id = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, {
        documentId: doc,
        itemId,
        warehouseId,
        lotId,
        unitId,
        quantity: "1.000000",
      }),
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.inventory_movement set value = 0 where id = ${id}`,
      ),
    ).rejects.toThrow();
    const [priv] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.table_privileges
       where table_schema = 'app' and table_name = 'inventory_movement'
         and grantee = 'app_rw' and privilege_type in ('UPDATE', 'DELETE')`;
    expect(priv!.n).toBe(0);
    expect(IMMUTABLE.has("inventory_movement")).toBe(true);
    expect(AUDIT_EXEMPT.has("inventory_movement")).toBe(true);
  });

  it("an issue beyond available stock is refused with ERR_STOCK_INSUFFICIENT (test 18, LEGACY-048)", async () => {
    const wh = await seedWarehouse(db, a, { code: "SHORT" });
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, {
        documentId: doc,
        itemId,
        warehouseId: wh,
        lotId,
        unitId,
        quantity: "3.000000",
      }),
    );
    const doc2 = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        insertMovement(tx, a, {
          documentId: doc2,
          itemId,
          warehouseId: wh,
          lotId,
          unitId,
          quantity: "-4.000000",
        }),
      ),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
    // 3 out of 3 is exactly zero and is allowed — the boundary is `available + new.quantity < 0`.
    const doc3 = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, {
        documentId: doc3,
        itemId,
        warehouseId: wh,
        lotId,
        unitId,
        quantity: "-3.000000",
      }),
    );
  });

  it("the availability sum sees this transaction's earlier rows, never stock_on_hand", async () => {
    const wh = await seedWarehouse(db, a, { code: "SAMETX" });
    const doc = await draftDocument(db, a);
    // stock_on_hand is empty for this warehouse (nothing MERGEs it in this task), yet the receipt in the
    // same transaction is enough for the issue that follows it. That is §4.7.3's "NEVER from stock_on_hand".
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await insertMovement(tx, a, {
        documentId: doc,
        lineNo: 1,
        movementNo: 1,
        itemId,
        warehouseId: wh,
        lotId,
        unitId,
        quantity: "7.000000",
      });
      await insertMovement(tx, a, {
        documentId: doc,
        lineNo: 2,
        movementNo: 2,
        itemId,
        warehouseId: wh,
        lotId,
        unitId,
        quantity: "-7.000000",
      });
    });
    const [soh] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.stock_on_hand where warehouse_id = ${wh}`,
    );
    expect(soh!.n).toBe(0);
  });

  it("an inventory.negative_stock.override event on the document is the one door (§4.5.3, hazard 17)", async () => {
    const wh = await seedWarehouse(db, a, { code: "OVERRIDE" });
    const doc = await draftDocument(db, a);
    // A REAL second principal: role_assignment.principal_id has an FK to app.principal, so a bare uuid is a
    // 23503 and `document_event_override_guard` needs a principal that actually holds the code at the
    // document's branch. The two inserts are 2B's own `secondPrincipal` shape (plan0A:837 — the principal
    // without RETURNING, then its membership, in one transaction as the tenant's system principal).
    const second = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${second}, 'human', ${`stock-supervisor:${a.tenant}`}, 'Stock supervisor')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${second})`;
    });
    await grantCodes(db, a, {
      codes: ["inventory.negative_stock.override"],
      principalId: second,
      roleCode: "stock-override",
    });
    // recordOverride (2B, §4.3.1) is the ONE way an override event is written — it knows §4.5.2's column
    // list and the guard checks its `coalesce(attributed_to, actor_id)`. A hand-rolled document_event insert
    // here would be a second spelling of a frozen write (hazard 24: only triggers and this door write it).
    await withTenant(db.rw, a.tenant, second, (tx) =>
      recordOverride(
        tx,
        { tenantId: a.tenant, actorId: second, requestId: "stock-override-1" },
        {
          documentId: doc,
          code: "inventory.negative_stock.override",
          reason: "stock count pending",
        },
      ),
    );
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      insertMovement(tx, a, {
        documentId: doc,
        itemId,
        warehouseId: wh,
        lotId,
        unitId,
        quantity: "-2.000000",
      }),
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ quantity: string }[]>`select quantity::text from app.inventory_movement
                                  where document_id = ${doc} and warehouse_id = ${wh}`,
    );
    expect(row!.quantity).toBe("-2.000000");
  });

  it("the override is per DOCUMENT, so a second document with no event is still refused", async () => {
    // The same warehouse the previous case drove to −2. Looked up, not re-seeded: warehouse is
    // `unique (company_id, code)` and a second seedWarehouse with this code would be a 23505.
    const [wh] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { id: string }[]
        >`select id from app.warehouse where company_id = ${a.company} and code = 'OVERRIDE'`,
    ).then((rows) => rows.map((r) => r.id));
    const other = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        insertMovement(tx, a, {
          documentId: other,
          itemId,
          warehouseId: wh!,
          lotId,
          unitId,
          quantity: "-1.000000",
        }),
      ),
    ).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("stock_on_hand has no id column and its primary key is the full natural key (§3.5.3)", async () => {
    const [idCol] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'stock_on_hand' and column_name = 'id'`;
    expect(idCol!.n).toBe(0);
    const [pk] = await db.admin<{ cols: string[] }[]>`
      select array_agg(a.attname order by k.ord) as cols
        from pg_constraint c
        join unnest(c.conkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'app.stock_on_hand'::regclass and c.contype = 'p'`;
    expect(pk!.cols).toEqual(["company_id", "item_id", "warehouse_id", "lot_id"]);
  });

  it("a second tenant sees neither table's rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [m] = await tx<{ n: number }[]>`select count(*)::int as n from app.inventory_movement`;
      const [h] = await tx<{ n: number }[]>`select count(*)::int as n from app.stock_on_hand`;
      return [m!.n, h!.n];
    });
    expect(counts).toEqual([0, 0]);
  });

  it("document gained warehouse_id / to_warehouse_id and attachment gained lot_id, each FK'd", async () => {
    const fks = await db.admin<{ tbl: string; col: string; ref: string }[]>`
      select cl.relname as tbl, a.attname as col, rf.relname as ref
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join unnest(c.conkey) as k(attnum) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.contype = 'f'
         and ((cl.relname = 'document'   and a.attname in ('warehouse_id', 'to_warehouse_id'))
           or (cl.relname = 'attachment' and a.attname = 'lot_id'))
       order by cl.relname, a.attname`;
    expect(fks.map((f) => `${f.tbl}.${f.col}->${f.ref}`)).toEqual([
      "attachment.lot_id->lot",
      "document.to_warehouse_id->warehouse",
      "document.warehouse_id->warehouse",
    ]);
  });

  it("an attachment must belong to exactly one of a document or a lot", async () => {
    const doc = await draftDocument(db, a);
    const both = withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.attachment (tenant_id, company_id, document_id, lot_id, object_key, file_name,
                                   mime_type, byte_size, sha256)
      values (${a.tenant}, ${a.company}, ${doc}, ${lotId}, 'k-both', 'cert.pdf', 'application/pdf', 10,
              decode('00', 'hex'))`,
    );
    await expect(both).rejects.toThrow(/attachment_owner_check/);
    const neither = withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.attachment (tenant_id, company_id, object_key, file_name, mime_type, byte_size, sha256)
      values (${a.tenant}, ${a.company}, 'k-none', 'cert.pdf', 'application/pdf', 10, decode('00', 'hex'))`,
    );
    await expect(neither).rejects.toThrow(/attachment_owner_check/);
  });

  it("lintSchema is clean with stock_on_hand in NO_ID_TABLES and AUDIT_EXEMPT", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
