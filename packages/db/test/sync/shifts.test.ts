import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "../../src/sync/apply";
import { classifyShifts, shiftRef } from "../../src/sync/shifts";
import {
  seedShift,
  seedTenantV2,
  seedTerminal,
  seedEmployee,
  seedCashier,
  grantCodes,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** The 4-argument TEST helper (§4.1); the production `withTenant(sql, ctx, fn)` is a different export. */
const asTerminal = <T>(
  db: Db,
  s: Seed,
  principalId: string,
  fn: (tx: import("postgres").Sql) => Promise<T>,
) => withTenant(db.rw, s.tenant, principalId, fn) as Promise<T>;

describe("6D shift apply — the open path (§4.10.1, contracts amendment A2)", () => {
  let db: Db;
  let s: Seed;
  let t1: { terminalId: string; principalId: string };
  let t2: { terminalId: string; principalId: string };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Shifty");
    t1 = await seedTerminal(db, s, { code: "T1" });
    t2 = await seedTerminal(db, s, { code: "T2" });
    const employee = await seedEmployee(db, s, { employeeNumber: "SHIFT-CASH" });
    await seedCashier(db, s, { employeeId: employee, principalId: s.human, branchId: s.hq });
    await grantCodes(db, s, { codes: ["pos.shift.own"], branchIds: [s.hq] });
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  const openMsg = (
    shiftId: string,
    terminalId: string,
    over: Partial<Record<string, unknown>> = {},
  ) => ({
    shiftId,
    kind: "open",
    terminalId,
    cashierPrincipalId: s.human,
    at: new Date().toISOString(),
    currency: "MYR",
    openingFloat: { amount: "150.0000", currency: "MYR" },
    countedCash: null,
    ...over,
  });

  const apply = (terminal: typeof t1, shifts: unknown[]) =>
    asTerminal(db, s, terminal.principalId, (tx) =>
      applyBatch(
        tx,
        { tenantId: s.tenant, actorId: terminal.principalId, requestId: "shift-test" },
        {
          terminalId: terminal.terminalId,
          companyId: s.company,
          branchId: s.hq,
          principalId: terminal.principalId,
        },
        {
          terminalId: terminal.terminalId,
          batchId: crypto.randomUUID(),
          tickets: [],
          shifts,
          tillEvents: [],
        },
      ),
    );

  it("shiftRef is `<shiftId>:<kind>` and classifyShifts is pure (§4.10.1)", () => {
    expect(shiftRef({ shiftId: "abc", kind: "open" })).toBe("abc:open");
    const c = classifyShifts([
      { shiftId: "a", kind: "open" },
      { shiftId: "b", kind: "close" },
      { shiftId: "c", kind: "pause" },
      7,
    ]);
    expect(c.opens.map((x) => x.index)).toEqual([0]);
    expect(c.closes.map((x) => x.index)).toEqual([1]);
    expect(c.malformed.map((x) => x.index)).toEqual([2, 3]);
    expect(c.malformed[0]!.outcome.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(c.malformed[0]!.outcome.error!.detail).toContain("pause");
  });

  it("an open message inserts the shift at the TILL'S id and answers accepted", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t1.terminalId)]);
    expect(out.shiftResults).toEqual([{ ref: `${id}:open`, status: "accepted", error: null }]);

    const [row] = await db.admin<
      {
        terminal_id: string;
        branch_id: string;
        opened_principal_id: string;
        opening_float: string;
        currency: string;
        closed_at: string | null;
      }[]
    >`select terminal_id::text, branch_id::text, opened_principal_id::text,
                opening_float::text, currency, closed_at::text from app.shift where id = ${id}`;
    expect(row!.terminal_id).toBe(t1.terminalId);
    expect(row!.branch_id).toBe(s.hq); // from the CONTEXT, never the payload
    expect(row!.opened_principal_id).toBe(s.human); // the cashier, ATTRIBUTED
    expect(row!.opening_float).toBe("150.0000");
    expect(row!.closed_at).toBeNull();
  });

  it("re-sending the same open answers duplicate and writes nothing a second time (zero duplicates)", async () => {
    const id = await uuidv7(db.admin);
    await apply(t1, [openMsg(id, t1.terminalId)]);
    const out = await apply(t1, [
      openMsg(id, t1.terminalId, { openingFloat: { amount: "999.0000", currency: "MYR" } }),
    ]);
    expect(out.shiftResults[0]!.status).toBe("duplicate");

    const [row] = await db.admin<{ opening_float: string; n: number }[]>`
      select opening_float::text, (select count(*)::int from app.shift where id = ${id}) as n
        from app.shift where id = ${id}`;
    expect(row!.n).toBe(1);
    expect(row!.opening_float).toBe("150.0000"); // FIRST write wins; the re-send changed nothing
  });

  it("a shift claiming another terminal is REJECTED, and the row is not created", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t2.terminalId)]); // sent BY t1, CLAIMING t2
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.shiftResults[0]!.error!.detail).toContain("terminalId");
    const [n] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.shift where id = ${id}`;
    expect(n!.n).toBe(0);
  });

  it("an open with no openingFloat is rejected — a drawer with no counted-in figure is not a shift", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [openMsg(id, t1.terminalId, { openingFloat: null })]);
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.shiftResults[0]!.error!.detail).toContain("openingFloat");
  });

  it("an openingFloat in the wrong currency is rejected — the count and the shift are one money", async () => {
    const id = await uuidv7(db.admin);
    const out = await apply(t1, [
      openMsg(id, t1.terminalId, { openingFloat: { amount: "10.0000", currency: "USD" } }),
    ]);
    expect(out.shiftResults[0]!.status).toBe("rejected");
    expect(out.shiftResults[0]!.error!.detail).toContain("USD");
  });

  it("shiftResults come back in SEND order even though opens are applied before closes", async () => {
    const a = await uuidv7(db.admin);
    const b = await uuidv7(db.admin);
    await apply(t1, [openMsg(a, t1.terminalId)]);
    // Send [close a, open b]: the server applies open b FIRST (a close must see its batch's tickets), but
    // the till keys its outbox by ref and reads the array positionally in `markAcked` — a reordered array
    // would ack the wrong row (§4.10.5), which is a lost message with no error anywhere.
    const out = await apply(t1, [
      {
        ...openMsg(a, t1.terminalId),
        kind: "close",
        openingFloat: null,
        countedCash: { amount: "150.0000", currency: "MYR" },
      },
      openMsg(b, t1.terminalId),
    ]);
    expect(out.shiftResults.map((r) => r.ref)).toEqual([`${a}:close`, `${b}:open`]);
  });

  it("one bad shift message does not touch its neighbours (savepoint per message)", async () => {
    const good = await uuidv7(db.admin);
    const out = await apply(t1, [
      openMsg(good, t1.terminalId),
      openMsg("not-a-uuid", t1.terminalId),
    ]);
    expect(out.shiftResults.map((r) => r.status)).toEqual(["accepted", "rejected"]);
    const [n] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.shift where id = ${good}`;
    expect(n!.n).toBe(1);
  });

  it("a ticket naming a shift of ANOTHER terminal is refused by assertShiftKnown (amendment A2)", async () => {
    const foreign = await seedShift(db, s, {
      terminalId: t2.terminalId,
      cashierPrincipalId: s.human,
    });
    const { assertShiftKnown } = await import("../../src/sync/shifts");
    await expect(
      asTerminal(db, s, t1.principalId, (tx) =>
        assertShiftKnown(
          tx,
          {
            terminalId: t1.terminalId,
            companyId: s.company,
            branchId: s.hq,
            principalId: t1.principalId,
          },
          foreign,
        ),
      ),
    ).rejects.toMatchObject({ code: "ERR_CONFLICT_REFERENCE" });
  });

  it("assertShiftKnown accepts a shift of THIS terminal, while open", async () => {
    const mine = await seedShift(db, s, { terminalId: t1.terminalId, cashierPrincipalId: s.human });
    const { assertShiftKnown } = await import("../../src/sync/shifts");
    await expect(
      asTerminal(db, s, t1.principalId, (tx) =>
        assertShiftKnown(
          tx,
          {
            terminalId: t1.terminalId,
            companyId: s.company,
            branchId: s.hq,
            principalId: t1.principalId,
          },
          mine,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses reuse of a shift id by another signed terminal without acknowledging it", async () => {
    const id = await seedShift(db, s, { terminalId: t2.terminalId, cashierPrincipalId: s.human });
    const out = await apply(t1, [openMsg(id, t1.terminalId)]);
    expect(out.shiftResults[0]).toMatchObject({
      status: "rejected",
      error: { code: "ERR_CONFLICT_REFERENCE" },
    });
  });
  it("answers rejected, never duplicate, for a shift id another tenant holds — a row the read cannot see", async () => {
    // `app.shift`'s key is `id` alone, and RLS hides the other tenant's row from the duplicate read, so only the
    // insert meets it. With `on conflict do nothing` (removed by the 6D shift integrity corrections) the insert
    // returned nothing and the open was acknowledged as `duplicate` for a shift that is not this terminal's.
    const other = await seedTenantV2(db, "Shifty-Other");
    const theirs = await seedTerminal(db, other, { code: "OT1" });
    const id = await seedShift(db, other, {
      terminalId: theirs.terminalId,
      cashierPrincipalId: other.human,
    });
    const out = await apply(t1, [openMsg(id, t1.terminalId)]);
    expect(out.shiftResults[0]).toMatchObject({
      status: "rejected",
      error: { code: "ERR_CONFLICT_UNIQUE" },
    });
    const [mine] = await asTerminal(
      db,
      s,
      t1.principalId,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.shift where id = ${id}`,
    );
    expect(mine!.n).toBe(0);
    const [held] = await db.admin<{ tenant_id: string; terminal_id: string }[]>`
      select tenant_id, terminal_id from app.shift where id = ${id}`;
    expect(held).toEqual({ tenant_id: other.tenant, terminal_id: theirs.terminalId });
  });
  it("refuses unknown cashier authority and a non-company currency", async () => {
    const unknown = await apply(t1, [
      openMsg(await uuidv7(db.admin), t1.terminalId, { cashierPrincipalId: s.system }),
    ]);
    expect(unknown.shiftResults[0]).toMatchObject({
      status: "rejected",
      error: { code: "ERR_RBAC_FORBIDDEN" },
    });
    const foreign = await apply(t1, [
      openMsg(await uuidv7(db.admin), t1.terminalId, {
        currency: "USD",
        openingFloat: { amount: "1.0000", currency: "USD" },
      }),
    ]);
    expect(foreign.shiftResults[0]).toMatchObject({
      status: "rejected",
      error: { code: "ERR_VALIDATION_FAILED" },
    });
  });
  it("refuses new tickets under a shift whose server count has already been fixed", async () => {
    const id = await seedShift(db, s, { terminalId: t1.terminalId, cashierPrincipalId: s.human });
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) =>
        tx`update app.shift set closed_at=now(),closed_principal_id=${s.human},counted_cash=0,expected_cash=0,over_short=0 where id=${id}`,
    );
    const { assertShiftKnown } = await import("../../src/sync/shifts");
    await expect(
      asTerminal(db, s, t1.principalId, (tx) =>
        assertShiftKnown(
          tx,
          {
            terminalId: t1.terminalId,
            companyId: s.company,
            branchId: s.hq,
            principalId: t1.principalId,
          },
          id,
        ),
      ),
    ).rejects.toMatchObject({ code: "ERR_CONFLICT_REFERENCE" });
  });
});
