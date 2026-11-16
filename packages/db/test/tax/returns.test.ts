import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant as prodWithTenant } from "../../src";
import {
  createTaxReturn,
  generateTaxReturn,
  getTaxReturn,
  listTaxReturns,
  taxReturnTieOut,
} from "../../src/tax";
import { startDb, type Db } from "../harness";
import {
  postTaxedDocument,
  taxFixture,
  type TaxFixture,
} from "../../../../tests/invariants/support/tax";

let db: Db;
let f: TaxFixture;
let returnId: string;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "returns-test" });
const Q1 = { periodStart: "2026-01-01", periodEnd: "2026-03-31" };

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "returns");
  // The DoD fixture: five documents, one of each shape the pack's five boxes must separate.
  await postTaxedDocument(db, f, {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-01-15",
    lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
  });
  await postTaxedDocument(db, f, {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-02-10",
    lines: [{ lineNo: 1, amount: "500.0000", taxCode: "SYN-OUT-STD" }],
  });
  await postTaxedDocument(db, f, {
    typeCode: "SALES_CREDIT_NOTE",
    effectiveDate: "2026-02-20",
    lines: [{ lineNo: 1, amount: "-200.0000", taxCode: "SYN-OUT-STD" }],
  });
  await postTaxedDocument(db, f, {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-03-05",
    lines: [
      { lineNo: 1, amount: "300.0000", taxCode: "SYN-OUT-ZERO" },
      { lineNo: 2, amount: "150.0000", taxCode: "SYN-EXEMPT" },
    ],
  });
  await postTaxedDocument(db, f, {
    typeCode: "PURCHASE_INVOICE",
    effectiveDate: "2026-03-20",
    partyId: f.vendorId,
    lines: [
      {
        lineNo: 1,
        kind: "account",
        accountId: f.accounts["5900"]!,
        amount: "800.0000",
        taxCode: "SYN-IN-STD",
      },
    ],
  });
  // …and one OUTSIDE the quarter, which must not appear in any box (LEGACY-059).
  await postTaxedDocument(db, f, {
    typeCode: "SALES_INVOICE",
    effectiveDate: "2026-04-02",
    lines: [{ lineNo: 1, amount: "9999.0000", taxCode: "SYN-OUT-STD" }],
  });
  const row = await prodWithTenant(db.rw, ctx(), (tx) =>
    createTaxReturn(tx, ctx(), { companyId: f.s.company, regimeId: f.regimeId, ...Q1 }),
  );
  returnId = row.id;
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("tax returns (§4.9.2, the Phase 5 DoD)", () => {
  it("a new return is a draft with no payload and no generator", async () => {
    const { row } = await prodWithTenant(db.rw, ctx(), (tx) => getTaxReturn(tx, returnId));
    expect(row).toMatchObject({
      status: "draft",
      payload: null,
      payloadSha256: null,
      generatedBy: null,
      regimeCode: "SYNTH-MY-v1",
      periodStart: "2026-01-01",
    });
  });

  it("one return per company, regime and period start — a second reservation is refused", async () => {
    // The unique key stays (transaction-return.test.ts pins it), but since the PR 11 review's overlap rule
    // it is the backstop: the overlap read refuses an identical range first, as the same 409 code, and
    // names the return it collides with — which the driver's constraint name never did.
    const again = prodWithTenant(db.rw, ctx(), (tx) =>
      createTaxReturn(tx, ctx(), { companyId: f.s.company, regimeId: f.regimeId, ...Q1 }),
    );
    await expect(again).rejects.toMatchObject({ code: "ERR_CONFLICT_UNIQUE" });
    await expect(again).rejects.toThrow(`overlaps tax return ${returnId} (2026-01-01..2026-03-31`);
  });

  it("generate fills every box from tax_transaction, excluding the out-of-period document (LEGACY-059)", async () => {
    const { row, boxes } = await prodWithTenant(db.rw, ctx(), (tx) =>
      generateTaxReturn(tx, ctx(), returnId),
    );
    expect(row.status).toBe("generated");
    expect(row.generatedBy).toBe(f.s.human);
    const box = (c: string) => boxes.find((b) => b.code === c)!.amount.toString();
    expect(box("S1")).toBe("1300.0000"); // 1000 + 500 - 200 : the 9999 of 2026-04-02 is NOT here
    expect(box("S2")).toBe("143.0000"); // 110 + 55 - 22
    expect(box("S3")).toBe("450.0000"); // 300 zero-rated + 150 exempt
    expect(box("P1")).toBe("800.0000");
    expect(box("P2")).toBe("88.0000");
  });

  it("regenerating is byte-identical and keeps the FIRST generator (§4.3.4's closed_by precedent)", async () => {
    const first = await prodWithTenant(db.rw, ctx(), (tx) => getTaxReturn(tx, returnId));
    const again = await prodWithTenant(
      db.rw,
      { tenantId: f.s.tenant, actorId: f.s.system, requestId: "regen" },
      (tx) =>
        generateTaxReturn(
          tx,
          { tenantId: f.s.tenant, actorId: f.s.system, requestId: "regen" },
          returnId,
        ),
    );
    expect(again.row.payload).toBe(first.row.payload);
    expect(again.row.payloadSha256).toBe(first.row.payloadSha256);
    expect(again.row.generatedBy).toBe(f.s.human); // NOT the system principal
  });

  it("the payload is what the pack produced, and the sha is sha256 of exactly those bytes", async () => {
    const { row } = await prodWithTenant(db.rw, ctx(), (tx) => getTaxReturn(tx, returnId));
    // `convert_to(payload, 'UTF8')` — `payload` is `text` and PostgreSQL has no text→bytea cast; the
    // stored sha is the sha of the payload's UTF-8 bytes, and this is the expression that says so.
    const [check] = await db.admin<{ same: boolean }[]>`
      select payload_sha256 = sha256(convert_to(payload, 'UTF8')) as same
        from app.tax_return where id = ${returnId}`;
    expect(check!.same).toBe(true);
    expect(row.payload).toContain('"regimeCode":"SYNTH-MY-v1"');
  });

  it("the tie-out reconciles both control accounts to the cent — the DoD's third verb", async () => {
    const rows = await prodWithTenant(db.rw, ctx(), (tx) => taxReturnTieOut(tx, returnId));
    expect(rows.map((r) => r.accountCode)).toEqual(["1350", "2300"]);
    const out = rows.find((r) => r.accountCode === "2300")!;
    expect(out).toMatchObject({
      boxCodes: ["S2"],
      boxBase: "143.0000",
      ledgerBase: "143.0000",
      difference: "0.0000",
    });
    const inp = rows.find((r) => r.accountCode === "1350")!;
    expect(inp).toMatchObject({
      boxCodes: ["P2"],
      boxBase: "88.0000",
      ledgerBase: "88.0000",
      difference: "0.0000",
    });
  });

  it("a return whose transactions carry a SECOND regime is refused, not filed wrong (spec:2444)", async () => {
    const g = await taxFixture(db, "returns-two-regimes");
    const second = await prodWithTenant(
      db.rw,
      { tenantId: g.s.tenant, actorId: g.s.human, requestId: "r2" },
      async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                      name_en, source)
          values (${g.s.tenant}, ${g.s.company}, 'SYNTH-MY-v1', 'MY', 2, '2026-01-01',
                  'Synthetic regime v1 revision 2', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
          returning id`;
        return r!.id;
      },
    );
    const gctx = { tenantId: g.s.tenant, actorId: g.s.human, requestId: "r2" };
    await postTaxedDocument(db, g, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-15",
      lines: [{ lineNo: 1, amount: "100.0000", taxCode: "SYN-OUT-STD" }],
    });
    const r = await prodWithTenant(db.rw, gctx, (tx) =>
      createTaxReturn(tx, gctx, { companyId: g.s.company, regimeId: second, ...Q1 }),
    );
    // Version 2 has no definition in the pack, and its period holds v1 transactions — two refusals, one code.
    await expect(
      prodWithTenant(db.rw, gctx, (tx) => generateTaxReturn(tx, gctx, r.id)),
    ).rejects.toThrow(/ERR_TAX_REGIME_MISMATCH/);
    const [after] = await db.admin<{ status: string; payload: string | null }[]>`
      select status, payload from app.tax_return where id = ${r.id}`;
    expect(after).toEqual({ status: "draft", payload: null }); // the refusal left NOTHING behind
  });

  it("listTaxReturns pages on (period_start, id) and filters by regime code", async () => {
    const rows = await prodWithTenant(db.rw, ctx(), (tx) =>
      listTaxReturns(tx, { companyId: f.s.company, regimeCode: "SYNTH-MY-v1", limit: 10 }),
    );
    expect(rows.map((r) => r.periodStart)).toEqual(["2026-01-01"]);
    expect(
      await prodWithTenant(db.rw, ctx(), (tx) =>
        listTaxReturns(tx, { companyId: f.s.company, regimeCode: "NOPE", limit: 10 }),
      ),
    ).toEqual([]);
  });
});
