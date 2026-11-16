import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DATASETS,
  DATASET_IDS,
  datasetFor,
  isDatasetId,
  type DatasetId,
} from "../../src/reports/datasets";
import { ReportError } from "../../src/reports/errors";
import type { DatasetParams } from "../../src/reports/query";
import {
  grantCodes,
  seedBranch,
  seedShift,
  seedTenantV2,
  seedTerminal,
  startDb,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "../index";

/**
 * 7C Task 1 — the three Phase 6 datasets (§4.16.2; contracts round 15, amendments A1, A2 and A16). Each is
 * driven through `datasetFor(...).run` directly, so a dataset defect is diagnosed before any definition exists
 * to blame. The laterals' non-zero figures (tickets, takings, till-event counts) are proven over a real synced
 * day by 7C's harness and Task 4's group test; here they are typed zeros.
 */
const fields = (id: DatasetId): string[] => datasetFor(id).columns.map((c) => c.field);

/** A comparison of two ISO dates, which order as strings — the oracle of the midnight case below. */
const LOCAL_DATE_OPS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
const holdsOn = (op: (typeof LOCAL_DATE_OPS)[number], local: string, day: string): boolean =>
  op === "eq"
    ? local === day
    : op === "ne"
      ? local !== day
      : op === "lt"
        ? local < day
        : op === "lte"
          ? local <= day
          : op === "gt"
            ? local > day
            : local >= day;

describe("7C datasets — the three Phase 6 members (§4.16.2, amendment A1)", () => {
  let db: Db;
  let s: Seed;
  let other: Seed;
  let branchB: string;
  let terminalId: string;
  let cashierId: string;
  let shiftId: string;
  let lateShiftId: string;
  let tillEventId: string;
  let needsAttentionId: string;
  let clientRef: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "7c-datasets");
    other = await seedTenantV2(db, "7c-datasets-other");
    // `branch_isolation` (Form A, 0068/0070) admits a branch only to a principal with a live role in the
    // company, and `seedTenant` grants `s.human` none — so the reader is granted, company-wide.
    await grantCodes(db, s, { codes: ["pos.report.read", "pos.needs_attention.resolve"] });
    await grantCodes(db, other, { codes: ["pos.report.read", "pos.needs_attention.resolve"] });
    branchB = await seedBranch(db, s, { code: "BR2", nameEn: "Branch two" });
    const t = await seedTerminal(db, s, { code: "T1" });
    terminalId = t.terminalId;
    cashierId = t.principalId;
    shiftId = await seedShift(db, s, {
      terminalId,
      cashierPrincipalId: cashierId,
      openingFloat: "200.0000",
    });
    // A shift opened at 17:30 UTC on 1 March: 01:30 on 2 March in the company's default Asia/Kuala_Lumpur, so
    // the date companion and a UTC date disagree (A16 item 3). Fixture rows are written as the system principal
    // on the migrator, exactly as 6D's `seedShift` writes them (6D amendment A17); none is a ledger row.
    lateShiftId = await uuidv7(db.admin);
    tillEventId = await uuidv7(db.admin);
    needsAttentionId = await uuidv7(db.admin);
    clientRef = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`
        insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id, opened_principal_id,
                               opened_at, opening_float, currency)
        values (${lateShiftId}, ${s.tenant}, ${s.company}, ${s.hq}, ${terminalId}, ${cashierId},
                '2026-03-01T17:30:00Z', '50.0000', 'MYR')`;
      await tx`
        insert into app.till_event (id, tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                    cashier_principal_id, occurred_at, reason, client_ref)
        values (${tillEventId}, ${s.tenant}, ${s.company}, ${s.hq}, ${terminalId}, ${shiftId}, 'no_sale',
                ${cashierId}, '2026-03-01T09:00:00Z', 'change for the float', ${await uuidv7(db.admin)})`;
      await tx`
        insert into app.needs_attention (id, tenant_id, company_id, branch_id, terminal_id, client_ref, payload,
                                         error_code, error_detail, created_at)
        values (${needsAttentionId}, ${s.tenant}, ${s.company}, ${s.hq}, ${terminalId}, ${clientRef},
                ${JSON.stringify({ clientRef, secret: "the whole rejected ticket" })}::text::jsonb,
                'ERR_POS_LIMIT_EXCEEDED', 'line 1 discount exceeds 0.100000', '2026-03-01T17:30:00Z')`;
    });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  const run = (seed: Seed, id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, seed.tenant, seed.human, (tx) =>
      datasetFor(id).run(tx, {
        companyId: seed.company,
        filters: [],
        sort: [],
        limit: 100,
        offset: 0,
        ...params,
      }),
    );

  it("the registry holds the three Phase 6 ids, and 8D's six make thirty-four", () => {
    for (const id of ["shift", "till_event", "needs_attention"]) {
      expect(isDatasetId(id), id).toBe(true);
      expect(DATASETS[id as DatasetId].id, id).toBe(id);
    }
    // 7A's twenty-five (no `pdc` — OD-09 not built) plus these three. A count assertion is what catches a
    // dataset added without a §4.16.2 row (hazard 32); 8D's six move it in 8D's own PR — five in 8D Task 2 (33),
    // `leave_record` in Task 8 (34; contracts round 19, 8D A13 item 1 — ⚠️ OD-13 answered build, A14).
    expect(DATASET_IDS).toHaveLength(34);
  });

  it("each dataset serves exactly amendment A1's row fields, in order", () => {
    expect(fields("shift")).toEqual([
      "shift_id",
      "branch_id",
      "branch_code",
      "terminal_id",
      "terminal_code",
      "cashier_principal_id",
      "cashier_name",
      "opened_at",
      "opened_on",
      "closed_at",
      "closed_principal_id",
      "currency",
      "opening_float",
      "counted_cash",
      "expected_cash",
      "over_short",
      "over_short_document_id",
      "ticket_count",
      "return_count",
      "net_sales_base",
      "no_sale_count",
      "drawer_open_count",
      "void_count",
    ]);
    expect(fields("till_event")).toEqual([
      "till_event_id",
      "shift_id",
      "branch_id",
      "branch_code",
      "terminal_id",
      "terminal_code",
      "kind",
      "ticket_document_id",
      "ticket_number",
      "cashier_principal_id",
      "cashier_name",
      "supervisor_principal_id",
      "reason",
      "occurred_at",
    ]);
    expect(fields("needs_attention")).toEqual([
      "needs_attention_id",
      "branch_id",
      "branch_code",
      "terminal_id",
      "terminal_code",
      "client_ref",
      "error_code",
      "error_detail",
      "resolved_principal_id",
      "resolved_at",
      "resolution_note",
      "created_at",
      "created_on",
      "is_open",
    ]);
  });

  it("every selected key is a declared column and every declared column is selected", async () => {
    // 7B's `assertFieldCoverage` checks a definition against the ROWS; this checks the dataset against itself,
    // so a column declared but not selected (or selected but not declared) fails here with its name.
    for (const id of ["shift", "till_event", "needs_attention"] as DatasetId[]) {
      const rows = await run(s, id);
      expect(rows.length, id).toBeGreaterThan(0);
      expect(Object.keys(rows[0]!), id).toEqual(fields(id));
    }
  });

  it("shift returns one row per shift, money as fixed-decimal strings and every lateral a typed zero", async () => {
    const rows = await run(s, "shift", {
      filters: [{ field: "shift_id", op: "eq", value: shiftId }],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row["shift_id"]).toBe(shiftId);
    expect(row["branch_id"]).toBe(s.hq);
    expect(row["terminal_id"]).toBe(terminalId);
    expect(row["terminal_code"]).toBe("T1");
    expect(row["opening_float"]).toBe("200.0000");
    expect(row["currency"]).toBe("MYR");
    expect(row["cashier_principal_id"]).toBe(cashierId);
    expect(row["opened_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row["closed_at"]).toBeNull();
    expect(row["counted_cash"]).toBeNull();
    expect(row["over_short"]).toBeNull();
    // No ticket posted, so the laterals are zeros of the right TYPE and not nulls: a null renders as an empty
    // cell and a reader cannot tell "no sales" from "no column".
    expect(row["ticket_count"]).toBe(0);
    expect(row["return_count"]).toBe(0);
    expect(row["net_sales_base"]).toBe("0.0000");
    // The till event below is a no-sale on THIS shift; the lateral counts it and nothing else.
    expect(row["no_sale_count"]).toBe(1);
    expect(row["drawer_open_count"]).toBe(0);
    expect(row["void_count"]).toBe(0);
  });

  it("shift filters by branch and by cashier and sorts by opened_at", async () => {
    expect(
      await run(s, "shift", { filters: [{ field: "branch_id", op: "eq", value: branchB }] }),
    ).toEqual([]);
    expect(
      await run(s, "shift", {
        filters: [{ field: "cashier_principal_id", op: "eq", value: cashierId }],
      }),
    ).toHaveLength(2);
    const ascending = await run(s, "shift", { sort: [{ field: "opened_at", dir: "asc" }] });
    expect(ascending.map((r) => r["shift_id"])).toEqual([lateShiftId, shiftId]);
    // The default order is newest first, on the key 6D's history pages on.
    expect((await run(s, "shift")).map((r) => r["shift_id"])).toEqual([shiftId, lateShiftId]);
  });

  it("a DATE range binds to opened_on, in the company's timezone; the same value against opened_at is refused", async () => {
    const late = (
      await run(s, "shift", { filters: [{ field: "shift_id", op: "eq", value: lateShiftId }] })
    )[0]!;
    expect(late["opened_at"]).toBe("2026-03-01T17:30:00Z");
    expect(late["opened_on"]).toBe("2026-03-02"); // Asia/Kuala_Lumpur, as 6D's zReport buckets it
    const on = (day: string) =>
      run(s, "shift", { filters: [{ field: "opened_on", op: "eq", value: day }] });
    expect((await on("2026-03-02")).map((r) => r["shift_id"])).toEqual([lateShiftId]);
    expect(await on("2026-03-01")).toEqual([]);
    expect(
      await run(s, "shift", {
        filters: [
          { field: "opened_on", op: "gte", value: "2026-03-01" },
          { field: "opened_on", op: "lte", value: "2026-03-31" },
        ],
      }),
    ).toHaveLength(1);
    // Every POS date range in §4.16.1 is a `kind: "date"` parameter; 7A's `assertValue` refuses that value
    // against a `timestamp` column, which is the whole reason the companion exists.
    await expect(
      run(s, "shift", { filters: [{ field: "opened_at", op: "gte", value: "2026-01-01" }] }),
    ).rejects.toThrow(/is not a timestamp \(field 'opened_at'\)/);
  });

  it("till_event names its shift, terminal and cashier and filters over its closed kind vocabulary", async () => {
    const rows = await run(s, "till_event");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      till_event_id: tillEventId,
      shift_id: shiftId,
      branch_id: s.hq,
      terminal_code: "T1",
      kind: "no_sale",
      ticket_document_id: null,
      ticket_number: null,
      cashier_principal_id: cashierId,
      supervisor_principal_id: null,
      reason: "change for the float",
      occurred_at: "2026-03-01T09:00:00Z",
    });
    expect(
      await run(s, "till_event", {
        filters: [{ field: "kind", op: "in", value: ["drawer_open", "void"] }],
      }),
    ).toEqual([]);
    expect(
      await run(s, "till_event", { filters: [{ field: "kind", op: "in", value: ["no_sale"] }] }),
    ).toHaveLength(1);
  });

  // A boolean filter's "true" is the regression case: 7A bound it as `$1::boolean`, and postgres.js serialises a
  // boolean-typed parameter as `x === true ? 't' : 'f'`, so the STRING "true" became false and `is_open eq
  // "true"` returned the CLOSED rows (contracts round 15, A16 item 12). `is_matched eq "false"` — the only
  // boolean filter 7A's and 7B's tests used — passed by accident.
  it("needs_attention lists the refused ticket by client_ref, open, with its date companion", async () => {
    const rows = await run(s, "needs_attention");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      needs_attention_id: needsAttentionId,
      branch_id: s.hq,
      terminal_code: "T1",
      client_ref: clientRef,
      error_code: "ERR_POS_LIMIT_EXCEEDED",
      resolved_principal_id: null,
      resolved_at: null,
      created_at: "2026-03-01T17:30:00Z",
      created_on: "2026-03-02",
      is_open: true,
    });
    expect(
      await run(s, "needs_attention", {
        filters: [{ field: "is_open", op: "eq", value: "true" }],
      }),
    ).toHaveLength(1);
    expect(
      await run(s, "needs_attention", {
        filters: [{ field: "is_open", op: "eq", value: "false" }],
      }),
    ).toEqual([]);
    // The `in` form binds an array, and the same serialiser applied to each element (A16 item 12).
    expect(
      await run(s, "needs_attention", {
        filters: [{ field: "is_open", op: "in", value: ["true"] }],
      }),
    ).toHaveLength(1);
    expect(
      await run(s, "needs_attention", {
        filters: [{ field: "is_open", op: "ne", value: "true" }],
      }),
    ).toEqual([]);
    expect(
      await run(s, "needs_attention", {
        filters: [{ field: "created_on", op: "gte", value: "2026-03-02" }],
      }),
    ).toHaveLength(1);
    expect(
      await run(s, "needs_attention", {
        filters: [{ field: "created_on", op: "lt", value: "2026-03-02" }],
      }),
    ).toEqual([]);
  });

  it("needs_attention never exposes the rejected ticket's payload (amendment A1)", async () => {
    expect(datasetFor("needs_attention").columns.map((c) => c.field)).not.toContain("payload");
    // Nor is it SELECTED: a key absent from `columns` but present in the row still reaches a renderer through
    // `Object.keys`, which is how a side channel is built by accident. The row carries the stored payload's
    // marker nowhere.
    const rows = await run(s, "needs_attention");
    expect(Object.keys(rows[0]!)).not.toContain("payload");
    expect(JSON.stringify(rows)).not.toContain("the whole rejected ticket");
    const source = readFileSync(
      fileURLToPath(new URL("../../src/reports/datasets/pos.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/\bna\.payload\b/);
  });

  it("TENANT ISOLATION — the other tenant sees none of these rows", async () => {
    for (const id of ["shift", "till_event", "needs_attention"] as DatasetId[]) {
      expect((await run(s, id)).length, id).toBeGreaterThan(0);
      expect(await run(other, id), id).toEqual([]);
      // Tenant A's company id under tenant B's context: RLS, not the company predicate, empties it.
      expect(await run(other, id, { companyId: s.company }), id).toEqual([]);
    }
  });

  // [7 remediation] — `opened_on` and `created_on` filters compile to bounds on opened_at / created_at
  // (`DatasetColumn.localDateOf`), so migration 0077's `(company_id, opened_at)` and `(company_id, created_at)`
  // indexes seek them. The rows must be exactly the rows the timezone expression selects. The oracle is
  // Postgres's own `(instant at time zone tz)::date`, read per row and compared in the test, for every operator,
  // at instants one microsecond either side of local midnight: in Asia/Kuala_Lumpur (UTC+8, no DST), and in
  // America/Havana on the two days its DST change touches midnight — 8 March 2026, when 00:00 never happens,
  // and 1 November 2026, when 00:00–00:59 happens twice (Postgres reads an ambiguous local time as the LATER
  // instant, so a plain `day::timestamp at time zone tz` would start that day an hour late).
  it("a date-companion range selects exactly what the timezone expression does, at local midnight", async () => {
    const b = await seedTenantV2(db, "7c-datasets-midnight");
    await grantCodes(db, b, { codes: ["pos.report.read", "pos.needs_attention.resolve"] });
    const t = await seedTerminal(db, b, { code: "T1" });
    const cases: { zone: string; days: string[] }[] = [
      { zone: "Asia/Kuala_Lumpur", days: ["2026-03-01", "2026-03-02", "2026-03-03"] },
      { zone: "America/Havana", days: ["2026-03-07", "2026-03-08", "2026-03-09"] },
      { zone: "America/Havana", days: ["2026-10-31", "2026-11-01", "2026-11-02"] },
    ];
    const instants = [
      // Asia/Kuala_Lumpur's midnights of 2 and 3 March.
      "2026-03-01T15:59:59.999999Z",
      "2026-03-01T16:00:00Z",
      "2026-03-02T15:59:59.999999Z",
      "2026-03-02T16:00:00Z",
      // Havana's skipped midnight (00:00 CST → 01:00 CDT at 05:00Z on 8 March) and the next one (04:00Z).
      "2026-03-08T04:59:59.999999Z",
      "2026-03-08T05:00:00Z",
      "2026-03-09T03:59:59.999999Z",
      "2026-03-09T04:00:00Z",
      // Havana's repeated midnight: 00:00 CDT at 04:00Z, then 01:00 CDT falls back to 00:00 CST at 05:00Z.
      "2026-11-01T03:59:59.999999Z",
      "2026-11-01T04:00:00Z",
      "2026-11-01T04:30:00Z",
      "2026-11-01T05:00:00Z",
      "2026-11-02T04:59:59.999999Z",
      "2026-11-02T05:00:00Z",
    ];
    await withTenant(db.migrator, b.tenant, b.system, async (tx) => {
      for (const at of instants) {
        await tx`
          insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id, opened_principal_id,
                                 opened_at, opening_float, currency)
          values (${await uuidv7(db.admin)}, ${b.tenant}, ${b.company}, ${b.hq}, ${t.terminalId},
                  ${t.principalId}, ${at}::timestamptz, '0.0000', 'MYR')`;
        const ref = await uuidv7(db.admin);
        await tx`
          insert into app.needs_attention (id, tenant_id, company_id, branch_id, terminal_id, client_ref,
                                           payload, error_code, error_detail, created_at)
          values (${await uuidv7(db.admin)}, ${b.tenant}, ${b.company}, ${b.hq}, ${t.terminalId}, ${ref},
                  ${JSON.stringify({ clientRef: ref })}::text::jsonb, 'ERR_POS_LIMIT_EXCEEDED', 'probe',
                  ${at}::timestamptz)`;
      }
    });
    const targets = [
      { id: "shift", field: "opened_on", key: "shift_id", table: "shift", instant: "opened_at" },
      {
        id: "needs_attention",
        field: "created_on",
        key: "needs_attention_id",
        table: "needs_attention",
        instant: "created_at",
      },
    ] as const;
    for (const { zone, days } of cases) {
      await withTenant(db.migrator, b.tenant, b.system, async (tx) => {
        await tx`update app.company set timezone = ${zone} where id = ${b.company}`;
      });
      for (const target of targets) {
        // The oracle: each row's local date by the expression the companion's `ref` selects.
        const oracle = await withTenant(
          db.migrator,
          b.tenant,
          b.system,
          (tx) =>
            tx<{ id: string; local: string }[]>`
            select r.id::text as id, ((r.${tx(target.instant)} at time zone c.timezone)::date)::text as local
              from app.${tx(target.table)} r join app.company c on c.id = r.company_id
             where r.company_id = ${b.company}`,
        );
        expect(oracle).toHaveLength(instants.length);
        for (const day of days) {
          for (const op of LOCAL_DATE_OPS) {
            const rows = await run(b, target.id, {
              filters: [{ field: target.field, op, value: day }],
              limit: 1000,
            });
            expect(
              rows.map((r) => r[target.key]).toSorted(),
              `${zone} ${target.field} ${op} ${day}`,
            ).toEqual(
              oracle
                .filter((o) => holdsOn(op, o.local, day))
                .map((o) => o.id)
                .toSorted(),
            );
          }
        }
      }
    }
  });

  it("an unknown id is ERR_REPORT_DATASET_UNKNOWN, not a crash", () => {
    try {
      datasetFor("shifts");
      expect.unreachable("an unknown dataset must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReportError);
      expect((e as ReportError).code).toBe("ERR_REPORT_DATASET_UNKNOWN");
      expect((e as ReportError).detail).toContain("'shifts'");
    }
  });
});
