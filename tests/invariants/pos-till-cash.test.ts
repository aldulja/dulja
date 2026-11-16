/**
 * ⚠️ OD-10 (answered yes, 2026-11-04 — docs/owner/od-10/decision.md; ADR 0064). 6D Tasks 9–11 through the
 * real sync path: `applyBatch` → `applyCashEvent` → `buildTillDocument` → `postDocument`, against
 * PostgreSQL. One file and one stack, three `describe`s in file order — paid-out, safe drop, banking — each
 * on its own drawer so every figure is derived inside its block.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch, zReport } from "@dulja/db";
import { grantCodes, seedShift, seedTerminal, withTenant, type Db } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { buildTicket } from "./support/pos";
import { branchActor, staffFixture, type StaffFixture } from "./support/staff";

let api: StartedApi;
let db: Db;
let f: StaffFixture;
/** Branch B's own terminal and an open shift on it: branch B is at 6C's closed defaults (no paid-outs). */
let terminalB: { terminalId: string; principalId: string };
let shiftB: string;

type Terminal = { terminalId: string; principalId: string };

beforeAll(async () => {
  api = await startApi();
  db = api.db;
  f = await staffFixture(api, "tillcash");
  // Branch A allows paid-outs up to 100.0000 (OD-10 fact 1); branch B keeps the closed defaults.
  await withTenant(
    db.migrator,
    f.seed.tenant,
    f.seed.system,
    (tx) => tx`update app.branch_pos_policy
                  set paid_out_allowed = true, max_paid_out_amount = 100
                where company_id = ${f.seed.company} and branch_id = ${f.branchA}`,
  );
  terminalB = await seedTerminal(db, f.seed, { code: "TCB1", branchId: f.branchB });
  await grantCodes(db, f.seed, {
    codes: ["pos.shift.own"],
    principalId: f.cashierB,
    roleCode: "tillcash-own-b",
    branchIds: [f.branchB],
  });
  shiftB = await seedShift(db, f.seed, {
    terminalId: terminalB.terminalId,
    cashierPrincipalId: f.cashierB,
    openingFloat: "100.0000",
    branchId: f.branchB,
  });
}, 300_000);
afterAll(async () => {
  await api.stop();
});

/** One `applyBatch` as `terminal`, with whatever arrays the caller names. */
const batchAs = (terminal: Terminal, branchId: string, body: Record<string, unknown>) =>
  withTenant(db.rw, f.seed.tenant, terminal.principalId, (tx) =>
    applyBatch(
      tx as never,
      { tenantId: f.seed.tenant, actorId: terminal.principalId, requestId: "till-cash" },
      {
        terminalId: terminal.terminalId,
        companyId: f.seed.company,
        branchId,
        principalId: terminal.principalId,
      },
      {
        terminalId: terminal.terminalId,
        batchId: crypto.randomUUID(),
        tickets: [],
        shifts: [],
        tillEvents: [],
        ...body,
      },
    ),
  );

interface CashOpts {
  kind: "paid_out" | "safe_drop" | "banking";
  amount: string;
  shiftId: string;
  cashierPrincipalId?: string;
  supervisorPrincipalId?: string | null;
  reference?: string | null;
  fromSafe?: boolean;
  clientRef?: string;
}
const cashMsg = (m: CashOpts, cashier: string) => ({
  clientRef: m.clientRef ?? crypto.randomUUID(),
  shiftId: m.shiftId,
  kind: m.kind,
  amount: { amount: m.amount, currency: "MYR" },
  cashierPrincipalId: m.cashierPrincipalId ?? cashier,
  supervisorPrincipalId: m.supervisorPrincipalId ?? null,
  occurredAt: new Date().toISOString(),
  reference: m.reference === undefined ? null : m.reference,
  fromSafe: m.fromSafe ?? false,
});
/** One `TillCashMsg` at branch A on terminal A. */
const pushCash = (m: CashOpts) =>
  batchAs(f.terminalA, f.branchA, { cashEvents: [cashMsg(m, f.cashierA)] });

const sellCash = async (shiftId: string, prices: string[]) => {
  const out = await batchAs(f.terminalA, f.branchA, {
    tickets: prices.map((unitPrice) =>
      buildTicket(f.pos, {
        sku: "SKU-A",
        shiftId,
        unitPrice,
        tender: "cash",
        cashierPrincipalId: f.cashierA,
      }),
    ),
  });
  expect(out.results.map((r) => r.status)).toEqual(prices.map(() => "accepted"));
};

const closeShiftFor = (shiftId: string, counted: string) =>
  batchAs(f.terminalA, f.branchA, {
    shifts: [
      {
        shiftId,
        kind: "close",
        terminalId: f.terminalA.terminalId,
        cashierPrincipalId: f.cashierA,
        at: new Date().toISOString(),
        currency: "MYR",
        openingFloat: null,
        countedCash: { amount: counted, currency: "MYR" },
      },
    ],
  });

/** The ledger legs of the document a cash event produced, `(code, debit, credit)` ordered by code. */
const legsOf = (ref: string) =>
  db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, le.debit::text as debit, le.credit::text as credit
      from app.ledger_entry le
      join app.document d on d.id = le.document_id
      join app.account  a on a.id = le.account_id
     where d.company_id = ${f.seed.company} and d.client_ref = ${ref}::uuid
     order by a.code`;

const docOf = async (ref: string) =>
  (
    await db.admin<
      {
        id: string;
        code: string;
        status: string;
        series: string;
        shift_id: string;
        attributed_to: string;
        created_by: string;
        notes: string | null;
      }[]
    >`select d.id::text as id, t.code, d.status::text as status, d.series, d.shift_id::text as shift_id,
             d.attributed_to::text as attributed_to, d.created_by::text as created_by, d.notes
        from app.document d join app.document_type t on t.id = d.document_type_id
       where d.client_ref = ${ref}::uuid`
  )[0];

describe("⚠️ OD-10 — TILL_PAID_OUT (ADR 0064, spec:1354)", () => {
  let shiftId: string;
  beforeAll(async () => {
    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "300.0000" });
    await sellCash(shiftId, ["50.0000", "50.0000"]);
  }, 300_000);

  it("a paid-out debits 5130 and credits 1110, both legs tagged BRANCH", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "30.0000",
      shiftId,
      reference: "RCPT-001",
    });
    expect(out.cashEventResults).toEqual([
      { ref: expect.any(String), status: "accepted", error: null },
    ]);
    const ref = out.cashEventResults[0]!.ref;
    expect(await legsOf(ref)).toEqual([
      { code: "1110", debit: "0.0000", credit: "30.0000" },
      { code: "5130", debit: "30.0000", credit: "0.0000" },
    ]);
    const [dims] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from app.ledger_entry_dimension led
        join app.ledger_entry le on le.id = led.entry_id
        join app.document d on d.id = le.document_id
        join app.dimension_value dv on dv.id = led.dimension_value_id
        join app.dimension_type dt on dt.id = dv.dimension_type_id
       where d.client_ref = ${ref}::uuid and dt.code = 'BRANCH'`;
    expect(dims!.n).toBe(2);
  });

  it("is posted as TPO-<terminal>, carries the shift, and the terminal acts while the cashier is attributed", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "10.0000",
      shiftId,
      reference: "RCPT-002",
    });
    const d = await docOf(out.cashEventResults[0]!.ref);
    expect(d!.code).toBe("TILL_PAID_OUT");
    expect(d!.status).toBe("posted");
    expect(d!.series).toBe(`TPO-${f.terminalA.code}`);
    expect(d!.shift_id).toBe(shiftId);
    expect(d!.created_by).toBe(f.terminalA.principalId);
    expect(d!.attributed_to).toBe(f.cashierA);
    expect(d!.notes).toContain("RCPT-002");
  });

  it("re-sending a paid-out answers duplicate and posts nothing twice", async () => {
    const clientRef = crypto.randomUUID();
    const first = await pushCash({
      kind: "paid_out",
      amount: "5.0000",
      shiftId,
      reference: "R-5",
      clientRef,
    });
    expect(first.cashEventResults[0]!.status).toBe("accepted");
    const second = await pushCash({
      kind: "paid_out",
      amount: "5.0000",
      shiftId,
      reference: "R-5",
      clientRef,
    });
    expect(second.cashEventResults[0]).toEqual({
      ref: clientRef,
      status: "duplicate",
      error: null,
    });
    expect(await legsOf(clientRef)).toHaveLength(2);
  });

  it("a paid-out without a reference is refused (OD-10 fact 4) and posts nothing", async () => {
    const out = await pushCash({ kind: "paid_out", amount: "1.0000", shiftId, reference: null });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.cashEventResults[0]!.error!.detail).toContain("reference");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("a paid-out at a branch whose policy forbids it is ERR_POS_LIMIT_EXCEEDED", async () => {
    const out = await batchAs(terminalB, f.branchB, {
      cashEvents: [
        cashMsg(
          { kind: "paid_out", amount: "1.0000", shiftId: shiftB, reference: "X" },
          f.cashierB,
        ),
      ],
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect(out.cashEventResults[0]!.error!.detail).toContain("paid_out");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("above max_paid_out_amount with no supervisor is ERR_POS_LIMIT_EXCEEDED, naming the limit", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "150.0000",
      shiftId,
      reference: "BIG-1",
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect(out.cashEventResults[0]!.error!.detail).toContain("100.0000");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("above the limit with a DIFFERENT supervisor holding pos.ticket.override posts, and records the override", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "150.0000",
      shiftId,
      reference: "BIG-2",
      supervisorPrincipalId: f.supervisorA,
    });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    const ref = out.cashEventResults[0]!.ref;
    expect(await legsOf(ref)).toEqual([
      { code: "1110", debit: "0.0000", credit: "150.0000" },
      { code: "5130", debit: "150.0000", credit: "0.0000" },
    ]);
    const [ev] = await db.admin<{ code: string; attributed_to: string; reason: string }[]>`
      select e.override_code as code, e.attributed_to::text as attributed_to, e.reason
        from app.document_event e join app.document d on d.id = e.document_id
       where d.client_ref = ${ref}::uuid and e.event_kind = 'override'`;
    expect(ev).toEqual({
      code: "pos.ticket.override",
      attributed_to: f.supervisorA,
      reason: "paid_out: BIG-2",
    });
  });

  it("the cashier cannot approve their own paid-out", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "150.0000",
      shiftId,
      reference: "BIG-3",
      supervisorPrincipalId: f.cashierA,
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([]);
  });

  it("a supervisor sent for a paid-out within the limit is refused as malformed", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "20.0000",
      shiftId,
      reference: "SMALL",
      supervisorPrincipalId: f.supervisorA,
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a cash event naming an unknown shift is ERR_CONFLICT_REFERENCE and posts nothing", async () => {
    const out = await pushCash({
      kind: "paid_out",
      amount: "1.0000",
      shiftId: crypto.randomUUID(),
      reference: "Z",
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_CONFLICT_REFERENCE");
    expect(await docOf(out.cashEventResults[0]!.ref)).toBeUndefined();
  });

  it("one refused cash event leaves the ticket beside it in its batch committed (savepoint per message)", async () => {
    const good = buildTicket(f.pos, {
      sku: "SKU-A",
      shiftId,
      unitPrice: "7.0000",
      tender: "cash",
      cashierPrincipalId: f.cashierA,
    });
    const out = await batchAs(f.terminalA, f.branchA, {
      tickets: [good],
      cashEvents: [
        cashMsg({ kind: "paid_out", amount: "999.0000", shiftId, reference: "NO" }, f.cashierA),
      ],
    });
    expect(out.results[0]!.status).toBe("accepted");
    expect(out.cashEventResults[0]!.status).toBe("rejected");
  });

  it("a batch with no cashEvents array answers cashEventResults: []", async () => {
    const out = await batchAs(f.terminalA, f.branchA, {});
    expect(out.cashEventResults).toEqual([]);
  });

  it("the paid-outs reduce expected_cash through ADR 0063's unchanged formula, and the Z-report lists them", async () => {
    // 300 float + 50 + 50 + 7 cash sales − 30 − 10 − 5 − 150 paid out = 212 expected.
    const out = await closeShiftFor(shiftId, "212.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh).toEqual({ expected_cash: "212.0000", over_short: "0.0000" });

    const reader = await branchActor(db, f.seed, f.branchA, ["pos.report.read"], "tillcash-reader");
    const [z] = await withTenant(db.rw, f.seed.tenant, reader, (tx) =>
      zReport(tx as never, { companyId: f.seed.company, shiftId, limit: 1 }),
    );
    expect(z!.tenders.find((t) => t.method === "cash")!.amount).toBe("107.0000");
    expect(z!.cashControl.find((c) => c.documentTypeCode === "TILL_PAID_OUT")!.amount).toBe(
      "-195.0000",
    );
  });

  it("a re-sent paid-out after the close still answers duplicate", async () => {
    const clientRef = crypto.randomUUID();
    const open = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "50.0000" });
    await pushCash({
      kind: "paid_out",
      amount: "2.0000",
      shiftId: open,
      reference: "LATE",
      clientRef,
    });
    await closeShiftFor(open, "48.0000");
    const again = await pushCash({
      kind: "paid_out",
      amount: "2.0000",
      shiftId: open,
      reference: "LATE",
      clientRef,
    });
    expect(again.cashEventResults[0]!.status).toBe("duplicate");
  });
});

describe("⚠️ OD-10 — TILL_SAFE_DROP (spec:1354, ADR 0064)", () => {
  let shiftId: string;
  beforeAll(async () => {
    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    await sellCash(shiftId, ["200.0000", "200.0000", "200.0000"]);
  }, 300_000);

  it("a safe drop debits 1130 Cash in transit and credits 1110, numbered TSD-<terminal>", async () => {
    const out = await pushCash({
      kind: "safe_drop",
      amount: "500.0000",
      shiftId,
      reference: "BAG-0007",
    });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    const ref = out.cashEventResults[0]!.ref;
    expect(await legsOf(ref)).toEqual([
      { code: "1110", debit: "0.0000", credit: "500.0000" },
      { code: "1130", debit: "500.0000", credit: "0.0000" },
    ]);
    const d = await docOf(ref);
    expect(d!.code).toBe("TILL_SAFE_DROP");
    expect(d!.series).toBe(`TSD-${f.terminalA.code}`);
    expect(d!.notes).toContain("BAG-0007");
  });

  it("a safe drop needs no reference and no supervisor, and is not limited by paid_out_allowed (fact 2)", async () => {
    const out = await batchAs(terminalB, f.branchB, {
      cashEvents: [
        cashMsg({ kind: "safe_drop", amount: "9999.0000", shiftId: shiftB }, f.cashierB),
      ],
    });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
  });

  it("a safe drop carrying a supervisor or fromSafe is refused as malformed", async () => {
    const withSup = await pushCash({
      kind: "safe_drop",
      amount: "1.0000",
      shiftId,
      supervisorPrincipalId: f.supervisorA,
    });
    expect(withSup.cashEventResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    const fromSafe = await pushCash({
      kind: "safe_drop",
      amount: "1.0000",
      shiftId,
      fromSafe: true,
    });
    expect(fromSafe.cashEventResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a principal who is not a cashier of the branch with pos.shift.own is ERR_RBAC_FORBIDDEN", async () => {
    const out = await pushCash({
      kind: "safe_drop",
      amount: "10.0000",
      shiftId,
      cashierPrincipalId: f.supervisorA,
    });
    expect(out.cashEventResults[0]!.status).toBe("rejected");
    expect(out.cashEventResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the drop reduces expected_cash, the close ties, and 1130 keeps the money", async () => {
    // 100 float + 600 sold − 500 dropped = 200 expected.
    const out = await closeShiftFor(shiftId, "200.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh).toEqual({ expected_cash: "200.0000", over_short: "0.0000" });
  });
});

describe("⚠️ OD-10 — TILL_BANKING and app.till_banking_link (ADR 0064, amendment A16)", () => {
  let shiftId: string;
  let bankAccountId: string;
  beforeAll(async () => {
    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "200.0000" });
    await sellCash(shiftId, ["200.0000", "200.0000", "200.0000", "200.0000"]);
    const [bank] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${f.seed.company} and code = '1100'`;
    bankAccountId = bank!.id;
  }, 300_000);

  it("a banking from the DRAWER debits 1100 and credits 1110", async () => {
    const out = await pushCash({
      kind: "banking",
      amount: "600.0000",
      shiftId,
      reference: "DEP-1",
    });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([
      { code: "1100", debit: "600.0000", credit: "0.0000" },
      { code: "1110", debit: "0.0000", credit: "600.0000" },
    ]);
    expect((await docOf(out.cashEventResults[0]!.ref))!.series).toBe(`TBK-${f.terminalA.code}`);
  });

  it("a banking from the SAFE debits 1100 and credits 1130 (fact 3: the cashier picks)", async () => {
    await pushCash({ kind: "safe_drop", amount: "200.0000", shiftId, reference: "BAG-9" });
    const out = await pushCash({ kind: "banking", amount: "200.0000", shiftId, fromSafe: true });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    expect(await legsOf(out.cashEventResults[0]!.ref)).toEqual([
      { code: "1100", debit: "200.0000", credit: "0.0000" },
      { code: "1130", debit: "0.0000", credit: "200.0000" },
    ]);
  });

  it("the link row carries the shift, the bank account, from_safe, the amount and the branch", async () => {
    const out = await pushCash({ kind: "banking", amount: "50.0000", shiftId, reference: "DEP-3" });
    const d = await docOf(out.cashEventResults[0]!.ref);
    const [link] = await db.admin<
      {
        shift_id: string;
        bank_account_id: string;
        from_safe: boolean;
        amount: string;
        branch_id: string;
        reference: string;
        value_date: string;
        effective_date: string;
      }[]
    >`select l.shift_id::text, l.bank_account_id::text, l.from_safe, l.amount::text, l.branch_id::text,
             l.reference, l.value_date::text, d.effective_date::text
        from app.till_banking_link l join app.document d on d.id = l.banking_document_id
       where l.banking_document_id = ${d!.id}`;
    expect(link).toEqual({
      shift_id: shiftId,
      bank_account_id: bankAccountId,
      from_safe: false,
      amount: "50.0000",
      branch_id: f.branchA,
      reference: "DEP-3",
      value_date: link!.effective_date,
      effective_date: link!.effective_date,
    });
  });

  it("re-sending a banking answers duplicate and there is still exactly ONE link row", async () => {
    const clientRef = crypto.randomUUID();
    await pushCash({ kind: "banking", amount: "25.0000", shiftId, clientRef });
    const second = await pushCash({ kind: "banking", amount: "25.0000", shiftId, clientRef });
    expect(second.cashEventResults[0]!.status).toBe("duplicate");
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_banking_link l
        join app.document d on d.id = l.banking_document_id
       where d.client_ref = ${clientRef}::uuid`;
    expect(n!.n).toBe(1);
  });

  it("the Z-report shows each drawer banking in cashControl, never as a tender", async () => {
    // +200 float +800 sold −600 banked (drawer) −200 dropped −50 banked −25 banked = 125 expected; the 200
    // banked FROM THE SAFE never touches 1110.
    const out = await closeShiftFor(shiftId, "125.0000");
    expect(out.shiftResults[0]!.status).toBe("accepted");
    const reader = await branchActor(db, f.seed, f.branchA, ["pos.report.read"], "tillbank-reader");
    const [z] = await withTenant(db.rw, f.seed.tenant, reader, (tx) =>
      zReport(tx as never, { companyId: f.seed.company, shiftId, limit: 1 }),
    );
    expect(z!.tenders.find((t) => t.method === "cash")!.amount).toBe("800.0000");
    expect(z!.tenders.find((t) => t.method === "transfer")).toBeUndefined();
    expect(z!.cashControl.find((c) => c.documentTypeCode === "TILL_BANKING")!.amount).toBe(
      "-675.0000",
    );
    expect(z!.cashControl.find((c) => c.documentTypeCode === "TILL_SAFE_DROP")!.amount).toBe(
      "-200.0000",
    );
    expect(z!.expectedCash).toBe("125.0000");
    expect(z!.overShort).toBe("0.0000");
  });

  it("a principal of branch B sees no branch-A link row (Form A), while branch A's reader does", async () => {
    const readerB = await branchActor(db, f.seed, f.branchB, ["pos.report.read"], "tillbank-b");
    const [hidden] = await withTenant(
      db.rw,
      f.seed.tenant,
      readerB,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_banking_link`,
    );
    expect(hidden!.n).toBe(0);
    const readerA = await branchActor(db, f.seed, f.branchA, ["pos.report.read"], "tillbank-a");
    const [seen] = await withTenant(
      db.rw,
      f.seed.tenant,
      readerA,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_banking_link`,
    );
    expect(seen!.n).toBeGreaterThan(0);
  });
});

// Phase 7 code review (2026-11-06), fixed 2026-11-07: a cash event is an act on ONE'S OWN drawer, so its
// cashier must be the shift's own cashier (`app.shift.opened_principal_id`), not merely a live cashier of
// the branch holding `pos.shift.own`. Before the fix a second cashier's paid-out posted against cashier A's
// drawer, attributed to the second cashier, and A's over/short absorbed it (ADR 0064's 2026-11-07 amendment).
describe("⚠️ OD-10 — a cash event names the shift's own cashier (ADR 0064 amendment)", () => {
  let shiftId: string;
  beforeAll(async () => {
    shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
    // supervisorA becomes a full cashier of branch A in their own right: live, holding pos.shift.own. The
    // only thing they lack is ownership of cashierA's drawer.
    await grantCodes(db, f.seed, {
      codes: ["pos.shift.own"],
      principalId: f.supervisorA,
      roleCode: "tillcash-own-sup-a",
      branchIds: [f.branchA],
    });
  }, 300_000);

  it.each([
    { kind: "paid_out" as const, reference: "RCPT-X" },
    { kind: "safe_drop" as const, reference: null },
    { kind: "banking" as const, reference: null },
  ])(
    "a $kind naming another live cashier of the branch is ERR_RBAC_FORBIDDEN and posts nothing",
    async ({ kind, reference }) => {
      const out = await pushCash({
        kind,
        amount: "10.0000",
        shiftId,
        reference,
        cashierPrincipalId: f.supervisorA,
      });
      expect(out.cashEventResults[0]!.status).toBe("rejected");
      expect(out.cashEventResults[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
      expect(out.cashEventResults[0]!.error!.detail).toContain("shift's own cashier");
      expect(await docOf(out.cashEventResults[0]!.ref)).toBeUndefined();
    },
  );

  it("the shift's own cashier's event posts, and the drawer's expectation counts only it", async () => {
    const out = await pushCash({ kind: "safe_drop", amount: "40.0000", shiftId });
    expect(out.cashEventResults[0]!.status).toBe("accepted");
    expect((await docOf(out.cashEventResults[0]!.ref))!.attributed_to).toBe(f.cashierA);
    // 100 float − 40 dropped = 60: none of the refused events above reached cashier A's drawer.
    const closed = await closeShiftFor(shiftId, "60.0000");
    expect(closed.shiftResults[0]!.status).toBe("accepted");
    const [sh] = await db.admin<{ expected_cash: string; over_short: string }[]>`
      select expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
    expect(sh).toEqual({ expected_cash: "60.0000", over_short: "0.0000" });
  });
});
