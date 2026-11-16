import { describe, expect, it } from "vitest";
import { evaluatePredicate, predicateColumns } from "../src/legacy/predicate";
import { quoteIdent, renderCount, renderMinMax, renderSelect } from "../src/drivers/sql";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import type { LegacyColumn } from "../src/legacy/types";
import { loadCorpus } from "./support/corpus";

const COLUMNS: LegacyColumn[] = [
  { name: "SITE", kind: "integer", scale: 0, nullable: false },
  { name: "ID", kind: "integer", scale: 0, nullable: false },
  { name: "DEBIT", kind: "decimal", scale: 4, nullable: true },
  { name: "EXCHANGE", kind: "float", scale: 0, nullable: true },
  { name: "DATE", kind: "date", scale: 0, nullable: true },
  { name: "NOTE", kind: "text", scale: 0, nullable: true },
];

describe("renderSelect — the only producer of statement text in this package (ADR 0082)", () => {
  it("casts every non-text column so no money or date ever arrives as a JavaScript number or Date", () => {
    const r = renderSelect(
      { table: "VOUITEMS", columns: ["ID", "DEBIT", "EXCHANGE", "DATE", "NOTE"] },
      COLUMNS,
    );
    expect(r.text).toBe(
      'select cast("ID" as varchar(20)) as "ID", cast("DEBIT" as varchar(40)) as "DEBIT",' +
        ' cast("EXCHANGE" as varchar(40)) as "EXCHANGE", cast("DATE" as varchar(24)) as "DATE", "NOTE" as "NOTE"' +
        ' from "VOUITEMS"',
    );
    expect(r.params).toEqual([]);
  });

  it("binds every value as a parameter and never as text", () => {
    const r = renderSelect(
      {
        table: "VOUITEMS",
        columns: ["ID"],
        orderBy: ["SITE", "ID"],
        where: {
          op: "and",
          operands: [
            { op: "eq", column: "SITE", value: "1" },
            {
              op: "or",
              operands: [
                { op: "in", column: "ID", values: ["7", "9"] },
                { op: "is_null", column: "NOTE" },
              ],
            },
            { op: "between", column: "DATE", from: "2024-01-01", to: "2024-12-31" },
          ],
        },
      },
      COLUMNS,
    );
    expect(r.text).toBe(
      'select cast("ID" as varchar(20)) as "ID" from "VOUITEMS"' +
        ' where ("SITE" = ? and ("ID" in (?, ?) or "NOTE" is null) and "DATE" between ? and ?)' +
        ' order by "SITE", "ID"',
    );
    expect(r.params).toEqual(["1", "7", "9", "2024-01-01", "2024-12-31"]);
  });

  it("a hostile value is a parameter and never reaches the text", () => {
    const hostile = "1'; delete from VOUITEMS; --";
    const r = renderCount("VOUITEMS", COLUMNS, { op: "ne", column: "NOTE", value: hostile });
    expect(r.text).toBe(
      'select cast(count(*) as varchar(20)) as "N" from "VOUITEMS" where "NOTE" <> ?',
    );
    expect(r.params).toEqual([hostile]);
  });

  it("renders count and min/max on the native column, casting only the result", () => {
    expect(renderCount("VOUITEMS", COLUMNS).text).toBe(
      'select cast(count(*) as varchar(20)) as "N" from "VOUITEMS"',
    );
    expect(renderMinMax("VOUITEMS", "DATE", COLUMNS).text).toBe(
      'select cast(min("DATE") as varchar(24)) as "MIN_V", cast(max("DATE") as varchar(24)) as "MAX_V" from "VOUITEMS"',
    );
  });

  it("every shape it can produce starts with `select` — the reader is read-only by construction", () => {
    const shapes = [
      renderSelect({ table: "VOUITEMS", columns: [] }, COLUMNS),
      renderCount("VOUITEMS", COLUMNS, { op: "is_not_null", column: "NOTE" }),
      renderMinMax("VOUITEMS", "ID", COLUMNS),
    ];
    for (const s of shapes) expect(s.text.startsWith("select ")).toBe(true);
  });

  it("refuses an identifier at the shape gate and, separately, at the membership gate", () => {
    // `quoteIdent` runs before the declared-column lookup, and its two gates raise different messages.
    // `DROP TABLE` contains a space, so it never reaches the membership test: the shape test rejects it.
    expect(() => renderSelect({ table: "VOUITEMS", columns: ["DROP TABLE"] }, COLUMNS)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: identifier DROP TABLE is not a bare Firebird identifier/,
    );
    // A well-formed name that is not a column of this table fails the membership test instead.
    expect(() => renderSelect({ table: "VOUITEMS", columns: ["NOSUCH"] }, COLUMNS)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: identifier NOSUCH is not a declared column or table of this source/,
    );
    // The table's own name passes both gates and is still not a column, which is `projection`'s own message.
    expect(() => renderSelect({ table: "VOUITEMS", columns: ["VOUITEMS"] }, COLUMNS)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: identifier VOUITEMS is not a declared column of VOUITEMS/,
    );
    // The same two gates guard a predicate's column and an order-by key.
    expect(() =>
      renderCount("VOUITEMS", COLUMNS, { op: "eq", column: 'ID" or 1=1 --', value: "1" }),
    ).toThrow(/ERR_IMPORT_SOURCE_UNREADABLE: identifier .* is not a bare Firebird identifier/);
    expect(() =>
      renderSelect({ table: "VOUITEMS", columns: ["ID"], orderBy: ["NOSUCH"] }, COLUMNS),
    ).toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
    expect(() => quoteIdent('X" or 1=1 --', new Set(["X"]))).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE/,
    );
    expect(quoteIdent("VOUITEMS", new Set(["VOUITEMS"]))).toBe('"VOUITEMS"');
  });

  it("refuses an empty boolean or an empty in-list rather than rendering a statement with no meaning", () => {
    expect(() => renderCount("VOUITEMS", COLUMNS, { op: "and", operands: [] })).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: an empty and predicate has no meaning/,
    );
    expect(() => renderCount("VOUITEMS", COLUMNS, { op: "in", column: "ID", values: [] })).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: an empty in-list on ID has no meaning/,
    );
  });
});

describe("evaluatePredicate — the fixture driver's structural evaluation of the same predicate", () => {
  const row = { SITE: "1", ID: "7", NOTE: null, DATE: "2024-06-01" };

  it("agrees with the SQL semantics of every operator", () => {
    expect(evaluatePredicate(row, { op: "eq", column: "SITE", value: "1" })).toBe(true);
    expect(evaluatePredicate(row, { op: "ne", column: "SITE", value: "1" })).toBe(false);
    expect(evaluatePredicate(row, { op: "in", column: "ID", values: ["7", "9"] })).toBe(true);
    expect(evaluatePredicate(row, { op: "is_null", column: "NOTE" })).toBe(true);
    expect(evaluatePredicate(row, { op: "is_not_null", column: "NOTE" })).toBe(false);
    expect(
      evaluatePredicate(row, {
        op: "between",
        column: "DATE",
        from: "2024-01-01",
        to: "2024-12-31",
      }),
    ).toBe(true);
    expect(evaluatePredicate(row, { op: "gt", column: "DATE", value: "2024-12-31" })).toBe(false);
    expect(evaluatePredicate(row, { op: "lte", column: "DATE", value: "2024-06-01" })).toBe(true);
    expect(
      evaluatePredicate(row, {
        op: "and",
        operands: [
          { op: "eq", column: "SITE", value: "1" },
          { op: "is_null", column: "NOTE" },
        ],
      }),
    ).toBe(true);
    expect(
      evaluatePredicate(row, {
        op: "or",
        operands: [
          { op: "eq", column: "SITE", value: "2" },
          { op: "is_null", column: "NOTE" },
        ],
      }),
    ).toBe(true);
  });

  it("treats a comparison against NULL as unknown, exactly as SQL does", () => {
    expect(evaluatePredicate(row, { op: "eq", column: "NOTE", value: "x" })).toBe(false);
    expect(evaluatePredicate(row, { op: "ne", column: "NOTE", value: "x" })).toBe(false);
    expect(evaluatePredicate(row, { op: "eq", column: "SITE", value: null })).toBe(false);
    expect(evaluatePredicate(row, { op: "in", column: "NOTE", values: [null] })).toBe(false);
  });

  it("names every column a predicate touches, so the driver can validate them", () => {
    expect(
      predicateColumns({
        op: "and",
        operands: [
          { op: "eq", column: "SITE", value: "1" },
          {
            op: "or",
            operands: [
              { op: "is_null", column: "NOTE" },
              { op: "eq", column: "SITE", value: "2" },
            ],
          },
        ],
      }),
    ).toEqual(["SITE", "NOTE"]);
  });

  it("filters the fixture corpus, validating every column the predicate names", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    expect(await driver.count("VOUITEMS", { op: "eq", column: "ID", value: "2" })).toBe(2);
    expect(await driver.count("VOUITEMS", { op: "is_null", column: "COSTCENTRE" })).toBe(4);
    await expect(
      driver.count("VOUITEMS", { op: "eq", column: "NOSUCH", value: "1" }),
    ).rejects.toThrow(/ERR_IMPORT_SOURCE_UNREADABLE: column VOUITEMS.NOSUCH is not in the corpus/);
  });
});
