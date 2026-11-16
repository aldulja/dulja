import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "@dulja/db";
import { reverseDocument } from "@dulja/db"; // 1A, packages/db/src/posting/reverse.ts
import { resolveAccountByCode } from "@dulja/db"; // Step 2
import { grantCodes, seedEmployee, seedCashier } from "@dulja/db/test";
import { withTenant, type Db } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { buildTicket } from "./support/pos";
import { staffFixture, type StaffFixture } from "./support/staff";

describe("6D shift close — the derivation, the sign and the posting (test 21's unit half, ADR 0063)", () => {
  let db: Db;
  let f: StaffFixture; // 6C's world: two branches, three cashiers, one terminal each
  let api: StartedApi;

  beforeAll(async () => {
    api = await startApi(); // 6A's spelling, from apps/api/test/support/app
    f = await staffFixture(api, "close");
    db = api.db;
    // The closer needs pos.shift.own for their OWN shift. `seedCashier` grants exactly `opts.permissions`
    // (6C), and staffFixture's cashierA holds sell/discount/return — NOT the shift codes. Granting here
    // rather than widening 6C's fixture keeps 6C's own limit tests asserting the authority they assert.
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.own"],
      principalId: f.cashierA,
      roleCode: "own-shift",
      branchIds: [f.branchA],
    });
  }, 300_000);

  // This file starts its own container and its own API, so it stops them. §3.7.1's one-per-file rule.
  afterAll(async () => {
    await api.stop();
  });

  /**
   * Sell `amounts` as cash tickets into `shiftId` through the REAL apply path, and return the document ids.
   * Never `insert into app.ledger_entry`: the whole value of test 21 is that the ledger got there by
   * posting, and a fixture that wrote entries directly would prove nothing (hazard 22).
   *
   * **`unitPrice` + `tender`, never a `cashPrice` option.** 6A's `buildTicket` takes
   * `{ sku, quantity, unitPrice, discount, tender, kind, clientRef, shiftId, cashierPrincipalId,
   * customerId, newCustomer, returnsClientRef, events }` (6A Task 10 Step 6) and derives the single tender's
   * amount as `unitPrice × quantity − discount`, tax-inclusive. With the default `quantity` of `1.000000`
   * and no discount, `unitPrice: "40.0000"` is a ticket whose one cash tender is `40.0000` — which is what
   * these cases mean. §4.17.1 forbids widening 6A's signature, and nothing here needs it widened.
   */
  const sellCash = async (shiftId: string, amounts: string[]): Promise<string[]> => {
    const out = await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(
        tx as never,
        {
          tenantId: f.seed.tenant,
          actorId: f.terminalA.principalId,
          requestId: "shift-close-test",
        },
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
          tickets: amounts.map((a) =>
            buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: a, tender: "cash" }),
          ),
        },
      ),
    );
    expect(out.results.map((r) => r.status)).toEqual(amounts.map(() => "accepted"));
    return out.results.map((r) => r.documentId!);
  };

  /** A close whose `countedCash` bag is passed through verbatim, so the two malformed cases can send null
   *  and a wrong currency without `close`'s string parameter getting in the way. */
  const closeRaw = (shiftId: string, countedCash: { amount: string; currency: string } | null) =>
    withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(
        tx as never,
        {
          tenantId: f.seed.tenant,
          actorId: f.terminalA.principalId,
          requestId: "shift-close-test",
        },
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
              shiftId,
              kind: "close",
              terminalId: f.terminalA.terminalId,
              cashierPrincipalId: f.cashierA,
              at: new Date().toISOString(),
              currency: "MYR",
              openingFloat: null,
              countedCash,
            },
          ],
        },
      ),
    );

  const close = (shiftId: string, counted: string, closer = f.cashierA) =>
    withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(
        tx as never,
        {
          tenantId: f.seed.tenant,
          actorId: f.terminalA.principalId,
          requestId: "shift-close-test",
        },
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
              shiftId,
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

  it("expected_cash is opening_float plus the 1110 net of the shift's posted tickets (ADR 0063)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["25.0000", "10.5000"]);
    const out = await close(shiftId, "135.5000");
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [row] = await db.admin<
      {
        expected_cash: string;
        counted_cash: string;
        over_short: string;
        closed_at: string;
        closed_principal_id: string;
        over_short_document_id: string | null;
      }[]
    >`select expected_cash::text, counted_cash::text, over_short::text, closed_at::text,
                closed_principal_id::text, over_short_document_id::text from app.shift where id = ${shiftId}`;
    expect(row!.expected_cash).toBe("135.5000");
    expect(row!.counted_cash).toBe("135.5000");
    expect(row!.over_short).toBe("0.0000");
    expect(row!.closed_principal_id).toBe(f.cashierA);
    expect(row!.over_short_document_id).toBeNull(); // an exact count posts NOTHING (Step 4)
  });

  it("an OVER drawer debits 1110 and credits 5120, and over_short is POSITIVE", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["20.0000"]);
    const out = await close(shiftId, "123.0000"); // expected 120, counted 123 → over 3
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [sh] = await db.admin<{ over_short: string; doc: string }[]>`
      select over_short::text, over_short_document_id::text as doc from app.shift where id = ${shiftId}`;
    expect(sh!.over_short).toBe("3.0000");
    expect(sh!.doc).not.toBeNull();

    const legs = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, le.debit::text, le.credit::text
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${sh!.doc} order by a.code`;
    expect(legs).toEqual([
      { code: "1110", debit: "3.0000", credit: "0.0000" },
      { code: "5120", debit: "0.0000", credit: "3.0000" },
    ]);
  });

  it("a SHORT drawer debits 5120 and credits 1110, and over_short is NEGATIVE", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["20.0000"]);
    const out = await close(shiftId, "118.5000"); // expected 120, counted 118.50 → short 1.50
    expect(out.shiftResults[0]!.status).toBe("accepted");

    const [sh] = await db.admin<{ over_short: string; doc: string }[]>`
      select over_short::text, over_short_document_id::text as doc from app.shift where id = ${shiftId}`;
    expect(sh!.over_short).toBe("-1.5000");
    const legs = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, le.debit::text, le.credit::text
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${sh!.doc} order by a.code`;
    expect(legs).toEqual([
      { code: "1110", debit: "0.0000", credit: "1.5000" },
      { code: "5120", debit: "1.5000", credit: "0.0000" },
    ]);
    // The magnitude on the ledger is POSITIVE on both legs. Nothing wrote a negative debit (§4.4.2 A9).
    for (const l of legs) {
      expect(l.debit).not.toMatch(/^-/);
      expect(l.credit).not.toMatch(/^-/);
    }
  });

  it("the over/short document carries the shift, the terminal, the branch and the cashier", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "50.0000" });
    await close(shiftId, "51.0000");
    const [d] = await db.admin<
      {
        shift_id: string;
        terminal_id: string;
        branch_id: string;
        attributed_to: string;
        created_by: string;
        posted_by: string;
        series: string;
        status: string;
        code: string;
      }[]
    >`select d.shift_id::text, d.terminal_id::text, d.branch_id::text, d.attributed_to::text,
                d.created_by::text, d.posted_by::text, d.series, d.status::text, t.code
           from app.document d join app.document_type t on t.id = d.document_type_id
          where d.shift_id = ${shiftId} and t.code = 'TILL_OVER_SHORT'`;
    expect(d!.code).toBe("TILL_OVER_SHORT");
    expect(d!.status).toBe("posted");
    expect(d!.terminal_id).toBe(f.terminalA.terminalId);
    expect(d!.branch_id).toBe(f.branchA);
    expect(d!.attributed_to).toBe(f.cashierA); // the cashier is ATTRIBUTED
    expect(d!.created_by).toBe(f.terminalA.principalId); // the terminal ACTED (hazard 19)
    expect(d!.posted_by).toBe(f.terminalA.principalId);
    // 6A's resolveSeries suffixes EVERY document carrying a terminal_id (amendment A15). The code is read
    // off the fixture and NOT written as "T1": `posFixture` enrols its terminal with `code: "KL01"`
    // (6A Task 10 Step 6) and `StaffFixture.terminalA` IS `pos.terminal` (6C Task 9 Step 2), so every assertion that reaches
    // this suite through `staffFixture` sees `TOS-KL01`. 6A writes its own equivalent the same way
    // (6A Task 11 Step 1: `expect(doc!.series).toBe(`POS-${f.terminal.code}`)`).
    expect(d!.series).toBe(`TOS-${f.terminalA.code}`);
  });

  it("the BRANCH dimension is on both ledger lines (spec:1066, dimensions.required)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "50.0000" });
    await close(shiftId, "52.0000");
    // `led.entry_id`, NOT `led.ledger_entry_id`. `app.ledger_entry_dimension` is
    // `(tenant_id, entry_id, dimension_type_id, dimension_value_id)` with `primary key (entry_id,
    // dimension_type_id)` (plan0A:2041–2046). 2A's own self-review records making and correcting this
    // exact mistake as its item 16, noting that the wrong column left its two BRANCH-dimension assertions
    // "never run" — a query that errors is a case that proves nothing. 1a:2843 and 1a:6043 are the
    // correct form.
    const dims = await db.admin<{ code: string; value_id: string }[]>`
      select dt.code, led.dimension_value_id::text as value_id
        from app.ledger_entry le
        join app.ledger_entry_dimension led on led.entry_id = le.id
        join app.dimension_type dt on dt.id = led.dimension_type_id
        join app.document d on d.id = le.document_id
       where d.shift_id = ${shiftId}`;
    expect(dims).toHaveLength(2);
    expect(new Set(dims.map((d) => d.code))).toEqual(new Set(["BRANCH"]));
    expect(new Set(dims.map((d) => d.value_id))).toEqual(new Set([f.branchA]));
  });

  it("a re-sent close answers duplicate, and a DIFFERENT countedCash does not overwrite the first", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await close(shiftId, "101.0000");
    const out = await close(shiftId, "500.0000");
    expect(out.shiftResults[0]!.status).toBe("duplicate");
    expect(out.shiftResults[0]!.error).toBeNull();

    const [sh] = await db.admin<{ counted_cash: string; over_short: string }[]>`
      select counted_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh!.counted_cash).toBe("101.0000"); // FIRST count stands
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d join app.document_type t on t.id = d.document_type_id
       where d.shift_id = ${shiftId} and t.code = 'TILL_OVER_SHORT'`;
    expect(n!.n).toBe(1); // ONE over/short document, ever
  });

  it("closing SOMEONE ELSE'S shift without pos.shift.close_any is ERR_RBAC_FORBIDDEN", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "10.0000" });
    const out = await close(shiftId, "10.0000", f.supervisorA); // holds override, not close_any
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.shiftResults[0]!.error!.detail).toContain("pos.shift.close_any");
    const [sh] = await db.admin<{ closed_at: string | null }[]>`
      select closed_at::text from app.shift where id = ${shiftId}`;
    expect(sh!.closed_at).toBeNull(); // refused, and STILL OPEN
  });

  it("a branch manager holding pos.shift.close_any may close a cashier's shift (spec:2160)", async () => {
    const managerId = f.pos.supervisorId;
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.close_any"],
      principalId: managerId,
      roleCode: "bm-close",
      branchIds: [f.branchA],
    });
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "10.0000" });
    const out = await close(shiftId, "10.0000", managerId);
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ closed_principal_id: string }[]>`
      select closed_principal_id::text from app.shift where id = ${shiftId}`;
    expect(sh!.closed_principal_id).toBe(managerId);
  });

  it("closing one's OWN shift without pos.shift.own is ERR_RBAC_FORBIDDEN and names that code", async () => {
    const employee = await seedEmployee(db, f.seed, { employeeNumber: "NO-SHIFT-CODE" });
    const principalId = await seedCashier(db, f.seed, {
      employeeId: employee,
      branchId: f.branchA,
      permissions: ["pos.ticket.sell"],
    });
    const shiftId = await f.openShift({ cashierPrincipalId: principalId, openingFloat: "10.0000" });
    const out = await close(shiftId, "10.0000", principalId);
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.shiftResults[0]!.error!.detail).toContain("pos.shift.own");
  });

  it("a countedCash the till omits is rejected, and a wrong-currency count too", async () => {
    const a = await f.openShift({ cashierPrincipalId: f.cashierA });
    const out1 = await closeRaw(a, null);
    expect(out1.shiftResults[0]!.error!.detail).toContain("countedCash");
    const b = await f.openShift({ cashierPrincipalId: f.cashierA });
    const out2 = await closeRaw(b, { amount: "1.0000", currency: "USD" });
    expect(out2.shiftResults[0]!.error!.detail).toContain("USD");
  });

  it("a close in the SAME batch as its tickets sees them (the whole reason for Task 3's ordering)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "0.0000" });
    // One payload: a 40.00 cash sale AND the close. Under 6A's original order the close would run first
    // and find an empty drawer, reporting a 40.00 over on every till that sells its last sale and shuts.
    const out = await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      applyBatch(
        tx as never,
        {
          tenantId: f.seed.tenant,
          actorId: f.terminalA.principalId,
          requestId: "shift-close-test",
        },
        {
          terminalId: f.terminalA.terminalId,
          companyId: f.seed.company,
          branchId: f.branchA,
          principalId: f.terminalA.principalId,
        },
        {
          terminalId: f.terminalA.terminalId,
          batchId: crypto.randomUUID(),
          tillEvents: [],
          shifts: [
            {
              shiftId,
              kind: "close",
              terminalId: f.terminalA.terminalId,
              cashierPrincipalId: f.cashierA,
              at: new Date().toISOString(),
              currency: "MYR",
              openingFloat: null,
              countedCash: { amount: "40.0000", currency: "MYR" },
            },
          ],
          tickets: [
            buildTicket(f.pos, { sku: "SKU-A", shiftId, unitPrice: "40.0000", tender: "cash" }),
          ],
        },
      ),
    );
    expect(out.results[0]!.status).toBe("accepted");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh!.expected_cash).toBe("40.0000");
    expect(sh!.over_short).toBe("0.0000");
  });

  it("a REVERSED ticket's cash is still in the expectation, and so is its reversal (ADR 0063)", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "0.0000" });
    const [ticketId] = await sellCash(shiftId, ["30.0000"]);
    // **The reversal runs as the TERMINAL, not as a human**, and that is not a stylistic choice: the
    // reversal document is another `POS_TICKET` (`reversal.producesType`, 6A's POS_TICKET.json decision 4)
    // whose policy has `approval.post = "pos.sync.push"`, and 2B's R2 evaluates that code INSIDE the
    // posting transaction. `s.human` does not hold it, and `admin`'s computed array excludes every
    // `pos.sync.*` code (§3.6.4) — so a human-actor reversal dies at the trigger with ERR_RBAC_FORBIDDEN.
    const [source] = await db.admin<
      { date: string }[]
    >`select effective_date::text date from app.document where id=${ticketId!}`;
    await withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      reverseDocument(
        tx as never,
        {
          tenantId: f.seed.tenant,
          actorId: f.terminalA.principalId,
          requestId: "shift-close-test",
        },
        { documentId: ticketId!, effectiveDate: source!.date, reason: "mis-scan" },
      ),
    );

    // ⚠️ **STOP AND RAISE if this case fails with `expected_cash` = "30.0000".** It means
    // `reverseDocument` does not copy `shift_id` onto the reversal document, so the reversal's 1110 credit
    // is outside `d.shift_id = $1` and only the original's debit is counted. Neither 1A's §4.3.1 entry nor
    // 6A's plan settles whether the reversal inherits the POS header columns, and this plan does not
    // invent an answer. The fix is in 1A's `reverse.ts` (carry `shift_id` and `terminal_id` forward, which
    // is also what makes a reversed ticket appear in its own Z-report) plus a §4.3.1 amendment — NOT a
    // widened predicate here, which would have to guess which reversal belongs to which drawer.
    const out = await close(shiftId, "0.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    // 30 in, 30 out: the expectation is zero, not 30 (which `status = 'posted'` alone would have given).
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh!.expected_cash).toBe("0.0000");
    expect(sh!.over_short).toBe("0.0000");
  });

  it("resolveAccountByCode refuses loudly and names the seeding file (hazard 33)", async () => {
    // 5130 is seeded since OD-10 was answered yes (2026-11-04); every code the till path names resolves.
    for (const code of ["1110", "1130", "5120", "5130", "1100"]) {
      await expect(
        withTenant(db.rw, f.seed.tenant, f.seed.human, (tx) =>
          resolveAccountByCode(tx as never, f.seed.company, code),
        ),
      ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    }
    await expect(
      withTenant(db.rw, f.seed.tenant, f.seed.human, (tx) =>
        resolveAccountByCode(tx as never, f.seed.company, "5999"),
      ),
    ).rejects.toMatchObject({
      code: "ERR_NOT_FOUND",
      detail: expect.stringMatching(/5999.*an unregistered file/),
    });
  });

  it("rolls back the close and every draft row if the real over-short posting cannot resolve its type", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "10.0000" });
    await withTenant(
      db.migrator,
      f.seed.tenant,
      f.seed.system,
      (tx) =>
        tx`update app.document_type set archived_at=now() where company_id=${f.seed.company} and code='TILL_OVER_SHORT'`,
    );
    try {
      const out = await close(shiftId, "11.0000");
      expect(out.shiftResults[0]).toMatchObject({
        status: "rejected",
        error: { code: "ERR_NOT_FOUND" },
      });
      const [row] = await db.admin<
        { closed_at: string | null; counted_cash: string | null }[]
      >`select closed_at::text,counted_cash::text from app.shift where id=${shiftId}`;
      expect(row).toEqual({ closed_at: null, counted_cash: null });
      const [docs] = await db.admin<
        { n: number }[]
      >`select count(*)::int n from app.document where shift_id=${shiftId}`;
      expect(docs!.n).toBe(0);
    } finally {
      await withTenant(
        db.migrator,
        f.seed.tenant,
        f.seed.system,
        (tx) =>
          tx`update app.document_type set archived_at=null where company_id=${f.seed.company} and code='TILL_OVER_SHORT'`,
      );
    }
  });
  it("refuses negative physical counts without fixing a server expectation", async () => {
    const shiftId = await f.openShift({ cashierPrincipalId: f.cashierA });
    const out = await close(shiftId, "-1.0000");
    expect(out.shiftResults[0]).toMatchObject({
      status: "rejected",
      error: { code: "ERR_VALIDATION_FAILED" },
    });
    expect(
      (
        await db.admin<
          { closed_at: string | null }[]
        >`select closed_at::text from app.shift where id=${shiftId}`
      )[0]!.closed_at,
    ).toBeNull();
  });
});
