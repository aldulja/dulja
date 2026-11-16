import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  Money,
  currency,
  intlFormatters,
  renderReport,
  validateReportDefinition,
} from "@dulja/domain";
import { agedBalance, type AgedBalanceRow } from "../../src/reports/ageing";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B and 7C harnesses, reachable from packages/db/test/** through 3B's amendment A21(c).
import {
  arApReportFixture,
  paramsFor,
  readDefinition7C,
  readEnvelope7C,
  type ArApReportFixture,
} from "../../../../tests/invariants/support/reports-7c";
import {
  assertFieldCoverage,
  assertTieOut,
  runDefinition,
} from "../../../../tests/invariants/support/reports";

const MYR = currency("MYR");

/**
 * 7C Task 3 — the four AR/AP definitions (contracts §4.16.1; round 15, A6 and A8). `accounting.ageing` is 4B's
 * code re-expressed at definitionVersion 2: 4B's JSON route and its tie-out stand byte-for-byte (7B A2), and the
 * parity case below proves the definition's rows equal `agedBalance`'s figures bucket for bucket.
 */
describe("7C AR/AP definitions — contracts §4.16.1, amendments A6 and A8", () => {
  let db: Db;
  let f: ArApReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "7c-arap");
  }, 300_000);
  afterAll(async () => {
    await db?.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);

  const CODES = [
    "accounting.ageing",
    "accounting.party_statement",
    "accounting.allocation_register",
    "accounting.unreconciled_items",
  ] as const;

  it("all four validate against the live dataset and permission sets", async () => {
    const sets = await read((tx) => reportDefinitionSets(tx));
    for (const code of CODES) {
      const definition = readDefinition7C(code);
      const result = validateReportDefinition(definition, sets);
      expect(result.errors, code).toEqual([]);
      expect(result.ok, code).toBe(true);
      expect(definition.code, code).toBe(code);
    }
  });

  it("accounting.ageing is seeded at definitionVersion 2 — 4B owns version 1", () => {
    expect(readEnvelope7C("accounting.ageing").definitionVersion).toBe(2);
    for (const code of CODES.slice(1)) {
      expect(readEnvelope7C(code).definitionVersion, code).toBe(1);
    }
  });

  it("every field each definition names is a column its dataset serves", async () => {
    for (const code of CODES) {
      const definition = readDefinition7C(code);
      const rows = await read((tx) => runDefinition(tx, definition, paramsFor(code, f)));
      assertFieldCoverage(definition, rows);
    }
  });

  it("accounting.ageing ties to the party_ageing projection", async () => {
    const definition = readDefinition7C("accounting.ageing");
    await read((tx) =>
      assertTieOut(tx, definition, {
        params: paramsFor("accounting.ageing", f),
        baseCurrency: MYR,
        asOf: f.ageingAsOf,
      }),
    );
  });

  it("accounting.ageing PARITY: the definition's rows equal 4B's agedBalance figure for figure", async () => {
    const definition = readDefinition7C("accounting.ageing");
    const rows = await read((tx) =>
      runDefinition(tx, definition, paramsFor("accounting.ageing", f)),
    );
    const route = await read((tx) =>
      agedBalance(tx, { companyId: f.s.company, asOf: f.ageingAsOf, limit: 1000 }),
    );
    expect(route.length).toBeGreaterThan(0);
    // The definition's rows are one per (party, currency, bucket) with snake_case keys; the route's are one per
    // (party, currency) with the five buckets as camelCase members and ONE base total. The mapping is explicit —
    // never a key coercion (Global Constraint 10).
    const BUCKETS: readonly [string, keyof AgedBalanceRow][] = [
      ["current", "current"],
      ["1_30", "d1_30"],
      ["31_60", "d31_60"],
      ["61_90", "d61_90"],
      ["over_90", "over_90"],
    ];
    for (const r of route) {
      const mine = rows.filter((x) => x["party_id"] === r.partyId && x["currency"] === r.currency);
      expect(mine.length, `${r.partyCode} ${r.currency}`).toBeGreaterThan(0);
      for (const [bucket, member] of BUCKETS) {
        const row = mine.find((x) => x["bucket"] === bucket);
        const fromDefinition = Money.of(String(row?.["amount"] ?? "0.0000"), MYR);
        const fromRoute = Money.of(String(r[member]), MYR);
        expect(fromDefinition.toString(), `${r.partyCode} ${bucket}`).toBe(fromRoute.toString());
      }
      let base = Money.zero(MYR);
      for (const row of mine) base = base.add(Money.of(String(row["base_amount"]), MYR));
      expect(base.toString(), `${r.partyCode} base`).toBe(Money.of(r.totalBase, MYR).toString());
    }
    // And no (party, currency) the definition reports is one the route does not.
    for (const row of rows) {
      expect(
        route.some((r) => r.partyId === row["party_id"] && r.currency === row["currency"]),
        `${String(row["party_code"])} ${String(row["currency"])}`,
      ).toBe(true);
    }
  });

  // [7 remediation] — the definition sorted on `bucket`, whose TEXT order is 1_30, 31_60, 61_90, current,
  // over_90, so a party's current balance printed between its 61–90 and its over-90 days. It sorts on the
  // dataset's `bucket_rank` now: 4B's own vocabulary order (0048's CHECK), the order `agedBalance` reports in.
  it("accounting.ageing prints a party's buckets in 4B's order, current first, never by text", async () => {
    const ORDER = ["current", "1_30", "31_60", "61_90", "over_90"];
    const definition = readDefinition7C("accounting.ageing");
    expect(definition.sort.map((k) => k.field)).toEqual(["party_code", "currency", "bucket_rank"]);
    // The dataset's rank IS the vocabulary position, on every row the fixture's snapshot holds.
    const rows = await read((tx) =>
      runDefinition(tx, definition, paramsFor("accounting.ageing", f)),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row["bucket_rank"], String(row["bucket"])).toBe(ORDER.indexOf(String(row["bucket"])));
    }
    // And the render orders by it: one party's five buckets, handed over in text order.
    const party = {
      party_code: "C-1",
      party_name_en: "One",
      party_kind: "customer",
      currency: "MYR",
    };
    const textOrder = ORDER.toSorted().map((bucket) => ({
      ...party,
      bucket,
      bucket_rank: ORDER.indexOf(bucket),
      amount: "1.0000",
      base_amount: "1.0000",
    }));
    expect(textOrder.map((r) => r.bucket)).toEqual([
      "1_30",
      "31_60",
      "61_90",
      "current",
      "over_90",
    ]);
    const rendered = renderReport(definition, textOrder, {
      format: "csv",
      lang: "en",
      formatters: intlFormatters("en", { currency: "MYR" }),
      generatedAt: "2026-01-31T00:00:00Z",
    });
    expect(
      rendered.rows
        .filter((r) => r.kind === "data")
        .map((r) => r.cells.find((c) => c.field === "bucket")!.raw),
    ).toEqual(ORDER);
  });

  it("accounting.ageing's optional partyKind narrows the same rows and never invents any", async () => {
    const definition = readDefinition7C("accounting.ageing");
    const base = paramsFor("accounting.ageing", f);
    const all = await read((tx) => runDefinition(tx, definition, base));
    const customers = await read((tx) =>
      runDefinition(tx, definition, { ...base, partyKind: "customer" }),
    );
    const vendors = await read((tx) =>
      runDefinition(tx, definition, { ...base, partyKind: "vendor" }),
    );
    // "The filter selects, and never invents": each filtered run equals the unfiltered run restricted to that
    // kind — never a row count, and never `customers + vendors === all` (`app.party.kind` has five values).
    expect(customers).toEqual(all.filter((r) => r["party_kind"] === "customer"));
    expect(vendors).toEqual(all.filter((r) => r["party_kind"] === "vendor"));
    expect(customers.length).toBeGreaterThan(0); // the fixture's customer is open
  });

  it("accounting.party_statement ties Σ base_total to the ledger for one party", async () => {
    const definition = readDefinition7C("accounting.party_statement");
    const rows = await read((tx) =>
      runDefinition(tx, definition, paramsFor("accounting.party_statement", f)),
    );
    // The customer's invoice, credit note and receipt — and nothing of the vendor's.
    expect(rows.map((r) => r["document_id"]).toSorted()).toEqual(
      [f.invoiceId, f.creditNoteId, f.receiptId].toSorted(),
    );
    expect(rows.every((r) => r["party_id"] === f.customerId)).toBe(true);
    await read((tx) =>
      assertTieOut(tx, definition, {
        params: paramsFor("accounting.party_statement", f),
        baseCurrency: MYR,
        window: { partyId: f.customerId, fromDate: "2026-01-01", toDate: "2026-01-31" },
      }),
    );
  });

  it("accounting.allocation_register ties Σ base_amount to app.allocation", async () => {
    const definition = readDefinition7C("accounting.allocation_register");
    const rows = await read((tx) =>
      runDefinition(tx, definition, paramsFor("accounting.allocation_register", f)),
    );
    expect(rows.map((r) => r["allocation_id"])).toContain(f.allocationId);
    await read((tx) =>
      assertTieOut(tx, definition, {
        params: paramsFor("accounting.allocation_register", f),
        baseCurrency: MYR,
      }),
    );
  });

  it("accounting.unreconciled_items returns the open line, not the matched one", async () => {
    const definition = readDefinition7C("accounting.unreconciled_items");
    const params = paramsFor("accounting.unreconciled_items", f);
    const rows = await read((tx) => runDefinition(tx, definition, params));
    expect(rows.map((r) => r["line_id"])).toEqual([f.openLineId]);
    expect(rows[0]!["is_matched"]).toBe(false);
    expect(rows[0]!["amount"]).toBe("250.0000");
    await read((tx) => assertTieOut(tx, definition, { params, baseCurrency: MYR }));
    // `isMatched: "true"` is the reconciled half — the receipt's line (7A's boolean bind, A16 item 12).
    const matched = await read((tx) =>
      runDefinition(tx, definition, { ...params, isMatched: "true" }),
    );
    expect(matched.map((r) => r["line_id"])).toEqual([f.matchedLineId]);
    await read((tx) =>
      assertTieOut(tx, definition, { params: { ...params, isMatched: "true" }, baseCurrency: MYR }),
    );
  });

  it("every definition is gated by a code that exists in app.permission", async () => {
    const sets = await read((tx) => reportDefinitionSets(tx));
    for (const code of CODES) {
      expect(sets.permissions.has(readDefinition7C(code).permission), code).toBe(true);
    }
    expect(readDefinition7C("accounting.unreconciled_items").permission).toBe(
      "accounting.bank.reconcile",
    );
  });
});
