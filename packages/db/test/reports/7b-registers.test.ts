import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  Money,
  currency,
  intlFormatters,
  renderReport,
  validateReportDefinition,
} from "@dulja/domain";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { ROLES } from "../../seed/roles";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B harness, reachable from packages/db/test/** through 3B's amendment A21(c).
import {
  assertTieOut,
  readDefinition,
  readEnvelope,
  reportFixture,
  runDefinition,
  type ReportFixture,
} from "../../../../tests/invariants/support/reports";

/**
 * 7B Task 3 — the document register and the two `auditor` views (spec:2163).
 *
 * The two auditor views filter `occurred_at`, a `timestamptz`, so their window parameters are `fromTime` /
 * `toTime` of kind `text` carrying RFC 3339 instants: 7A's `audit_log` and `document_event` datasets declare
 * `occurred_at` as a `timestamp` column and refuse a bare `YYYY-MM-DD` value, and a `date` parameter is
 * exactly that at the runs route. The column renders as `text` (the stored UTC instant) because 7A's `date`
 * format reads a calendar date and has no instant format.
 */
const MYR = currency("MYR");
const REGISTER = "accounting.document_register";
const AUDIT = "accounting.audit_log";
const EVENTS = "accounting.document_event_log";

describe("7B document register and the two auditor views (§4.16.1, spec:2163)", () => {
  let db: Db;
  let f: ReportFixture;
  /** A window around the fixture's own audit and event rows, from the database clock — never the host's. */
  let fromTime: string;
  let toTime: string;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha");
    const [w] = await db.admin<{ from_time: string; to_time: string }[]>`
      select to_char((now() - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as from_time,
             to_char((now() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as to_time`;
    fromTime = w!.from_time;
    toTime = w!.to_time;
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const registerParams = (over: Record<string, string | null> = {}) => ({
    companyId: f.s.company,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
    documentTypeCode: "JOURNAL",
    status: "posted",
    branchId: null,
    ...over,
  });
  const auditParams = () => ({
    companyId: f.s.company,
    tableName: "document",
    action: "insert",
    fromTime,
    toTime,
    actorId: null,
  });

  it("all three validate, and the two auditor views are gated admin.audit_log.read", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const code of [REGISTER, AUDIT, EVENTS]) {
      const result = validateReportDefinition(readDefinition(code), sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(readEnvelope(code).definitionVersion).toBe(1);
      expect(readDefinition(code).module).toBe("accounting");
    }
    expect(readDefinition(AUDIT).permission).toBe("admin.audit_log.read");
    expect(readDefinition(EVENTS).permission).toBe("admin.audit_log.read");
    expect(readDefinition(REGISTER).permission).toBe("accounting.report.read");
  });

  it("documentTypeCode is a text parameter, not an enum over §4.14 (amendment A10, test 15's report clause)", () => {
    for (const code of [REGISTER, EVENTS]) {
      const p = readDefinition(code).parameters.find((x) => x.name === "documentTypeCode");
      expect(p).toBeDefined();
      expect(p!.kind).toBe("text");
      expect(p!.options).toBeUndefined();
      expect(p!.required).toBe(false);
    }
  });

  it("neither auditor view exposes a row image — `before` and `after` are not columns (spec:2450, test 32)", () => {
    for (const code of [AUDIT, EVENTS]) {
      const d = readDefinition(code);
      const fields = [...d.columns.map((c) => c.field), ...d.dataset.filters.map((c) => c.field)];
      expect(fields).not.toContain("before");
      expect(fields).not.toContain("after");
    }
  });

  it("accounting.document_register's amount total equals the ledger's own debit sum for the same documents", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(REGISTER), {
        params: registerParams(),
        baseCurrency: MYR,
        window: { fromDate: "2026-01-01", toDate: "2026-01-31", documentTypeCodes: ["JOURNAL"] },
      });
    });
  });

  it("the register reports one row per document, and an unknown type code answers zero rows, not an error", async () => {
    await read(async (tx) => {
      const d = readDefinition(REGISTER);
      const rows = await runDefinition(tx, d, registerParams());
      expect(rows.length).toBe(3);
      // `document_id` and `base_total` are 7A's column aliases (A3), never camelCase members.
      expect(new Set(rows.map((r) => String(r["document_id"]))).size).toBe(3);
      const totals = rows.map((r) => Money.of(String(r["base_total"]), MYR).toString());
      expect(totals).toEqual(["1200.0000", "300.0000", "200.0000"]);
      const unknown = await runDefinition(
        tx,
        d,
        registerParams({ documentTypeCode: "A_TYPE_NO_TENANT_HAS", status: null }),
      );
      expect(unknown).toEqual([]);
      // February's journal is outside the date range and reappears when the range covers it.
      const both = await runDefinition(tx, d, registerParams({ toDate: "2026-02-28" }));
      expect(both.length).toBe(4);
    });
  });

  it("accounting.audit_log's witness: every document of the company has its insert audit row, and the report shows it", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(AUDIT), {
        params: auditParams(),
        baseCurrency: MYR,
        // `assertTieOut` projects ONE key list over both sides, so the witness columns are aliased to the
        // dataset's own snake_case field names (A3).
        witness: {
          key: ["table_name", "row_id"],
          rows: (t) => t<{ table_name: string; row_id: string }[]>`
            select 'document' as table_name, id::text as row_id
              from app.document where company_id = ${f.s.company}`,
        },
      });
    });
  });

  it("accounting.audit_log's window is half-open: a toTime at the window's start answers nothing", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(AUDIT), {
        ...auditParams(),
        toTime: fromTime,
      });
      expect(rows).toEqual([]);
    });
  });

  it("accounting.document_event_log's witness: one posted transition per posted document (2B's trigger wrote them)", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(EVENTS), {
        params: {
          companyId: f.s.company,
          documentTypeCode: null,
          eventKind: "transition",
          toStatus: "posted",
          fromTime,
          toTime,
        },
        baseCurrency: MYR,
        witness: {
          key: ["document_id", "to_status"],
          rows: (t) => t<{ document_id: string; to_status: string }[]>`
            select id::text as document_id, 'posted' as to_status
              from app.document where company_id = ${f.s.company} and status = 'posted'`,
        },
      });
    });
  });

  it("all three render in English and Arabic — the integer seq, the text instants and the money total", async () => {
    await read(async (tx) => {
      const runs: [string, Record<string, string | null>][] = [
        [REGISTER, registerParams()],
        [AUDIT, auditParams()],
        [
          EVENTS,
          { companyId: f.s.company, eventKind: "transition", toStatus: "posted", fromTime, toTime },
        ],
      ];
      for (const [code, params] of runs) {
        const rows = await runDefinition(tx, readDefinition(code), params);
        expect(rows.length, code).toBeGreaterThan(0);
        for (const lang of ["en", "ar"] as const) {
          const r = renderReport(readDefinition(code), rows, {
            format: "csv",
            lang,
            formatters: intlFormatters(lang, { currency: "MYR" }),
            generatedAt: "2026-11-05T00:00:00Z",
          });
          expect(r.rowCount, `${code} ${lang}`).toBe(rows.length);
          expect(r.dir).toBe(lang === "ar" ? "rtl" : "ltr");
        }
      }
      const total = renderReport(
        readDefinition(REGISTER),
        await runDefinition(tx, readDefinition(REGISTER), registerParams()),
        {
          format: "csv",
          lang: "en",
          formatters: intlFormatters("en", { currency: "MYR" }),
        },
      )
        .rows.filter((row) => row.kind === "total")
        .at(-1)!
        .cells.find((c) => c.field === "base_total")!.raw;
      expect(Money.of(String(total), MYR).toString()).toBe("1700.0000");
    });
  });

  it("the auditor role reaches both views and holds nothing mutating (spec:2163, R7)", async () => {
    const auditor = ROLES.find((r) => r.code === "auditor");
    expect(auditor, "the nine roles of §3.6.4 include auditor").toBeDefined();
    expect(auditor!.permissions).toContain(readDefinition(AUDIT).permission);
    expect(auditor!.permissions).toContain(readDefinition(EVENTS).permission);
    expect(auditor!.permissions).toContain(readDefinition(REGISTER).permission);
    const rows = await db.admin<{ code: string; mutating: boolean }[]>`
      select code, mutating from app.permission`;
    const mutating = new Map(rows.map((r) => [r.code, r.mutating]));
    expect(mutating.get("admin.audit_log.read")).toBe(false);
    expect(auditor!.permissions.filter((c) => mutating.get(c) === true)).toEqual([]);
  });

  it("a principal holding no code still reads the rows through the dataset — RLS and the gate are separate controls", async () => {
    // The gate is the runs route's `requireReportRead` (§4.2.5); the dataset itself is under RLS, which is
    // tenant-scoped, not permission-scoped. The outsider is in the SAME tenant, so RLS admits the rows and the
    // API gate is what refuses — asserting that keeps the two controls honestly distinct.
    await withTenant(db.rw, f.s.tenant, f.outsider, async (tx) => {
      const rows = await runDefinition(tx, readDefinition(AUDIT), auditParams());
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
