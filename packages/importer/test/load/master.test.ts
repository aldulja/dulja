import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { withTenant } from "@dulja/db";
import { seedBranch, startDb, type Db, type Seed } from "@dulja/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import { assertAccountMap, readAccountMap } from "../../src/load/account-map";
import { clearAccountMap, setAccountMap } from "../../src/load/accounts";
import { loaders } from "../../src/load/registry";
import { runLoad, setLoadSource } from "../../src/load/run";
import { clearKeyRing, setKeyRing } from "../../src/load/employees";
import type { LoadContext, LoadReport } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING } from "../support/tenant";

let db: Db;
let s: Seed;
let first: LoadReport;
const runs: string[] = [];
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));

function newRun(): string {
  const id = randomUUID();
  runs.push(id);
  return id;
}

function useCorpus(corpus: LegacyCorpus): void {
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(corpus);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  });
}

/** The cut-over corpus with one table's rows replaced. */
function withTable(table: string, rows: readonly LegacyRow[]): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  return { ...corpus, tables: { ...corpus.tables, [table]: { ...corpus.tables[table]!, rows } } };
}

const ctxFor = (seed: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> =>
  loadContextFor(db, seed, over.runId ?? newRun(), over);

const read = <T>(seed: Seed, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  withTenant(db.rw, { tenantId: seed.tenant, actorId: seed.human, requestId: randomUUID() }, fn);

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "master");
  setAccountMap(readAccountMap(MAP));
  setKeyRing(TEST_KEY_RING);
  useCorpus(loadCorpus("cut-over"));
  first = await runLoad(db.rw, await ctxFor(s));
}, 240_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("the registry after Task 4 — six master loaders, in an order that is itself topological", () => {
  it("registers units, warehouses, accounts, parties, items and lots, each on its own target table", () => {
    // Task 5 on add the document loaders among them, and Task 8 the employee master and its YTD opening
    // (registry.test.ts pins the whole list and its order).
    const master = loaders.filter(
      (l) =>
        ![
          "opening_balance",
          "open_item",
          "opening_stock",
          "employee",
          "employee_ytd_opening",
        ].includes(l.targetTable),
    );
    expect(master.map((l) => [l.targetTable, l.sourceTable, l.dependsOn])).toEqual([
      ["unit_of_measure", "UNITS", []],
      ["warehouse", "WAREHOUSES", []],
      ["account", "ACCOUNTS", []],
      ["party", "ACCOUNTS", []],
      ["item", "MATERIALS", ["unit_of_measure"]],
      ["lot", "MATBATCHES", ["item"]],
    ]);
    // Every column is a hypothesis until OD-17 reads the live catalogue (hazard 3, 9B Task 14).
    for (const loader of master)
      for (const column of loader.sourceColumns) expect(column.confidence).toBe("hypothesis");
  });
});

describe("the master-data loaders (contracts §4.13.2, §5.1 #3, #8)", () => {
  it("loads units through createUnit with their legacy key recorded in import_batch", async () => {
    const rows = await read(
      s,
      (tx) => tx<{ code: string; name_en: string; name_ar: string | null }[]>`
        select code, name_en, name_ar from app.unit_of_measure where company_id = ${s.company} order by code`,
    );
    expect(rows.map((r) => r.code)).toEqual(["CARTON", "KILOGRAM", "PIECE"]);
    expect(rows.find((r) => r.code === "PIECE")).toEqual({
      code: "PIECE",
      name_en: "Piece",
      name_ar: "قطعة",
    });
    const keys = await read(
      s,
      (tx) => tx<{ source_key: string }[]>`
        select source_key from app.import_batch
         where source_table = 'UNITS' and target_table = 'unit_of_measure' order by source_key`,
    );
    expect(keys.map((k) => k.source_key)).toEqual(["1", "2", "3"]);
    expect(first.perLoader["unit_of_measure"]).toEqual({ inserted: 3, skipped: 0, conflicts: 0 });
  });

  it("loads warehouses as kind 'stock' in the company's head-office BRANCH — the importer creates no branch", async () => {
    // Read as the owner: `warehouse`'s branch-scoped read (§4.5.6 Form A″) shows a principal only its branches'.
    const rows = await db.admin<
      { code: string; kind: string; branch_id: string; name_en: string }[]
    >`
      select code, kind, branch_id, name_en from app.warehouse where company_id = ${s.company} order by code`;
    // `codeFromName` upper-cases and replaces each run of non-alphanumerics with one `-`: the free-text "Main store"
    // and "Shop 1" become MAIN-STORE and SHOP-1, and name_en keeps the original verbatim.
    expect(rows.map((r) => [r.code, r.name_en])).toEqual([
      ["MAIN-STORE", "Main store"],
      ["SHOP-1", "Shop 1"],
    ]);
    expect(rows.every((r) => r.kind === "stock")).toBe(true);
    expect(rows.every((r) => r.branch_id === s.hq)).toBe(true);
  });

  it("loads items with legacy_ref, track_lots from the source flag, and all FOUR §4.6.1 account defaults", async () => {
    const rows = await read(
      s,
      (tx) => tx<
        {
          code: string;
          kind: string;
          legacy_ref: string | null;
          track_lots: boolean;
          unit: string;
          revenue: string | null;
          inventory: string | null;
          cogs: string | null;
          expense: string | null;
        }[]
      >`
        select i.code, i.kind, i.legacy_ref, i.track_lots, u.code as unit,
               r.code as revenue, v.code as inventory, g.code as cogs, x.code as expense
          from app.item i
          join app.unit_of_measure u on u.id = i.base_unit_id
          left join app.account r on r.id = i.revenue_account_id
          left join app.account v on v.id = i.inventory_account_id
          left join app.account g on g.id = i.cogs_account_id
          left join app.account x on x.id = i.expense_account_id
         where i.company_id = ${s.company} order by i.code`,
    );
    expect(rows).toEqual([
      {
        code: "DELIVERY",
        kind: "service",
        legacy_ref: "DELIVERY",
        track_lots: false,
        unit: "PIECE",
        revenue: "4000",
        inventory: null,
        cogs: null,
        expense: "5900",
      },
      {
        code: "GADGET",
        kind: "product",
        legacy_ref: "GADGET",
        track_lots: false,
        unit: "CARTON",
        revenue: "4000",
        inventory: "1300",
        cogs: "5000",
        expense: "5900",
      },
      {
        code: "WIDGET",
        kind: "product",
        legacy_ref: "WIDGET",
        track_lots: true,
        unit: "PIECE",
        revenue: "4000",
        inventory: "1300",
        cogs: "5000",
        expense: "5900",
      },
    ]);
  });

  it("loads a batch as a lot with its expiry, and skips a batch whose material is missing (§5.1 #3 — orphans are reported)", async () => {
    const lots = await read(
      s,
      (tx) => tx<
        { code: string; legacy_ref: string; expires_on: string | null; made: string | null }[]
      >`
        select l.code, l.legacy_ref, l.expires_on::text as expires_on, l.manufactured_on::text as made
          from app.lot l join app.item i on i.id = l.item_id
         where i.company_id = ${s.company} and l.legacy_ref is not null order by l.code`,
    );
    expect(lots).toEqual([
      { code: "B-2401", legacy_ref: "B-2401", expires_on: "2027-03-31", made: "2024-04-01" },
    ]);
    const orphan = {
      loader: "lot",
      sourceTable: "MATBATCHES",
      sourceKey: "9001",
      reason: "material 999 has no imported item; the batch is an orphan (LEGACY-073)",
    };
    expect(first.skips.filter((k) => k.loader === "lot")).toEqual([orphan]);
    // A map skip is not recorded, so the orphan is reported again on every run until the source is corrected.
    const again = await runLoad(db.rw, await ctxFor(s));
    expect(again.skips.filter((k) => k.loader === "lot")).toEqual([orphan]);
  });

  it("splits the legacy Accounts table into parties and accounts by its own IsCustomer/IsVendor flags", async () => {
    const parties = await read(
      s,
      (tx) => tx<
        {
          code: string;
          kind: string;
          legacy_ref: string;
          name_ar: string | null;
          tax_registration: string | null;
        }[]
      >`
        select code, kind, legacy_ref, name_ar, tax_registration
          from app.party where company_id = ${s.company} and kind <> 'employee' order by code`,
    );
    // legacy_ref is the human ACCCODE on both party and account; the import_batch key of a party is `ACC:<ACCID>`
    // (Task 7 resolves Bills.BilAcc through it), of an account the bare ACCCODE (Task 5 resolves AccTotals through it).
    expect(parties).toEqual([
      {
        code: "C-2001",
        kind: "customer",
        legacy_ref: "2001",
        name_ar: "ألفا للتجارة",
        tax_registration: "TX-2001",
      },
      {
        code: "V-3001",
        kind: "vendor",
        legacy_ref: "3001",
        name_ar: null,
        tax_registration: "TX-3001",
      },
    ]);
    const accounts = await read(
      s,
      (tx) => tx<{ code: string; legacy_ref: string }[]>`
        select code, legacy_ref from app.account
         where company_id = ${s.company} and legacy_ref is not null order by code`,
    );
    expect(accounts).toEqual([
      { code: "1000", legacy_ref: "1101" },
      { code: "1200", legacy_ref: "1301" },
      { code: "1300", legacy_ref: "1401" },
      { code: "2100", legacy_ref: "2101" },
    ]);
    const keys = await read(
      s,
      (tx) => tx<{ source_key: string; target_table: string }[]>`
        select source_key, target_table from app.import_batch
         where source_table = 'ACCOUNTS' order by target_table, source_key`,
    );
    expect(keys.map((k) => `${k.target_table}:${k.source_key}`)).toEqual([
      "account:1101",
      "account:1301",
      "account:1401",
      "account:2101",
      "party:ACC:200",
      "party:ACC:300",
    ]);
  });

  it("gives every imported party the §4.15 control accounts and never a null one (hazard 33)", async () => {
    const rows = await read(
      s,
      (tx) => tx<{ code: string; receivable: string | null; payable: string | null }[]>`
        select p.code, r.code as receivable, y.code as payable
          from app.party p
          left join app.account r on r.id = p.receivable_account_id
          left join app.account y on y.id = p.payable_account_id
         where p.company_id = ${s.company} and p.kind <> 'employee' order by p.code`,
    );
    // The party loader's customers and vendors; an employee's party (Task 8) ages on neither control.
    expect(rows).toEqual([
      { code: "C-2001", receivable: "1200", payable: null },
      { code: "V-3001", receivable: null, payable: "2100" },
    ]);
  });

  it("re-running the same load inserts nothing: every key is a silent skip", async () => {
    const report = await runLoad(db.rw, await ctxFor(s));
    for (const table of ["unit_of_measure", "warehouse", "account", "party", "item", "lot"])
      expect(report.perLoader[table]!.inserted, table).toBe(0);
    const [n] = await read(
      s,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.item where company_id = ${s.company}`,
    );
    expect(n!.n).toBe(3);
  });

  it("writes every imported row as the tenant's system principal, audited", async () => {
    const [audit] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where tenant_id = ${s.tenant} and table_name = 'item' and action = 'insert' and actor_id = ${s.system}`;
    expect(audit!.n).toBe(3);
  });
});

describe("what the master loaders refuse, report or keep apart", () => {
  it("links an account whose unused ACCOPENBAL is NULL, so its AccTotals balance opens (2026-11-15 review, HRP-21)", async () => {
    const fresh = await seedLoadableTenant(db, "master-legacy007");
    const rows = loadCorpus("cut-over").tables["ACCOUNTS"]!.rows.map((r) =>
      r["ACCCODE"] === "1101" ? { ...r, ACCOPENBAL: null } : r,
    );
    useCorpus(withTable("ACCOUNTS", rows));
    try {
      const report = await runLoad(db.rw, await ctxFor(fresh, { only: ["account"] }));
      expect(report.skips.filter((k) => k.sourceKey === "1101")).toEqual([]);
      const [linked] = await db.admin<{ code: string }[]>`
        select code from app.account where company_id = ${fresh.company} and legacy_ref = '1101'`;
      expect(linked?.code).toBe("1000");
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("keeps two legacy rows whose names give one code apart, and reuses a row a person already created", async () => {
    const fresh = await seedLoadableTenant(db, "master-codes");
    // A unit a person created through the API before the load: the load adopts it rather than duplicating it.
    await read(
      fresh,
      (tx) => tx`
      insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
      values (app.current_tenant(), ${fresh.company}, 'PIECE', 'Piece (by hand)')`,
    );
    const corpus = withTable("WAREHOUSES", [
      { WARID: "1", WARNAME: "Main store", WARNOTE: null },
      { WARID: "2", WARNAME: "MAIN  STORE", WARNOTE: null },
    ]);
    useCorpus(corpus);
    try {
      const report = await runLoad(
        db.rw,
        await ctxFor(fresh, { only: ["unit_of_measure", "warehouse"] }),
      );
      expect(report.perLoader["unit_of_measure"]).toEqual({
        inserted: 2,
        skipped: 1,
        conflicts: 0,
      });
      const warehouses = await db.admin<{ code: string; name_en: string; key: string }[]>`
        select w.code, w.name_en, b.source_key as key
          from app.warehouse w join app.import_batch b on b.target_id = w.id
         where w.company_id = ${fresh.company} order by w.code`;
      // Two legacy warehouses never become one Dulja warehouse: the second takes its legacy key as a suffix.
      expect(warehouses).toEqual([
        { code: "MAIN-STORE", name_en: "Main store", key: "1" },
        { code: "MAIN-STORE-2", name_en: "MAIN  STORE", key: "2" },
      ]);
      const [piece] = await read(
        fresh,
        (tx) => tx<{ name_en: string; mapped: boolean }[]>`
          select u.name_en, exists (select 1 from app.import_batch b where b.target_id = u.id) as mapped
            from app.unit_of_measure u where u.company_id = ${fresh.company} and u.code = 'PIECE'`,
      );
      expect(piece).toEqual({ name_en: "Piece (by hand)", mapped: true });
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses to adopt a hand-made item or warehouse whose unit, kind, lot tracking or branch differs (2026-11-15 review, HRP-13)", async () => {
    const fresh = await seedLoadableTenant(db, "master-adopt-shape");
    useCorpus(loadCorpus("cut-over"));
    await runLoad(db.rw, await ctxFor(fresh, { only: ["unit_of_measure"] }));
    // A person made WIDGET in cartons before the load; the legacy material counts it in pieces (MATUNIT 1).
    await read(
      fresh,
      (tx) => tx`
        insert into app.item (tenant_id, company_id, code, name_en, kind, base_unit_id, track_lots)
        select app.current_tenant(), ${fresh.company}, 'WIDGET', 'Widget (by hand)', 'product', id, true
          from app.unit_of_measure where company_id = ${fresh.company} and code = 'CARTON'`,
    );
    await expect(runLoad(db.rw, await ctxFor(fresh, { only: ["item"] }))).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: item: legacy 10 would adopt the existing WIDGET, which a person made, but its base unit is CARTON and the legacy material's is PIECE/,
    );
    // Corrected to the legacy unit, it is adopted as before.
    await read(
      fresh,
      (tx) => tx`
        update app.item set base_unit_id = (select id from app.unit_of_measure
                                             where company_id = ${fresh.company} and code = 'PIECE')
         where company_id = ${fresh.company} and code = 'WIDGET'`,
    );
    const items = await runLoad(db.rw, await ctxFor(fresh, { only: ["item"] }));
    expect(items.perLoader["item"]).toMatchObject({ inserted: 2, skipped: 1 });

    // A warehouse a person made in another branch: the import would land MAIN-STORE in the head office.
    const b2 = await seedBranch(db, fresh, { code: "B2" });
    await withTenant(
      db.rw,
      { tenantId: fresh.tenant, actorId: fresh.system, requestId: randomUUID() },
      (tx) => tx`
        insert into app.warehouse (tenant_id, company_id, code, name_en, kind, branch_id)
        values (app.current_tenant(), ${fresh.company}, 'MAIN-STORE', 'Main store (B2)', 'stock', ${b2})`,
    );
    await expect(runLoad(db.rw, await ctxFor(fresh, { only: ["warehouse"] }))).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: warehouse: legacy \d+ would adopt the existing MAIN-STORE, which a person made, but it belongs to a branch other than the head office/,
    );
  });

  it("never maps a legacy batch onto the item's sentinel lot (ADR 0034)", async () => {
    const fresh = await seedLoadableTenant(db, "master-sentinel");
    useCorpus(
      withTable("MATBATCHES", [
        { BATID: "9002", BATMAT: "10", BATCODE: "NONE", BATEXPIRY: null, BATMFG: null },
      ]),
    );
    try {
      const report = await runLoad(
        db.rw,
        await ctxFor(fresh, { only: ["unit_of_measure", "item", "lot"] }),
      );
      expect(report.skips.filter((k) => k.loader === "lot")).toEqual([
        {
          loader: "lot",
          sourceTable: "MATBATCHES",
          sourceKey: "9002",
          reason:
            "batch 9002 is coded NONE, the code Dulja reserves for every item's sentinel lot (ADR 0034); rename the batch in the source",
        },
      ]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("refuses a map that sends a legacy account to a Dulja account the company does not have, or to a group", async () => {
    const fresh = await seedLoadableTenant(db, "master-unseeded");
    const base = readAccountMap(MAP);
    const map = (code: string, type: "asset" | "liability") =>
      assertAccountMap(
        {
          ...base,
          entries: base.entries.map((e) =>
            e.legacyCode === "1101" ? { ...e, code, type, nameEn: "Mapped" } : e,
          ),
        },
        "test",
      );
    const only = { only: ["account"] };
    try {
      setAccountMap(map("1100", "asset"));
      await expect(runLoad(db.rw, await ctxFor(fresh, only))).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: the account map sends legacy 1101 to Dulja account 1100, which company \S+ does not have; seed it/,
      );
      await read(
        fresh,
        (tx) => tx`
        insert into app.account (tenant_id, company_id, code, name_en, type, is_group)
        values (app.current_tenant(), ${fresh.company}, '2410', 'Statutory payable', 'liability', true)`,
      );
      setAccountMap(map("2410", "liability"));
      await expect(runLoad(db.rw, await ctxFor(fresh, only))).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: the account map sends legacy 1101 to Dulja account 2410, which is a group account; a balance cannot post to it/,
      );
    } finally {
      setAccountMap(readAccountMap(MAP));
    }
  });
});
