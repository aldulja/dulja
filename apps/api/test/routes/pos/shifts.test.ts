import { encodeCursor } from "@dulja/contracts";
import { ShiftList } from "@dulja/contracts/pos/shift";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedShift, seedTerminal, uuidv7 } from "@dulja/db/test";
import { applyBatch, withTenant } from "@dulja/db"; // the PRODUCTION withTenant(sql, ctx, fn)
import { startApi, type StartedApi } from "../../support/app";
import { buildOpenApiDocument } from "../../../src/openapi";
import type { BatchResult } from "@dulja/sync";
import { buildTicket, syncRequest } from "../../../../../tests/invariants/support/pos";
import { staffFixture, type StaffFixture } from "../../../../../tests/invariants/support/staff";

const problemOf = async (response: Response) =>
  (await response.json()) as { code: string; detail: string };
const rowsOf = async <T>(res: Response) => ((await res.json()) as { items: T[] }).items;
/** The report window: a day either side of the run date. The corpus is dated `now()` (sales, opens and
 *  closes) and both reports compare dates in the company's timezone, so a fixed calendar-year window
 *  would empty every report from that year's last UTC evening on, and turn the R7 cases' "no branch-B
 *  row" assertions vacuous. One day either side of the UTC date covers any company offset. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const RANGE = `from=${day(-1)}&to=${day(1)}`;

describe("GET /v1/companies/:companyId/shifts and the two pos report GETs (6D T7)", () => {
  let api: StartedApi;
  let f: StaffFixture;
  let reader: string; // holds pos.report.read at branch A
  let nobody: string; // holds nothing
  let managerB: string; // holds pos.report.read at branch B only
  let closedShift: string;
  let openShift: string;
  // R7: three principals whose `branch_isolation` visibility is WIDER than their `pos.report.read` grant.
  let splitReader: string; // pos.report.read at A, and a cashier role (pos.ticket.sell) at B
  let wideReader: string; // pos.report.read at A, and a company-wide role without the code
  let mirrorReader: string; // pos.report.read at B, and a cashier role at A
  let shiftB: string; // a closed branch-B shift, 3.00 short, with one till event

  const principal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      { tenantId: f.seed.tenant, actorId: f.seed.system, requestId: "shift-routes" },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`human:${label}:${f.seed.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${f.seed.tenant}, ${id})`;
      },
    );
    return id;
  };

  const sync = (body: Record<string, unknown>) =>
    withTenant(
      api.db.rw,
      { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "shift-routes" },
      (tx) =>
        applyBatch(
          tx,
          { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "shift-routes" },
          {
            terminalId: f.terminalA.terminalId,
            companyId: f.seed.company,
            branchId: f.branchA,
            principalId: f.terminalA.principalId,
          },
          {
            terminalId: f.terminalA.terminalId,
            batchId: crypto.randomUUID(),
            tickets: [],
            shifts: [],
            tillEvents: [],
            ...body,
          },
        ),
    );

  beforeAll(async () => {
    api = await startApi();
    f = await staffFixture(api, "shiftroutes");

    reader = await principal("shift-reader");
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"],
      principalId: reader,
      roleCode: "sr-a",
      branchIds: [f.branchA],
    });
    nobody = await principal("shift-nobody");
    managerB = await principal("shift-mgr-b");
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"],
      principalId: managerB,
      roleCode: "sr-b",
      branchIds: [f.branchB],
    });
    await grantCodes(api.db, f.seed, {
      codes: ["pos.shift.own"],
      principalId: f.cashierA,
      roleCode: "sr-own",
      branchIds: [f.branchA],
    });

    // One closed shift with a 2.00 short, and one still open, so the list has both states.
    closedShift = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sync({
      tickets: [
        buildTicket(f.pos, {
          sku: "SKU-A",
          cashierPrincipalId: f.cashierA,
          shiftId: closedShift,
          unitPrice: "40.0000",
          tender: "cash",
        }),
      ],
    });
    await sync({
      tillEvents: [
        {
          clientRef: crypto.randomUUID(),
          shiftId: closedShift,
          kind: "no_sale",
          ticketClientRef: null,
          cashierPrincipalId: f.cashierA,
          supervisorPrincipalId: null,
          occurredAt: "2026-01-15T01:00:00.000Z",
        },
        {
          clientRef: crypto.randomUUID(),
          shiftId: closedShift,
          kind: "drawer_open",
          ticketClientRef: null,
          cashierPrincipalId: f.cashierA,
          supervisorPrincipalId: null,
          occurredAt: "2026-01-15T02:00:00.000Z",
        },
      ],
    });
    await sync({
      shifts: [
        {
          shiftId: closedShift,
          kind: "close",
          terminalId: f.terminalA.terminalId,
          cashierPrincipalId: f.cashierA,
          at: new Date().toISOString(),
          currency: "MYR",
          openingFloat: null,
          countedCash: { amount: "138.0000", currency: "MYR" },
        },
      ],
    });
    openShift = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "5.0000" });

    // R7's corpus. Each principal's assignments make `app.actor_in_branch` true at a branch where it does
    // NOT hold pos.report.read, so `branch_isolation` alone shows it rows the report code does not cover.
    splitReader = await principal("shift-split");
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"],
      principalId: splitReader,
      roleCode: "sr-split-report-a",
      branchIds: [f.branchA],
    });
    await grantCodes(api.db, f.seed, {
      codes: ["pos.ticket.sell"],
      principalId: splitReader,
      roleCode: "sr-split-sell-b",
      branchIds: [f.branchB],
    });
    wideReader = await principal("shift-wide");
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"],
      principalId: wideReader,
      roleCode: "sr-wide-report-a",
      branchIds: [f.branchA],
    });
    await grantCodes(api.db, f.seed, {
      codes: ["hr.employee.read"],
      principalId: wideReader,
      roleCode: "sr-wide-hr", // no branchIds: company-wide, so every branch is visible
    });
    mirrorReader = await principal("shift-mirror");
    await grantCodes(api.db, f.seed, {
      codes: ["pos.report.read"],
      principalId: mirrorReader,
      roleCode: "sr-mirror-report-b",
      branchIds: [f.branchB],
    });
    await grantCodes(api.db, f.seed, {
      codes: ["pos.ticket.sell"],
      principalId: mirrorReader,
      roleCode: "sr-mirror-sell-a",
      branchIds: [f.branchA],
    });

    // A branch-B drawer: opened, one no-sale, closed 3.00 short. Written as the system principal because
    // a terminal at B has no stock to sell from, and the close is the four columns `shift_close_is_atomic`
    // demands in one statement; the figures are only what R7's reads must not show to the wrong reader.
    const terminalB = await seedTerminal(api.db, f.seed, { code: "KL02", branchId: f.branchB });
    shiftB = await seedShift(api.db, f.seed, {
      terminalId: terminalB.terminalId,
      cashierPrincipalId: f.cashierB,
      branchId: f.branchB,
      openingFloat: "50.0000",
    });
    await withTenant(
      api.db.migrator,
      { tenantId: f.seed.tenant, actorId: f.seed.system, requestId: "shift-routes-b" },
      async (tx) => {
        await tx`insert into app.till_event (tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                             cashier_principal_id, occurred_at, client_ref)
                 values (${f.seed.tenant}, ${f.seed.company}, ${f.branchB}, ${terminalB.terminalId},
                         ${shiftB}, 'no_sale', ${f.cashierB}, now(), ${crypto.randomUUID()})`;
        await tx`update app.shift
                    set closed_at = now(), closed_principal_id = ${f.cashierB},
                        counted_cash = 47, expected_cash = 50, over_short = -3
                  where id = ${shiftB}`;
      },
    );
  }, 300_000);

  afterAll(async () => {
    await api.stop();
  });

  const base = () => `/v1/companies/${f.seed.company}`;

  it("1. the list answers 200 with the envelope, and every money member is { amount, currency }", async () => {
    const res = await api.request({ method: "GET", path: `${base()}/shifts?limit=50`, as: reader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        shiftId: string;
        openingFloat: { amount: string; currency: string };
        overShort: { amount: string } | null;
      }[];
      next_cursor: string | null;
    };
    expect(body.items.map((i) => i.shiftId)).toEqual(
      expect.arrayContaining([closedShift, openShift]),
    );
    for (const item of body.items) {
      // MoneySchema's own form: a decimal string at scale 4, never a JSON number (Constraint 2).
      expect(item.openingFloat.amount).toMatch(/^-?\d+\.\d{4}$/);
      expect(item.openingFloat.currency).toBe("MYR");
    }
    expect(body.items.find((i) => i.shiftId === openShift)!.overShort).toBeNull();
    expect(body.next_cursor).toBeNull(); // two shifts, limit 50
  });

  it("2. a principal holding no code is 403 ERR_RBAC_FORBIDDEN", async () => {
    const res = await api.request({ method: "GET", path: `${base()}/shifts?limit=50`, as: nobody });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("3. the detail read is 200 for a closed shift and 404 for an unknown id", async () => {
    const ok = await api.request({
      method: "GET",
      path: `${base()}/shifts/${closedShift}`,
      as: reader,
    });
    expect(ok.status).toBe(200);
    const shift = (await ok.json()) as {
      overShort: { amount: string };
      countedCash: { amount: string };
    };
    expect(shift.overShort.amount).toBe("-2.0000");
    expect(shift.countedCash.amount).toBe("138.0000");

    const missing = await api.request({
      method: "GET",
      path: `${base()}/shifts/${await uuidv7(api.db.admin)}`,
      as: reader,
    });
    expect(missing.status).toBe(404);
    expect((await problemOf(missing)).code).toBe("ERR_NOT_FOUND");
  });

  it("4. the till-event read is 200, oldest first, and 404 for a shift that is not there", async () => {
    const res = await api.request({
      method: "GET",
      path: `${base()}/shifts/${closedShift}/till-events?limit=50`,
      as: reader,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { kind: string; occurredAt: string }[] };
    expect(body.items.map((e) => e.kind)).toEqual(["no_sale", "drawer_open"]); // ascending occurred_at
    const missing = await api.request({
      method: "GET",
      path: `${base()}/shifts/${await uuidv7(api.db.admin)}/till-events?limit=50`,
      as: reader,
    });
    expect(missing.status).toBe(404);
  });

  it("5. pos.z_report serves one shift, a range, and refuses neither with 400", async () => {
    const one = await api.request({
      method: "GET",
      path: `${base()}/reports/pos.z_report?shiftId=${closedShift}&limit=10`,
      as: reader,
    });
    expect(one.status).toBe(200);
    const z = (await one.json()) as {
      items: {
        expectedCash: { amount: string };
        tenders: { method: string; amount: { amount: string } }[];
      }[];
    };
    expect(z.items).toHaveLength(1);
    expect(z.items[0]!.expectedCash.amount).toBe("140.0000");
    expect(z.items[0]!.tenders.find((t) => t.method === "cash")!.amount.amount).toBe("40.0000");

    const history = await api.request({
      method: "GET",
      path: `${base()}/reports/pos.z_report?${RANGE}&limit=10`,
      as: reader,
    });
    expect(history.status).toBe(200);
    expect(((await history.json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);

    // NEITHER parameter. There is **one** guard and this pins where it lives: `ZReportQuery` is a plain
    // `ZodObject` (Step 2's note on 0b:4317 — a `.refine` would make it a `ZodEffects` and
    // `@hono/zod-openapi` derives query parameters from a `ZodObject`), so Zod admits the request and
    // `zReport`'s own `ReportParamError` fires inside `withTenant`. Step 4's `catch` translates it with
    // `new AppError(e.code, e.detail)`, which is the 400 below. **If this ever answers 500**, the handler
    // lost its `instanceof ReportParamError` branch — do not re-add a `.refine` to compensate.
    const neither = await api.request({
      method: "GET",
      path: `${base()}/reports/pos.z_report?limit=10`,
      as: reader,
    });
    expect(neither.status).toBe(400);
    const problem = await problemOf(neither);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("shiftId");
  });

  it("6. the branch-B manager reads an empty list through both reports (test 36 at the API surface)", async () => {
    const sales = await api.request({
      method: "GET",
      path: `${base()}/reports/pos.sales_by_cashier?${RANGE}&limit=50`,
      as: managerB,
    });
    expect(sales.status).toBe(200);
    // Nothing of branch A's. Branch B's own closed shift (R7's corpus) is this manager's to read.
    const items = ((await sales.json()) as { items: { branchId: string }[] }).items;
    expect(items.filter((r) => r.branchId !== f.branchB)).toEqual([]);

    // 200-with-nothing on the collection, 404 on the row: Form A makes branch A's shift invisible, and
    // "not found" rather than "forbidden" is the honest answer to a row you cannot see.
    const detail = await api.request({
      method: "GET",
      path: `${base()}/shifts/${closedShift}`,
      as: managerB,
    });
    expect(detail.status).toBe(404);
  });

  // R7 — `staffBranchGate` admits a caller who holds pos.report.read in ANY branch, and `branch_isolation`
  // shows every branch the caller holds ANY role at, so neither bounds a row to the report code. Before the
  // fix each of the five reads below returned branch B's float, count, over/short and events to a reader
  // whose pos.report.read covers branch A only. The detail reads answer what the sibling staff details
  // answer for a visible row outside the grant (employees, cashiers): 403, not the row.
  for (const [label, as] of [
    ["a cashier role at B", () => splitReader],
    ["a company-wide role without the code", () => wideReader],
  ] as const) {
    it(`R7. pos.report.read at A plus ${label} reads no branch-B shift, event or report row`, async () => {
      const list = await api.request({
        method: "GET",
        path: `${base()}/shifts?limit=50`,
        as: as(),
      });
      expect(list.status).toBe(200);
      const ids = (await rowsOf<{ shiftId: string }>(list)).map((i) => i.shiftId);
      expect(ids).toContain(closedShift); // branch A, inside the grant
      expect(ids).not.toContain(shiftB);

      const filtered = await api.request({
        method: "GET",
        path: `${base()}/shifts?filter[branchId][eq]=${f.branchB}&limit=50`,
        as: as(),
      });
      expect(filtered.status).toBe(200);
      expect(await rowsOf(filtered)).toEqual([]);

      const own = await api.request({
        method: "GET",
        path: `${base()}/shifts/${closedShift}`,
        as: as(),
      });
      expect(own.status).toBe(200);
      for (const path of [`/shifts/${shiftB}`, `/shifts/${shiftB}/till-events?limit=50`]) {
        const res = await api.request({ method: "GET", path: base() + path, as: as() });
        expect(res.status, path).toBe(403);
        expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
      }

      const one = await api.request({
        method: "GET",
        path: `${base()}/reports/pos.z_report?shiftId=${shiftB}&limit=10`,
        as: as(),
      });
      expect(one.status).toBe(200);
      expect(await rowsOf(one)).toEqual([]);
      const history = await api.request({
        method: "GET",
        path: `${base()}/reports/pos.z_report?${RANGE}&limit=50`,
        as: as(),
      });
      expect(history.status).toBe(200);
      const zs = await rowsOf<{ shiftId: string; branchId: string }>(history);
      expect(zs.map((z) => z.shiftId)).toContain(closedShift);
      expect(zs.filter((z) => z.branchId === f.branchB)).toEqual([]);

      const sales = await api.request({
        method: "GET",
        path: `${base()}/reports/pos.sales_by_cashier?${RANGE}&limit=50`,
        as: as(),
      });
      expect(sales.status).toBe(200);
      const byCashier = await rowsOf<{ cashierPrincipalId: string; branchId: string }>(sales);
      expect(byCashier.some((r) => r.cashierPrincipalId === f.cashierA)).toBe(true);
      expect(byCashier.filter((r) => r.branchId === f.branchB)).toEqual([]);
    });
  }

  it("R7. pos.report.read at B plus a cashier role at A reads B and none of A's sales or shifts", async () => {
    // The mirror, because branch A is where the corpus's TICKETS are: this is the case that proves the
    // sales-by-cashier revenue and the Z-report tenders, not only the shift columns, follow the grant.
    const list = await api.request({
      method: "GET",
      path: `${base()}/shifts?limit=50`,
      as: mirrorReader,
    });
    expect(list.status).toBe(200);
    expect((await rowsOf<{ shiftId: string }>(list)).map((i) => i.shiftId)).toEqual([shiftB]);

    const detail = await api.request({
      method: "GET",
      path: `${base()}/shifts/${shiftB}`,
      as: mirrorReader,
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { overShort: { amount: string } }).overShort.amount).toBe(
      "-3.0000",
    );
    const events = await api.request({
      method: "GET",
      path: `${base()}/shifts/${shiftB}/till-events?limit=50`,
      as: mirrorReader,
    });
    expect(events.status).toBe(200);
    expect((await rowsOf<{ kind: string }>(events)).map((e) => e.kind)).toEqual(["no_sale"]);
    for (const path of [`/shifts/${closedShift}`, `/shifts/${closedShift}/till-events?limit=50`]) {
      const res = await api.request({ method: "GET", path: base() + path, as: mirrorReader });
      expect(res.status, path).toBe(403);
    }

    const z = await api.request({
      method: "GET",
      path: `${base()}/reports/pos.z_report?shiftId=${closedShift}&limit=10`,
      as: mirrorReader,
    });
    expect(z.status).toBe(200);
    expect(await rowsOf(z)).toEqual([]);

    const sales = await api.request({
      method: "GET",
      path: `${base()}/reports/pos.sales_by_cashier?${RANGE}&limit=50`,
      as: mirrorReader,
    });
    expect(sales.status).toBe(200);
    expect(
      await rowsOf<{ cashierPrincipalId: string; branchId: string; overShort: { amount: string } }>(
        sales,
      ),
    ).toEqual([
      expect.objectContaining({
        cashierPrincipalId: f.cashierB,
        branchId: f.branchB,
        overShort: { amount: "-3.0000", currency: "MYR" },
      }),
    ]);
  });

  it("validates keyset values before SQL and pages every shift exactly once with ISO timestamps", async () => {
    const malformed = encodeCursor({ k: ["not-a-timestamp"], id: closedShift });
    for (const path of [
      `/shifts?cursor=${malformed}`,
      `/shifts/${closedShift}/till-events?cursor=${malformed}`,
      `/reports/pos.z_report?shiftId=${closedShift}&cursor=${malformed}`,
    ]) {
      const res = await api.request({ method: "GET", path: base() + path, as: reader });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const res = await api.request({
        method: "GET",
        path: `${base()}/shifts?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        as: reader,
      });
      expect(res.status).toBe(200);
      const page = ShiftList.parse(await res.json());
      expect(page.items).toHaveLength(1);
      ids.push(page.items[0]!.shiftId);
      cursor = page.next_cursor;
      expect(ids.length).toBeLessThan(10);
    } while (cursor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([closedShift, openShift]));
  });

  it("the till-event 200 media type is { schema } alone, with no stray member in the OpenAPI document", () => {
    // The recovered route carried `{ schema: TillEventList, TillEventSchema }`, and @hono/zod-openapi copies
    // every member of a media-type object into the document, so a Zod object leaked into openapi.json.
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, { get: { responses: Record<string, { content: object }> } }>;
    };
    const media =
      doc.paths["/v1/companies/{companyId}/shifts/{shiftId}/till-events"]!.get.responses["200"]!
        .content;
    expect(Object.keys((media as Record<string, object>)["application/json"]!)).toEqual(["schema"]);
  });

  describe("keyset cursors keep the microsecond (6D T7, PR 12 plan audit)", () => {
    // Two shifts opened, and two till events, 400 µs apart inside ONE millisecond. The sync path cannot write
    // these — it binds a till's `at` / `occurredAt` through a JS Date and stores whole milliseconds — so they
    // stand for rows whose instant SQL wrote (`now()`, as `seedShift` does). A cursor cut to the millisecond
    // (`toISOString`) landed before the row it had passed: the newest-first reads skipped the older shift,
    // and the oldest-first event stream served the first event again on every page.
    let terminal: string;
    let early: string;
    let late: string;
    const events = [crypto.randomUUID(), crypto.randomUUID()] as const;

    beforeAll(async () => {
      terminal = (await seedTerminal(api.db, f.seed, { code: "KL09", branchId: f.branchA }))
        .terminalId;
      early = await uuidv7(api.db.admin);
      late = await uuidv7(api.db.admin);
      await withTenant(
        api.db.migrator,
        { tenantId: f.seed.tenant, actorId: f.seed.system, requestId: "shift-cursor-us" },
        async (tx) => {
          // `::text::timestamptz`, as the routes bind a cursor: a `$n::timestamptz` parameter goes through a
          // JS Date in postgres.js and would store the very millisecond this corpus must not have. Closed,
          // a year back and over_short 0, so no other case's window, list or shortfall sees them.
          for (const [id, at] of [
            [early, "2025-03-01T10:00:00.000100Z"],
            [late, "2025-03-01T10:00:00.000500Z"],
          ] as const) {
            await tx`insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id,
                                            opened_principal_id, opened_at, opening_float, currency,
                                            closed_at, closed_principal_id, counted_cash, expected_cash,
                                            over_short)
                     values (${id}, ${f.seed.tenant}, ${f.seed.company}, ${f.branchA}, ${terminal},
                             ${f.cashierA}, ${at}::text::timestamptz, 0, 'MYR',
                             ${at}::text::timestamptz + interval '1 hour', ${f.cashierA}, 0, 0, 0)`;
          }
          for (const [ref, at] of [
            [events[0], "2025-03-01T10:00:01.000100Z"],
            [events[1], "2025-03-01T10:00:01.000500Z"],
          ] as const) {
            await tx`insert into app.till_event (tenant_id, company_id, branch_id, terminal_id, shift_id,
                                                 kind, cashier_principal_id, occurred_at, client_ref)
                     values (${f.seed.tenant}, ${f.seed.company}, ${f.branchA}, ${terminal}, ${early},
                             'no_sale', ${f.cashierA}, ${at}::text::timestamptz, ${ref})`;
          }
        },
      );
      // The corpus is what it claims: both pairs share a millisecond and differ in the microsecond.
      const stored = await api.db.admin<{ at: string }[]>`
        select to_char(opened_at at time zone 'UTC', 'HH24:MI:SS.US') as at from app.shift
         where id in (${early}, ${late})
        union all
        select to_char(occurred_at at time zone 'UTC', 'HH24:MI:SS.US') from app.till_event
         where client_ref in (${events[0]}, ${events[1]})
        order by 1`;
      expect(stored.map((r) => r.at)).toEqual([
        "10:00:00.000100",
        "10:00:00.000500",
        "10:00:01.000100",
        "10:00:01.000500",
      ]);
    });

    /** Follows `next_cursor` one row at a time; six pages is far past the two rows, so a cursor that never
     *  advances ends here rather than hanging the suite. */
    const walk = async <T>(path: string, idOf: (item: T) => string) => {
      const ids: string[] = [];
      const shown: T[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 6; page += 1) {
        const res = await api.request({
          method: "GET",
          path: `${base()}${path}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
          as: reader,
        });
        expect(res.status, path).toBe(200);
        const body = (await res.json()) as { items: T[]; next_cursor: string | null };
        shown.push(...body.items);
        ids.push(...body.items.map(idOf));
        cursor = body.next_cursor;
        if (cursor === null) break;
      }
      return { ids, shown };
    };

    it("the shift list pages both shifts of one millisecond, newest first", async () => {
      const { ids, shown } = await walk<{ shiftId: string; openedAt: string }>(
        `/shifts?filter[terminalId][eq]=${terminal}`,
        (s) => s.shiftId,
      );
      expect(ids).toEqual([late, early]);
      // The DTO keeps its millisecond ISO form; only the cursor carries the microsecond.
      expect(shown.map((s) => s.openedAt)).toEqual([
        "2025-03-01T10:00:00.000Z",
        "2025-03-01T10:00:00.000Z",
      ]);
    });

    it("the Z-report history pages both shifts of one millisecond, newest first", async () => {
      const { ids, shown } = await walk<{ shiftId: string; openedAt: string }>(
        `/reports/pos.z_report?branchId=${f.branchA}&from=2025-02-28&to=2025-03-02`,
        (z) => z.shiftId,
      );
      expect(ids).toEqual([late, early]);
      expect(shown.map((z) => z.openedAt)).toEqual([
        "2025-03-01T10:00:00.000Z",
        "2025-03-01T10:00:00.000Z",
      ]);
    });

    it("the till-event stream pages both events of one millisecond once each, oldest first", async () => {
      const { ids, shown } = await walk<{ clientRef: string; occurredAt: string }>(
        `/shifts/${early}/till-events?`,
        (e) => e.clientRef,
      );
      expect(ids).toEqual([events[0], events[1]]);
      expect(shown.map((e) => e.occurredAt)).toEqual([
        "2025-03-01T10:00:01.000Z",
        "2025-03-01T10:00:01.000Z",
      ]);
    });
  });

  it("a signed close carrying the till's own expectedCash or overShort is refused whole and closes nothing (ADR 0063)", async () => {
    // ADR 0063: the till sends the count and nothing else; the server derives expected and over/short, and
    // either arriving in a payload is REFUSED. A non-strict schema stripped them and answered `accepted`.
    const close = {
      shiftId: openShift,
      kind: "close",
      terminalId: f.terminalA.terminalId,
      cashierPrincipalId: f.cashierA,
      at: new Date().toISOString(),
      currency: "MYR",
      openingFloat: null,
      countedCash: { amount: "5.0000", currency: "MYR" },
    };
    const post = (shift: Record<string, unknown>) =>
      syncRequest(api, f.terminalA, {
        method: "POST",
        path: "/v1/sync/tickets",
        body: {
          terminalId: f.terminalA.terminalId,
          batchId: crypto.randomUUID(),
          tickets: [],
          shifts: [shift],
          tillEvents: [],
        },
      });
    const closedAt = async () =>
      (
        await api.db.admin<{ closed_at: string | null }[]>`
          select closed_at::text from app.shift where id = ${openShift}`
      )[0]!.closed_at;

    for (const figure of [
      { expectedCash: { amount: "5.0000", currency: "MYR" } },
      { overShort: { amount: "0.0000", currency: "MYR" } },
    ]) {
      const refused = await post({ ...close, ...figure });
      expect(refused.status, Object.keys(figure).join()).toBe(400);
      expect((await problemOf(refused)).code).toBe("ERR_VALIDATION_FAILED");
      expect(await closedAt()).toBeNull();
    }

    // The control: the same close carrying the count alone is taken, so the refusals above were the field's.
    const taken = await post(close);
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as BatchResult).shiftResults).toEqual([
      { ref: `${openShift}:close`, status: "accepted", error: null },
    ]);
    expect(await closedAt()).not.toBeNull();
  });
});
