import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, type Violation } from "../src/index";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "./index";

let db: Db;
let a: Seed;
let b: Seed;

/** File-local because §4.17 gives 3C no type-seeding helper and 2A's `seedDocumentType` needs a Db, not a Seed alone. */
async function seedDocumentTypeLocal(s: Seed, code: string, series: string): Promise<string> {
  return seedDocumentType(db, s, {
    code,
    module: "inventory",
    policy: {
      version: 1,
      documentType: code,
      direction: "none",
      requires: [],
      lines: [],
      inventory: { effect: "none" },
      tax: { applies: false },
      numbering: { series, assignAt: "issue" },
      reversal: { allowed: false, producesType: null },
      approval: { required: false, approve: null, post: "accounting.journal.post" },
      fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      dimensions: { required: [] },
    },
  });
}

/** A PURCHASE_ORDER-shaped type configured in the database: direction none, inventory none, no ledger lines. */
async function orderType(s: Seed): Promise<string> {
  return seedDocumentTypeLocal(s, "LINK_ORDER", "LO");
}
/** A GOODS_RECEIPT-shaped type: it only has to be a second type with its own series. */
async function receiptType(s: Seed): Promise<string> {
  return seedDocumentTypeLocal(s, "LINK_RECEIPT", "LR");
}

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "link-a");
  b = await seedTenantV2(db, "link-b");
  await grantCodes(db, a, { codes: ["accounting.journal.post", "accounting.journal.create"] });
  await grantCodes(db, b, { codes: ["accounting.journal.post", "accounting.journal.create"] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("app.document_link — migration 0037 (contracts §4.6.1; SAH-017, SAH-018)", () => {
  it("the schema linter reports zero violations after 0037", async () => {
    const violations: Violation[] = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("has tenant_id, forced RLS, a tenant_isolation policy and an audit_row trigger", async () => {
    const [t] = await db.admin<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'app.document_link'::regclass`;
    expect(t).toEqual({ rls: true, forced: true });
    const policies = await db.admin<{ polname: string; permissive: string }[]>`
      select polname, polpermissive::text as permissive from pg_policy where polrelid = 'app.document_link'::regclass order by 1`;
    expect(policies.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.document_link'::regclass and not tgisinternal order by 1`;
    expect(triggers.map((t2) => t2.tgname)).toEqual(["audit_row", "document_link_open_quantity"]);
  });

  it("app_rw holds select, insert and update — and NO delete (contracts §3.5.4 is closed)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_link' order by 1`;
    expect(grants.map((g) => g.privilege_type).toSorted()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("app_rw holds SELECT and ONLY select on the open-quantity view, and the view runs as the invoker", async () => {
    const [v] = await db.admin<{ opts: string[] | null }[]>`
      select reloptions as opts from pg_class where oid = 'app.document_open_quantity'::regclass`;
    expect(v!.opts).toContain("security_invoker=true");
    // The EXACT list, not "SELECT is present". Plan 0A's `alter default privileges … grant select, insert,
    // update on tables to app_rw` (plan0A:2564) applies to VIEWS as well as tables, so without 0037's
    // explicit revoke this returns ["INSERT", "SELECT", "UPDATE"] — and Task 14's SAH-017 claim that the one
    // place the figure exists "cannot be written to at all" would be unsupported by the privilege surface.
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_open_quantity' order by 1`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);
  });

  it("open_quantity is ordered minus every non-void, non-reversed link", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "LINK-ITEM" });
    const warehouseId = await seedWarehouse(db, a, { code: "LINK-WH" });
    const partyId = await seedParty(db, a, { kind: "vendor", code: "LINK-VEND" });

    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "100.000000",
          unitPrice: "5.0000",
          amount: "500.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "40.000000",
          unitPrice: "5.0000",
          amount: "200.0000",
        },
      ],
    });

    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.document set status = 'issued' where id = ${order.documentId}`;
      await tx`insert into app.document_link
                 (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
               values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!},
                       ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 40)`;
    });

    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { ordered: string; linked: string; open: string }[]
        >`select ordered_quantity::text as ordered, linked_quantity::text as linked, open_quantity::text as open
        from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`,
    );
    expect(row).toEqual({ ordered: "100.000000", linked: "40.000000", open: "60.000000" });

    // Voiding the target releases the quantity — nothing is decremented anywhere.
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${receipt.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'void' where id = ${receipt.documentId}`,
    );
    const [after] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { linked: string; open: string }[]
        >`select linked_quantity::text as linked, open_quantity::text as open
        from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`,
    );
    expect(after).toEqual({ linked: "0.000000", open: "100.000000" });
  });

  it("refuses a link beyond the open quantity with ERR_DOC_LINK_OVER_FULFILLED, naming both figures", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "OVER-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "10.000000",
          unitPrice: "1.0000",
          amount: "10.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "11.000000",
          unitPrice: "1.0000",
          amount: "11.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );

    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link
          (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!},
                ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 11)`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* has 10\.000000 open of 10\.000000 ordered; 11\.000000 requested/,
    );
  });

  it("refuses the second of two links that together exceed the order (the double-add of SAH-017)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "DOUBLE-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "10.000000",
          unitPrice: "1.0000",
          amount: "10.0000",
        },
      ],
    });
    const r1 = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "6.000000",
          unitPrice: "1.0000",
          amount: "6.0000",
        },
      ],
    });
    const r2 = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "6.000000",
          unitPrice: "1.0000",
          amount: "6.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );

    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${r1.documentId}, ${r1.lineIds[0]!}, 'receives_against', 6)`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${r2.documentId}, ${r2.lineIds[0]!}, 'receives_against', 6)`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* has 4\.000000 open of 10\.000000 ordered; 6\.000000 requested/,
    );
  });

  it("refuses a link whose target is not a draft (ERR_DOC_NOT_DRAFT) and whose source is not issued (ERR_DOC_STATUS_ILLEGAL)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "STATUS-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "9.000000",
          unitPrice: "1.0000",
          amount: "9.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "9.000000",
          unitPrice: "1.0000",
          amount: "9.0000",
        },
      ],
    });

    // The source is still a draft: nothing has been committed to, so there is nothing to fulfil.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 9)`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: source document .* is draft — only an issued or posted document can be fulfilled/,
    );

    // Issue both: the target is no longer a draft, so the link cannot be recorded on it.
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${receipt.documentId}`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 9)`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is issued — a fulfilment link is recorded on a draft/,
    );
  });

  it("admits a link against a POSTED source, because a goods receipt may follow an invoice", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "POSTED-SRC-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "2.000000",
          unitPrice: "1.0000",
          amount: "2.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "2.000000",
          unitPrice: "1.0000",
          amount: "2.0000",
        },
      ],
    });
    // A raw status walk: draft → issued → posted is what the state machine admits, and this is a DB-tier test
    // of the link guard, not of the posting service.
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'posted' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 2)`,
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { open: string }[]
        >`select open_quantity::text as open from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`,
    );
    expect(row!.open).toBe("0.000000");
  });

  it("deleting the draft target cascades the link away and releases the quantity (no DELETE grant needed)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "CASCADE-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "10.000000",
          unitPrice: "1.0000",
          amount: "10.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "10.000000",
          unitPrice: "1.0000",
          amount: "10.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 10)`,
    );

    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`delete from app.document where id = ${receipt.documentId}`,
    );
    const [after] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { open: string }[]
        >`select open_quantity::text as open from app.document_open_quantity where document_line_id = ${order.lineIds[0]!}`,
    );
    expect(after!.open).toBe("10.000000");
  });

  it("refuses to delete the line of an ISSUED order at all — 2B's child guard fires before the FK (ERR_DOC_NOT_DRAFT)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "NODEL-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "5.000000",
          unitPrice: "1.0000",
          amount: "5.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "5.000000",
          unitPrice: "1.0000",
          amount: "5.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 5)`,
    );

    // NOT 23503. 2B ships `app.forbid_line_delete_unless_draft()` as a BEFORE DELETE trigger on
    // app.document_line raising `ERR_DOC_NOT_DRAFT … its lines cannot be deleted` with errcode
    // 'check_violation' (2b:1874-1887), and it fires on the non-draft parent BEFORE any foreign-key check on
    // document_link runs. So the source-side NO ACTION FK is unreachable through app_rw while that guard
    // stands — which is the stronger property, and is what the DDL comment in migration 0037 means by "an
    // issued order cannot be deleted anyway". The FK is still the belt: it is what a future slice holding a
    // DELETE grant would hit, and §3.5.4 is closed, so no test can reach it today.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`delete from app.document_line where id = ${order.lineIds[0]!}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("tenant B sees none of tenant A's links and none of A's open-quantity rows (test 12)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "ISO-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "3.000000",
          unitPrice: "1.0000",
          amount: "3.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "3.000000",
          unitPrice: "1.0000",
          amount: "3.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 3)`,
    );

    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select (select count(*)::int from app.document_link) + (select count(*)::int from app.document_open_quantity) as n`,
    );
    expect(seen[0]!.n).toBe(0);

    // …and B cannot point a link at A's rows either. NOT 23503, and the reason is the firing order:
    // `document_link_open_quantity` is a BEFORE INSERT ROW trigger, and PostgreSQL runs those before it
    // evaluates referential integrity (an FK is an AFTER-row RI trigger). Under B's RLS the guard's
    // `select d.status … where d.id = new.source_document_id` returns no row, `v_source` is null, and it
    // raises `ERR_DOC_STATUS_ILLEGAL: source document … is not visible — only an issued or posted document
    // can be fulfilled` with errcode 'check_violation' (23514). So the GUARD is the first refusal, not the
    // composite FK. The FK is still the belt underneath — it is what a caller that somehow satisfied every
    // trigger clause would hit — but no cross-tenant document id can reach it, because "invisible" fails the
    // source-status clause first. Asserting 23503 here would be a test that can never go green.
    const bReceipt = await draftTypedDocument(db, b, {
      documentTypeId: await receiptType(b),
      series: "LR",
      lines: [{ kind: "text", description: "x" }],
    });
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
        insert into app.document_link (tenant_id, company_id, source_document_id, target_document_id, link_kind)
        values (${b.tenant}, ${b.company}, ${order.documentId}, ${bReceipt.documentId}, 'receives_against')`,
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: source document .* is not visible/);
  });

  it("writes an audit row for every link insert (test 13)", async () => {
    const before = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'document_link'`;
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "AUDIT-ITEM" });
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "1.000000",
          unitPrice: "1.0000",
          amount: "1.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "1.000000",
          unitPrice: "1.0000",
          amount: "1.0000",
        },
      ],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_link (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
      values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!}, ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 1)`,
    );
    const after = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'document_link'`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });
  // ── migrations 0109 and 0110 (Phase 3 review pass) ──────────────────────────────────────────────────
  // Every case here is one the pre-0109 trigger ADMITTED. They are the regression tests the review found
  // missing: without them, 0110.down.sql restoring 0109's body — or any later `create or replace` of the
  // function — would reopen the hole with nothing red, which is exactly how the Phase 2 defects survived.

  it("0109: refuses a source line that is not a line of the source document (ERR_VALIDATION_FAILED)", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "L109-A" });
    const line = {
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      quantity: "5.000000",
      unitPrice: "1.0000",
      amount: "5.0000",
    };
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [line],
    });
    const other = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [line],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [line],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.document set status = 'issued' where id in (${order.documentId}, ${other.documentId})`,
    );
    // The source DOCUMENT is `order`; the source LINE belongs to `other`. Same company, both issued — the
    // intra-company variant the verifier named, which needs no second company to demonstrate.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link
          (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${other.lineIds[0]!},
                ${receipt.documentId}, ${receipt.lineIds[0]!}, 'receives_against', 1)`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source line .* is not a line of document/);
  });

  it("0109: refuses a target line that is not a line of the target document", async () => {
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "L109-B" });
    const line = {
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      quantity: "5.000000",
      unitPrice: "1.0000",
      amount: "5.0000",
    };
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [line],
    });
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [line],
    });
    const otherReceipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [line],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link
          (tenant_id, company_id, source_document_id, source_line_id, target_document_id, target_line_id, link_kind, quantity)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${order.lineIds[0]!},
                ${receipt.documentId}, ${otherReceipt.lineIds[0]!}, 'receives_against', 1)`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: target line .* is not a line of document/);
  });

  it("0110: refuses a HEADER-ONLY link whose source document belongs to another company of the tenant", async () => {
    // A second company in tenant A, created directly: §4.17 has no seedCompany helper and this case is the
    // reason 0110 exists — 0109's line check ran only when source_line_id was not null, so a header-only
    // link (the `settles` shape 4A uses) with company_id = A's first company and a source document of A's
    // second company passed every check in the function.
    const companyB = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${a.tenant}, 'L110-B', 'Link second company', 'MYR') returning id`;
      return row!.id;
    });
    await grantCodes(db, { ...a, company: companyB });
    const orderTy = await orderType(a);
    const receiptTy = await receiptType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "L110-A" });
    const line = {
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      quantity: "5.000000",
      unitPrice: "1.0000",
      amount: "5.0000",
    };
    const receipt = await draftTypedDocument(db, a, {
      documentTypeId: receiptTy,
      series: "LR",
      lines: [line],
    });
    // The foreign source: a document row in company B, issued. Drafted by SQL because draftTypedDocument
    // writes to the seed's own company by design.
    const foreignSource = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.document
          (tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id,
           effective_date, currency, branch_id, status)
        select ${a.tenant}, ${companyB}, d.document_type_id, d.posting_policy_id, d.series,
               d.fiscal_period_id, d.effective_date, d.currency, d.branch_id, 'issued'
          from app.document d where d.id = ${receipt.documentId} returning id`;
      return row!.id;
    });
    void orderTy;
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link
          (tenant_id, company_id, source_document_id, target_document_id, link_kind)
        values (${a.tenant}, ${a.company}, ${foreignSource}, ${receipt.documentId}, 'settles')`,
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: source document .* is not visible/);
  });

  it("0110: refuses a target document of another company, even for a line link", async () => {
    const companyB = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${a.tenant}, 'L110-C', 'Link third company', 'MYR') returning id`;
      return row!.id;
    });
    await grantCodes(db, { ...a, company: companyB });
    const orderTy = await orderType(a);
    const { itemId, baseUnitId } = await seedItem(db, a, { code: "L110-D" });
    const line = {
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      quantity: "5.000000",
      unitPrice: "1.0000",
      amount: "5.0000",
    };
    const order = await draftTypedDocument(db, a, {
      documentTypeId: orderTy,
      series: "LO",
      lines: [line],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.document set status = 'issued' where id = ${order.documentId}`,
    );
    const foreignTarget = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.document
          (tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id,
           effective_date, currency, branch_id, status)
        select ${a.tenant}, ${companyB}, d.document_type_id, d.posting_policy_id, d.series,
               d.fiscal_period_id, d.effective_date, d.currency, d.branch_id, 'draft'
          from app.document d where d.id = ${order.documentId} returning id`;
      return row!.id;
    });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_link
          (tenant_id, company_id, source_document_id, target_document_id, link_kind)
        values (${a.tenant}, ${a.company}, ${order.documentId}, ${foreignTarget}, 'settles')`,
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: target document .* is not visible/);
  });
});
