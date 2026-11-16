import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { salesByCashier, zReport } from "@dulja/db";
import { grantCodes, type Seed } from "@dulja/db/test";
import { uuidv7, withTenant, type Db } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { buildTicket } from "./support/pos";
import { branchActor, staffFixture, type StaffFixture } from "./support/staff";
import { applyBatch } from "@dulja/db";
import type { Sql } from "postgres";

/** The report window: a day either side of the run date. Every sale, open and close below is dated
 *  `now()` and both reports compare dates in the company's timezone, so a fixed calendar-year window
 *  would empty every report from that year's last UTC evening on, and turn R7's empty answers vacuous.
 *  One day either side of the UTC date covers any company offset. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const FROM = day(-1);
const TO = day(1);

describe("6D POS reports — pos.z_report and pos.sales_by_cashier (§4.16.1, §4.16.3)", () => {
  let api: StartedApi;
  let db: Db;
  let f: StaffFixture;
  let shiftId: string;
  /** The `clientRef` of the 10.0000 cash sale, so the refund can point at it — a return with a null
   *  `returnsClientRef` is a BLIND return and branch A refuses those (see the note below this block). */
  let tenRef: string;
  /** Holds pos.report.read at branch A only — the code both reports filter every row by (R7). `s.human`
   *  holds no report code at all (it is 6A's cashier), so reading as it would answer empty everywhere. */
  let reader: string;

  beforeAll(async () => {
    api = await startApi();
    db = api.db;
    f = await staffFixture(api, "zrep");
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.own"],
      principalId: f.cashierA,
      roleCode: "own-z",
      branchIds: [f.branchA],
    });
    reader = await branchActor(db, f.seed, f.branchA, ["pos.report.read"], "z-reader");
    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    // Two cash sales, one card sale, one cash return, then a short close — the smallest corpus in which
    // every line of the report is non-trivial.
    tenRef = crypto.randomUUID();
    await sellInto(shiftId, [
      { unitPrice: "40.0000", tender: "cash" },
      { unitPrice: "10.0000", tender: "cash", clientRef: tenRef },
      { unitPrice: "25.0000", tender: "card" },
    ]);
    await returnInto(shiftId, { unitPrice: "10.0000", tender: "cash", returnsClientRef: tenRef });
    await closeShiftFor(shiftId, "138.0000"); // expected 140 → short 2
  }, 300_000);

  afterAll(async () => {
    await api.stop();
  }); // this file starts its own stack, so it stops it

  const read = <T>(fn: (tx: never) => Promise<T>) =>
    withTenant(db.rw, f.seed.tenant, reader, fn as never) as Promise<T>;

  /** One `applyBatch` of `n` tickets into `shiftId`, through the real path. `opts` are 6A's `buildTicket`
   *  options verbatim — `unitPrice` + `tender`, never a `cashPrice`/`cardPrice` that does not exist
   *  (Task 5 Step 5's first fact). Returns the posted document ids. */
  const sellInto = async (
    shift: string,
    tickets: readonly Parameters<typeof buildTicket>[1][],
  ): Promise<string[]> => {
    const out = await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(
        tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "report-test" },
        {
          terminalId: f.terminalA.terminalId,
          companyId: f.seed.company,
          branchId: f.branchA,
          principalId: f.terminalA.principalId,
        },
        {
          terminalId: f.terminalA.terminalId,
          batchId: crypto.randomUUID(),
          shifts: [],
          tillEvents: [],
          tickets: tickets.map((t) =>
            buildTicket(f.pos, {
              sku: "SKU-A",
              shiftId: shift,
              cashierPrincipalId: f.cashierA,
              ...t,
            }),
          ),
        },
      ),
    );
    expect(out.results.map((r) => r.status)).toEqual(tickets.map(() => "accepted"));
    return out.results.map((r) => r.documentId!);
  };

  /** The same, for one `kind: "return"` ticket. **`returnsClientRef` is required, not optional.** 6C
   *  classifies `kind === "return"` with `returnsClientRef === null` as a BLIND return (6C Task 9 Step 1(b)), which
   *  needs `pos.ticket.return_blind` AND `blind_return_allowed = true`; `staffFixture` sets branch A's
   *  `blind_return_allowed` to false and gives `cashierA` `pos.ticket.return` and not `return_blind`
   *  (6C Task 9 Step 2's `staffFixture`). A refund with a null ref is therefore REFUSED at branch A and every figure below
   *  would be short by it — with `out.results[0].status === "rejected"` as the only clue. 6A's builder
   *  negates quantity, total, tax, discount and the tender together inside itself; nothing is negated here. */
  const returnInto = async (
    shift: string,
    opts: Parameters<typeof buildTicket>[1] & { returnsClientRef: string },
  ): Promise<string> => {
    const [id] = await sellInto(shift, [{ ...opts, kind: "return" }]);
    return id!;
  };

  /** Close `shift` at `counted` through the real sync path — the only way a shift closes (amendment A12),
   *  and the reason there is no `closeShift` fixture (§4.17's note on the `seedShift` row). */
  const closeShiftFor = (shift: string, counted: string, closer = f.cashierA) =>
    withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(
        tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "report-test" },
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
          tillEvents: [],
          shifts: [
            {
              shiftId: shift,
              kind: "close",
              terminalId: f.terminalA.terminalId,
              cashierPrincipalId: closer,
              at: new Date().toISOString(),
              currency: "MYR",
              openingFloat: null,
              countedCash: { amount: counted, currency: "MYR" },
            },
          ],
        },
      ),
    );

  /** A plain human principal with a membership, for the branch-B manager case. Task 5 Step 1 carries the
   *  same helper and the same reason it is test-local rather than a second `fixtures.ts` row (hazard 9). */
  const seedEmployeePrincipal = async (s: Seed, label: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`human:${label}:${s.tenant}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  it("one shiftId returns exactly one Z-report with the shift's own figures", async () => {
    const rows = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    expect(rows).toHaveLength(1);
    const z = rows[0]!;
    expect(z.shiftId).toBe(shiftId);
    // `posFixture` enrols its terminal as `KL01` (6A Task 10 Step 6) and `StaffFixture.terminalA` IS that terminal
    // (6C Task 9 Step 2), so the code is read off the fixture and never written as "T1".
    expect(z.terminalCode).toBe(f.terminalA.code);
    expect(z.currency).toBe("MYR");
    expect(z.openingFloat).toBe("100.0000");
    expect(z.countedCash).toBe("138.0000");
    expect(z.expectedCash).toBe("140.0000");
    expect(z.overShort).toBe("-2.0000");
    expect(z.overShortDocumentId).not.toBeNull();
    expect(z.ticketCount).toBe(3);
    expect(z.returnCount).toBe(1);
  });

  it("the tender lines are the LEDGER's movement per §4.15 account, to the cent", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    const byMethod = Object.fromEntries(z!.tenders.map((t) => [t.method, t]));
    expect(byMethod.cash!.accountCode).toBe("1110");
    expect(byMethod.cash!.amount).toBe("40.0000"); // 40 + 10 − 10 refunded
    expect(byMethod.card!.accountCode).toBe("1120");
    expect(byMethod.card!.amount).toBe("25.0000");
    expect(byMethod.transfer).toBeUndefined(); // no transfer tender in this shift: no row
    expect(byMethod.store_credit).toBeUndefined();
  });

  it("the TILL_OVER_SHORT movement is in cashControl and NOT in the cash tender line", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    const cash = z!.tenders.find((t) => t.method === "cash")!;
    expect(cash.amount).toBe("40.0000"); // NOT 38 — the correction is not a tender
    const tos = z!.cashControl.find((c) => c.documentTypeCode === "TILL_OVER_SHORT")!;
    expect(tos.amount).toBe("-2.0000"); // the drawer LOST 2 to the correction
  });

  it("a date range returns the shift HISTORY under the same code, newest first, keyset-paged", async () => {
    const second = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "5.0000" });
    await closeShiftFor(second, "5.0000");
    const page1 = await read((tx) =>
      zReport(tx, {
        companyId: f.seed.company,
        branchId: f.branchA,
        from: FROM,
        to: TO,
        limit: 1,
      }),
    );
    expect(page1).toHaveLength(1);
    const page2 = await read((tx) =>
      zReport(tx, {
        companyId: f.seed.company,
        branchId: f.branchA,
        from: FROM,
        to: TO,
        limit: 1,
        cursor: { openedAt: page1[0]!.openedAt, shiftId: page1[0]!.shiftId },
      }),
    );
    expect(page2).toHaveLength(1);
    expect(page2[0]!.shiftId).not.toBe(page1[0]!.shiftId);
    expect(page2[0]!.openedAt <= page1[0]!.openedAt).toBe(true);
  });

  it("neither shiftId nor a from/to range is ERR_VALIDATION_FAILED, not a full-table scan", async () => {
    await expect(
      read((tx) => zReport(tx, { companyId: f.seed.company, limit: 50 })),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("the till-event counts are per kind and omit a kind with no events", async () => {
    const [z] = await read((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
    expect(z!.tillEvents).toEqual([]); // this shift had none
  });

  it("salesByCashier reports revenue from the LEDGER, grouped by document.attributed_to", async () => {
    const rows = await read((tx) =>
      salesByCashier(tx, {
        companyId: f.seed.company,
        from: FROM,
        to: TO,
        branchId: f.branchA,
        limit: 50,
      }),
    );
    const mine = rows.find((r) => r.cashierPrincipalId === f.cashierA)!;
    expect(mine.ticketCount).toBe(3);
    expect(mine.returnCount).toBe(1);
    expect(mine.baseCurrency).toBe("MYR");
    // A COMPUTED figure, not a regex: `netSalesBase` is the income-account movement, so read that movement
    // and compare. A regex would pass against a join fan-out that multiplied the figure by the line count,
    // which is exactly the defect Step 2's two-CTE split exists to avoid.
    // `a.type`, NOT `a.account_type` — `app.account_type` is the enum TYPE (plan0A:1484) and `type` is the
    // column (plan0A:1492). The wrong spelling is `column a.account_type does not exist`, which fails the
    // case rather than weakening it, but it is the same typo Step 2's `revenue` CTE must not carry either.
    const [expectedNet] = await db.admin<{ net: string }[]>`
      select (sum(le.base_credit) - sum(le.base_debit))::text as net
        from app.ledger_entry le
        join app.document d on d.id = le.document_id
        join app.account  a on a.id = le.account_id and a.type = 'income'
       where d.attributed_to = ${f.cashierA} and d.shift_id = ${shiftId}`;
    expect(mine.netSalesBase).toBe(expectedNet!.net);
    expect(mine.overShortBase).toBe("-2.0000"); // the shift's correction lands on its closer
  });

  it("a cashier with no tickets in the range does not appear", async () => {
    const rows = await read((tx) =>
      salesByCashier(tx, {
        companyId: f.seed.company,
        from: FROM,
        to: TO,
        limit: 50,
      }),
    );
    expect(rows.map((r) => r.cashierPrincipalId)).not.toContain(f.cashierB);
  });

  it("a branch manager restricted to branch B sees no branch-A shift through either report (test 36)", async () => {
    const mgr = await seedEmployeePrincipal(f.seed, "mgr-b");
    await grantCodes(db, f.seed, {
      codes: ["pos.report.read"],
      principalId: mgr,
      roleCode: "bm-b-z",
      branchIds: [f.branchB],
    });
    const rows = await withTenant(db.rw, f.seed.tenant, mgr, (tx) =>
      zReport(tx as never, { companyId: f.seed.company, shiftId, limit: 50 }),
    );
    expect(rows).toEqual([]); // Form A's restrictive policy on app.shift, not a WHERE clause here
  });

  it("R7. pos.report.read at B plus any role covering A reads no branch-A shift or sale through either report", async () => {
    // `branch_isolation` admits a branch where the caller holds ANY role, so before R7 both principals
    // below read branch A's float, count, over/short and per-cashier sales through a code granted at B.
    const split = await branchActor(db, f.seed, f.branchB, ["pos.report.read"], "z-split");
    await grantCodes(db, f.seed, {
      codes: ["pos.ticket.sell"],
      principalId: split,
      roleCode: "z-split-sell-a",
      branchIds: [f.branchA],
    });
    const wide = await branchActor(db, f.seed, f.branchB, ["pos.report.read"], "z-wide");
    await grantCodes(db, f.seed, {
      codes: ["hr.employee.read"],
      principalId: wide,
      roleCode: "z-wide-hr", // company-wide: every branch is visible
    });
    // `reader` (pos.report.read at A) is the control: the same three reads in the same window DO return
    // branch A's shift and sales to it, so the empty answers for the other two are R7's filter and never
    // an empty range.
    for (const [p, inGrant] of [
      [reader, true],
      [split, false],
      [wide, false],
    ] as const) {
      const as = <T>(fn: (tx: never) => Promise<T>) =>
        withTenant(db.rw, f.seed.tenant, p, fn as never) as Promise<T>;
      // The shift IS visible to this principal, so an empty report below is the code's filter, not RLS's.
      const visible = await as(
        (tx: Sql) => tx<{ n: number }[]>`
        select count(*)::int as n from app.shift where id = ${shiftId}`,
      );
      expect(visible[0]!.n).toBe(1);
      const one = await as((tx) => zReport(tx, { companyId: f.seed.company, shiftId, limit: 50 }));
      expect(one.map((z) => z.shiftId)).toEqual(inGrant ? [shiftId] : []);
      const history = await as((tx) =>
        zReport(tx, {
          companyId: f.seed.company,
          branchId: f.branchA,
          from: FROM,
          to: TO,
          limit: 50,
        }),
      );
      expect(history.map((z) => z.shiftId)).toEqual(
        inGrant ? expect.arrayContaining([shiftId]) : [],
      );
      const sales = await as((tx) =>
        salesByCashier(tx, {
          companyId: f.seed.company,
          from: FROM,
          to: TO,
          limit: 50,
        }),
      );
      expect(
        sales.filter((r) => r.branchId === f.branchA).map((r) => r.cashierPrincipalId),
      ).toEqual(inGrant ? expect.arrayContaining([f.cashierA]) : []);
    }
  });
  it("includes a manager who closes but sells no tickets, and filters that actor correctly", async () => {
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.close_any"],
      principalId: f.supervisorA,
      roleCode: "report-manager-close",
      branchIds: [f.branchA],
    });
    const shift = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "0.0000" });
    const out = await closeShiftFor(shift, "1.0000", f.supervisorA);
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const rows = await read((tx) =>
      salesByCashier(tx, {
        companyId: f.seed.company,
        from: FROM,
        to: TO,
        cashierPrincipalId: f.supervisorA,
        limit: 50,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cashierPrincipalId: f.supervisorA,
      branchId: f.branchA,
      ticketCount: 0,
      returnCount: 0,
      netSalesBase: "0.0000",
      discountBase: "0.0000",
      overShortBase: "1.0000",
    });
  });
});
