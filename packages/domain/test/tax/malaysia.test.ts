import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src";
import {
  canonicalJson,
  MALAYSIA_REGIMES,
  malaysiaPack,
  SYNTH_MY_V1,
  type TaxRegime,
  type TaxTransactionRow,
} from "../../src/tax";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);
const REGIME: TaxRegime = {
  id: "r-1",
  code: "SYNTH-MY-v1",
  jurisdiction: "MY",
  version: 1,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};

const txn = (over: Partial<TaxTransactionRow>): TaxTransactionRow => ({
  documentId: "d-1",
  documentTypeCode: "SALES_INVOICE",
  lineNo: 1,
  taxCodeId: "c-1",
  taxCode: "SYN-OUT-STD",
  regimeId: "r-1",
  kind: "output",
  rate: "0.11000000",
  base: m("300.0000"),
  tax: m("33.0000"),
  baseBase: m("300.0000"),
  taxBase: m("33.0000"),
  effectiveDate: "2026-01-15",
  postingSeq: "1",
  ...over,
});

describe("malaysiaPack (§4.9.1, amendment A3)", () => {
  it("ships exactly ONE regime definition until OD-15 — and no published figure or name (hazard 1)", () => {
    expect(MALAYSIA_REGIMES).toEqual([SYNTH_MY_V1]);
    expect(SYNTH_MY_V1.code).toBe("SYNTH-MY-v1");
    expect(malaysiaPack.jurisdiction).toBe("MY");
    // No box label, box code or regime code may resemble a published Malaysian one (hazard 1, §2.6).
    const text = JSON.stringify(MALAYSIA_REGIMES);
    for (const forbidden of [
      "SST",
      "GST",
      "TX",
      "ZRL",
      "ES43",
      "MyInvois",
      "LHDN",
      "0.06",
      "0.08",
      "0.1000",
    ]) {
      expect(text, `${forbidden} must not appear in a shipped definition`).not.toContain(forbidden);
    }
  });

  it("the five synthetic boxes cover every kind exactly once per measure", () => {
    expect(SYNTH_MY_V1.boxes.map((b) => b.code)).toEqual(["S1", "S2", "S3", "P1", "P2"]);
    expect(SYNTH_MY_V1.boxes.map((b) => b.measure)).toEqual(["base", "tax", "base", "base", "tax"]);
  });

  it("buildReturn sums each box from the transactions and NOTHING else", () => {
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      // ⚠️ Every override sets the BASE-CURRENCY twins as well as the document-currency figures.
      // `buildReturnFrom` sums `baseBase` / `taxBase` — a return is filed in base currency — so overriding
      // only `base` / `tax` would leave the `txn()` defaults (300 / 33) in the columns the boxes actually
      // read, and every assertion below would be measuring the default rather than the case.
      transactions: [
        txn({}), // output 300 / 33
        txn({
          documentId: "d-2",
          base: m("100.0000"),
          tax: m("11.0000"),
          baseBase: m("100.0000"),
          taxBase: m("11.0000"),
        }), // output 100 / 11
        txn({
          documentId: "d-3",
          documentTypeCode: "SALES_CREDIT_NOTE",
          base: m("-50.0000"),
          tax: m("-5.5000"),
          baseBase: m("-50.0000"),
          taxBase: m("-5.5000"),
        }), // credit note, signed
        txn({
          documentId: "d-4",
          taxCode: "SYN-OUT-ZERO",
          taxCodeId: "c-2",
          kind: "zero",
          rate: "0.00000000",
          base: m("70.0000"),
          tax: m("0.0000"),
          baseBase: m("70.0000"),
          taxBase: m("0.0000"),
        }),
        txn({
          documentId: "d-5",
          documentTypeCode: "PURCHASE_INVOICE",
          taxCode: "SYN-IN-STD",
          taxCodeId: "c-3",
          kind: "input",
          base: m("200.0000"),
          tax: m("22.0000"),
          baseBase: m("200.0000"),
          taxBase: m("22.0000"),
        }),
      ],
    });
    const box = (c: string) => boxes.find((b) => b.code === c)!.amount.toString();
    expect(box("S1")).toBe("350.0000"); // 300 + 100 - 50 : output baseBase, signed
    expect(box("S2")).toBe("38.5000"); // 33 + 11 - 5.5   : output taxBase, signed
    expect(box("S3")).toBe("70.0000"); // zero-rated baseBase
    expect(box("P1")).toBe("200.0000");
    expect(box("P2")).toBe("22.0000");
  });

  // MON-04 (2026-11-15 full review). A zero-rated or exempt code declares no side; its fact takes the
  // document's. An exempt PURCHASE is not a supply, and S3 counted it by kind alone.
  it("a box sums facts of its own side: an exempt purchase is in no supplies box", () => {
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [
        txn({
          documentTypeCode: "PURCHASE_INVOICE",
          taxCode: "SYN-EXEMPT",
          kind: "exempt",
          side: "input",
          base: m("400.0000"),
          tax: m("0.0000"),
          baseBase: m("400.0000"),
          taxBase: m("0.0000"),
        }),
        txn({
          lineNo: 2,
          taxCode: "SYN-EXEMPT",
          kind: "exempt",
          side: "output",
          base: m("150.0000"),
          tax: m("0.0000"),
          baseBase: m("150.0000"),
          taxBase: m("0.0000"),
        }),
      ],
    });
    const by = Object.fromEntries(boxes.map((b) => [b.code, b.amount.toString()]));
    expect(by).toEqual({
      S1: "0.0000",
      S2: "0.0000",
      S3: "150.0000",
      P1: "0.0000",
      P2: "0.0000",
    });
  });

  it("the boxes read the BASE-currency twins, not the document-currency figures", () => {
    // The one case that separates them. A foreign-currency invoice carries `base`/`tax` in the document's
    // currency and `baseBase`/`taxBase` in the company's; a return is filed in the company's, so a box that
    // summed `base` would add EUR to MYR. Written as its own case because the case above sets the two pairs
    // equal on every row, which is exactly the shape that cannot tell them apart.
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [
        txn({
          base: m("100.0000"),
          tax: m("11.0000"),
          baseBase: m("470.0000"),
          taxBase: m("51.7000"),
        }),
      ],
    });
    expect(boxes.find((b) => b.code === "S1")!.amount.toString()).toBe("470.0000");
    expect(boxes.find((b) => b.code === "S2")!.amount.toString()).toBe("51.7000");
  });

  it("a box with no matching transaction is present and ZERO, never absent (SAH-011's shape)", () => {
    const { boxes } = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [],
    });
    expect(boxes).toHaveLength(5);
    for (const b of boxes) expect(b.amount.toString(), b.code).toBe("0.0000");
  });

  it("an empty period is filed in the currency the caller names, not MYR (PR 11 review, round 3)", () => {
    // `returnCurrency` read the currency off the first row and fell back to MYR, so an empty quarter of
    // a company whose base currency is not MYR carried `"currency":"MYR"` — a return in a currency the
    // company does not keep its books in. `generateTaxReturn` passes the company's base currency.
    const EUR = currency("EUR");
    const { boxes, payload } = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [],
      currency: EUR,
    });
    expect(JSON.parse(payload)).toMatchObject({ currency: "EUR" });
    for (const b of boxes) expect(b.amount.currency, b.code).toBe("EUR");
  });

  it("a transaction whose base currency is not the return's is refused, naming it", () => {
    expect(() =>
      malaysiaPack.buildReturn({
        regime: REGIME,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        transactions: [txn({})], // MYR base twins
        currency: currency("EUR"),
      }),
    ).toThrow(/ERR_TAX_REGIME_MISMATCH: document d-1 line 1 is in MYR, not the return's EUR/);
  });

  it("naming the currency the rows already carry changes no byte of the payload", () => {
    const input = {
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [txn({})],
    };
    expect(malaysiaPack.buildReturn({ ...input, currency: MYR }).payload).toBe(
      malaysiaPack.buildReturn(input).payload,
    );
  });

  it("the payload is canonical, carries the regime and the period, and is byte-identical across calls", () => {
    const input = {
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [txn({})],
    };
    const a = malaysiaPack.buildReturn(input);
    const b = malaysiaPack.buildReturn({ ...input, transactions: [txn({})] });
    expect(a.payload).toBe(b.payload);
    expect(a.payload).toContain('"regimeCode":"SYNTH-MY-v1"');
    expect(a.payload).toContain('"periodStart":"2026-01-01"');
    expect(a.payload.startsWith("{")).toBe(true);
    expect(a.payload).toBe(canonicalJson(JSON.parse(a.payload)));
  });

  it("transaction ORDER does not change the payload — a return is not a report of rows", () => {
    const one = txn({ documentId: "d-1" });
    const two = txn({ documentId: "d-2", base: m("100.0000"), tax: m("11.0000") });
    const fwd = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [one, two],
    });
    const rev = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [two, one],
    });
    expect(fwd.payload).toBe(rev.payload);
  });

  it("a transaction outside the period is REFUSED, not silently included (SAH-059)", () => {
    expect(() =>
      malaysiaPack.buildReturn({
        regime: REGIME,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        transactions: [txn({ effectiveDate: "2026-04-01" })],
      }),
    ).toThrow(
      /ERR_TAX_REGIME_MISMATCH: document d-1 line 1 is dated 2026-04-01, outside 2026-01-01\.\.2026-03-31/,
    );
  });

  it("a transaction of another regime is REFUSED (SAH-020, spec:2444's clause)", () => {
    expect(() =>
      malaysiaPack.buildReturn({
        regime: REGIME,
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        transactions: [txn({ regimeId: "r-OTHER" })],
      }),
    ).toThrow(/ERR_TAX_REGIME_MISMATCH: document d-1 line 1 carries regime r-OTHER/);
  });

  it("a regime the pack does not KNOW is a mismatch, not an empty return (amendment A3)", () => {
    expect(() =>
      malaysiaPack.buildReturn({
        regime: { ...REGIME, code: "SYNTH-MY-v9", version: 9 },
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        transactions: [],
      }),
    ).toThrow(/ERR_TAX_REGIME_MISMATCH: this pack has no definition for SYNTH-MY-v9 v9/);
  });

  it("validateReturn accepts what buildReturn produced and names what it refuses", () => {
    const { payload } = malaysiaPack.buildReturn({
      regime: REGIME,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      transactions: [txn({})],
    });
    expect(malaysiaPack.validateReturn(payload)).toEqual({ ok: true, errors: [] });
    expect(malaysiaPack.validateReturn("not json")).toMatchObject({ ok: false });
    const missing = JSON.parse(payload) as { boxes: unknown[] };
    missing.boxes = missing.boxes.slice(1);
    expect(malaysiaPack.validateReturn(JSON.stringify(missing))).toEqual({
      ok: false,
      errors: ["box S1 is missing"],
    });
    const bad = JSON.parse(payload) as { boxes: { code: string; amount: string }[] };
    bad.boxes[0]!.amount = "300";
    expect(malaysiaPack.validateReturn(JSON.stringify(bad))).toEqual({
      ok: false,
      errors: ['box S1 amount "300" is not a 4-dp figure'],
    });
  });
});
