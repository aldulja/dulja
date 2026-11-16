import { describe, expect, it } from "vitest";
import { OdbcLegacyDriver, redactDsn } from "../src/drivers/odbc";

const DSN = process.env.LEGACY_ODBC_DSN;

describe("redactDsn — no credential reaches an artefact or a log line", () => {
  it("keeps the driver and the database and drops everything secret", () => {
    expect(
      redactDsn(
        "DRIVER={Firebird/InterBase(r) driver};UID=SYSDBA;PWD=masterkey;DBNAME=C:/db/STANDARD.FDB",
      ),
    ).toBe("DRIVER={Firebird/InterBase(r) driver};UID=***;PWD=***;DBNAME=C:/db/STANDARD.FDB");
    expect(redactDsn("DSN=sahli;user=reader;Password=s3cret")).toBe(
      "DSN=sahli;user=***;Password=***",
    );
  });

  it("drops a brace-quoted credential whole, `;` and `=` inside it included (2026-11-15 review, HRP-07)", () => {
    const dsn =
      "DRIVER=Firebird;DBNAME=srv:/db/sahli.fdb;UID={SYS;DBA};PWD={ab;TopSecret99=x};CHARSET=UTF8";
    expect(redactDsn(dsn)).toBe(
      "DRIVER=Firebird;DBNAME=srv:/db/sahli.fdb;UID=***;PWD=***;CHARSET=UTF8",
    );
    const driver = new OdbcLegacyDriver({ query: async () => [], close: async () => {} }, dsn);
    expect(driver.source).not.toMatch(/TopSecret99|DBA/);
    // Spaces around the key, and an unclosed brace, which runs to the end and goes with the value.
    expect(redactDsn("DSN=sahli; Pwd = {s3cret;CHARSET=UTF8")).toBe("DSN=sahli; Pwd =***");
    expect(redactDsn("DSN=sahli;;User Id=reader;")).toBe("DSN=sahli;;User Id=***;");
  });
});

/** A scripted connection: answers each statement from a table and records what it was asked, binding included. */
function scripted(answers: Record<string, Record<string, unknown>[]>) {
  const asked: { text: string; params: readonly unknown[] }[] = [];
  return {
    asked,
    conn: {
      query(text: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
        asked.push({ text, params });
        const key = Object.keys(answers).find((k) => text.includes(k));
        return key
          ? Promise.resolve(answers[key] ?? [])
          : Promise.reject(new Error(["unscripted:", text].join(" ")));
      },
      close: () => Promise.resolve(),
    },
  };
}

const CATALOGUE = [
  { N: "ID", T: 8, S: 0, U: 0, NN: 1 },
  { N: "DEBIT", T: 16, S: -4, U: 1, NN: 0 },
  { N: "DATE", T: 12, S: 0, U: 0, NN: 0 },
  { N: "NOTE", T: 37, S: 0, U: 0, NN: 0 },
  { N: "RATE", T: 27, S: 0, U: 0, NN: 0 },
  { N: "LAYOUT", T: 261, S: 0, U: 0, NN: 0 },
];

describe("OdbcLegacyDriver over a scripted connection — the catalogue, the casts and the refusals", () => {
  it("classifies RDB$FIELDS types, reads only with `select`, and binds the table name", async () => {
    const { conn, asked } = scripted({
      rdb$relation_fields: CATALOGUE,
      rdb$index_segments: [{ N: "ID" }],
    });
    const driver = new OdbcLegacyDriver(conn, "DSN=x;PWD=secret");
    expect(driver.source).toBe("DSN=x;PWD=***");
    expect(await driver.columns("VOUITEMS")).toEqual([
      { name: "ID", kind: "integer", scale: 0, nullable: false },
      { name: "DEBIT", kind: "decimal", scale: 4, nullable: true },
      { name: "DATE", kind: "date", scale: 0, nullable: true },
      { name: "NOTE", kind: "text", scale: 0, nullable: true },
      { name: "RATE", kind: "float", scale: 0, nullable: true },
      { name: "LAYOUT", kind: "blob", scale: 0, nullable: true },
    ]);
    expect(await driver.keyColumns("VOUITEMS")).toEqual(["ID"]);
    for (const q of asked) expect(q.text.startsWith("select ")).toBe(true);
    expect(asked[0]?.params).toEqual(["VOUITEMS"]);
  });

  it("refuses a value that arrives as a number or a Date — the varchar cast was lost", async () => {
    for (const leaked of [100.5, new Date(0)]) {
      const { conn } = scripted({
        rdb$relation_fields: CATALOGUE,
        rdb$index_segments: [],
        'from "VOUITEMS"': [{ DEBIT: leaked }],
      });
      const driver = new OdbcLegacyDriver(conn, "DSN=x");
      const read = async () => {
        for await (const _ of driver.cursor({ table: "VOUITEMS", columns: ["DEBIT"] }, 10)) break;
      };
      await expect(read()).rejects.toThrow(
        /ERR_IMPORT_SOURCE_UNREADABLE: VOUITEMS.DEBIT arrived as a/,
      );
    }
  });

  it("carries a blob across the seam as base64, never as a lossy text decode", async () => {
    const bytes = Buffer.from([0x54, 0x50, 0x46, 0x30, 0xff, 0x00, 0x80, 0xc3, 0x28]);
    const { conn } = scripted({
      rdb$relation_fields: CATALOGUE,
      rdb$index_segments: [],
      'from "VOUITEMS"': [{ LAYOUT: bytes }],
    });
    const driver = new OdbcLegacyDriver(conn, "DSN=x");
    const rows = [];
    for await (const batch of driver.cursor({ table: "VOUITEMS", columns: ["LAYOUT"] }, 10))
      rows.push(...batch);
    expect(rows).toEqual([{ LAYOUT: "VFBGMP8AgMMo" }]);
    expect(Buffer.from(String(rows[0]?.LAYOUT), "base64").equals(bytes)).toBe(true);
  });

  it("orders a read by the primary key when the caller names no order", async () => {
    const { conn, asked } = scripted({
      rdb$relation_fields: CATALOGUE,
      rdb$index_segments: [{ N: "ID" }],
      'from "VOUITEMS"': [],
    });
    const driver = new OdbcLegacyDriver(conn, "DSN=x");
    for await (const _ of driver.cursor({ table: "VOUITEMS", columns: ["ID"] }, 10)) break;
    expect(asked.at(-1)?.text).toBe(
      'select cast("ID" as varchar(20)) as "ID" from "VOUITEMS" order by "ID"',
    );
  });

  it("answers the engine version from ENGINE_VERSION, the owner's declaration, or not at all", async () => {
    expect(
      await new OdbcLegacyDriver(
        scripted({ ENGINE_VERSION: [{ V: " WI-V2.5.9.27139 Firebird 2.5 " }] }).conn,
        "DSN=x",
      ).engineVersion(),
    ).toBe("WI-V2.5.9.27139 Firebird 2.5");
    expect(await new OdbcLegacyDriver(scripted({}).conn, "DSN=x").engineVersion()).toBeNull();
    expect(
      await new OdbcLegacyDriver(scripted({}).conn, "DSN=x", "Firebird 1.5.6").engineVersion(),
    ).toBe("Firebird 1.5.6");
  });
});

// contracts §3.7.1 gives `tests/staging` the same shape: a suite that needs a real endpoint is skipped, never
// failed, when the endpoint is not configured. This one needs the owner's database (OD-17).
describe.skipIf(!DSN)("OdbcLegacyDriver against the live source (OD-17)", () => {
  it("reports an engine version or refuses to guess one", async () => {
    const { connectOdbc } = await import("../src/drivers/odbc");
    const driver = await connectOdbc({ dsn: DSN as string });
    try {
      const version = await driver.engineVersion();
      expect(version === null || version.length > 0).toBe(true);
      expect((await driver.tables()).length).toBeGreaterThan(0);
    } finally {
      await driver.close();
    }
  });
});
