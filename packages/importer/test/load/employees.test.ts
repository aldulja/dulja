import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import {
  checkEmployeeYtdProjection,
  createEmployee,
  listEmployeeYtdOpening,
  readSensitive,
  sourceHashOf,
  upsertEmployeeYtdOpening,
  withTenant,
  ytdFromEmployeeYtd,
} from "@dulja/db";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { currency, Money } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { clearAccountMap, setAccountMap } from "../../src/load/accounts";
// The registry BEFORE the loader module (9B T6's note): a loader imports `./run` and `./refs`, which import the
// registry, so importing a loader module first would build `loaders` with that loader still unset.
import { loaders } from "../../src/load/registry";
import {
  clearKeyRing,
  employeeLoader,
  employeeYtdOpeningLoader,
  SENSITIVE_SOURCES,
  setKeyRing,
} from "../../src/load/employees";
import { runLoad, setLoadSource } from "../../src/load/run";
import type { LoadContext, LoadReport } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING as RING } from "../support/tenant";

let db: Db;
let s: Seed;
let first: LoadReport;
let firstRun: string;
const runs: string[] = [];
const MYR = currency("MYR");
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));
// Every figure and identifier in the corpus is invented and is nobody's.
const ONLY_HR = ["employee", "employee_ytd_opening"];

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

/** The cut-over corpus with one table's rows replaced (or the table removed). */
function withTable(table: string, rows: readonly LegacyRow[] | null): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  const tables = { ...corpus.tables };
  if (rows === null) delete tables[table];
  else tables[table] = { ...tables[table]!, rows: [...rows] };
  return { ...corpus, tables };
}

const EMPLOYEES = (): readonly LegacyRow[] => loadCorpus("cut-over").tables["EMPLOYEES"]!.rows;
const PAYITEMS = (): readonly LegacyRow[] => loadCorpus("cut-over").tables["PAYITEMS"]!.rows;

const ctxFor = (seed: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> =>
  loadContextFor(db, seed, over.runId ?? newRun(), over);

/** Read as the tenant's system principal: `employee` is branch-isolated, `employee_sensitive` is behind the RESTRICTIVE
 *  `sensitive_gate`, and the seed's human holds no role in the company. */
const read = <T>(seed: Seed, fn: (tx: Sql) => Promise<T>): Promise<T> =>
  withTenant(db.rw, { tenantId: seed.tenant, actorId: seed.system, requestId: randomUUID() }, fn);

const ownTenant = (name: string): Promise<Seed> =>
  seedLoadableTenant(db, `${name}-${randomUUID().slice(0, 8)}`);

const people = (seed: Seed) =>
  read(
    seed,
    (tx) => tx<
      {
        employee_number: string;
        party_kind: string;
        party_code: string;
        legacy_ref: string | null;
        home: string;
        terminated_on: string | null;
        principal_id: string | null;
      }[]
    >`
      select e.employee_number, p.kind as party_kind, p.code as party_code, e.legacy_ref, v.code as home,
             to_char(e.terminated_on, 'YYYY-MM-DD') as terminated_on, e.principal_id
        from app.employee e join app.party p on p.id = e.party_id
        join app.dimension_value v on v.id = e.home_branch_id
       where e.company_id = ${seed.company} order by e.employee_number`,
  );

const openings = (seed: Seed) =>
  read(seed, (tx) => listEmployeeYtdOpening(tx, { companyId: seed.company, year: 2026 }));

const employeeId = async (seed: Seed, number: string): Promise<string> =>
  (
    await read(
      seed,
      (tx) => tx<{ id: string }[]>`
        select id::text as id from app.employee where company_id = ${seed.company} and employee_number = ${number}`,
    )
  )[0]!.id;

beforeAll(async () => {
  db = await startDb();
  s = await seedLoadableTenant(db, "employees");
  setAccountMap(readAccountMap(MAP));
  setKeyRing(RING);
  useCorpus(loadCorpus("cut-over"));
  firstRun = newRun();
  first = await runLoad(db.rw, await ctxFor(s, { runId: firstRun }));
}, 300_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("the employee loaders' shape (9B plan N10)", () => {
  it("are two loaders over EMPLOYEES with disjoint keys: the master first, its YTD opening after it", () => {
    expect(loaders.map((l) => l.targetTable)).toEqual(
      expect.arrayContaining(["employee", "employee_ytd_opening"]),
    );
    expect(employeeLoader.sourceTable).toBe("EMPLOYEES");
    expect(employeeLoader.dependsOn).toEqual([]);
    expect(employeeLoader.wholeTable).toBeUndefined();
    expect(employeeLoader.sourceKey({ EMPID: " 5001 " })).toBe("5001");
    expect(employeeYtdOpeningLoader.sourceTable).toBe("EMPLOYEES");
    expect(employeeYtdOpeningLoader.dependsOn).toEqual(["employee"]);
    expect(employeeYtdOpeningLoader.sourceKey({ EMPID: "5001" })).toBe("YTD:5001");
    expect(employeeLoader.sourceColumns.map((c) => c.name)).toEqual([
      "EMPID",
      "EMPNUMBER",
      "EMPNAME",
      "EMPNAMEAR",
      "EMPHIRED",
      "EMPLEFT",
      "EMPNATID",
      "EMPDOB",
      "EMPBANKACC",
      "EMPEPFNO",
      "EMPSOCSONO",
      "EMPTAXNO",
    ]);
    // The YTD figures are the opening loader's: the employee's own hash carries no pay figure.
    expect(employeeYtdOpeningLoader.sourceColumns.map((c) => c.name)).toEqual([
      "EMPID",
      "EMPYTDGROSS",
      "EMPYTDNET",
    ]);
    expect(
      [...employeeLoader.sourceColumns, ...employeeYtdOpeningLoader.sourceColumns].every(
        (c) => c.confidence === "hypothesis",
      ),
    ).toBe(true);
  });

  it("keys the sensitive map by 8A's own field names, and marks every one sensitive", () => {
    expect(Object.keys(SENSITIVE_SOURCES)).toEqual([
      "national_id",
      "date_of_birth",
      "bank_account",
      "epf_number",
      "socso_number",
      "tax_number",
    ]);
    expect(Object.values(SENSITIVE_SOURCES).every((c) => c.sensitive === true && !c.required)).toBe(
      true,
    );
    const sensitive = employeeLoader.sourceColumns.filter((c) => c.sensitive).map((c) => c.name);
    expect(sensitive).toEqual(Object.values(SENSITIVE_SOURCES).map((c) => c.name));
  });
});

describe("the employee load (§5.1 #11, #12)", () => {
  it("creates one party of kind employee and one employee per HR row, in HQ, and no Accounts row becomes a person (§5.1 #12)", async () => {
    expect(await people(s)).toEqual([
      {
        employee_number: "E-001",
        party_kind: "employee",
        party_code: "E-001",
        legacy_ref: "E-001",
        home: "HQ",
        terminated_on: null,
        principal_id: null,
      },
      {
        employee_number: "E-002",
        party_kind: "employee",
        party_code: "E-002",
        legacy_ref: "E-002",
        home: "HQ",
        terminated_on: "2026-01-20",
        principal_id: null,
      },
    ]);
    const kinds = await read(
      s,
      (tx) => tx<{ kind: string; n: number }[]>`
        select kind::text as kind, count(*)::int as n from app.party
         where company_id = ${s.company} group by kind order by kind`,
    );
    expect(kinds).toEqual([
      { kind: "customer", n: 1 },
      { kind: "employee", n: 2 },
      { kind: "vendor", n: 1 },
    ]);
    expect(first.perLoader["employee"]).toEqual({ inserted: 2, skipped: 0, conflicts: 0 });
    expect(first.perLoader["employee_ytd_opening"]).toEqual({
      inserted: 2,
      skipped: 0,
      conflicts: 0,
    });
    expect(first.skips.filter((k) => k.sourceTable === "EMPLOYEES")).toEqual([]);
  });

  it("writes sensitive fields ONLY through 8A's encrypted writer — sealed, readable with the ring, never plain", async () => {
    const rows = await read(
      s,
      (tx) => tx<{ national_id_enc: Buffer | null; key_version: number }[]>`
        select s.national_id_enc, s.key_version from app.employee_sensitive s
          join app.employee e on e.id = s.employee_id
         where e.company_id = ${s.company} order by e.employee_number`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.key_version === 1 && r.national_id_enc !== null)).toBe(true);
    expect(rows[0]!.national_id_enc!.toString("latin1")).not.toContain("880101");
    const opened = await read(s, async (tx) =>
      readSensitive(tx, RING, await employeeId(s, "E-001")),
    );
    expect(opened!.values).toEqual({
      national_id: "880101-14-5555",
      passport: null,
      date_of_birth: "1988-01-01",
      residency_category: null,
      bank_account: "1234567890",
      epf_number: "EPF-0001",
      socso_number: "SOC-0001",
      tax_number: "SG-0001",
      work_permit_expiry: null,
    });
  });

  it("records each employee in import_batch with a hash that carries a sensitive value as presence only (acceptance test 32)", async () => {
    const [batch] = await read(
      s,
      (tx) => tx<{ target_table: string; source_hash: string }[]>`
        select target_table, source_hash from app.import_batch
         where company_id = ${s.company} and source_table = 'EMPLOYEES' and source_key = '5001'`,
    );
    expect(batch!.target_table).toBe("employee");
    const row = EMPLOYEES()[0]!;
    const sealed = new Set(Object.values(SENSITIVE_SOURCES).map((c) => c.name));
    const hashOf = (redact: boolean): string =>
      sourceHashOf(
        Object.fromEntries(
          employeeLoader.sourceColumns.map((c) => {
            const v = row[c.name] ?? null;
            return [c.name, redact && sealed.has(c.name) && v !== null ? "[sensitive]" : v];
          }),
        ),
      );
    expect(batch!.source_hash).toBe(hashOf(true));
    expect(batch!.source_hash).not.toBe(hashOf(false));
  });

  it("records each YTD opening with a hash that carries its pay figures as presence only (9B review, finding 6)", async () => {
    // A plain sha256 of {EMPID, gross, net} sits in import_batch behind tenant RLS alone and is brute-forced from a
    // salary range in seconds; the pay figures are sealed in the persisted digest exactly as the national id is.
    const pay = employeeYtdOpeningLoader.sourceColumns.filter((c) => c.name !== "EMPID");
    expect(pay.map((c) => [c.name, c.sensitive])).toEqual([
      ["EMPYTDGROSS", true],
      ["EMPYTDNET", true],
    ]);
    const [batch] = await read(
      s,
      (tx) => tx<{ source_hash: string }[]>`
        select source_hash from app.import_batch
         where company_id = ${s.company} and source_table = 'EMPLOYEES' and source_key = 'YTD:5001'`,
    );
    const row = EMPLOYEES()[0]!;
    expect(batch!.source_hash).toBe(
      sourceHashOf({ EMPID: "5001", EMPYTDGROSS: "[sensitive]", EMPYTDNET: "[sensitive]" }),
    );
    expect(batch!.source_hash).not.toBe(
      sourceHashOf({ EMPID: "5001", EMPYTDGROSS: row["EMPYTDGROSS"], EMPYTDNET: row["EMPYTDNET"] }),
    );
  });

  it("loads employee_ytd_opening for the cut-over date's tax year, provenance legacy:<run> (§3.10.1 Year-to-date)", async () => {
    const rows = await openings(s);
    expect(rows.map((o) => `${o.employeeNumber}:${o.year}:${o.gross}:${o.net}`)).toEqual([
      "E-001:2026:36000.0000:31200.0000",
      "E-002:2026:24000.0000:21600.0000",
    ]);
    expect(rows.every((o) => o.source === `legacy:${firstRun}` && o.loadedBy === s.system)).toBe(
      true,
    );
    expect(rows.every((o) => Object.keys(o.byComponent).length === 0)).toBe(true);
    expect(rows.every((o) => Object.keys(o.byScheme).length === 0)).toBe(true);
    const [batch] = await read(
      s,
      (tx) => tx<{ target_table: string; target_id: string }[]>`
        select target_table, target_id::text as target_id from app.import_batch
         where company_id = ${s.company} and source_table = 'EMPLOYEES' and source_key = 'YTD:5001'`,
    );
    expect(batch).toEqual({ target_table: "employee_ytd_opening", target_id: rows[0]!.id });
  });

  it("leaves employee_ytd itself untouched — the opening is a read-time addend, never a projection row (round 18 B14; acceptance test 35, re-run)", async () => {
    expect(await read(s, (tx) => checkEmployeeYtdProjection(tx))).toEqual([]);
    const [projected] = await read(
      s,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.employee_ytd where company_id = ${s.company}`,
    );
    expect(projected!.n).toBe(0);
    const id = await employeeId(s, "E-001");
    const ytd = await read(s, (tx) => ytdFromEmployeeYtd(tx, s.company, 2026, [id]));
    expect(ytd[id]!["gross"]!.toString()).toBe("36000.0000");
    expect(ytd[id]!["net"]!.toString()).toBe("31200.0000");
  });

  /**
   * **What this proves, and what it deliberately does not.** It proves the import path REACHES 8C's termination trigger:
   * the employee is created active and its `terminated_on` set by an UPDATE (the audit trail holds that update), the
   * only shape that fires an `AFTER UPDATE OF terminated_on` trigger, and spec:2090 names the Phase 9 importer as
   * something that must not bypass it. It does NOT re-prove the trigger's effects — the revoked `pos_cashier`, the
   * expired `role_assignment`, the tombstone — because an imported employee has none of the rows they act on: the load
   * sets no `principal_id` and creates no cashier. An assertion over them would read the same whether or not the trigger
   * ran, so none is written; acceptance test 34's downstream half is 8C's own suite.
   */
  it("terminates by UPDATE, so 8C's AFTER UPDATE OF terminated_on trigger fires on the import path (acceptance test 34, re-run — trigger reached)", async () => {
    const id = await employeeId(s, "E-002");
    const audit = await read(
      s,
      (tx) => tx<{ action: string; before: string | null; after: string | null }[]>`
        select action, before ->> 'terminated_on' as before, after ->> 'terminated_on' as after
          from app.audit_log where table_name = 'employee' and row_id = ${id} order by seq`,
    );
    expect(audit).toEqual([
      { action: "insert", before: null, after: null },
      { action: "update", before: null, after: "2026-01-20" },
    ]);
    // Termination is not deletion (spec:2049): the leaver is still there, with their sealed fields.
    expect(await read(s, (tx) => readSensitive(tx, RING, id))).not.toBeNull();
  });

  it("is idempotent: a second run of the same source records and writes nothing", async () => {
    const before = await people(s);
    const report = await runLoad(db.rw, await ctxFor(s, { only: ONLY_HR }));
    expect(report.perLoader["employee"]).toEqual({ inserted: 0, skipped: 2, conflicts: 0 });
    expect(report.perLoader["employee_ytd_opening"]).toEqual({
      inserted: 0,
      skipped: 2,
      conflicts: 0,
    });
    expect(await people(s)).toEqual(before);
    expect((await openings(s)).every((o) => o.source === `legacy:${firstRun}`)).toBe(true);
  });
});

describe("§5.1 #11 — an opening that does not reconcile to the employee's own payslips", () => {
  const DRIFT =
    "employee 5001's stored YTD gross does not equal the sum of their 2026 payslips (PAYITEMS); the employee is loaded and their YTD opening is NOT — reconcile it with the customer and re-run (--only employee_ytd_opening) (§5.1 #11). The figures are pay data and are not printed; compare them in the legacy payroll";
  const drifted = (): LegacyCorpus =>
    withTable(
      "PAYITEMS",
      PAYITEMS().map((r) => (r["PITEMP"] === "5001" ? { ...r, PITGROSS: "35000.0000" } : r)),
    );

  it("loads the employee, withholds the opening, reports why without a figure — and loads it once the source is corrected", async () => {
    const own = await ownTenant("employees-ytd-drift");
    useCorpus(drifted());
    try {
      const report = await runLoad(db.rw, await ctxFor(own, { only: ONLY_HR }));
      expect(report.skips).toEqual([
        {
          loader: "employee_ytd_opening",
          sourceTable: "EMPLOYEES",
          sourceKey: "YTD:5001",
          reason: DRIFT,
        },
      ]);
      for (const figure of ["36000", "35000", "1000.0000"])
        expect(JSON.stringify(report.skips)).not.toContain(figure);
      expect((await openings(own)).map((o) => o.employeeNumber)).toEqual(["E-002"]);
      expect((await people(own)).map((p) => p.employee_number)).toEqual(["E-001", "E-002"]);

      // The withheld opening was reported, NOT recorded — so the corrected source loads it.
      useCorpus(loadCorpus("cut-over"));
      const again = await runLoad(db.rw, await ctxFor(own, { only: ONLY_HR }));
      expect(again.skips).toEqual([]);
      expect(again.perLoader["employee_ytd_opening"]).toEqual({
        inserted: 1,
        skipped: 1,
        conflicts: 0,
      });
      expect((await openings(own)).map((o) => `${o.employeeNumber}:${o.gross}`)).toEqual([
        "E-001:36000.0000",
        "E-002:24000.0000",
      ]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("checks net as well as gross, and a dry run on an empty tenant still reports the drift", async () => {
    const own = await ownTenant("employees-ytd-dry");
    useCorpus(
      withTable(
        "PAYITEMS",
        PAYITEMS().map((r) => (r["PITEMP"] === "5002" ? { ...r, PITNET: "21599.9900" } : r)),
      ),
    );
    try {
      const report = await runLoad(db.rw, await ctxFor(own, { only: ONLY_HR, dryRun: true }));
      expect(report.skips.map((k) => [k.sourceKey, k.reason])).toEqual([
        [
          "YTD:5001",
          "employee 5001 was not loaded, so their YTD opening cannot be (a dry run loads no employee; otherwise the employee loader's own report says why)",
        ],
        ["YTD:5002", DRIFT.replace("5001", "5002").replace("YTD gross", "YTD net")],
      ]);
      expect(await people(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("withholds an opening it cannot reconcile at all — no PAYITEMS, no figures, half a figure — and never reads a NULL as zero", async () => {
    const own = await ownTenant("employees-ytd-absent");
    useCorpus(withTable("PAYITEMS", null));
    try {
      const report = await runLoad(db.rw, await ctxFor(own, { only: ONLY_HR }));
      expect(report.skips.map((k) => k.reason)).toEqual([
        "employee 5001's YTD cannot be reconciled: the source has no PAYITEMS table, so their YTD opening is NOT loaded (§5.1 #11) — an unreconciled figure is never loaded",
        "employee 5002's YTD cannot be reconciled: the source has no PAYITEMS table, so their YTD opening is NOT loaded (§5.1 #11) — an unreconciled figure is never loaded",
      ]);
      expect(await openings(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }

    const own2 = await ownTenant("employees-ytd-null");
    const [a, b] = EMPLOYEES();
    useCorpus(
      withTable("EMPLOYEES", [
        { ...a!, EMPYTDGROSS: null, EMPYTDNET: null },
        { ...b!, EMPYTDNET: null },
      ]),
    );
    try {
      const report = await runLoad(db.rw, await ctxFor(own2, { only: ONLY_HR }));
      expect(report.skips.map((k) => k.reason)).toEqual([
        "employee 5001 carries no current-tax-year YTD (EMPYTDGROSS and EMPYTDNET are NULL or absent), so no opening is loaded — a NULL is never read as zero (§5.1 #11, LEGACY-007)",
        "employee 5002 carries EMPYTDGROSS without EMPYTDNET; a half opening is not loaded — a NULL is never read as zero (§5.1 #11, LEGACY-007)",
      ]);
      expect((await people(own2)).map((p) => p.employee_number)).toEqual(["E-001", "E-002"]);
      expect(await openings(own2)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("leaves an opening a load did not write as it is (8C's manual:<reason> form)", async () => {
    const own = await ownTenant("employees-ytd-manual");
    useCorpus(loadCorpus("cut-over"));
    await runLoad(db.rw, await ctxFor(own, { only: ["employee"] }));
    const id = await employeeId(own, "E-001");
    await read(own, (tx) =>
      upsertEmployeeYtdOpening(
        tx,
        { tenantId: own.tenant, actorId: own.system, requestId: randomUUID() },
        {
          companyId: own.company,
          employeeId: id,
          year: 2026,
          gross: Money.of("100.0000", MYR),
          net: Money.of("90.0000", MYR),
          byComponent: {},
          byScheme: {},
          source: "manual:entered before cut-over",
        },
      ),
    );
    const runId = newRun();
    const report = await runLoad(
      db.rw,
      await ctxFor(own, { runId, only: ["employee_ytd_opening"] }),
    );
    expect(report.skips.map((k) => k.reason)).toEqual([
      "employee 5001 already has a 2026 opening (source manual:entered before cut-over); the load left it as it is",
    ]);
    expect((await openings(own)).map((o) => `${o.employeeNumber}:${o.gross}:${o.source}`)).toEqual([
      "E-001:100.0000:manual:entered before cut-over",
      `E-002:24000.0000:legacy:${runId}`,
    ]);
  });
});

describe("the employee master's edges", () => {
  it("refuses the load without a key ring, before anything of the page is written", async () => {
    const own = await ownTenant("employees-no-ring");
    clearKeyRing();
    try {
      await expect(runLoad(db.rw, await ctxFor(own, { only: ["employee"] }))).rejects.toThrow(
        "ERR_VALIDATION_FAILED: no HR key ring is set; HR_FIELD_ENCRYPTION_KEY must be present",
      );
      expect(await people(own)).toEqual([]);
    } finally {
      setKeyRing(RING);
    }
  });

  it("refuses a malformed sensitive or pay value naming the row and the column, and never the value", async () => {
    const [a] = EMPLOYEES();
    // Strings, not regex literals: `dependency-rule`'s scanner stalls on some regex literals (9B T6's note).
    const cases: [string, LegacyRow, string, string][] = [
      [
        "natid",
        { ...a!, EMPNATID: `X${"9".repeat(120)}` },
        "ERR_VALIDATION_FAILED: EMPLOYEES/5001: EMPNATID is longer than 120 characters; it is a sensitive field (§4.12.5) and is not printed",
        "9".repeat(120),
      ],
      [
        "dob",
        { ...a!, EMPDOB: "01/01/1988" },
        "ERR_VALIDATION_FAILED: EMPLOYEES/5001: EMPDOB is not a YYYY-MM-DD date; it is a sensitive field (§4.12.5) and is not printed",
        "01/01/1988",
      ],
      [
        "gross",
        { ...a!, EMPYTDGROSS: "36,000.00" },
        "ERR_VALIDATION_FAILED: EMPLOYEES/5001: EMPYTDGROSS is not a decimal numeric(19,4) can hold; it is a pay figure and is not printed — read it in the legacy payroll",
        "36,000",
      ],
    ];
    for (const [name, row, message, value] of cases) {
      const own = await ownTenant(`employees-bad-${name}`);
      useCorpus(withTable("EMPLOYEES", [row]));
      const runId = newRun();
      try {
        const error = await runLoad(db.rw, await ctxFor(own, { runId, only: ONLY_HR })).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(error?.message).toBe(message);
        expect(error?.message).not.toContain(value);
        const artefact = join("artefacts", "legacy", runId, "load-failed.json");
        expect(existsSync(artefact)).toBe(true);
        expect(readFileSync(artefact, "utf8")).not.toContain(value);
      } finally {
        useCorpus(loadCorpus("cut-over"));
      }
    }
  });

  it("reports an employee who left before they were hired, and loads the rest", async () => {
    const own = await ownTenant("employees-dates");
    const [a, b] = EMPLOYEES();
    useCorpus(withTable("EMPLOYEES", [a!, { ...b!, EMPLEFT: "2020-01-01" }]));
    try {
      const report = await runLoad(db.rw, await ctxFor(own, { only: ["employee"] }));
      expect(report.skips.map((k) => k.reason)).toEqual([
        "employee 5002 left on 2020-01-01, before they were hired on 2021-07-15; correct the source — the loader will not guess which date is wrong",
      ]);
      expect((await people(own)).map((p) => p.employee_number)).toEqual(["E-001"]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("adopts an employee a person created with the same payroll number, writes none of its fields, and still opens its YTD", async () => {
    const own = await ownTenant("employees-adopt");
    const hq = await read(
      own,
      (tx) => tx<{ id: string }[]>`
        select v.id::text as id from app.dimension_value v join app.dimension_type t on t.id = v.dimension_type_id
         where t.company_id = ${own.company} and t.code = 'BRANCH' and v.code = 'HQ'`,
    );
    const made = await read(own, (tx) =>
      createEmployee(tx, own.company, {
        employeeNumber: "E-001",
        nameEn: "Aisyah (cashier)",
        homeBranchId: hq[0]!.id,
        hiredOn: "2019-03-01",
      }),
    );
    useCorpus(loadCorpus("cut-over"));
    const report = await runLoad(db.rw, await ctxFor(own, { only: ONLY_HR }));
    expect(report.perLoader["employee"]).toEqual({ inserted: 1, skipped: 1, conflicts: 0 });
    expect(report.skips.map((k) => k.reason)).toEqual([
      "employee 5001's payroll number E-001 already exists in Dulja (created by hand), so the load adopted that employee and wrote none of its fields; HR enters its sensitive fields and any termination",
    ]);
    expect(await employeeId(own, "E-001")).toBe(made.id);
    expect((await people(own))[0]!.legacy_ref).toBeNull();
    expect(await read(own, (tx) => readSensitive(tx, RING, made.id))).toBeNull();
    expect((await openings(own)).map((o) => [o.employeeId === made.id, o.gross])).toEqual([
      [true, "36000.0000"],
      [false, "24000.0000"],
    ]);
  });

  it("moves the employee party to <number>-<EMPID> when another party holds the payroll number as its code", async () => {
    const own = await ownTenant("employees-party-code");
    await read(
      own,
      (tx) => tx`
        insert into app.party (tenant_id, company_id, kind, code, name_en)
        values (app.current_tenant(), ${own.company}, 'customer', 'E-002', 'A customer coded E-002')`,
    );
    useCorpus(loadCorpus("cut-over"));
    await runLoad(db.rw, await ctxFor(own, { only: ["employee"] }));
    expect((await people(own)).map((p) => [p.employee_number, p.party_code])).toEqual([
      ["E-001", "E-001"],
      ["E-002", "E-002-5002"],
    ]);
  });

  it("refuses two legacy employees with one payroll number — a payroll number identifies one person", async () => {
    const own = await ownTenant("employees-dup-number");
    const [a, b] = EMPLOYEES();
    useCorpus(withTable("EMPLOYEES", [a!, { ...b!, EMPNUMBER: "E-001" }]));
    try {
      await expect(runLoad(db.rw, await ctxFor(own, { only: ["employee"] }))).rejects.toThrow(
        "ERR_VALIDATION_FAILED: employee 5002 carries payroll number E-001, which another legacy employee already became; a payroll number identifies one person — correct the source",
      );
      expect(await people(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });
});

// 9B T15 — ⚠️ OD-27, Part VII #13 ("is the legacy Salaries module in live use?"). Unanswered, the plan runs Task 8 and
// reports what it finds; an EMPTY `EMPLOYEES` is the "not in use" outcome reached by evidence. An ABSENT one is still a
// pre-flight failure (ADR 0084 decision 3 — a misspelt table looks the same), and the refusal names the operator's
// other remedy: `only` without the two HR loaders, which is what the runbook says to run when #13 is answered no.
describe("Part VII #13 — a source whose Salaries module is not in use (OD-27)", () => {
  const withoutHr = (): string[] =>
    loaders.map((l) => l.targetTable).filter((t) => !ONLY_HR.includes(t));

  it("an EMPTY EMPLOYEES loads zero employees and zero openings, and everything else loads", async () => {
    const own = await ownTenant("employees-empty");
    useCorpus(withTable("EMPLOYEES", []));
    try {
      const report = await runLoad(db.rw, await ctxFor(own));
      expect(report.perLoader["employee"]).toEqual({ inserted: 0, skipped: 0, conflicts: 0 });
      expect(report.perLoader["employee_ytd_opening"]).toEqual({
        inserted: 0,
        skipped: 0,
        conflicts: 0,
      });
      expect(await people(own)).toEqual([]);
      expect(await openings(own)).toEqual([]);
      expect(report.perLoader["opening_balance"]!.inserted).toBe(1);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });

  it("an ABSENT EMPLOYEES fails pre-flight naming the table and the remedy; leaving the HR loaders out loads the rest", async () => {
    const own = await ownTenant("employees-absent");
    useCorpus(withTable("EMPLOYEES", null));
    try {
      await expect(runLoad(db.rw, await ctxFor(own))).rejects.toThrow(
        "ERR_IMPORT_SOURCE_UNREADABLE: pre-flight failed: the source has no EMPLOYEES.*. Re-run 9A's scope report and correct the column map before loading. If the legacy module behind EMPLOYEES is not in use (OD-27; Part VII #13 asks it of EMPLOYEES), re-run with only leaving out employee, employee_ytd_opening",
      );
      expect(await people(own)).toEqual([]);
      const report = await runLoad(db.rw, await ctxFor(own, { only: withoutHr() }));
      expect(Object.keys(report.perLoader)).not.toContain("employee");
      expect(report.perLoader["opening_balance"]!.inserted).toBe(1);
      expect(await people(own)).toEqual([]);
    } finally {
      useCorpus(loadCorpus("cut-over"));
    }
  });
});
