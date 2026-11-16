// apps/pos/test/authority.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPin } from "@dulja/db/staff/pin";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import {
  clockEvent,
  findCashierByEmployeeNumber,
  hasCode,
  liftRefusals,
  loginCashier,
  markAttendanceSent,
  pendingAttendance,
  requireCode,
  TILL_OVERRIDE_LIFTS,
  type TillRefusal,
} from "../src/main/authority";
import { TillError } from "../src/main/errors";

let db: PosDatabase;
let store: SqliteSyncStore;
const dirs: string[] = [];

const LIMITS = {
  maxLineDiscountPct: "0.100000",
  maxTicketDiscountPct: "0.050000",
  maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000",
  blindReturnAllowed: false,
  maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500",
  requireCustomerOver: null,
  maxCashInDrawer: null,
};

async function mirrorCashier(opts: {
  principalId: string;
  pin: string;
  codes: string[];
  revoked?: boolean;
}): Promise<void> {
  await store.applyChanges([
    {
      stream: "cashier",
      op: "upsert",
      id: opts.principalId,
      revision: 1n,
      row: {
        principal_id: opts.principalId,
        employee_id: "emp-1",
        branch_id: "br-1",
        pin_hash: await hashPin(opts.pin),
        snapshot: { codes: opts.codes, limits: LIMITS, revision: "1" },
        revoked_at: opts.revoked === true ? "2026-01-10T00:00:00.000Z" : null,
        employee_number: "E-001",
      },
    },
  ]);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
  dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
});
afterEach(() => {
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("PIN login and offline authority (spec:1324, §4.6.3)", () => {
  it("refuses malformed limits and a cashier from another enrolled branch", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.ticket.sell"] });
    db.raw.prepare("insert into meta values ('branch_id','other-branch')").run();
    await expect(loginCashier(db, { principalId: "p-1", pin: "4821" })).rejects.toMatchObject({
      code: "ERR_TILL_PIN_INVALID",
    });
    db.raw.prepare("delete from meta where key='branch_id'").run();
    for (const limits of [
      { ...LIMITS, maxLineDiscountPct: 1 },
      { ...LIMITS, roundingIncrement: "0.0000" },
      { ...LIMITS, maxPriceOverridePct: "1.100000" },
    ]) {
      db.raw
        .prepare("update catalogue_cashier set snapshot_json = ? where id='p-1'")
        .run(JSON.stringify({ codes: ["pos.ticket.sell"], limits, revision: "9007199254740993" }));
      await expect(loginCashier(db, { principalId: "p-1", pin: "4821" })).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    }
  });

  it("accepts the right PIN and returns the codes and limits from the snapshot", async () => {
    await mirrorCashier({
      principalId: "p-1",
      pin: "4821",
      codes: ["pos.ticket.sell", "pos.shift.own"],
    });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    expect(cashier.principalId).toBe("p-1");
    expect(cashier.branchId).toBe("br-1");
    expect(cashier.codes).toEqual(["pos.ticket.sell", "pos.shift.own"]);
    expect(cashier.limits.maxLineDiscountPct).toBe("0.100000");
    expect(cashier.snapshotRevision).toBe("1");
  });

  it("refuses the wrong PIN with ERR_TILL_PIN_INVALID and says nothing about which half was wrong", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: [] });
    let thrown: unknown;
    try {
      await loginCashier(db, { principalId: "p-1", pin: "0000" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_PIN_INVALID");
    // An unknown cashier answers the SAME code. A different one would let anyone enumerate the branch's
    // cashier list from the till's login screen.
    let unknown: unknown;
    try {
      await loginCashier(db, { principalId: "nobody", pin: "4821" });
    } catch (e) {
      unknown = e;
    }
    expect((unknown as TillError).code).toBe("ERR_TILL_PIN_INVALID");
  });

  it("refuses a revoked cashier even with the right PIN — the tombstone reaches a disconnected till", async () => {
    await mirrorCashier({
      principalId: "p-1",
      pin: "4821",
      codes: ["pos.ticket.sell"],
      revoked: true,
    });
    await expect(loginCashier(db, { principalId: "p-1", pin: "4821" })).rejects.toMatchObject({
      code: "ERR_TILL_PIN_INVALID",
    });
  });

  it("never stores or logs the PIN, and never compares it as a string", async () => {
    // SAH-028's whole point. The stored value is an Argon2id PHC string and the comparison is verifyPin's.
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: [] });
    const hash = db.raw
      .prepare<[], { pin_hash: string }>("select pin_hash from catalogue_cashier")
      .get()!.pin_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain("4821");
    const everything = db.raw
      .prepare<[], { row_json: string; snapshot_json: string }>(
        "select row_json, snapshot_json from catalogue_cashier",
      )
      .get()!;
    expect(everything.row_json).not.toContain('"4821"');
    expect(everything.snapshot_json).not.toContain("4821");
  });

  it("hasCode and requireCode read the snapshot, and requireCode refuses with ERR_RBAC_FORBIDDEN", async () => {
    await mirrorCashier({
      principalId: "p-1",
      pin: "4821",
      codes: ["pos.ticket.sell", "pos.price.check"],
    });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    expect(hasCode(cashier, "pos.price.check")).toBe(true);
    expect(hasCode(cashier, "pos.ticket.void")).toBe(false);
    expect(() => requireCode(cashier, "pos.ticket.void")).toThrow(TillError);
    try {
      requireCode(cashier, "pos.ticket.void");
    } catch (e) {
      expect((e as TillError).code).toBe("ERR_RBAC_FORBIDDEN");
    }
  });

  it("finds a cashier by employee number, which is what the login screen types", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: [] });
    expect(findCashierByEmployeeNumber(db, "E-001")).toEqual({ principalId: "p-1" });
    expect(findCashierByEmployeeNumber(db, "E-999")).toBeNull();
  });

  it("TILL_OVERRIDE_LIFTS lifts exactly what the subject names, and an unknown subject lifts nothing", () => {
    const refusals: TillRefusal[] = [
      { kind: "line_discount", detail: "12% > 10%", lineNo: 1 },
      { kind: "void", detail: "300.0000 > 200.0000", lineNo: null },
    ];
    expect(liftRefusals(refusals, ["discount"]).map((r) => r.kind)).toEqual(["void"]);
    expect(liftRefusals(refusals, ["discount", "void"])).toEqual([]);
    expect(liftRefusals(refusals, ["nonsense"])).toHaveLength(2);
    expect(TILL_OVERRIDE_LIFTS["blind_return"]).toEqual(["blind_return"]);
  });

  it("clockEvent writes an attendance row that survives until a ticket carries it (spec:2089)", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.attendance.clock"] });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    const id = await clockEvent(db, cashier, "clock_in");
    expect(pendingAttendance(db)).toEqual([
      { kind: "clock_in", principalId: "p-1", at: expect.any(String) },
    ]);
    markAttendanceSent(db, [id]);
    expect(pendingAttendance(db)).toEqual([]);
  });

  it("clockEvent refuses a cashier without pos.attendance.clock", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.ticket.sell"] });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    await expect(clockEvent(db, cashier, "clock_in")).rejects.toMatchObject({
      code: "ERR_RBAC_FORBIDDEN",
    });
  });
});
