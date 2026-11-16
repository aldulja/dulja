import { describe, expect, it } from "vitest";
import { UNIT_RATE } from "../../src/money/exchange-rate";
import { Money, currency } from "../../src/money/money";
import type { DocumentSnapshot, LineSnapshot } from "../../src/posting/evaluate";
import { buildPrintModel, type PrintContext } from "../../src/print/model";

const MYR = currency("MYR");
const line = (
  lineNo: number,
  description: string,
  debit: string,
  credit: string,
): LineSnapshot => ({
  id: `line-${lineNo}`,
  lineNo,
  kind: "account",
  description,
  accountId: debit === "0.0000" ? "acc-sales" : "acc-cash",
  itemId: null,
  quantity: null,
  unitPrice: null,
  discount: Money.zero(MYR),
  amount: Money.zero(MYR),
  taxCodeId: null,
  taxAmount: Money.zero(MYR),
  totalInclTax: Money.zero(MYR),
  debit: Money.of(debit, MYR),
  credit: Money.of(credit, MYR),
  cost: null,
  warehouseId: null,
  toWarehouseId: null,
  lotId: null,
  unitId: null,
  unitQuantity: null,
  countedQuantity: null,
  expectedQuantity: null,
  tenderMethod: null,
  customFields: {},
  dimensions: {},
  payroll: null,
});

const snapshot: DocumentSnapshot = {
  header: {
    id: "doc-1",
    companyId: "co-1",
    documentTypeCode: "JOURNAL",
    status: "posted",
    series: "JV",
    fiscalPeriodId: "fp-1",
    number: 17n,
    effectiveDate: "2026-01-15",
    partyId: null,
    currency: MYR,
    exchangeRate: UNIT_RATE(MYR),
    branchId: "br-1",
    attributedTo: null,
    clientRef: null,
    warehouseId: null,
    toWarehouseId: null,
    taxInclusive: false,
    reversesDocumentId: null,
    customFields: {},
  },
  lines: [line(1, "Cash received", "150.0000", "0.0000"), line(2, "Sales", "0.0000", "150.0000")],
  company: { id: "co-1", baseCurrency: MYR, fxRoundingAccountId: "acc-fx", costingMethod: "avco" },
  party: null,
  refs: {
    accountsByCode: {},
    items: {},
    taxCodes: {},
    components: {},
    schemes: {},
    dimensionTypesByCode: {},
  },
};

const base: Omit<PrintContext, "lang"> = {
  companyName: "HQ Sdn Bhd",
  documentTypeNameEn: "Journal Voucher",
  documentTypeNameAr: "قيد يومية",
  partyName: null,
  notes: "opening entry",
  accountLabels: { "acc-cash": "1000 · Cash", "acc-sales": "4000 · Sales" },
  labels: { en: { total: "Total" }, ar: { total: "الإجمالي" } },
};

describe("buildPrintModel — pure, string-only, bilingual (spec:2253)", () => {
  it("renders the English model with left-to-right direction and the English type name", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "en" });
    expect(m).toMatchObject({
      lang: "en",
      dir: "ltr",
      rtl: false,
      labels: { total: "Total" },
      company: { name: "HQ Sdn Bhd", baseCurrency: "MYR" },
      totals: { debit: "150.0000", credit: "150.0000", lineCount: 2 },
    });
    expect(m.document).toMatchObject({
      typeCode: "JOURNAL",
      typeName: "Journal Voucher",
      series: "JV",
      number: "17",
      effectiveDate: "2026-01-15",
      currency: "MYR",
      exchangeRate: "1.00000000",
      notes: "opening entry",
    });
    expect(m.lines[0]).toEqual({
      lineNo: 1,
      description: "Cash received",
      account: "1000 · Cash",
      debit: "150.0000",
      credit: "0.0000",
      quantity: "",
      unitPrice: "",
      amount: "0.0000",
    });
  });

  it("renders the Arabic model right-to-left with the Arabic type name and label catalogue", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "ar" });
    expect(m.dir).toBe("rtl");
    expect(m.rtl).toBe(true);
    expect(m.document.typeName).toBe("قيد يومية");
    expect(m.labels["total"]).toBe("الإجمالي");
  });

  it("falls back to the English type name when name_ar is null — never an empty heading", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "ar", documentTypeNameAr: null });
    expect(m.document.typeName).toBe("Journal Voucher");
  });

  it("carries a Hijri rendering of the effective date alongside the Gregorian one (spec:2039)", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "ar" });
    expect(m.document.effectiveDate).toBe("2026-01-15");
    expect(m.document.effectiveDateHijri).not.toBe("");
    expect(m.document.effectiveDateHijri).not.toBe(m.document.effectiveDate);
  });

  it("never emits a number where money belongs — every amount is a fixed-scale string", () => {
    const m = buildPrintModel(snapshot, { ...base, lang: "en" });
    for (const v of [m.totals.debit, m.totals.credit, ...m.lines.map((l) => l.debit)]) {
      expect(typeof v).toBe("string");
      expect(v).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("is deterministic — two builds are structurally identical", () => {
    expect(buildPrintModel(snapshot, { ...base, lang: "en" })).toEqual(
      buildPrintModel(snapshot, { ...base, lang: "en" }),
    );
  });
});
