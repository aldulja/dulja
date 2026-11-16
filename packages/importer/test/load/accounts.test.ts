import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACCOUNT_CODE_PATTERN,
  assertAccountMap,
  readAccountMap,
  treatmentOf,
  type AccountMap,
} from "../../src/load/account-map";
import { accountLoader, accountMap, clearAccountMap, setAccountMap } from "../../src/load/accounts";
import type { RefResolver } from "../../src/load/types";

const good: AccountMap = {
  generatedFrom: "artefacts/legacy/2026-01-31/scope.json",
  entries: [
    {
      legacyCode: "1101",
      code: "1000",
      nameEn: "Cash on hand",
      nameAr: "الصندوق",
      type: "asset",
      treatment: "balance",
      note: null,
    },
    {
      legacyCode: "1301",
      code: "1200",
      nameEn: "Trade receivables",
      nameAr: null,
      type: "asset",
      treatment: "ar_control",
      note: "open items supply this",
    },
    {
      legacyCode: "1401",
      code: "1300",
      nameEn: "Inventory",
      nameAr: null,
      type: "asset",
      treatment: "inventory_control",
      note: "OPENING_STOCK supplies this",
    },
    {
      legacyCode: "2101",
      code: "2100",
      nameEn: "Trade payables",
      nameAr: null,
      type: "liability",
      treatment: "ap_control",
      note: null,
    },
    {
      legacyCode: "9999",
      code: "5900",
      nameEn: "Suspense (legacy)",
      nameAr: null,
      type: "expense",
      treatment: "exclude",
      note: "reported, never loaded",
    },
  ],
};

const FIXTURE = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dulja-account-map-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  clearAccountMap();
});

const noRefs: RefResolver = { byLegacyRef: async () => null };

describe("the account map — the owner's mapping, validated, never inferred (9B plan N6)", () => {
  it("accepts a well-formed map and answers a treatment by legacy code", () => {
    const map = assertAccountMap(good, "test");
    expect(treatmentOf(map, "1301")).toBe("ar_control");
    expect(treatmentOf(map, "0000")).toBeNull();
  });

  it("refuses a Dulja code that is not §4.15's four-digit type-prefixed form, naming the legacy code", () => {
    expect(ACCOUNT_CODE_PATTERN.test("1200")).toBe(true);
    expect(ACCOUNT_CODE_PATTERN.test("0200")).toBe(false);
    const bad = {
      ...good,
      entries: [{ ...good.entries[0]!, code: "ABC" }, ...good.entries.slice(1)],
    };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy account 1101 maps to code "ABC", which is not \^\[1-5\]\[0-9\]\{3\}\$/,
    );
  });

  it("refuses a code whose first digit disagrees with its account type (§4.15's frozen rule)", () => {
    const bad = {
      ...good,
      entries: [{ ...good.entries[0]!, type: "income" as const }, ...good.entries.slice(1)],
    };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy account 1101 maps to 1000 but is typed income; code 1000 is an asset/,
    );
  });

  it("refuses two legacy codes mapping to one Dulja code with different names", () => {
    const bad = {
      ...good,
      entries: [...good.entries, { ...good.entries[0]!, legacyCode: "1102", nameEn: "Petty cash" }],
    };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy accounts 1101 and 1102 both map to 1000 with different names/,
    );
  });

  it("refuses two legacy codes mapping to one Dulja code with different treatments", () => {
    const bad = {
      ...good,
      entries: [...good.entries, { ...good.entries[1]!, legacyCode: "1302", treatment: "balance" }],
    };
    expect(() => assertAccountMap(bad, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: legacy accounts 1301 and 1302 both map to 1200 with different treatments \(ar_control, balance\)/,
    );
  });

  it("accepts two legacy codes mapping to one Dulja code with the SAME name — a legacy chart split by branch is normal", () => {
    const merged = {
      ...good,
      entries: [...good.entries, { ...good.entries[0]!, legacyCode: "1102" }],
    };
    expect(assertAccountMap(merged, "map.json").entries).toHaveLength(6);
  });

  it("refuses one legacy code listed twice", () => {
    const twice = { ...good, entries: [...good.entries, { ...good.entries[0]! }] };
    expect(() => assertAccountMap(twice, "map.json")).toThrow(
      /^ERR_VALIDATION_FAILED: map\.json: legacy account 1101 appears twice$/,
    );
  });

  it("needs an ar_control and an ap_control, each naming ONE Dulja account — the ageing tie-out has one control each (§4.8.2)", () => {
    const two = {
      ...good,
      entries: [...good.entries, { ...good.entries[1]!, legacyCode: "1302", code: "1200" }],
    };
    expect(assertAccountMap(two, "map.json").entries).toHaveLength(6); // same code, same name: fine
    const none = { ...good, entries: good.entries.filter((e) => e.treatment !== "ar_control") };
    expect(() => assertAccountMap(none, "map.json")).toThrow(
      /ERR_VALIDATION_FAILED: map\.json: no account is marked ar_control; the open-item load has no control to tie to/,
    );
    const split = {
      ...good,
      entries: [
        ...good.entries,
        {
          ...good.entries[3]!,
          legacyCode: "2102",
          code: "2200",
          nameEn: "Other payables",
        },
      ],
    };
    expect(() => assertAccountMap(split, "map.json")).toThrow(
      /^ERR_VALIDATION_FAILED: map\.json: ap_control is marked on 2100 and 2200; the ageing ties to ONE control account \(contracts §4\.8\.2\)$/,
    );
  });

  it("refuses an unknown treatment, a missing name, an empty map and a map that is not an object", () => {
    const bad = (patch: object) => ({
      ...good,
      entries: [{ ...good.entries[0]!, ...patch }, ...good.entries.slice(1)],
    });
    expect(() => assertAccountMap(bad({ treatment: "carry" }), "m")).toThrow(
      /legacy account 1101 has treatment "carry"; expected one of balance, ar_control, ap_control, inventory_control, exclude/,
    );
    expect(() => assertAccountMap(bad({ nameEn: "" }), "m")).toThrow(
      /legacy account 1101 has no nameEn/,
    );
    expect(() => assertAccountMap({ ...good, entries: [] }, "m")).toThrow(/entries is empty/);
    expect(() => assertAccountMap({ ...good, generatedFrom: "" }, "m")).toThrow(
      /generatedFrom must name the scope artefact/,
    );
    expect(() => assertAccountMap(null, "m")).toThrow(
      /^ERR_VALIDATION_FAILED: m: the map is not an object$/,
    );
  });

  it("reads the committed fixture, and refuses an unreadable or malformed file with a LoadError naming it", () => {
    expect(readAccountMap(FIXTURE).entries.map((e) => [e.legacyCode, e.code, e.treatment])).toEqual(
      [
        ["1101", "1000", "balance"],
        ["1301", "1200", "ar_control"],
        ["1401", "1300", "inventory_control"],
        ["2101", "2100", "ap_control"],
      ],
    );
    const missing = join(scratch, "absent.json");
    expect(() => readAccountMap(missing)).toThrow(
      /^ERR_VALIDATION_FAILED: .*absent\.json: the account map could not be read/,
    );
    const broken = join(scratch, "broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    expect(() => readAccountMap(broken)).toThrow(
      /^ERR_VALIDATION_FAILED: .*broken\.json: the account map is not JSON/,
    );
  });
});

/** One legacy `ACCOUNTS` row, ledger-flagged, with `over` applied. */
const accountRow = (over: Record<string, string | null> = {}) => ({
  ACCID: "100",
  ACCCODE: "1101",
  ACCNAME: "Cash on hand",
  ACCISCUSTOMER: "0",
  ACCISVENDOR: "0",
  ACCOPENBAL: "5000.0000",
  ...over,
});

describe("the account loader's map — a link, never an invented account", () => {
  it("refuses to run without the owner's map, rather than guessing one", () => {
    clearAccountMap();
    expect(() => accountMap()).toThrow(
      /^ERR_VALIDATION_FAILED: no account map has been set; pass --account-map <path>/,
    );
  });

  it("keys on ACCCODE, links a mapped code, and reports every other row with its reason", async () => {
    setAccountMap(assertAccountMap(good, "test"));
    expect(accountLoader.sourceKey(accountRow())).toBe("1101");
    expect(await accountLoader.map(accountRow(), noRefs)).toEqual({
      legacyKey: "100",
      legacyCode: "1101",
      code: "1000",
    });
    expect(await accountLoader.map(accountRow({ ACCCODE: "7777" }), noRefs)).toEqual({
      skip: "legacy account 7777 is not in the account map; add it with a treatment, or mark it exclude",
    });
    expect(await accountLoader.map(accountRow({ ACCCODE: "9999" }), noRefs)).toEqual({
      skip: "legacy account 9999 is mapped exclude; it is reported and not loaded",
    });
    expect(
      await accountLoader.map(accountRow({ ACCID: "200", ACCISCUSTOMER: "1" }), noRefs),
    ).toEqual({
      skip: "account 200 is a customer or vendor; the party loader takes it",
    });
  });

  it("links an account whose stored ACCOPENBAL is NULL — no amount is read from it (2026-11-15 review, HRP-21)", async () => {
    setAccountMap(assertAccountMap(good, "test"));
    expect(await accountLoader.map(accountRow({ ACCOPENBAL: null }), noRefs)).toEqual({
      legacyKey: "100",
      legacyCode: "1101",
      code: "1000",
    });
    expect(accountLoader.sourceColumns.map((c) => c.name)).not.toContain("ACCOPENBAL");
  });
});
