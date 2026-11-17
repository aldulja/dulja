import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { UserConfig } from "vite";
import { CATALOGUE_STREAMS } from "@dulja/sync";
import {
  openPosDatabase,
  LOCAL_SCHEMA_VERSION,
  StoreCorruptError,
  type PosDatabase,
} from "../src/main/database";
import {
  moneyToText,
  textToMoney,
  quantityToText,
  textToQuantity,
  revisionToText,
  textToRevision,
} from "../src/main/money";
import { Money, Quantity, currency } from "@dulja/domain";

const dirs: string[] = [];
const databases: PosDatabase[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "dulja-pos-"));
  dirs.push(dir);
  return join(dir, "till.sqlite");
}
function open(path = file()): PosDatabase {
  const db = openPosDatabase(path);
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable local POS store", () => {
  it("contains the eight read-only mirrors and eleven local tables", () => {
    const db = open();
    const tables = db.raw
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      [
        "attendance",
        "cash_event",
        ...CATALOGUE_STREAMS.map((stream) => `catalogue_${stream}`),
        "meta",
        "outbox",
        "pending_customer",
        "shift",
        "sync_cursor",
        "ticket",
        "ticket_line",
        "ticket_tender",
        "till_event",
      ].toSorted(),
    );
    expect(tables).toHaveLength(19);
    expect(db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.raw.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.raw.pragma("foreign_keys", { simple: true })).toBe(1);
    const shiftColumns = db.raw
      .prepare<[], { name: string }>("pragma table_info(shift)")
      .all()
      .map((row) => row.name);
    expect(shiftColumns).not.toContain("expected_cash");
    expect(shiftColumns).not.toContain("over_short");
  });

  it("rolls back both nested units and refuses a thenable before commit", () => {
    const db = open();
    expect(() =>
      db.tx(() => {
        db.raw.prepare("insert into meta values ('outer', '1')").run();
        db.tx(() => db.raw.prepare("insert into meta values ('inner', '2')").run());
        throw new Error("outbox failure");
      }),
    ).toThrow("outbox failure");
    expect(db.raw.prepare("select * from meta where key in ('outer','inner')").all()).toEqual([]);
    expect(() =>
      db.tx(() => {
        db.raw.prepare("insert into meta values ('async', '3')").run();
        return Promise.resolve();
      }),
    ).toThrow("synchronous");
    expect(db.raw.prepare("select * from meta where key = 'async'").get()).toBeUndefined();
  });

  it("preserves unsent tickets, exact amounts and revisions across the version-1 upgrade", () => {
    const path = file();
    // Construct the original model before pending_customer was introduced.
    const original = new Database(path);
    const sql = readFileSync(new URL("../src/main/schema.sql", import.meta.url), "utf8");
    original.exec(sql.slice(0, sql.indexOf("-- ── 4. pending_customer")));
    original.prepare("insert into meta values ('schema_version', '1')").run();
    original.prepare("insert into sync_cursor values ('item', '9007199254740993')").run();
    original
      .prepare(
        "insert into shift (id,terminal_id,cashier_principal_id,opened_at,opening_float,currency) values ('s','t','c','2026-10-09T00:00:00Z','9007199254740993.0001','MYR')",
      )
      .run();
    original
      .prepare(
        "insert into ticket (id,shift_id,cashier_principal_id,kind,status,currency,net_total,tax_total,total,catalogue_revision,created_at) values ('ticket','s','c','sale','completed','MYR','0.0001','0.0000','0.0001','9007199254740993','2026-10-09T00:00:00Z')",
      )
      .run();
    original
      .prepare(
        "insert into ticket_line values ('ticket',1,'i',null,'9007199254740.000001','u','0.0001','0.0000',null,'0.0000','0.0001')",
      )
      .run();
    original
      .prepare(
        "insert into outbox (id,kind,ref,payload,created_at) values ('o','ticket','ticket',?, '2026-10-09T00:00:00Z')",
      )
      .run('{"revision":"9007199254740993"}');
    original.close();
    const db = open(path);
    expect(db.raw.prepare("select value from meta where key='schema_version'").get()).toEqual({
      value: String(LOCAL_SCHEMA_VERSION),
    });
    expect(db.raw.prepare("select revision from sync_cursor").get()).toEqual({
      revision: "9007199254740993",
    });
    expect(db.raw.prepare("select opening_float from shift").get()).toEqual({
      opening_float: "9007199254740993.0001",
    });
    expect(db.raw.prepare("select quantity from ticket_line").get()).toEqual({
      quantity: "9007199254740.000001",
    });
    expect(db.raw.prepare("select payload, acked_at from outbox").get()).toEqual({
      payload: '{"revision":"9007199254740993"}',
      acked_at: null,
    });
    db.close();
    expect(open(path).raw.prepare("select count(*) as n from ticket").get()).toEqual({ n: 1 });
  });

  it("rebuilds a version-2 outbox under the cash_event kind and keeps every row, sent or not (⚠️ OD-10)", () => {
    const path = file();
    const sql = readFileSync(new URL("../src/main/schema.sql", import.meta.url), "utf8");
    const old = sql.replace("'till_event', 'cash_event'", "'till_event'");
    expect(old).not.toBe(sql); // the version-2 CHECK really is the narrower one
    const original = new Database(path);
    original.exec(old);
    original.prepare("insert into meta values ('schema_version', '2')").run();
    const row = original.prepare(
      "insert into outbox (id,kind,ref,payload,attempts,last_error,acked_at,created_at) values (?,?,?,?,?,?,?,?)",
    );
    row.run(
      "o1",
      "ticket",
      "t1",
      '{"a":"1.0000"}',
      2,
      "ERR_X: refused",
      null,
      "2026-10-09T00:00:00Z",
    );
    row.run(
      "o2",
      "till_event",
      "e1",
      "{}",
      0,
      null,
      "2026-10-09T00:01:00Z",
      "2026-10-09T00:00:30Z",
    );
    expect(() =>
      original
        .prepare(
          "insert into outbox (id,kind,ref,payload,created_at) values ('x','cash_event','c','{}','z')",
        )
        .run(),
    ).toThrow(/CHECK/);
    original.close();

    const db = open(path);
    const outbox = db.raw
      .prepare(
        "select id,kind,ref,payload,attempts,last_error,acked_at,created_at from outbox order by id",
      )
      .all();
    expect(outbox).toEqual([
      {
        id: "o1",
        kind: "ticket",
        ref: "t1",
        payload: '{"a":"1.0000"}',
        attempts: 2,
        last_error: "ERR_X: refused",
        acked_at: null,
        created_at: "2026-10-09T00:00:00Z",
      },
      {
        id: "o2",
        kind: "till_event",
        ref: "e1",
        payload: "{}",
        attempts: 0,
        last_error: null,
        acked_at: "2026-10-09T00:01:00Z",
        created_at: "2026-10-09T00:00:30Z",
      },
    ]);
    db.raw
      .prepare(
        "insert into outbox (id,kind,ref,payload,created_at) values ('o3','cash_event','c1','{}','z')",
      )
      .run();
    // The indexes and the refused-row view belong to the NEW table; the old one is gone.
    const objects = db.raw
      .prepare<[], { name: string; tbl_name: string }>(
        "select name, tbl_name from sqlite_master where name in ('outbox_ref_idx','outbox_pending_idx','outbox_refused','outbox_before_v3') order by name",
      )
      .all();
    expect(objects).toEqual([
      { name: "outbox_pending_idx", tbl_name: "outbox" },
      { name: "outbox_ref_idx", tbl_name: "outbox" },
      { name: "outbox_refused", tbl_name: "outbox_refused" },
    ]);
    expect(() =>
      db.raw
        .prepare(
          "insert into outbox (id,kind,ref,payload,created_at) values ('o4','cash_event','c1','{}','z')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(db.raw.prepare("select count(*) as n from outbox_refused").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("select value from meta where key='schema_version'").get()).toEqual({
      value: "3",
    });
  });

  it("refuses corrupted files and unknown schema versions without overwriting them", () => {
    const path = file();
    writeFileSync(path, "broken database");
    expect(() => openPosDatabase(path)).toThrow(StoreCorruptError);
    expect(readFileSync(path, "utf8")).toBe("broken database");
    const futurePath = file();
    const future = new Database(futurePath);
    future.exec(
      "create table meta (key text primary key, value text not null) strict; insert into meta values ('schema_version', '99')",
    );
    future.close();
    expect(() => openPosDatabase(futurePath)).toThrow("unsupported");
    const intact = new Database(futurePath);
    expect(intact.prepare("select value from meta").get()).toEqual({ value: "99" });
    intact.close();
  });

  it("has one exact boundary for money, quantities and revisions", () => {
    const myr = currency("MYR");
    expect(moneyToText(textToMoney("9007199254740993.0001", myr))).toBe("9007199254740993.0001");
    expect(quantityToText(textToQuantity("9007199254740.000001"))).toBe("9007199254740.000001");
    expect(textToMoney(moneyToText(Money.of("0.0001", myr)), myr).toString()).toBe("0.0001");
    expect(textToQuantity(quantityToText(Quantity.of("0.000001"))).toString()).toBe("0.000001");
    expect(revisionToText(textToRevision("9007199254740993"))).toBe("9007199254740993");
    for (const value of ["01", "-1", "1.0", "1e3", "9223372036854775808"])
      expect(() => textToRevision(value)).toThrow();
    expect(() => revisionToText(-1n)).toThrow();
  });

  it("the schema file mentions no ESC/POS, drawer port, scanner, scale or OPOS term — D18, LEGACY-086", () => {
    // POS hardware is out of v1 (D18): a scanner is a keyboard, a drawer opens through the printer driver, and
    // nothing in the local model names a device. As words, so `drawer_open` and `max_cash_in_drawer` — a till
    // event and a branch limit, not hardware — stay legal while a `drawer_port` column does not.
    const sql = readFileSync(
      new URL("../src/main/schema.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    for (const banned of ["esc/pos", "escpos", "drawer_port", "0x4e"])
      expect(sql, banned).not.toContain(banned);
    for (const word of ["scanner", "scale", "opos", "serial", "usb"])
      expect(sql, word).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it("the vite config declares no package version and builds to dist/ with relative asset URLs", async () => {
    const text = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    // spec:104 — the lockfile owns versions.
    expect(text).not.toMatch(/["']\^?\d+\.\d+\.\d+["']/);
    const config = (await import("../vite.config")).default as UserConfig;
    // app:// has no server to rewrite an absolute asset path.
    expect(config.base).toBe("./");
    // electron-builder.pos.yml copies ../pos/dist into the installer's renderer resources (T10).
    expect(config.build?.outDir ?? "dist").toBe("dist");
  });
});
