import { applyBatch } from "@dulja/db";
import {
  seedBranch,
  seedShift,
  seedBranchPosPolicy,
  seedCashier,
  seedEmployee,
  grantCodes,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { withTenant } from "@dulja/db"; // the PRODUCTION 3-argument form (§4.2.2)
import type { Ticket, TicketEvent } from "@dulja/sync";
import type { TicketOutcome } from "@dulja/db"; // 6A's db-local outcome, NOT @dulja/sync's TicketResult
import type { StartedApi } from "../../../apps/api/test/support/app"; // TYPE only, exactly as pos.ts does
import { buildTicket, posFixture, type PosFixture } from "./pos";

export interface StaffFixture {
  shiftA: string;
  openShift(opts: { cashierPrincipalId: string; openingFloat?: string }): Promise<string>;
  /** 6A's corpus, whole. Nothing below re-seeds any part of it. */
  pos: PosFixture;
  seed: Seed; // === pos.s, carried here because every call site reads it
  branchA: string; // === pos.s.hq — the branch pos.terminal is enrolled at
  branchB: string;
  terminalA: PosFixture["terminal"]; // === pos.terminal
  cashierA: string; // a pos_cashier at A: sell, discount, return (+ pos.shift.own, added by 6B's T4)
  cashierB: string; // a pos_cashier at B: sell
  supervisorA: string; // a pos_cashier at A holding pos.ticket.override and nothing else
  itemId: string;
  unitId: string; // === pos.items["SKU-A"], which HAS stock
}

/**
 * 6A's POS world plus a second branch, three cashiers and one limit row per branch.
 * The single shared staff world for every test in this slice (hazard 9).
 * Branch A's limits: line 10 %, ticket 5 %, void 50.0000, blind returns NOT allowed.
 * Branch B's limits: all zero — the closed defaults, so B refuses whatever A permits.
 *
 * It takes a `StartedApi` because `posFixture` does (it enrols a terminal through the real routes). Tests in
 * the `tests` workspace get one from 0B's `sharedApi()`; `apps/api/test/**` passes its own.
 */
export async function staffFixture(api: StartedApi, name: string): Promise<StaffFixture> {
  const pos = await posFixture(api, name); // company, items, warehouse, STOCK, tax pack,
  const db = api.db; // POS_TICKET, POS_EQUIV_INVOICE, enrolled terminal
  const seed = pos.s;
  const branchA = seed.hq; // where pos.terminal is enrolled
  const branchB = await seedBranch(db, seed, { code: `${name}-B` });

  const empA = await seedEmployee(db, seed, {
    employeeNumber: `${name}-EA`,
    homeBranchId: branchA,
  });
  const empB = await seedEmployee(db, seed, {
    employeeNumber: `${name}-EB`,
    homeBranchId: branchB,
  });
  const empS = await seedEmployee(db, seed, {
    employeeNumber: `${name}-ES`,
    homeBranchId: branchA,
  });

  await seedBranchPosPolicy(db, seed, {
    branchId: branchA,
    limits: {
      maxLineDiscountPct: "0.100000",
      maxTicketDiscountPct: "0.050000",
      maxVoidAmount: "50.0000",
    },
  });
  await seedBranchPosPolicy(db, seed, { branchId: branchB }); // every default at the closed position

  // These are 6C's OWN cashier principals, not `pos.cashierId` / `pos.supervisorId`. 6A's two principals
  // carry 6A's grant lists, which include pos.ticket.void and pos.ticket.return_blind on the supervisor;
  // test 37 needs a supervisor who could NOT have sold the ticket themselves, so it mints its own.
  //
  // ⚠️ **`"pos.shift.own"` joins this array in 6B's Task 4 PR, and is NOT to be removed as foreign.**
  // 6B's T4 Step 5 writes the edit out in full (6b:3067) and lists this file in its own Files block and its
  // `git add`. It cannot land here: `seedCashier` turns `permissions` into a per-cashier role through
  // `grantCodes`, which inserts into `app.role_permission`, whose `permission_code` FK points at
  // `app.permission` (plan0A:1322–1326) — and `pos.shift.own` does not exist until **6B's migration 0063**
  // is applied. Without it 6B's T6 `openShift`, which opens with `requireCode(opts.cashier,
  // PERMISSION["pos.shift.own"])`, throws `ERR_RBAC_FORBIDDEN` inside `openTill` and fails every case of
  // acceptance test 19. It is harmless to this slice: every exact-`codes` snapshot assertion (T7's four
  // `snap.codes` / `snapshotOf` cases, T8's two `body.snapshot.codes` cases) mints its **own** cashier with
  // its own `permissions` list, and none of them reads `cashierA`; `CASHIER_SNAPSHOT_CODES` is a derivation
  // (amendment A5), so 0063's three codes widen both its SQL and its TypeScript spelling by themselves.
  const cashierA = await seedCashier(db, seed, {
    employeeId: empA,
    branchId: branchA,
    pin: "4321",
    permissions: [
      "pos.ticket.sell",
      "pos.ticket.discount",
      "pos.ticket.return",
      "pos.shift.own",
      "pos.attendance.clock",
      "pos.price.check",
    ],
  });
  const cashierB = await seedCashier(db, seed, {
    employeeId: empB,
    branchId: branchB,
    pin: "4321",
    permissions: ["pos.ticket.sell"],
  });
  const supervisorA = await seedCashier(db, seed, {
    employeeId: empS,
    branchId: branchA,
    pin: "9999",
    permissions: ["pos.ticket.override"],
  });
  await api.loadPrincipals(); // the API half of Task 10 signs tokens for these

  const openShift = (opts: { cashierPrincipalId: string; openingFloat?: string }) =>
    seedShift(db, seed, {
      terminalId: pos.terminal.terminalId,
      cashierPrincipalId: opts.cashierPrincipalId,
      ...(opts.openingFloat === undefined ? {} : { openingFloat: opts.openingFloat }),
      branchId: branchA,
    });
  const shiftA = await openShift({ cashierPrincipalId: cashierA });
  const item = pos.items["SKU-A"]!;
  return {
    shiftA,
    openShift,
    pos,
    seed,
    branchA,
    branchB,
    terminalA: pos.terminal,
    cashierA,
    cashierB,
    supervisorA,
    itemId: item.itemId,
    unitId: item.baseUnitId,
  };
}

export interface TicketDraft {
  cashierPrincipalId: string;
  kind?: "sale" | "return";
  returnsClientRef?: string | null;
  /** One entry per item line. `sku` defaults to "SKU-A", the stocked item every case uses. */
  lines: { unitPrice: string; quantity: string; discount?: string; sku?: string }[];
  events?: TicketEvent[];
  attendance?: Ticket["attendance"];
}

/**
 * Composes a `Ticket` through **6A's `buildTicket`** and applies it through **6A's `applyBatch`**, returning
 * 6A's own `TicketOutcome`. It computes no tax, negates nothing and asserts nothing: 6A owns the ticket's
 * shape and its accounting, this slice owns its authority, and a helper that re-implemented either would be
 * the second spelling hazard 9 forbids.
 *
 * **Why `buildTicket` and not a hand-built literal.** Two of its rules are invisible until they bite.
 * (1) A `return` carries NEGATIVE quantity, total, tax and tender — `applyBatch` step (b) refuses a return
 *     whose line quantity is `> 0` with `ERR_VALIDATION_FAILED` before any 6C check runs (6A:3670), so both
 *     blind-return cases below would fail for the wrong reason.
 * (2) `taxAmount` is the SYNTH rate extracted from the DISCOUNTED total; step (g) recomputes it and refuses
 *     a disagreement, so a helper that sent zero tax would be refused on every ticket.
 * Amendment A13 is what gives `buildTicket` its `discount` and `lines` options.
 */
export async function applyTicket(f: StaffFixture, draft: TicketDraft): Promise<TicketOutcome> {
  const t = buildTicket(f.pos, {
    kind: draft.kind ?? "sale",
    returnsClientRef: draft.returnsClientRef ?? null,
    cashierPrincipalId: draft.cashierPrincipalId,
    events: draft.events ?? [],
    lines: draft.lines.map((l) => ({
      sku: l.sku ?? "SKU-A",
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      ...(l.discount === undefined ? {} : { discount: l.discount }),
    })),
  });
  // `attendance` is not a `buildTicket` option — it rides on the ticket and belongs to no line — so it is
  // set here rather than widening 6A's helper for one field.
  t.attendance = draft.attendance ?? [];

  const db = f.pos.api.db;
  const ctx = {
    tenantId: f.seed.tenant,
    actorId: f.terminalA.principalId,
    requestId: crypto.randomUUID(),
  };
  // applyBatch is FOUR parameters (6A): (tx, ctx: TenantContext, terminal: TerminalApplyContext, batch).
  // `ctx` carries the tenant and the ACTING principal; `terminal` carries the company, the branch, the
  // terminal id and the terminal's principal. Neither is derivable from the other, which is why there are two.
  const terminal = {
    terminalId: f.terminalA.terminalId,
    companyId: f.seed.company,
    branchId: f.branchA,
    principalId: f.terminalA.principalId,
  };
  const out = await withTenant(db.rw, ctx, (tx) =>
    applyBatch(tx, ctx, terminal, {
      terminalId: terminal.terminalId,
      batchId: crypto.randomUUID(),
      tickets: [t],
      shifts: [],
      tillEvents: [],
    }),
  );
  return out.results[0]!;
}

/**
 * A principal holding `codes` in the company, restricted to `branchId` — or **company-wide when
 * `branchId` is null**, which is `grantCodes` with no `branchIds` and is the case Task 10 needs to prove
 * that scope narrows and never widens. Returns the principal id.
 */
export async function branchActor(
  db: Db,
  s: Seed,
  branchId: string | null,
  codes: readonly string[],
  label: string,
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(
    db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() },
    async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`sub-${label}-${id}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    },
  );
  await grantCodes(db, s, {
    codes,
    principalId: id,
    roleCode: `role-${label}-${id.slice(-8)}`,
    ...(branchId === null ? {} : { branchIds: [branchId] }),
  });
  return id;
}
