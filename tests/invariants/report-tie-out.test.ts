import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  currency,
  intlFormatters,
  renderCsv,
  renderReport,
  type RenderedReport,
} from "@dulja/domain";
import {
  rebuildItemProfitability,
  rebuildStockValuation,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, uuidv7 } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { problemOf } from "../support/api";
import {
  CATALOGUE_7B,
  assertTieOut,
  readEnvelope,
  reportFixture,
  runDefinition,
  type ReportFixture,
  type TieOutOptions,
} from "./support/reports";

/**
 * 7B Task 11 — the Phase 7 definition of done for this slice's catalogue: "every report's numbers tie to the
 * ledger" (ADR 0068). Every definition's DECLARED `tieOut` is executed here against one fixture that carries
 * every chain (journals, inventory, sales, catalogue), and a definition with no case fails by name. It also
 * re-runs test 2 (deterministic projections, from the report side) and test 23 (one definition in both
 * directions), and asks 7A's runs route about all seventeen new codes.
 *
 * One container: the API's own database holds the fixture, so the route case and the tie-outs share it.
 * The group tests in `packages/db/test/reports/7b-*.test.ts` own each code's narrower assertions; the
 * parameters below are theirs, so a case here and its group test cannot drift apart silently.
 */
const MYR = currency("MYR");
const AS_OF = "2026-01-31";

interface Window {
  fromTime: string;
  toTime: string;
}

/** Every code's parameters and ledger window, in ONE place. A definition added to `CATALOGUE_7B` without an
 *  entry here fails the first case by name, which is the whole mechanism of ADR 0068. */
function caseFor(code: string, f: ReportFixture, w: Window): TieOutOptions {
  const c = f.s.company;
  const inv = f.inventory!;
  const cat = f.catalogue!;
  const jan = { fiscalPeriodId: f.s.period };
  const range = { fromDate: "2026-01-01", toDate: "2026-01-31" };
  switch (code) {
    case "accounting.general_ledger":
      return {
        params: { companyId: c, ...range, accountId: null, branchId: null },
        baseCurrency: MYR,
        window: jan,
      };
    case "accounting.journal_register":
      return {
        params: { companyId: c, ...range, documentTypeCode: null },
        baseCurrency: MYR,
        window: range,
      };
    case "accounting.account_statement":
      return {
        params: { companyId: c, accountId: f.s.cash, ...range },
        baseCurrency: MYR,
        window: { ...jan, accountCode: "1000" },
      };
    // `accountType` is "income", never null: the first money total is `base_balance`, and over every account
    // Σ(base_debit − base_credit) is zero by the ledger invariant, so a null type would compare 0.0000 with
    // 0.0000 and pass whatever the dataset returned (ADR 0068 rule 1). The ledger side is narrowed by TYPE,
    // not by code, because this fixture's sales chain may post revenue to more than one income account.
    case "accounting.period_comparison":
      return {
        params: { companyId: c, fiscalPeriodId: f.s.period, accountType: "income" },
        baseCurrency: MYR,
        window: { ...jan, accountTypes: ["income"] },
      };
    // The two statements take ONE parameter (amendment A6): `statementRows` applies the account-type split on
    // the report side, so only the LEDGER side is told which types the statement covers.
    case "accounting.profit_and_loss":
      return {
        params: { companyId: c, fiscalPeriodId: f.s.period },
        baseCurrency: MYR,
        window: { ...jan, accountTypes: ["income", "expense"] },
      };
    case "accounting.balance_sheet":
      return {
        params: { companyId: c, fiscalPeriodId: f.s.period },
        baseCurrency: MYR,
        window: { ...jan, accountTypes: ["asset", "liability", "equity"] },
      };
    case "accounting.document_register":
      return {
        params: {
          companyId: c,
          ...range,
          documentTypeCode: "JOURNAL",
          status: "posted",
          branchId: null,
        },
        baseCurrency: MYR,
        window: { ...range, documentTypeCodes: ["JOURNAL"] },
      };
    // The two auditor views filter a TIMESTAMP, so their window is `fromTime`/`toTime` (RFC 3339 text), never a
    // `date` parameter (7B Task 3). Every witness key is a `DatasetColumn.field` (A3): `assertTieOut` projects
    // ONE key list over both sides.
    case "accounting.audit_log":
      return {
        params: { companyId: c, tableName: "document", action: "insert", actorId: null, ...w },
        baseCurrency: MYR,
        witness: {
          key: ["table_name", "row_id"],
          rows: (t) => t<{ table_name: string; row_id: string }[]>`
            select 'document' as table_name, id::text as row_id
              from app.document where company_id = ${c}`,
        },
      };
    case "accounting.document_event_log":
      return {
        params: {
          companyId: c,
          documentTypeCode: null,
          eventKind: "transition",
          toStatus: "posted",
          ...w,
        },
        baseCurrency: MYR,
        witness: {
          key: ["document_id", "to_status"],
          rows: (t) => t<{ document_id: string; to_status: string }[]>`
            select id::text as document_id, 'posted' as to_status
              from app.document where company_id = ${c} and status = 'posted'`,
        },
      };
    case "accounting.trial_balance":
      return {
        params: { companyId: c, fiscalPeriodId: f.s.period, currency: null },
        baseCurrency: MYR,
        window: jan,
      };
    // `accountCode` narrows the stored side to the one account the report is filtered to (Task 4).
    case "accounting.ledger":
      return {
        params: { companyId: c, accountId: f.s.cash, ...range },
        baseCurrency: MYR,
        window: { ...jan, accountCode: "1000" },
      };
    // No `asOf` in the params: the definition declares none (A13). `TieOutOptions.asOf` is the HARNESS's.
    case "inventory.stock_ageing":
      return {
        params: { companyId: c, itemId: inv.itemId, warehouseId: null },
        baseCurrency: MYR,
        asOf: AS_OF,
      };
    case "inventory.movement_register":
      return {
        params: {
          companyId: c,
          fromDate: "2020-01-01",
          toDate: "2030-12-31",
          itemId: null,
          warehouseId: null,
          documentTypeCode: null,
        },
        baseCurrency: MYR,
      };
    // `tieOut.kind` is `none` (the `lot` dataset carries no quantity, A3), so a witness is MANDATORY (A5).
    case "inventory.expiry_list":
      return {
        params: { companyId: c, beforeDate: "2026-12-31", itemId: null },
        baseCurrency: MYR,
        witness: {
          key: ["code", "item_code", "expires_on"],
          rows: (t) => t<{ code: string; item_code: string; expires_on: string }[]>`
            select l.code, i.code as item_code, l.expires_on::text as expires_on
              from app.lot l join app.item i on i.id = l.item_id
             where l.company_id = ${c}
               and l.expires_on is not null and l.expires_on <= date '2026-12-31'`,
        },
      };
    case "inventory.price_list":
      return {
        params: { companyId: c, priceListId: cat.priceListId, itemId: null },
        baseCurrency: MYR,
        witness: {
          key: ["price_list_code", "item_code", "min_quantity", "unit_price"],
          rows: (t) => t<
            {
              price_list_code: string;
              item_code: string;
              min_quantity: string;
              unit_price: string;
            }[]
          >`
            select pl.code as price_list_code, i.code as item_code,
                   l.min_quantity::text as min_quantity, l.unit_price::text as unit_price
              from app.price_list_line l
              join app.price_list pl on pl.id = l.price_list_id
              join app.item i on i.id = l.item_id
             where pl.company_id = ${c}`,
        },
      };
    case "inventory.promotion_register":
      return {
        params: { companyId: c, kind: null },
        baseCurrency: MYR,
        witness: {
          key: ["code", "kind", "starts_at", "ends_at"],
          rows: (t) => t<{ code: string; kind: string; starts_at: string; ends_at: string }[]>`
            select code, kind,
                   to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at,
                   to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ends_at
              from app.promotion where company_id = ${c}`,
        },
      };
    // The register is complete for the corridor only (Task 6): the in-transit warehouse's on-hand is exactly
    // the transfer's dispatch leg, so the comparison is restricted to that key and refuses a key it lacks.
    case "inventory.transfer_register":
      return {
        params: {
          companyId: c,
          ...range,
          transferTypes: "TRANSFER,TRANSFER_RECEIPT",
          itemId: null,
          warehouseId: null,
        },
        baseCurrency: MYR,
        projectionKeys: [`${inv.itemId}|${inv.whTransit}|${inv.lotId}`],
      };
    case "inventory.count_register":
      return {
        params: {
          companyId: c,
          ...range,
          countTypes: "STOCK_COUNT",
          branchId: null,
          status: "posted",
        },
        baseCurrency: MYR,
        window: { ...range, documentTypeCodes: ["STOCK_COUNT"] },
      };
    case "inventory.profit_by_item":
      return {
        params: { companyId: c, fiscalPeriodId: f.s.period, itemId: null },
        baseCurrency: MYR,
      };
    case "inventory.stock_on_hand":
      return {
        params: {
          companyId: c,
          warehouseKinds: "stock,in_transit",
          itemId: null,
          warehouseId: null,
          hideQuantity: "0",
        },
        baseCurrency: MYR,
      };
    case "inventory.valuation":
      return {
        params: { companyId: c, asOf: AS_OF, itemId: inv.itemId, warehouseId: null },
        baseCurrency: MYR,
        asOf: AS_OF,
      };
    case "inventory.sales_by_item":
      return {
        params: { companyId: c, fiscalPeriodId: f.s.period, itemId: null },
        baseCurrency: MYR,
      };
    default:
      throw new Error(
        `report-tie-out: ${code} has no tie-out case — ADR 0068 requires one before the definition ships`,
      );
  }
}

/** Every fixed-scale figure a CSV render carries, sorted — test 23's numeral comparison at the text layer. */
function figures(csv: string): string[] {
  return csv
    .split(/[\r\n,]+/)
    .filter((t) => /^-?\d+\.\d{4}$/.test(t))
    .toSorted();
}

/** Every async projection's stored figures, as one digest — what "rebuilds bit-identically" compares. */
async function projectionDigest(tx: Sql, companyId: string): Promise<string> {
  const [row] = await tx<{ h: string | null }[]>`
    select md5(string_agg(t, '|' order by t)) as h from (
      select item_id::text || ':' || warehouse_id::text || ':' || as_of::text || ':' ||
             quantity::text || ':' || value::text as t
        from app.stock_valuation where company_id = ${companyId}
      union all
      select item_id::text || ':' || fiscal_period_id::text || ':' || quantity_sold::text || ':' ||
             revenue_base::text || ':' || cogs_base::text || ':' || margin_base::text
        from app.item_profitability where company_id = ${companyId}
    ) s`;
  if (row?.h == null)
    throw new Error("projectionDigest: both projections are empty for the company");
  return row.h;
}

describe("Phase 7 DoD — every report's numbers tie to the ledger (7B's catalogue, ADR 0068)", () => {
  let api: StartedApi;
  let f: ReportFixture;
  let w: Window;

  const ctxFor = async (actorId: string): Promise<TenantContext> => ({
    tenantId: f.s.tenant,
    actorId,
    requestId: await uuidv7(api.db.admin),
  });
  const rebuild = async (): Promise<void> => {
    await withTenant(api.db.rw, await ctxFor(f.s.system), async (tx) => {
      await rebuildStockValuation(tx, { companyId: f.s.company, asOf: AS_OF });
      await rebuildItemProfitability(tx, { companyId: f.s.company });
    });
  };

  beforeAll(async () => {
    api = await startApi();
    f = await reportFixture(api.db, "TieOut", { inventory: true, sales: true, catalogue: true });
    // Both projections are asynchronous; their rebuilds are 3B's and 4B's own functions, run as the tenant's
    // system principal (hazard 20). This slice writes no projection row.
    await rebuild();
    const [row] = await api.db.admin<{ from_time: string; to_time: string }[]>`
      select to_char((now() - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as from_time,
             to_char((now() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as to_time`;
    w = { fromTime: row!.from_time, toTime: row!.to_time };
  }, 300_000);
  afterAll(async () => {
    await api?.stop();
  });

  it("every code in the catalogue has a tie-out case", () => {
    for (const code of CATALOGUE_7B) expect(() => caseFor(code, f, w), code).not.toThrow();
    expect(() => caseFor("accounting.not_in_the_catalogue", f, w)).toThrow(/has no tie-out case/);
  });

  it.each([...CATALOGUE_7B])("%s ties", async (code) => {
    await withTenant(api.db.rw, await ctxFor(f.reader), (tx) =>
      assertTieOut(tx, readEnvelope(code).definition, caseFor(code, f, w)),
    );
  });

  it("TEST 2 re-run: a projection-backed report reads the projection, so a rebuild moves both or neither", async () => {
    // spec:2420, from the report side. A second rebuild must leave both async projections bit-identical, and
    // every report over them must still tie — a report that re-aggregated instead of reading would tie on
    // its own figure whatever the projection held, so the digest is what makes the clause bite.
    const before = await withTenant(api.db.rw, await ctxFor(f.reader), (tx) =>
      projectionDigest(tx, f.s.company),
    );
    await rebuild();
    const after = await withTenant(api.db.rw, await ctxFor(f.reader), (tx) =>
      projectionDigest(tx, f.s.company),
    );
    expect(after).toBe(before);
    for (const code of [
      "inventory.valuation",
      "inventory.stock_ageing",
      "inventory.profit_by_item",
      "inventory.sales_by_item",
    ]) {
      await withTenant(api.db.rw, await ctxFor(f.reader), (tx) =>
        assertTieOut(tx, readEnvelope(code).definition, caseFor(code, f, w)),
      );
    }
  });

  it("TEST 23 re-run: one definition renders in both directions with the same figures (spec:2441)", async () => {
    const definition = readEnvelope("accounting.trial_balance").definition;
    const rows = await withTenant(api.db.rw, await ctxFor(f.reader), (tx) =>
      runDefinition(tx, definition, {
        companyId: f.s.company,
        fiscalPeriodId: f.s.period,
        currency: null,
      }),
    );
    // `renderReport` is synchronous and `RenderOptions.formatters` is REQUIRED (A11): the numeral and calendar
    // policy is 0E's, injected. `generatedAt` is pinned so the two renders differ in nothing but language.
    const render = (lang: "en" | "ar"): RenderedReport =>
      renderReport(definition, rows, {
        format: "csv",
        lang,
        formatters: intlFormatters(lang, { currency: "MYR" }),
        parameters: { fiscalPeriodId: f.s.period },
        generatedAt: "2026-02-01T00:00:00Z",
      });
    const en = render("en");
    const ar = render("ar");

    expect(en.dir).toBe("ltr");
    expect(ar.dir).toBe("rtl");
    // LOGICAL column order in both (7A: "never reversed for rtl"); only the labels differ, both from the
    // definition.
    expect(ar.columns.map((c) => c.field)).toEqual(en.columns.map((c) => c.field));
    expect(en.title).toBe(definition.nameEn);
    expect(ar.title).toBe(definition.nameAr);
    expect(en.rowCount).toBe(ar.rowCount);
    expect(en.rowCount).toBeGreaterThan(0);

    // The FORMATTED figures carry the same number cell for cell. The two renders legitimately differ in the
    // currency's placement and the bidi marks around it ("MYR 1,200.00" against "\u200f1,200.00 MYR"), so
    // the comparison is on the figure itself — digits, grouping, decimal point and sign. `intlFormatters`
    // defaults `numberingSystem` to "latn" for both languages; if a later slice makes "arab" the Arabic
    // default this fails, and the fix is to normalise the numerals, never to drop the comparison, which is
    // the whole of test 23's numeral clause.
    const money = new Set(
      definition.columns.filter((c) => c.format === "money").map((c) => c.field),
    );
    const formatted = (r: RenderedReport) =>
      r.rows.flatMap((row) =>
        row.cells
          .filter((cell) => money.has(cell.field))
          .map((cell) => cell.text.replace(/[^\d.,-]/g, "")),
      );
    expect(formatted(ar)).toEqual(formatted(en));
    expect(formatted(en).some((t) => /\d/.test(t))).toBe(true);

    // And the rendered-text layer: `renderCsv`, the same data one step before 7A's PDF renderer (whose own
    // test 23 lives in apps/worker, which §3.1 keeps out of this workspace).
    const enText = renderCsv(en);
    const arText = renderCsv(ar);
    expect(figures(arText)).toEqual(figures(enText));
    expect(figures(enText).length).toBeGreaterThan(0);
    expect(arText).toContain(definition.columns[0]!.labelAr);
    expect(enText).toContain(definition.columns[0]!.labelEn);
  });

  it("7A's runs route takes all seventeen new codes past its grammar, and 400s one it does not", async () => {
    // Export authority first: 7A's gate order is requireReportExport → resolveDefinitionForRun →
    // requireReportRead (amendment A4), so an UNGRANTED caller gets 403 for every code and proves nothing.
    await grantCodes(api.db, f.s, {
      codes: ["accounting.report.export"],
      principalId: f.reader,
      roleCode: "phase7b_exporter",
    });
    const post = (code: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${f.s.company}/reports/${code}/runs`,
        as: f.reader,
        body: { parameters: {}, format: "csv", lang: "en" },
      });
    const codes = CATALOGUE_7B.filter((c) => readEnvelope(c).definitionVersion === 1);
    expect(codes.length).toBe(17);
    for (const code of codes) {
      // 404 is the PASSING result: this tenant's pack was never applied (Task 9's loader case owns that), so no
      // definition resolves. What the loop proves is reachability — each code clears `{code}`'s grammar and
      // the export gate and reaches 7A's resolver. A code the grammar rejects answers 400 instead (below).
      const res = await post(code);
      expect(res.status, `${code} answered ${res.status}`).toBe(404);
      expect((await problemOf(res)).code, code).toBe("ERR_NOT_FOUND");
    }
    const missing = await post("accounting.not_a_report");
    expect(missing.status).toBe(404);
    expect((await problemOf(missing)).code).toBe("ERR_NOT_FOUND");
    // Uppercase and camelCase: outside the grammar, so the only 400 this route gives for a code.
    const malformed = await post("Accounting.NotAReport");
    expect(malformed.status).toBe(400);
    expect((await problemOf(malformed)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
