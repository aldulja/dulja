// apps/pos/test/pin-lockout.test.ts — SAH-028's "rate limiting and lockout on failed attempts" (spec:476).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPin, verifyPin } from "@dulja/db/staff/pin";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import {
  authenticateCashier,
  PIN_FAILURES_BEFORE_LOCKOUT,
  PIN_LOCKOUT_BASE_MS,
  PIN_LOCKOUT_MAX_MS,
  pinLockoutMs,
  TILL_PIN_FAILURES_PER_WINDOW,
  TILL_PIN_WINDOW_MS,
} from "../src/main/authority";

// The real Argon2id check, wrapped so a test can see whether a locked attempt reached it at all.
vi.mock("@dulja/db/staff/pin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dulja/db/staff/pin")>();
  return { ...actual, verifyPin: vi.fn(actual.verifyPin) };
});

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
const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const dirs: string[] = [];
const open: PosDatabase[] = [];
let path: string;
let db: PosDatabase;
let pinHash: string;

function openAt(file: string): PosDatabase {
  const opened = openPosDatabase(file);
  open.push(opened);
  return opened;
}
const attempt = (employeeNumber: string, pin: string, when: Date, on: PosDatabase = db) =>
  authenticateCashier(on, { employeeNumber, pin, at: when });
const verifications = () => vi.mocked(verifyPin).mock.calls.length;

beforeAll(async () => {
  pinHash = await hashPin("4821");
});
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-lockout-"));
  dirs.push(dir);
  path = join(dir, "till.sqlite");
  db = openAt(path);
  await new SqliteSyncStore(db).applyChanges(
    ["E-001", "E-002"].map((employeeNumber, index) => ({
      stream: "cashier" as const,
      op: "upsert" as const,
      id: `p-${index + 1}`,
      revision: BigInt(index + 1),
      row: {
        principal_id: `p-${index + 1}`,
        employee_id: `emp-${index + 1}`,
        employee_number: employeeNumber,
        branch_id: "br-1",
        pin_hash: pinHash,
        snapshot: { codes: ["pos.ticket.sell"], limits: LIMITS, revision: "1" },
        revoked_at: null,
      },
    })),
  );
  vi.mocked(verifyPin).mockClear();
});
afterEach(() => {
  for (const opened of open.splice(0)) opened.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PIN lockout at the till (SAH-028, spec:476)", () => {
  it("locks an employee number after five wrong PINs and refuses even the right PIN, unverified, until the window passes", async () => {
    for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT; i++)
      await expect(attempt("E-001", "0000", at(i * 1000))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    expect(verifications()).toBe(PIN_FAILURES_BEFORE_LOCKOUT);
    const fifth = (PIN_FAILURES_BEFORE_LOCKOUT - 1) * 1000;
    for (const when of [fifth + 1, fifth + PIN_LOCKOUT_BASE_MS - 1])
      await expect(attempt("E-001", "4821", at(when))).rejects.toMatchObject({
        code: "ERR_RATE_LIMITED",
      });
    // The locked attempts never reached Argon2id, so they are neither an oracle nor a timing signal.
    expect(verifications()).toBe(PIN_FAILURES_BEFORE_LOCKOUT);
    // Another employee number on the same till is not caught by the lockout.
    expect((await attempt("E-002", "4821", at(fifth + 2))).principalId).toBe("p-2");
    expect((await attempt("E-001", "4821", at(fifth + PIN_LOCKOUT_BASE_MS))).principalId).toBe(
      "p-1",
    );
    expect(
      db.raw.prepare("select count(*) as n from meta where key like 'pin_attempt:%'").get(),
    ).toEqual({ n: 0 });
  });

  it("never holds a lockout or the till's window longer than its cap when the till's clock moves backwards", async () => {
    for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT; i++)
      await expect(attempt("E-001", "0000", at(i))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    // The clock jumps back a day. The lockout still binds, but only for the cap measured from the new time.
    const back = -24 * 60 * 60_000;
    await expect(attempt("E-001", "4821", at(back))).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
    });
    expect((await attempt("E-001", "4821", at(back + PIN_LOCKOUT_MAX_MS))).principalId).toBe("p-1");
    // The five wrong PINs were stamped in the till's "future" and no longer fill its window.
    for (let i = 0; i < TILL_PIN_FAILURES_PER_WINDOW - 1; i++)
      await expect(
        attempt(`X-${i}`, "0000", at(back + PIN_LOCKOUT_MAX_MS + 1 + i)),
      ).rejects.toMatchObject({ code: "ERR_TILL_PIN_INVALID" });
  });

  it("lets a manager's PIN reset, arriving as a new credential, clear the lockout — and nothing else", async () => {
    for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT; i++)
      await expect(attempt("E-001", "0000", at(i))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    const credential = (revision: bigint, hash: string) => ({
      stream: "cashier" as const,
      op: "upsert" as const,
      id: "p-1",
      revision,
      row: {
        principal_id: "p-1",
        employee_id: "emp-1",
        employee_number: "E-001",
        branch_id: "br-1",
        pin_hash: hash,
        snapshot: { codes: ["pos.ticket.sell"], limits: LIMITS, revision: String(revision) },
        revoked_at: null,
      },
    });
    // A snapshot-only change (same PIN hash) is not a reset: the number stays locked.
    await new SqliteSyncStore(db).applyChanges([credential(10n, pinHash)]);
    await expect(attempt("E-001", "4821", at(60_000))).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
    });
    // The reset PIN arrives with a new hash, and the cashier can sign in with it at once.
    await new SqliteSyncStore(db).applyChanges([credential(11n, await hashPin("1357"))]);
    expect((await attempt("E-001", "1357", at(61_000))).principalId).toBe("p-1");
  });

  it("resets the count on a successful PIN", async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT - 1; i++)
        await expect(attempt("E-001", "0000", at(round * 10_000 + i))).rejects.toMatchObject({
          code: "ERR_TILL_PIN_INVALID",
        });
      // Without the reset this fifth attempt would leave the number locked, and the next round's first
      // wrong PIN would be refused unverified instead of answering ERR_TILL_PIN_INVALID.
      expect((await attempt("E-001", "4821", at(round * 10_000 + 9))).principalId).toBe("p-1");
    }
  });

  it("keeps the lockout across closing and reopening the till's database", async () => {
    for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT; i++)
      await expect(attempt("E-001", "0000", at(i))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    db.close();
    const reopened = openAt(path);
    await expect(attempt("E-001", "4821", at(60_000), reopened)).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
    });
    expect(
      (
        await attempt(
          "E-001",
          "4821",
          at(PIN_FAILURES_BEFORE_LOCKOUT + PIN_LOCKOUT_BASE_MS),
          reopened,
        )
      ).principalId,
    ).toBe("p-1");
  });

  it("locks an unknown employee number exactly as it locks a real one, so the lockout lists nobody", async () => {
    const refusals = async (employeeNumber: string) => {
      vi.mocked(verifyPin).mockClear();
      const codes: unknown[] = [];
      for (let i = 0; i <= PIN_FAILURES_BEFORE_LOCKOUT; i++)
        codes.push(
          await attempt(employeeNumber, "0000", at(i)).then(
            () => "signed in",
            (error: { code: string; detail: string }) => error.code,
          ),
        );
      const locked = await attempt(
        employeeNumber,
        "0000",
        at(PIN_FAILURES_BEFORE_LOCKOUT + 1),
      ).catch((error: { detail: string }) => error.detail);
      return { codes, verified: verifications(), locked };
    };
    const known = await refusals("E-001");
    expect(known.codes).toEqual([
      ...Array<string>(PIN_FAILURES_BEFORE_LOCKOUT).fill("ERR_TILL_PIN_INVALID"),
      "ERR_RATE_LIMITED",
    ]);
    expect(known.verified).toBe(PIN_FAILURES_BEFORE_LOCKOUT);
    expect(await refusals("E-999")).toEqual(known);
  });

  it("doubles each further lockout and stops at the cap", async () => {
    expect(pinLockoutMs(PIN_FAILURES_BEFORE_LOCKOUT - 1)).toBe(0);
    expect(pinLockoutMs(PIN_FAILURES_BEFORE_LOCKOUT)).toBe(PIN_LOCKOUT_BASE_MS);
    expect(pinLockoutMs(PIN_FAILURES_BEFORE_LOCKOUT + 1)).toBe(2 * PIN_LOCKOUT_BASE_MS);
    expect(pinLockoutMs(PIN_FAILURES_BEFORE_LOCKOUT + 2)).toBe(4 * PIN_LOCKOUT_BASE_MS);
    expect(pinLockoutMs(1_000_000)).toBe(PIN_LOCKOUT_MAX_MS);
    for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT; i++)
      await expect(attempt("E-001", "0000", at(0))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    // The first window ends; one more wrong PIN locks the number again, for twice as long.
    await expect(attempt("E-001", "0000", at(PIN_LOCKOUT_BASE_MS))).rejects.toMatchObject({
      code: "ERR_TILL_PIN_INVALID",
    });
    await expect(
      attempt("E-001", "4821", at(PIN_LOCKOUT_BASE_MS + 2 * PIN_LOCKOUT_BASE_MS - 1)),
    ).rejects.toMatchObject({ code: "ERR_RATE_LIMITED" });
    expect(
      (await attempt("E-001", "4821", at(PIN_LOCKOUT_BASE_MS + 2 * PIN_LOCKOUT_BASE_MS)))
        .principalId,
    ).toBe("p-1");
  });

  it("counts attempts that race each other before any of them is verified", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: PIN_FAILURES_BEFORE_LOCKOUT + 3 }, () =>
        attempt("E-001", "0000", at(0)),
      ),
    );
    const codes = results.map((r) =>
      r.status === "rejected" ? (r.reason as { code: string }).code : "ok",
    );
    expect(codes.filter((c) => c === "ERR_TILL_PIN_INVALID")).toHaveLength(
      PIN_FAILURES_BEFORE_LOCKOUT,
    );
    expect(codes.filter((c) => c === "ERR_RATE_LIMITED")).toHaveLength(3);
    expect(verifications()).toBe(PIN_FAILURES_BEFORE_LOCKOUT);
  });

  it("throttles one PIN sprayed across many employee numbers, which no single number's lockout sees", async () => {
    // Each attempt is the first wrong PIN for its number, so the per-number lockout never trips.
    for (let i = 0; i < TILL_PIN_FAILURES_PER_WINDOW; i++)
      await expect(attempt(`E-${100 + i}`, "1234", at(i * 1000))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
    const verified = verifications();
    const spent = at(TILL_PIN_FAILURES_PER_WINDOW * 1000);
    await expect(attempt("E-200", "1234", spent)).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
    });
    // The whole till is paused: a real cashier's right PIN is refused too, unverified, and a restart keeps it.
    db.close();
    const reopened = openAt(path);
    await expect(attempt("E-002", "4821", spent, reopened)).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
    });
    expect(verifications()).toBe(verified);
    // The oldest wrong PIN leaves the window, and its place in the budget comes back.
    expect((await attempt("E-002", "4821", at(TILL_PIN_WINDOW_MS), reopened)).principalId).toBe(
      "p-2",
    );
  });

  it("spends the till's budget only on wrong PINs, and a success between them gives none of it back", async () => {
    for (let i = 0; i <= TILL_PIN_FAILURES_PER_WINDOW; i++)
      expect((await attempt("E-002", "4821", at(i))).principalId).toBe("p-2");
    // A cashier who knows their own PIN signs in after every guess; the guesses still use up the budget.
    for (let i = 0; i < TILL_PIN_FAILURES_PER_WINDOW; i++) {
      await expect(attempt(`E-${100 + i}`, "1234", at(100 + i))).rejects.toMatchObject({
        code: "ERR_TILL_PIN_INVALID",
      });
      if (i < TILL_PIN_FAILURES_PER_WINDOW - 1)
        expect((await attempt("E-002", "4821", at(200 + i))).principalId).toBe("p-2");
    }
    await expect(attempt("E-002", "4821", at(300))).rejects.toMatchObject({
      code: "ERR_RATE_LIMITED",
    });
  });
});
