import { IMPORT_LOADER_WRITE_CODES, importWriteCodes, unmappedImportTargets } from "@dulja/db";
import { describe, expect, it } from "vitest";
import { loaderFor, loaders, orderLoaders } from "../../src/load/registry";
import type { Loader } from "../../src/load/types";
import { NEVER_READ } from "../../src/snapshot";
// After the registry (9B T6's import-order note): a loader module imported first would build `loaders` half-bound.
import { mposLoader } from "../../src/load/mpos";

const loader = (targetTable: string, dependsOn: string[] = []): Loader<unknown, unknown> => ({
  sourceTable: "UNITS",
  targetTable,
  dependsOn,
  sourceColumns: [{ name: "UNTID", required: true, confidence: "hypothesis", note: "key" }],
  sourceKey: () => "1",
  map: (r) => r,
  load: async () => ({ inserted: 0, skipped: 0, batchIds: [] }),
});

const names = (list: readonly Loader<unknown, unknown>[]): string[] =>
  list.map((l) => l.targetTable);

describe("IMPORT_LOADER_WRITE_CODES — what a requester must hold for each loader (9B review, finding 4)", () => {
  it("has exactly one row per registered loader (packages/db's gates test checks each code is catalogued)", () => {
    // A loader registered without its row would be gated by nothing; the worker also refuses such a run.
    expect(Object.keys(IMPORT_LOADER_WRITE_CODES).toSorted()).toEqual(names(loaders).toSorted());
    expect(unmappedImportTargets(names(loaders))).toEqual([]);
  });

  it("asks the openings' posting codes and the employee master's sealed-field codes, never admin.company.manage alone", () => {
    expect(importWriteCodes(["opening_balance"])).toEqual(["accounting.journal.post"]);
    expect(importWriteCodes(["opening_stock"])).toEqual(["inventory.receipt.post"]);
    expect(importWriteCodes(["employee"])).toEqual([
      "hr.compensation.manage",
      "hr.employee.manage",
      "hr.employee.read_sensitive",
    ]);
    expect(importWriteCodes(null)).toEqual(
      [...new Set(Object.values(IMPORT_LOADER_WRITE_CODES).flat())].toSorted(),
    );
    expect(importWriteCodes(null)).not.toContain("admin.company.manage");
  });
});

describe("the loader registry — §4.13.2's `loaders`, ordered by `dependsOn`", () => {
  it("holds Task 4's six master loaders, Task 5's opening, Task 6's opening stock, Task 7's open items and Task 8's employees, in an order that is itself topological", () => {
    expect(names(loaders)).toEqual([
      "unit_of_measure",
      "warehouse",
      "account",
      "party",
      "employee",
      "item",
      "opening_balance",
      "open_item",
      "employee_ytd_opening",
      "lot",
      "opening_stock",
    ]);
    expect(names(orderLoaders(loaders))).toEqual(names(loaders));
    expect(loaderFor("item").sourceTable).toBe("MATERIALS");
    expect(loaderFor("opening_balance").sourceTable).toBe("ACCTOTALS");
    expect(loaderFor("opening_stock").sourceTable).toBe("BILLITEMS");
    expect(loaderFor("open_item").sourceTable).toBe("BILLS");
    expect(loaderFor("employee").sourceTable).toBe("EMPLOYEES");
    expect(loaderFor("employee_ytd_opening").sourceTable).toBe("EMPLOYEES");
    // 9B T13 — OD-16: the historical POS loader is written and exported, never registered (default: start clean).
    expect(loaders).not.toContain(mposLoader);
    expect(() => loaderFor("pos_ticket")).toThrow(
      "ERR_VALIDATION_FAILED: no loader for target table pos_ticket; registered: unit_of_measure, warehouse, account, party, employee, item, opening_balance, open_item, employee_ytd_opening, lot, opening_stock",
    );
  });

  it("orders dependencies first and is stable among loaders that are ready together", () => {
    expect(names(orderLoaders([loader("a", ["b"]), loader("b")]))).toEqual(["b", "a"]);
    expect(
      names(
        orderLoaders([
          loader("item", ["unit_of_measure"]),
          loader("unit_of_measure"),
          loader("warehouse"),
          loader("lot", ["item", "warehouse"]),
        ]),
      ),
    ).toEqual(["unit_of_measure", "warehouse", "item", "lot"]);
  });

  it("ignores a dependency outside the selection — an `only` run relies on the earlier run that loaded it", () => {
    expect(names(orderLoaders([loader("lot", ["item"])]))).toEqual(["lot"]);
  });

  it("raises on a cycle rather than looping, naming every member left", () => {
    expect(() => orderLoaders([loader("x", ["y"]), loader("y", ["x"]), loader("z")])).toThrow(
      /loader dependency cycle: x, y$/,
    );
  });

  it("refuses two loaders with one target table — the target is a loader's identity", () => {
    expect(() => orderLoaders([loader("item"), loader("item")])).toThrow(/two loaders target item/);
  });
});

// 9B T12 — ⚠️ OD-26 (Part VII #4). The default — a forced reset, never an import — holds whatever the answer: Dulja's
// identity is Supabase with MFA, so there is no password column to migrate a credential into. The SAH-028 `— 9B`
// block in `tests/regression/` proves the registry half through the barrel; this case is the half that needs 9A's
// `NEVER_READ`, which the barrel does not re-export (contracts round 20 C16 item 13), so it is asked inside the package.
describe("no legacy credential is read or imported (OD-26, SAH-028)", () => {
  it("keeps 9A's NEVER_READ deny-list intact, and no loader declares a column it lists", () => {
    // Upper case, both members, as Firebird stores identifiers and 9A ships the set.
    expect([...NEVER_READ].toSorted()).toEqual(["USERS.PASSWORD", "USERS.PIN"]);
    const declared = loaders.flatMap((l) =>
      l.sourceColumns.map((c) => [l.sourceTable, c.name].join(".")),
    );
    expect(declared.filter((pair) => NEVER_READ.has(pair))).toEqual([]);
    expect(loaders.map((l) => l.sourceTable)).not.toContain("USERS");
  });
});
