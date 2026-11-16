import { grantCodes } from "../fixtures";
import { seedTaxCode } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSnapshot, PostingError, resolvePolicy } from "../../src/posting";
import {
  draftDocument,
  JOURNAL_POLICY_V1,
  seedAccount,
  seedItem,
  seedParty,
  seedTenant,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("loadSnapshot and resolvePolicy — contracts §4.3.1", () => {
  let db: Db;
  let a: Seed;
  let plain: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    plain = await seedTenant(db, "Plain");
    await grantCodes(db, plain); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  it("loads the header, the lines and the company at the Phase 1 subset", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit)
               values (${a.tenant}, ${a.company}, ${doc}, 1, 'Cash in', ${a.cash}, 100.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit, dimensions)
               values (${a.tenant}, ${a.company}, ${doc}, 2, ${a.sales}, 100.0000, ${JSON.stringify({ COSTCENTRE: "cc-1" })}::text::jsonb)`;
    });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));

    expect(snap.header).toMatchObject({
      id: doc,
      companyId: a.company,
      documentTypeCode: "JOURNAL",
      status: "draft",
      series: "JV",
      fiscalPeriodId: a.period,
      number: null,
      effectiveDate: "2026-01-15",
      branchId: a.hq,
      partyId: null,
      taxInclusive: false,
      warehouseId: null,
      toWarehouseId: null,
      reversesDocumentId: null,
    });
    expect(snap.header.currency).toBe("MYR");
    expect(snap.header.exchangeRate).toEqual({
      from: "MYR",
      to: "MYR",
      rate: "1.00000000",
      effectiveFrom: "2026-01-15",
      source: "unit",
    });
    expect(snap.company).toMatchObject({
      id: a.company,
      baseCurrency: "MYR",
      costingMethod: "avco",
    });
    expect(snap.company.fxRoundingAccountId).not.toBeNull();
    expect(snap.party).toBeNull();
    expect(snap.lines).toHaveLength(2);
    expect(snap.lines[0]).toMatchObject({
      lineNo: 1,
      kind: "account",
      description: "Cash in",
      accountId: a.cash,
      itemId: null,
      tenderMethod: null,
      payroll: null,
    });
    expect(snap.lines[0]!.debit.toString()).toBe("100.0000");
    expect(snap.lines[0]!.credit.toString()).toBe("0.0000");
    expect(snap.lines[1]!.dimensions).toEqual({ COSTCENTRE: "cc-1" });
    expect(snap.refs.items).toEqual({});
    expect(snap.refs.taxCodes).toEqual({});
    expect(snap.refs.components).toEqual({});
    expect(snap.refs.schemes).toEqual({});
    expect(snap.refs.dimensionTypesByCode).toMatchObject({ BRANCH: a.branchType });
  });

  it("keys refs.accountsByCode by app.account.code over the company's leaf accounts", async () => {
    const doc = await draftDocument(db, a);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.refs.accountsByCode["1000"]).toBe(a.cash);
    expect(snap.refs.accountsByCode["4000"]).toBe(a.sales);
    expect(snap.refs.accountsByCode["5920"]).toBe(snap.company.fxRoundingAccountId);
  });

  it("builds a real ExchangeRate for a foreign-currency document", async () => {
    const doc = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.currency (tenant_id, code, name_en) values (${a.tenant}, 'USD', 'US dollar')
               on conflict (tenant_id, code) do nothing`;
      await tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                  effective_date, currency, exchange_rate, rate_source, branch_id)
        values (${doc}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', ${a.period},
                '2026-01-15', 'USD', 4.68350000, 'BNM 2026-01-15', ${a.hq})`;
    });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.exchangeRate).toEqual({
      from: "USD",
      to: "MYR",
      rate: "4.68350000",
      effectiveFrom: "2026-01-15",
      source: "BNM 2026-01-15",
    });
  });

  it("refuses a document of another tenant with ERR_NOT_FOUND, never a leak", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, plain.tenant, plain.human, (tx) => loadSnapshot(tx, doc)),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
  });

  it("resolves the policy effective for the date, preferring the higher version on a tie", async () => {
    const resolved = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePolicy(tx, a.docType, "2026-01-15"),
    );
    expect(resolved.definition).toEqual(JOURNAL_POLICY_V1);
    const [version] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ version: number }[]>`
      select version from app.posting_policy where id = ${resolved.policyId}`,
    );
    // 0A's version 1 shares effective_from 2026-01-01 and loses the tie.
    expect(version!.version).toBe(2);
  });

  it("raises ERR_POLICY_NOT_FOUND before the earliest effective_from", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => resolvePolicy(tx, a.docType, "2025-12-31")),
    ).rejects.toMatchObject({ code: "ERR_POLICY_NOT_FOUND" });
  });

  it("raises ERR_POLICY_INVALID for a stored definition that fails the schema (SAH-013)", async () => {
    await expect(
      withTenant(db.rw, plain.tenant, plain.human, (tx) =>
        resolvePolicy(tx, plain.docType, "2026-01-15"),
      ),
    ).rejects.toMatchObject({ code: "ERR_POLICY_INVALID" });
  });

  it("seedAccount is idempotent on (company, code) and returns the same id", async () => {
    const first = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    const second = await seedAccount(db, a, { code: "1100", nameEn: "Bank", type: "asset" });
    expect(second).toBe(first);
  });

  it("a PostingError instance carries its code and a detail naming the entity", () => {
    const error = new PostingError("ERR_NOT_FOUND", "no document 0192 in this tenant");
    expect(error.code).toBe("ERR_NOT_FOUND");
    expect(error.message).toBe("ERR_NOT_FOUND: no document 0192 in this tenant");
  });
});

describe("loadSnapshot at the Phase 2 shape — contracts §4.4.2", () => {
  let db: Db;
  let a: Seed;
  let party: string;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    party = await seedParty(db, a, { code: "LS-1" });
  });
  afterAll(async () => {
    await db.stop();
  });

  const withLines = async (
    lines: Record<string, unknown>[],
    header: Record<string, unknown> = {},
  ): Promise<string> => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      if (Object.keys(header).length > 0)
        await tx`update app.document set ${tx(header)} where id = ${doc}`;
      for (const [i, l] of lines.entries()) {
        await tx`insert into app.document_line ${tx({
          id: await uuidv7(db.admin),
          tenant_id: a.tenant,
          company_id: a.company,
          document_id: doc,
          line_no: i + 1,
          ...l,
        })}`;
      }
    });
    return doc;
  };

  it("fills the party from the document's party_id", async () => {
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }], { party_id: party });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.partyId).toBe(party);
    expect(snap.party).toMatchObject({ id: party, kind: "customer" });
    expect(snap.party!.receivableAccountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.party!.creditLimit).toBeNull(); // 4A's migration 0045 adds the column
  });

  it("leaves party null when the document has none — a JOURNAL has no party", async () => {
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }]);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.partyId).toBeNull();
    expect(snap.party).toBeNull();
  });

  it("fills every line column migration 0019 added, at the right scale and type", async () => {
    // 3A's 0032 added document_line_item_fk, so item_id must name a real row (assumption 10); tax_code_id
    // now names a real tax code under 5A's 0055 foreign key. Scale assertions remain unchanged.
    const { itemId: item } = await seedItem(db, a, { code: "ITM-2A" });
    const { taxCodeId: taxCode } = await seedTaxCode(db, a, { kind: "zero", rate: "0.00000000" });
    const doc = await withLines([
      {
        kind: "item",
        item_id: item,
        quantity: "3.500000",
        unit_price: "12.3456",
        discount: "1.0000",
        amount: "42.2096",
        tax_code_id: taxCode,
        tax_amount: "2.5326",
        total_incl_tax: "44.7422",
        cost: "30.0000",
      },
    ]);
    const [l] = (await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc))).lines;
    expect(l!.kind).toBe("item");
    expect(l!.itemId).toBe(item);
    expect(l!.taxCodeId).toBe(taxCode);
    expect(l!.quantity!.toString()).toBe("3.500000");
    expect(l!.unitPrice!.toString()).toBe("12.3456");
    expect(l!.discount.toString()).toBe("1.0000");
    expect(l!.amount.toString()).toBe("42.2096");
    expect(l!.taxAmount.toString()).toBe("2.5326");
    expect(l!.totalInclTax.toString()).toBe("44.7422");
    expect(l!.cost!.toString()).toBe("30.0000");
  });

  it("a null cost stays null — it is not zero (amendment A5)", async () => {
    const doc = await withLines([{ kind: "item", amount: "5.0000" }]);
    const [l] = (await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc))).lines;
    expect(l!.cost).toBeNull();
  });

  it("fills header.customFields from custom_field_value, keyed by the definition code (0D)", async () => {
    const defId = await uuidv7(db.admin);
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }]);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.custom_field_definition (id, tenant_id, company_id, entity, code, name_en, kind)
               values (${defId}, ${a.tenant}, ${a.company}, 'document', 'kind', 'Run kind', 'text')`;
      await tx`insert into app.custom_field_value (id, tenant_id, definition_id, entity_id, value)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${defId}, ${doc}, ${JSON.stringify("supplementary")}::text::jsonb)`;
    });
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.customFields).toEqual({ kind: "supplementary" });
  });

  it("fills current defaults and leaves unconfigured references empty", async () => {
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }]);
    const snap = await withTenant(db.rw, a.tenant, a.human, (tx) => loadSnapshot(tx, doc));
    expect(snap.header.warehouseId).toBeNull(); // 3A / 0031
    expect(snap.header.toWarehouseId).toBeNull(); // 3A / 0031
    expect(snap.header.taxInclusive).toBe(false); // 5A / 0054
    expect(snap.company.costingMethod).toBe("avco"); // 3B; OD-06's default
    expect(snap.refs.items).toEqual({}); // 3A
    expect(Object.values(snap.refs.taxCodes)).toHaveLength(1);
    expect(Object.values(snap.refs.taxCodes)[0]).toMatchObject({
      code: "SYN-OUT-STD",
      rate: "0.00000000",
    }); // 5A
    expect(snap.refs.components).toEqual({}); // 8A
    expect(snap.refs.schemes).toEqual({}); // 8A
  });

  it("another tenant's document is invisible, party and all", async () => {
    const b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
    const doc = await withLines([{ account_id: a.cash, debit: "1.0000" }], { party_id: party });
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) => loadSnapshot(tx, doc)),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
  });
});
