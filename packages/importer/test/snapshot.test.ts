import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportWriter } from "../src/artefacts";
import { FixtureLegacyDriver, type LegacyCorpus } from "../src/drivers/fixture";
import type { LegacyColumn, LegacyRow, SelectSpec } from "../src/legacy/types";
import { loaders } from "../src/load/registry";
import { NEVER_READ, PERSONAL_TABLES, planSnapshot, pseudonymise, snapshot } from "../src/snapshot";
import { loadCorpus } from "./support/corpus";
// After the registry (9B T6's import-order note): a loader module imported first would build `loaders` half-bound.
import { PAYITEM_COLUMNS } from "../src/load/employees";
import { mposLoader } from "../src/load/mpos";

const salt = Buffer.from("0".repeat(64), "hex");
const run = () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-9a-snap-"));
  return {
    dir,
    writer: new ReportWriter(dir, { source: "fixture corpus", engineVersion: "Firebird 2.5" }),
    driver: new FixtureLegacyDriver(loadCorpus()),
  };
};

/** Every file under a directory, as text. */
const walk = (at: string): string[] =>
  readdirSync(at, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(at, e.name)) : [readFileSync(join(at, e.name), "utf8")],
  );

/** The base corpus plus a `USERS` table holding the two values spec §5.1 #7 and #11 forbid reading. */
const withUsers = (): LegacyCorpus => {
  const corpus = loadCorpus();
  return {
    ...corpus,
    tables: {
      ...corpus.tables,
      USERS: {
        keyColumns: ["ID"],
        columns: [
          { name: "ID", kind: "integer", scale: 0, nullable: false },
          { name: "NAME", kind: "text", scale: 0, nullable: true },
          { name: "PASSWORD", kind: "text", scale: 0, nullable: true },
          { name: "PIN", kind: "text", scale: 0, nullable: true },
        ],
        rows: [{ ID: "1", NAME: "sysdba", PASSWORD: "masterkey", PIN: "1234" }],
      },
    },
  };
};

/** A fixture driver that records every read it is asked for, so a test can prove what was never selected. */
class RecordingDriver extends FixtureLegacyDriver {
  readonly specs: SelectSpec[] = [];

  override cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]> {
    this.specs.push(spec);
    return super.cursor(spec, batch);
  }
}

describe("planSnapshot — every column is classified, and the plan is the artefact", () => {
  it("copies a key, pseudonymises a name, and never reads a credential", () => {
    // USERS is a personal table, so its key is named (9B review, finding 2: an unnamed column there is omitted).
    const plan = planSnapshot(
      "USERS",
      [
        { name: "ID", kind: "integer", scale: 0, nullable: false },
        { name: "NAME", kind: "text", scale: 0, nullable: true },
        { name: "PASSWORD", kind: "text", scale: 0, nullable: true },
        { name: "PIN", kind: "text", scale: 0, nullable: true },
        { name: "MOBILE", kind: "text", scale: 0, nullable: true },
        { name: "TAXNUMBER", kind: "text", scale: 0, nullable: true },
        { name: "NOTES", kind: "blob", scale: 0, nullable: true },
      ],
      ["ID"],
    );
    expect(plan.map((p) => [p.column, p.action, p.kind])).toEqual([
      ["ID", "copy", null],
      ["NAME", "pseudonymise", "name"],
      ["PASSWORD", "omit", "credential"],
      ["PIN", "omit", "credential"],
      ["MOBILE", "pseudonymise", "contact"],
      ["TAXNUMBER", "pseudonymise", "identifier"],
      ["NOTES", "omit", "free_text"],
    ]);
    for (const row of plan) expect(row.why.length).toBeGreaterThan(20);
  });

  it("holds the two names spec §5.1 #7 and #11 forbid, and holds them as table.column", () => {
    expect([...NEVER_READ].toSorted()).toEqual(["USERS.PASSWORD", "USERS.PIN"]);
  });

  it("pseudonymises EMPLOYEES.NAME and ACCOUNTS.NAME (ADR 0083)", () => {
    const corpus = loadCorpus();
    for (const table of ["EMPLOYEES", "ACCOUNTS"]) {
      const plan = planSnapshot(table, corpus.tables[table]?.columns ?? []);
      expect(plan.find((p) => p.column === "NAME")).toMatchObject({
        action: "pseudonymise",
        kind: "name",
      });
    }
  });

  it("says on a short value's row that its pseudonym can collide (ADR 0083, amendment C4)", () => {
    const [code] = planSnapshot("ACCOUNTS", [
      { name: "NAME", kind: "text", scale: 0, nullable: true },
    ]);
    expect(code?.why).toContain("eight characters");
  });
});

describe("pseudonymise — deterministic under one salt, unlinkable across salts (ADR 0083 §5)", () => {
  it("gives two rows that shared a value the same pseudonym", () => {
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan")).toBe(
      pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan"),
    );
  });

  it("separates the same value in two columns, so a join cannot be rebuilt across them", () => {
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan")).not.toBe(
      pseudonymise(salt, "EMPLOYEES", "NAME", "Ali Hassan"),
    );
  });

  it("returns a value no longer than the one it replaces (correction C4)", () => {
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan")).toHaveLength(10);
    expect(pseudonymise(salt, "ACCOUNTS", "CODE", "1")).toHaveLength(1);
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "x".repeat(200))).toHaveLength(200);
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "")).toBe("");
  });

  it("changes completely under a different salt", () => {
    const other = Buffer.from("1".repeat(64), "hex");
    expect(pseudonymise(other, "ACCOUNTS", "NAME", "Ali Hassan")).not.toBe(
      pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan"),
    );
  });
});

describe("snapshot — spec:2272's anonymised extract", () => {
  it("writes one CSV per table, hashes it, and keeps the key columns joinable", async () => {
    const { dir, writer, driver } = run();
    const result = await snapshot(driver, writer, { tables: ["ACCOUNTS"], salt });

    expect(result.tables).toEqual([
      {
        table: "ACCOUNTS",
        rows: 5,
        file: "snapshot/ACCOUNTS.csv",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
      },
    ]);
    const csv = readFileSync(join(dir, "snapshot", "ACCOUNTS.csv"), "utf8");
    expect(csv).toContain("SITE,ID,CODE,NAME,ISEMPLOYEE");
    expect(csv).toContain("1,10,");
    expect(csv).not.toContain("Cash");
    expect(csv).not.toContain("Ali Hassan");
  });

  it("leaves no employee's name in the snapshot, Arabic included", async () => {
    const { dir, writer, driver } = run();
    await snapshot(driver, writer, { tables: ["EMPLOYEES", "ACCOUNTS"], salt });
    writer.finish();
    for (const content of walk(dir)) {
      for (const name of ["Ali Hassan", "Siti Nurhaliza", "Ravi Kumar", "أحمد", "احمد"])
        expect(content).not.toContain(name);
    }
  });

  it("never writes the salt anywhere under the run directory", async () => {
    const { dir, writer, driver } = run();
    const result = await snapshot(driver, writer, { tables: ["ACCOUNTS"], salt });
    writer.finish();
    expect(result.saltPersisted).toBe(false);
    const hex = salt.toString("hex");
    for (const content of walk(dir)) expect(content).not.toContain(hex);
  });

  it("refuses to snapshot a table it was not asked for", async () => {
    const { writer, driver } = run();
    await expect(snapshot(driver, writer, { tables: ["NOSUCHTABLE"], salt })).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: NOSUCHTABLE is not a table of this source/,
    );
  });

  it("omits a denied column from the header, not just from the values", async () => {
    const { dir, writer } = run();
    await snapshot(new FixtureLegacyDriver(withUsers()), writer, { tables: ["USERS"], salt });
    const csv = readFileSync(join(dir, "snapshot", "USERS.csv"), "utf8");
    expect(csv).toContain("ID,NAME");
    expect(csv).not.toContain("PASSWORD");
    expect(csv).not.toContain("PIN");
    expect(csv).not.toContain("masterkey");
    expect(csv).not.toContain("1234");
  });

  it("never selects Users.Password or Users.PIN — the deny-list holds at the read, not after it", async () => {
    const { writer } = run();
    const driver = new RecordingDriver(withUsers());
    await snapshot(driver, writer, { salt });
    const selected = driver.specs.flatMap((s) => s.columns.map((c) => [s.table, c].join(".")));
    expect(selected).toContain("USERS.ID");
    for (const denied of NEVER_READ) expect(selected).not.toContain(denied);
    // An empty column list means "every column" to a driver, so no read may ever be issued with one.
    for (const spec of driver.specs) expect(spec.columns.length).toBeGreaterThan(0);
  });

  it("counts a table whose every column is omitted and never reads it", async () => {
    // An empty column list is "every column" to a driver, so a table with nothing left to copy must not be read.
    const corpus = withUsers();
    const users = corpus.tables.USERS;
    if (!users) throw new Error("withUsers lost USERS");
    const secretsOnly: LegacyCorpus = {
      ...corpus,
      tables: {
        ...corpus.tables,
        USERS: {
          ...users,
          columns: users.columns.filter((c) => c.name !== "ID" && c.name !== "NAME"),
        },
      },
    };
    const { dir, writer } = run();
    const driver = new RecordingDriver(secretsOnly);
    const result = await snapshot(driver, writer, { tables: ["USERS"], salt });
    expect(driver.specs).toEqual([]);
    expect(result.tables).toMatchObject([{ table: "USERS", rows: 1, file: "snapshot/USERS.csv" }]);
    expect(result.omittedColumns).toBe(2);
    expect(readFileSync(join(dir, "snapshot", "USERS.csv"), "utf8")).toBe("﻿");
  });

  it("writes the plan beside the data so every column's treatment is auditable", async () => {
    const { dir, writer, driver } = run();
    const result = await snapshot(driver, writer, { tables: ["ACCOUNTS", "VOUCHERS"], salt });
    expect(result.pseudonymisedColumns).toBe(1);
    expect(result.omittedColumns).toBe(0);
    expect(result.plan).toHaveLength(9);
    const plan = readFileSync(join(dir, "snapshot-plan.csv"), "utf8");
    expect(plan).toContain("ACCOUNTS,NAME,pseudonymise,name");
  });
});

// ── 9B review, finding 2: the legacy columns are PREFIXED (`EMPNAME`, `ACCTAXNO`), and the snapshot leaves the site ──

const text = (name: string): LegacyColumn => ({ name, kind: "text", scale: 0, nullable: true });
const actionOf = (table: string, column: string, keys: readonly string[] = []) =>
  planSnapshot(table, [text(column)], keys)[0]!;

/**
 * Every source column a 9B loader declares, by table — plus the payslip columns the YTD reconciliation reads and the
 * unregistered historical POS loader's (OD-16) — the columns the cut-over will actually find in a customer's database.
 */
const LOADER_COLUMNS: readonly { table: string; column: string; sensitive: boolean }[] = [
  ...[...loaders, mposLoader].flatMap((l) =>
    l.sourceColumns.map((c) => ({
      table: l.sourceTable,
      column: c.name,
      sensitive: c.sensitive === true,
    })),
  ),
  ...PAYITEM_COLUMNS.map((column) => ({ table: "PAYITEMS", column, sensitive: false })),
];

/** The personal and pay columns the loaders name, each of which must never be copied in clear. */
const PERSONAL_LOADER_COLUMNS = [
  "EMPLOYEES.EMPNUMBER",
  "EMPLOYEES.EMPNAME",
  "EMPLOYEES.EMPNAMEAR",
  "EMPLOYEES.EMPHIRED",
  "EMPLOYEES.EMPLEFT",
  "EMPLOYEES.EMPNATID",
  "EMPLOYEES.EMPDOB",
  "EMPLOYEES.EMPBANKACC",
  "EMPLOYEES.EMPEPFNO",
  "EMPLOYEES.EMPSOCSONO",
  "EMPLOYEES.EMPTAXNO",
  "EMPLOYEES.EMPYTDGROSS",
  "EMPLOYEES.EMPYTDNET",
  "PAYITEMS.PITEMP",
  "PAYITEMS.PITYEAR",
  "PAYITEMS.PITGROSS",
  "PAYITEMS.PITNET",
  "ACCOUNTS.ACCNAME",
  "ACCOUNTS.ACCNAMEAR",
  "ACCOUNTS.ACCTAXNO",
  "ACCOUNTS.ACCEMAIL",
  "ACCOUNTS.ACCPHONE",
];

/**
 * The loader columns the snapshot COPIES in clear, reviewed one by one: keys, codes, flags, dates of documents and
 * stock movements, quantities and ledger figures. A new loader column the rules do not pseudonymise or omit fails
 * this pin until a person has decided it may leave the customer's premises as it is.
 */
const REVIEWED_COPIED = [
  "ACCOUNTS.ACCCODE",
  "ACCOUNTS.ACCID",
  "ACCOUNTS.ACCISCUSTOMER",
  "ACCOUNTS.ACCISVENDOR",
  "ACCTOTALS.ACTACC",
  "ACCTOTALS.ACTCREDIT",
  "ACCTOTALS.ACTDEBIT",
  "BILLITEMS.BTMBAT",
  "BILLITEMS.BTMDATE",
  "BILLITEMS.BTMID",
  "BILLITEMS.BTMIN",
  "BILLITEMS.BTMMAT",
  "BILLITEMS.BTMQNT",
  "BILLITEMS.BTMROW",
  "BILLITEMS.BTMSEQ",
  "BILLITEMS.BTMVAL",
  "BILLITEMS.BTMWAR",
  "BILLS.BILACC",
  "BILLS.BILDATE",
  "BILLS.BILID",
  "BILLS.BILKIND",
  "BILLS.BILNUMBER",
  "BILLS.BILOPEN",
  "EMPLOYEES.EMPID",
  "MATBATCHES.BATCODE",
  "MATBATCHES.BATEXPIRY",
  "MATBATCHES.BATID",
  "MATBATCHES.BATMAT",
  "MATBATCHES.BATMFG",
  "MATERIALS.MATCODE",
  "MATERIALS.MATID",
  "MATERIALS.MATISBATCH",
  "MATERIALS.MATISSERVICE",
  "MATERIALS.MATUNIT",
  "POSTICKETS.PTKCASHIER",
  "POSTICKETS.PTKDATE",
  "POSTICKETS.PTKID",
  "POSTICKETS.PTKNUMBER",
  "POSTICKETS.PTKTENDER",
  "POSTICKETS.PTKTERMINAL",
  "POSTICKETS.PTKTOTAL",
  "UNITS.UNTID",
  "WAREHOUSES.WARID",
];

/** The key each loader's source table is read by, as the cut-over corpus's catalogue declares it. */
const KEYS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(loadCorpus("cut-over").tables).map(([table, t]) => [table, t.keyColumns]),
);

describe("planSnapshot — the legacy columns are prefixed (9B review, finding 2)", () => {
  it("pseudonymises a prefixed name, Arabic name and party name", () => {
    for (const [table, column] of [
      ["EMPLOYEES", "EMPNAME"],
      ["EMPLOYEES", "EMPNAMEAR"],
      ["ACCOUNTS", "ACCNAME"],
      ["ACCOUNTS", "ACCNAMEAR"],
    ] as const)
      expect(actionOf(table, column), column).toMatchObject({
        action: "pseudonymise",
        kind: "name",
      });
  });

  it("pseudonymises a prefixed national id, bank account, scheme number and tax number", () => {
    for (const [table, column] of [
      ["EMPLOYEES", "EMPNATID"],
      ["EMPLOYEES", "EMPBANKACC"],
      ["EMPLOYEES", "EMPEPFNO"],
      ["EMPLOYEES", "EMPSOCSONO"],
      ["EMPLOYEES", "EMPTAXNO"],
      ["ACCOUNTS", "ACCTAXNO"],
    ] as const)
      expect(actionOf(table, column), column).toMatchObject({
        action: "pseudonymise",
        kind: "identifier",
      });
  });

  it("omits a date of birth and a pay figure wherever they are, because a pseudonym of either is not a value", () => {
    expect(actionOf("EMPLOYEES", "EMPDOB")).toMatchObject({
      action: "omit",
      kind: "date_of_birth",
    });
    for (const column of ["EMPYTDGROSS", "EMPYTDNET"])
      expect(actionOf("ACCOUNTS", column), column).toMatchObject({ action: "omit", kind: "pay" });
  });

  it("fails closed in a table of personal data: a column no rule recognises is omitted, its key copied", () => {
    expect(PERSONAL_TABLES.has("EMPLOYEES")).toBe(true);
    expect(PERSONAL_TABLES.has("PAYITEMS")).toBe(true);
    expect(PERSONAL_TABLES.has("USERS")).toBe(true);
    expect(PERSONAL_TABLES.has("ACCTOTALS")).toBe(false);
    expect(actionOf("PAYITEMS", "PITGROSS", ["PITID"])).toMatchObject({
      action: "omit",
      kind: null,
    });
    expect(actionOf("PAYITEMS", "PITNET", ["PITID"])).toMatchObject({ action: "omit", kind: null });
    expect(actionOf("EMPLOYEES", "EMPHIRED", ["EMPID"]).action).toBe("omit");
    expect(actionOf("EMPLOYEES", "EMPID", ["EMPID"]).action).toBe("copy");
    expect(actionOf("PAYITEMS", "PITID", ["PITID"]).action).toBe("copy");
    expect(actionOf("EMPLOYEES", "EMPID", ["EMPID"]).why).toContain("key");
    // Outside a personal table an unrecognised column is still copied: a code, a quantity, a date.
    expect(actionOf("BILLITEMS", "BTMQNT", ["BTMID"]).action).toBe("copy");
  });

  it("copies no column a 9B loader marks sensitive, nor any personal or pay column a loader names", () => {
    const plan = new Map(
      LOADER_COLUMNS.map(({ table, column }) => [
        `${table}.${column}`,
        actionOf(table, column, KEYS[table] ?? []),
      ]),
    );
    const sensitive = LOADER_COLUMNS.filter((c) => c.sensitive).map(
      (c) => `${c.table}.${c.column}`,
    );
    expect(sensitive.length).toBeGreaterThanOrEqual(8);
    for (const name of [...sensitive, ...PERSONAL_LOADER_COLUMNS]) {
      expect(plan.get(name), `${name} is not a loader column`).toBeDefined();
      expect(plan.get(name)!.action, name).not.toBe("copy");
    }
  });

  it("copies only the loader columns a person has reviewed as non-personal — a new one fails until reviewed", () => {
    const copied = LOADER_COLUMNS.filter(
      ({ table, column }) => actionOf(table, column, KEYS[table] ?? []).action === "copy",
    ).map(({ table, column }) => `${table}.${column}`);
    expect([...new Set(copied)].toSorted()).toEqual(REVIEWED_COPIED);
  });
});

describe("snapshot — the cut-over corpus leaves no personal value in clear (9B review, finding 2)", () => {
  it("writes no employee's name, identifier, birth date or pay, nor a party's tax number, e-mail or phone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-9b-snap-"));
    const writer = new ReportWriter(dir, {
      source: "fixture corpus",
      engineVersion: "Firebird 2.5",
    });
    const corpus = loadCorpus("cut-over");
    const result = await snapshot(new FixtureLegacyDriver(corpus), writer, {
      tables: ["EMPLOYEES", "PAYITEMS", "ACCOUNTS"],
      salt,
    });
    writer.finish();
    const values = (table: string, columns: readonly string[]) =>
      corpus.tables[table]!.rows.flatMap((r) =>
        columns.map((c) => r[c]).filter((v): v is string => typeof v === "string" && v !== ""),
      );
    const secrets = [
      ...values("EMPLOYEES", [
        "EMPNUMBER",
        "EMPNAME",
        "EMPNAMEAR",
        "EMPHIRED",
        "EMPNATID",
        "EMPDOB",
        "EMPBANKACC",
        "EMPEPFNO",
        "EMPSOCSONO",
        "EMPTAXNO",
        "EMPYTDGROSS",
        "EMPYTDNET",
      ]),
      ...values("PAYITEMS", ["PITGROSS", "PITNET"]),
      ...values("ACCOUNTS", ["ACCNAME", "ACCNAMEAR", "ACCTAXNO", "ACCEMAIL", "ACCPHONE"]),
    ];
    expect(secrets.length).toBeGreaterThan(30);
    const written = walk(dir).join("\n");
    for (const secret of secrets) expect(written, secret).not.toContain(secret);
    // The keys still join: EMPLOYEES and PAYITEMS are snapshotted by their own keys, in clear.
    const employees = readFileSync(join(dir, "snapshot", "EMPLOYEES.csv"), "utf8");
    expect(employees.split("\r\n")[0]).toBe(
      "\uFEFFEMPID,EMPNAME,EMPNAMEAR,EMPNATID,EMPBANKACC,EMPEPFNO,EMPSOCSONO,EMPTAXNO",
    );
    expect(employees).toContain("5001,");
    expect(
      result.plan
        .filter((p) => p.table === "EMPLOYEES" && p.action === "copy")
        .map((p) => p.column),
    ).toEqual(["EMPID"]);
  });
});
