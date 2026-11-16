import { v7 as uuidv7 } from "uuid";
import { D } from "@dulja/domain";
import { textToRevision } from "./money";
import { PERMISSION } from "@dulja/contracts";
import { verifyPin } from "@dulja/db/staff/pin";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";

export interface TillLimits {
  maxLineDiscountPct: string;
  maxTicketDiscountPct: string;
  maxVoidAmount: string;
  maxPriceOverridePct: string;
  blindReturnAllowed: boolean;
  maxBlindReturnAmount: string;
  roundingIncrement: string;
  requireCustomerOver: string | null;
  maxCashInDrawer: string | null;
}

export interface TillCashier {
  principalId: string;
  employeeId: string;
  branchId: string;
  codes: readonly string[];
  limits: TillLimits;
  snapshotRevision: string;
}

export type TillLimitKind =
  | "line_discount"
  | "ticket_discount"
  | "void"
  | "blind_return"
  | "price_override";
export interface TillRefusal {
  kind: TillLimitKind;
  detail: string;
  lineNo: number | null;
}

/**
 * The three codes §3.6.2 assigns slice 6B, named once, in the commit that seeds them.
 *
 * **This is what keeps `bun run lint:rules` green at every task boundary**, and it is not a lint prop.
 * §3.6.3's `permission-catalogue` rule fails the build when a catalogue code has no reference in
 * `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` or `packages/db/src` — and this task seeds three
 * codes whose real call sites land in this task (`pos.attendance.clock`, `clockEvent` below), **T5**
 * (`pos.price.check`, `priceCheck`) and **T6** (`pos.shift.own`, `openShift`). Without this array two of
 * the three would be orphans across two commits, and Global Constraint 19 — *"lint:rules stays green after
 * every task"* — would be suspended for the length of a PR chain rather than held.
 *
 * 6A's `packages/db/src/sync/authority.ts` is the precedent and its Task 5 gives the same reason in the same
 * words for its eight codes. The members are `PERMISSION[...]` lookups and not bare strings so a typo is a
 * compile error and `PermissionCode` stays the single source of the spelling.
 */
export const TILL_CODES = [
  PERMISSION["pos.price.check"],
  PERMISSION["pos.shift.own"],
  PERMISSION["pos.attendance.clock"],
] as const;

/**
 * Which override `subject` (§4.10.1's `TicketEvent.subject`) lifts which limit.
 *
 * It is the till's copy of 6C's `OVERRIDE_LIFTS` because that module imports `postgres` and the till carries
 * no PostgreSQL driver (Global Constraint 3). **Task 12's pinned test asserts the two maps are equal**, so a
 * change to one that is not made to the other fails the build rather than letting a till authorise something
 * the server will refuse — which is the SAH-027 shape 6C's nightly comparison exists to catch.
 *
 * `price_override` appears here and **not** in 6C's server-side map on purpose: 6C's Task 9 decision (c)
 * records that `max_price_override_pct` is enforced **at the till only**, because checking it server-side
 * would need a second pricing implementation and §4.10.1's `TicketLine` carries no catalogue price. The
 * server still verifies the override event's supervisor.
 */
export const TILL_OVERRIDE_LIFTS: Readonly<Record<string, readonly TillLimitKind[]>> = {
  discount: ["line_discount", "ticket_discount"],
  void: ["void"],
  blind_return: ["blind_return"],
  price_override: ["price_override"],
};

export function liftRefusals(
  refusals: readonly TillRefusal[],
  subjects: readonly string[],
): TillRefusal[] {
  const lifted = new Set<TillLimitKind>();
  for (const s of subjects) for (const k of TILL_OVERRIDE_LIFTS[s] ?? []) lifted.add(k);
  return refusals.filter((r) => !lifted.has(r.kind));
}

const refuse = (): never => {
  throw new TillError("ERR_TILL_PIN_INVALID", "that PIN does not match a cashier on this till");
};

interface CashierRow {
  id: string;
  employee_id: string;
  branch_id: string;
  pin_hash: string;
  snapshot_json: string;
  revoked_at: string | null;
}

/**
 * PIN login (spec:1324): the PIN is a **till credential and never a login** — no route accepts one and the
 * server never compares one. The stored value is the Argon2id PHC string 6C's `hashPin` produced, down-synced
 * in `catalogue_cashier`, and `verifyPin` is 6C's function imported through `@dulja/db/staff/pin` (A3) so
 * there is exactly one Argon2id call site in the product (SAH-025, 026, 028).
 *
 * **Every failure answers `ERR_TILL_PIN_INVALID`** — unknown cashier, wrong PIN, revoked credential alike.
 * Distinguishing them would let anyone standing at a till enumerate the branch's cashier list.
 *
 * This is the unthrottled check. Everything that takes a PIN from the screen calls `authenticateCashier`,
 * which counts failures and locks out before it ever reaches this function.
 */
export async function loginCashier(
  db: PosDatabase,
  opts: { principalId: string; pin: string },
): Promise<TillCashier> {
  const row = db.raw
    .prepare<[string], CashierRow>(
      "select id, employee_id, branch_id, pin_hash, snapshot_json, revoked_at from catalogue_cashier where id = ?",
    )
    .get(opts.principalId);

  if (row === undefined || row.revoked_at !== null) {
    // Still spend the time: an immediate answer for an unknown id is a timing oracle for the same list.
    await verifyPin(
      opts.pin,
      "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ).catch(() => false);
    return refuse();
  }
  if (!(await verifyPin(opts.pin, row.pin_hash))) return refuse();
  const expectedBranch = db.raw
    .prepare<[], { value: string }>("select value from meta where key = 'branch_id'")
    .get()?.value;
  if (expectedBranch !== undefined && expectedBranch !== row.branch_id) return refuse();
  let snapshot: { codes: string[]; limits: TillLimits; revision: string };
  try {
    snapshot = JSON.parse(row.snapshot_json) as typeof snapshot;
    if (!Array.isArray(snapshot.codes) || snapshot.codes.some((code) => typeof code !== "string"))
      return refuse();
    textToRevision(snapshot.revision);
    const limits = snapshot.limits;
    if (
      typeof limits !== "object" ||
      limits === null ||
      typeof limits.blindReturnAllowed !== "boolean"
    )
      return refuse();
    for (const key of [
      "maxLineDiscountPct",
      "maxTicketDiscountPct",
      "maxPriceOverridePct",
      "maxVoidAmount",
      "maxBlindReturnAmount",
      "roundingIncrement",
      "requireCustomerOver",
      "maxCashInDrawer",
    ] as const) {
      const value = limits[key];
      if (value === null && (key === "requireCustomerOver" || key === "maxCashInDrawer")) continue;
      if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return refuse();
      const decimal = new D(value);
      if (!decimal.isFinite() || decimal.isNegative()) return refuse();
      if (key.endsWith("Pct") && decimal.greaterThan(1)) return refuse();
      if (key === "roundingIncrement" && !decimal.greaterThan(0)) return refuse();
    }
  } catch {
    return refuse();
  }
  return {
    principalId: row.id,
    employeeId: row.employee_id,
    branchId: row.branch_id,
    codes: snapshot.codes,
    limits: snapshot.limits,
    snapshotRevision: snapshot.revision,
  };
}

/** What the login screen actually types: a short employee number, not a uuid. */
export function findCashierByEmployeeNumber(
  db: PosDatabase,
  employeeNumber: string,
): { principalId: string } | null {
  const row = db.raw
    .prepare<[string], { id: string }>(
      "select id from catalogue_cashier where json_extract(row_json, '$.employee_number') = ? and revoked_at is null",
    )
    .get(employeeNumber);
  return row === undefined ? null : { principalId: row.id };
}

/** Consecutive wrong PINs for one employee number before this till stops checking that number's PIN. */
export const PIN_FAILURES_BEFORE_LOCKOUT = 5;
/** The first lockout. Each further wrong PIN after a lockout ends doubles it, up to the cap below. */
export const PIN_LOCKOUT_BASE_MS = 5 * 60_000;
export const PIN_LOCKOUT_MAX_MS = 60 * 60_000;
/**
 * Wrong PINs this till takes **across every employee number** in any rolling window before it stops checking
 * any PIN until the oldest of them leaves the window. The per-number lockout cannot see one common PIN tried
 * against every number on the branch; this caps that spray at one guess a minute. A success does not free the
 * budget other attempts used, so a cashier who knows their own PIN cannot reset it by signing in between.
 */
export const TILL_PIN_FAILURES_PER_WINDOW = 10;
export const TILL_PIN_WINDOW_MS = 10 * 60_000;

/** How long the till refuses an employee number once it has `failures` consecutive wrong PINs. */
export function pinLockoutMs(failures: number): number {
  if (failures < PIN_FAILURES_BEFORE_LOCKOUT) return 0;
  const doublings = Math.min(failures - PIN_FAILURES_BEFORE_LOCKOUT, 16);
  return Math.min(PIN_LOCKOUT_MAX_MS, PIN_LOCKOUT_BASE_MS * 2 ** doublings);
}

/**
 * SAH-028's *"rate limiting and lockout on failed attempts"* (spec:476). It binds here because the cashier
 * PIN is the only credential the application hashes itself (spec:2132), and a four-digit PIN is ten thousand
 * guesses. **Every PIN the till takes from the screen comes through this function** — a sign-in and a
 * supervisor's approval alike — so both share one counter per employee number.
 *
 * - The counter is keyed by the employee number **as typed**, not by the cashier it resolves to, and an
 *   unknown number is counted and locked exactly like a known one: the lockout cannot be used to learn
 *   which numbers exist.
 * - The attempt is counted **before** the PIN is verified, in one synchronous SQLite transaction, so
 *   attempts racing on the IPC channel cannot each slip under the limit. A success deletes the count.
 * - A locked attempt is refused before the lookup and before `verifyPin` runs, so even the right PIN learns
 *   nothing until the window has passed.
 * - The same transaction spends one of the till's `TILL_PIN_FAILURES_PER_WINDOW`, and a success gives back
 *   only the one it spent.
 * - The count is a `meta` row of the till's SQLite file — owned local bookkeeping like `cancel:<ref>`, never
 *   synced and never a mirror (ADR 0057, §4.10.6) — so restarting the application does not reset it.
 */
export async function authenticateCashier(
  sqliteDb: PosDatabase,
  opts: { employeeNumber: string; pin: string; at?: Date },
): Promise<TillCashier> {
  const at = opts.at ?? new Date();
  countPinAttempt(sqliteDb, opts.employeeNumber, at);
  const found = findCashierByEmployeeNumber(sqliteDb, opts.employeeNumber);
  const cashier = await loginCashier(sqliteDb, {
    principalId: found?.principalId ?? "unknown",
    pin: opts.pin,
  });
  sqliteDb.tx(() => {
    sqliteDb.raw.prepare("delete from meta where key = ?").run(pinAttemptKey(opts.employeeNumber));
    const spent = readMeta<string[]>(sqliteDb, TILL_PIN_ATTEMPTS_KEY) ?? [];
    const own = spent.indexOf(at.toISOString());
    if (own !== -1) writeMeta(sqliteDb, TILL_PIN_ATTEMPTS_KEY, spent.toSpliced(own, 1));
  });
  return cashier;
}

/** The `meta` key of one employee number's PIN lockout; `mirror.ts` clears it when a new credential arrives. */
export const pinAttemptKey = (employeeNumber: string): string => `pin_attempt:${employeeNumber}`;
/** Not under `pin_attempt:`, so no employee number can name it. Holds the window's attempt times. */
const TILL_PIN_ATTEMPTS_KEY = "till_pin_attempts";

function readMeta<T>(sqliteDb: PosDatabase, key: string): T | undefined {
  const stored = sqliteDb.raw
    .prepare<[string], { value: string }>("select value from meta where key = ?")
    .get(key)?.value;
  return stored === undefined ? undefined : (JSON.parse(stored) as T);
}
function writeMeta(sqliteDb: PosDatabase, key: string, value: unknown): void {
  sqliteDb.raw
    .prepare(
      "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
    )
    .run(key, JSON.stringify(value));
}

function countPinAttempt(sqliteDb: PosDatabase, employeeNumber: string, at: Date): void {
  const key = pinAttemptKey(employeeNumber);
  // The refusal is thrown after the transaction commits, so the clamp below is kept even when it refuses.
  const refusal = sqliteDb.tx((): string | null => {
    const prior = readMeta<{ failures: number; lockedUntil: string | null }>(sqliteDb, key) ?? {
      failures: 0,
      lockedUntil: null,
    };
    // Both bounds are measured from `at`, so a till clock that moves backwards cannot stretch a lockout past
    // its cap or keep a spent attempt in the window for ever. A stored end later than the cap allows is
    // rewritten to the cap — once, so it then runs out like any other — and an attempt stamped after `at`
    // has left the window.
    const now = at.getTime();
    let lockedUntil = prior.lockedUntil === null ? null : Date.parse(prior.lockedUntil);
    if (lockedUntil !== null && lockedUntil > now + PIN_LOCKOUT_MAX_MS) {
      lockedUntil = now + PIN_LOCKOUT_MAX_MS;
      writeMeta(sqliteDb, key, { ...prior, lockedUntil: new Date(lockedUntil).toISOString() });
    }
    if (lockedUntil !== null && lockedUntil > now)
      return `too many wrong PINs for this employee number; try again after ${new Date(lockedUntil).toISOString()}`;
    const spent = (readMeta<string[]>(sqliteDb, TILL_PIN_ATTEMPTS_KEY) ?? []).filter((time) => {
      const spentAt = Date.parse(time);
      return spentAt > now - TILL_PIN_WINDOW_MS && spentAt <= now;
    });
    if (spent.length >= TILL_PIN_FAILURES_PER_WINDOW)
      return `too many wrong PINs at this till; try again after ${new Date(
        Math.min(...spent.map((time) => Date.parse(time))) + TILL_PIN_WINDOW_MS,
      ).toISOString()}`;
    const failures = prior.failures + 1;
    const lockout = pinLockoutMs(failures);
    writeMeta(sqliteDb, key, {
      failures,
      lockedUntil: lockout === 0 ? null : new Date(now + lockout).toISOString(),
    });
    writeMeta(sqliteDb, TILL_PIN_ATTEMPTS_KEY, [...spent, at.toISOString()]);
    return null;
  });
  if (refusal !== null) throw new TillError("ERR_RATE_LIMITED", refusal);
}

export function hasCode(cashier: TillCashier, code: string): boolean {
  return cashier.codes.includes(code);
}

export function requireCode(cashier: TillCashier, code: string): void {
  if (!hasCode(cashier, code)) {
    throw new TillError(
      "ERR_RBAC_FORBIDDEN",
      `this cashier does not hold ${code} at branch ${cashier.branchId}`,
    );
  }
}

/**
 * Clock in or out (spec:2089, §3.7.6's Staff row).
 *
 * The event is a **row**, not a field on a ticket, because a clock-in at 08:00 must survive until the first
 * sale at 08:04 — and must survive the till being closed in between. `pendingAttendance` is what `sell`
 * drains into `Ticket.attendance[]` (§4.10.1), and `markAttendanceSent` is called in the same SQLite
 * transaction as the ticket, so an event is attached to exactly one ticket and never to none.
 *
 * The literal below is `PERMISSION["pos.attendance.clock"]` and not the string, which is what makes
 * §3.6.3's `permission-catalogue` lint see a reference from `apps/pos` (the code has no other reference
 * anywhere in the product).
 */
export async function clockEvent(
  db: PosDatabase,
  cashier: TillCashier,
  kind: "clock_in" | "clock_out",
): Promise<string> {
  requireCode(cashier, PERMISSION["pos.attendance.clock"]);
  const id = uuidv7();
  db.raw
    .prepare(
      "insert into attendance (id, principal_id, kind, occurred_at, sent_at) values (?, ?, ?, ?, null)",
    )
    .run(id, cashier.principalId, kind, new Date().toISOString());
  return id;
}

export function pendingAttendance(
  db: PosDatabase,
): { kind: "clock_in" | "clock_out"; principalId: string; at: string }[] {
  return db.raw
    .prepare<[], { kind: "clock_in" | "clock_out"; principal_id: string; occurred_at: string }>(
      "select kind, principal_id, occurred_at from attendance where sent_at is null order by occurred_at, id",
    )
    .all()
    .map((r) => ({ kind: r.kind, principalId: r.principal_id, at: r.occurred_at }));
}

export function markAttendanceSent(db: PosDatabase, ids: readonly string[]): void {
  const stamp = db.raw.prepare("update attendance set sent_at = ? where id = ?");
  const now = new Date().toISOString();
  for (const id of ids) stamp.run(now, id);
}
