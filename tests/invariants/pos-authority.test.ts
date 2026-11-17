import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import type { Db } from "@dulja/db/test"; // the production 3-argument form
import { seedCashier, seedEmployee } from "@dulja/db/test";
import { sharedApi } from "../support/api"; // 0B's memoised StartedApi (§4.17.1)
import { staffFixture, applyTicket, branchActor, type StaffFixture } from "./support/staff";

let db: Db;
let f: StaffFixture;
let ledgerAfterAccepted: number;

/** Every ledger row in this fixture's OWN tenant. `posFixture` seeds a fresh tenant per call, so the count
 *  is this test's alone even though the API instance is shared. */
const ctx = () => ({
  tenantId: f.seed.tenant,
  actorId: f.seed.system,
  requestId: crypto.randomUUID(),
});
const countLedger = () =>
  withTenant(
    db.rw,
    ctx(),
    (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.ledger_entry`,
  ).then((r) => r[0]!.n);
const countLedgerFor = (documentId: string) =>
  withTenant(
    db.rw,
    ctx(),
    (tx) =>
      tx<
        { n: number }[]
      >`select count(*)::int as n from app.ledger_entry where document_id = ${documentId}`,
  ).then((r) => r[0]!.n);

beforeAll(async () => {
  // `sharedApi()` is 0B's registered way for the `tests` workspace to get a running API (§4.17.1); it is
  // memoised and is NOT stopped here — every regression file in this workspace shares it, and this suite
  // works in its own freshly seeded tenant.
  const { api } = await sharedApi();
  db = api.db;
  f = await staffFixture(api, "auth37");
}, 300_000);

describe("Acceptance test 37 — POS authority re-verified server-side (spec:2455; LEGACY-027, 048)", () => {
  it("a within-limit sale is accepted and posts", async () => {
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "5.0000" }], // 5% ≤ the 10% line limit
    });
    expect(r.status).toBe("accepted");
    expect(r.documentId).not.toBeNull();
    // A posted POS_TICKET writes SEVERAL ledger_entry rows, never one: app.ledger_entry is one row per
    // posting line with separate debit/credit columns and a CHECK that only one side is non-zero
    // (plan0A:1917-1921), so a balanced ticket is at minimum a cash debit and a revenue credit, and in
    // practice four once COGS and inventory post. Every count below is therefore an equality against a
    // CAPTURED value or a per-document count — never an arithmetic guess.
    expect(await countLedgerFor(r.documentId!)).toBeGreaterThanOrEqual(2);
    ledgerAfterAccepted = await countLedger();
    expect(ledgerAfterAccepted).toBeGreaterThan(0);
  });

  it("an over-limit LINE discount is rejected with ERR_POS_LIMIT_EXCEEDED and nothing reaches the ledger", async () => {
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }], // 25% > 10%
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect(r.error?.detail).toContain("line 1");
    expect(r.error?.detail).toContain("0.100000");
    expect(r.documentId).toBeNull();
    expect(await countLedger()).toBe(ledgerAfterAccepted); // "never in the ledger", as an equality
  });

  it("the rejected ticket is in needs_attention, with its payload and its code", async () => {
    const rows = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<
        { error_code: string; branch_id: string; resolved_at: string | null }[]
      >`select error_code, branch_id::text as branch_id, resolved_at
        from app.needs_attention order by created_at desc limit 1`,
    );
    expect(rows[0]).toMatchObject({
      error_code: "ERR_POS_LIMIT_EXCEEDED",
      branch_id: f.branchA,
      resolved_at: null,
    });
  });

  it("the SAME ticket with a supervisor override is accepted, and records ONE override event", async () => {
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "discount",
          supervisorPrincipalId: f.supervisorA,
          reason: "manager approved",
        },
      ],
    });
    expect(r.status).toBe("accepted");
    const events = await withTenant(
      db.rw,
      ctx(),
      (tx) => tx<
        { override_code: string; actor_id: string; attributed_to: string; reason: string }[]
      >`select override_code, actor_id, attributed_to, reason from app.document_event
        where document_id = ${r.documentId!} and event_kind = 'override'`,
    );
    // ONE row, not two. 6A's applyBatch step (h) is the only writer of this event; Step 5's seam adds no
    // recordOverride call of its own, and this length assertion is what would catch it if somebody did.
    expect(events).toHaveLength(1);
    // hazard 19 / LEGACY-044: the TERMINAL acted, the SUPERVISOR is attributed.
    expect(events[0]).toMatchObject({
      override_code: "pos.ticket.override",
      actor_id: f.terminalA.principalId,
      attributed_to: f.supervisorA,
      reason: "discount: manager approved",
    });
    ledgerAfterAccepted = await countLedger(); // re-capture: this ticket posted too
  });

  it("the cashier cannot be their own supervisor — ERR_OVERRIDE_NOT_AUTHORISED (the second-principal clause)", async () => {
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "discount",
          supervisorPrincipalId: f.cashierA,
          reason: "self",
        },
      ],
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
    expect(await countLedger()).toBe(ledgerAfterAccepted); // unchanged since the last accepted ticket
  });

  it("a supervisor who does not hold pos.ticket.override AT THIS BRANCH cannot lift the limit", async () => {
    const employeeId = await seedEmployee(db, f.seed, {
      employeeNumber: "auth37-SUP-B",
      homeBranchId: f.branchB,
    });
    const outsider = await seedCashier(db, f.seed, {
      employeeId,
      branchId: f.branchB,
      permissions: ["pos.ticket.override"],
    });
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "discount",
          supervisorPrincipalId: outsider,
          reason: "wrong branch",
        },
      ],
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
  });

  it("an over-limit TICKET discount is caught even when every line is within the line limit", async () => {
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      // three lines at 8% each: every line ≤ 10%, but the ticket is 8% > the 5% ticket limit
      lines: Array.from({ length: 3 }, () => ({
        unitPrice: "100.0000",
        quantity: "1.000000",
        discount: "8.0000",
      })),
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.detail).toContain("ticket discount");
  });

  it("a VOID over max_void_amount needs an override, and the cashier needs pos.ticket.void", async () => {
    const noVoid = await applyTicket(f, {
      cashierPrincipalId: f.cashierA, // holds sell, discount, return — NOT void
      lines: [{ unitPrice: "80.0000", quantity: "1.000000" }],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "void",
          supervisorPrincipalId: f.supervisorA,
          reason: "wrong item",
        },
      ],
    });
    expect(noVoid.status).toBe("rejected");
    expect(noVoid.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(noVoid.error?.detail).toContain("pos.ticket.void"); // an authority gap is NOT override-able
  });

  it("a BLIND return is refused when the branch does not allow one, and accepted with an override", async () => {
    const blind = {
      cashierPrincipalId: f.cashierA,
      kind: "return" as const,
      returnsClientRef: null,
      lines: [{ unitPrice: "30.0000", quantity: "1.000000" }],
    };
    const refused = await applyTicket(f, blind);
    expect(refused.status).toBe("rejected");
    expect(refused.error?.code).toBe("ERR_RBAC_FORBIDDEN"); // cashierA holds no pos.ticket.return_blind

    // `branchActor` alone is NOT enough here. `verifyTicket`'s FIRST check is "is this principal a live
    // pos_cashier at this branch"; a principal with a role assignment and no `pos_cashier` row is refused
    // with ERR_RBAC_FORBIDDEN before any limit is read, and the two assertions below would pass for the
    // wrong reason and then fail on the override case. `seedCashier` is what makes it a cashier.
    const empBlind = await seedEmployee(db, f.seed, {
      employeeNumber: "auth37-EBL",
      homeBranchId: f.branchA,
    });
    const cashierBlind = await seedCashier(db, f.seed, {
      employeeId: empBlind,
      branchId: f.branchA,
      pin: "5555",
      permissions: ["pos.ticket.return", "pos.ticket.return_blind"],
    });
    const stillRefused = await applyTicket(f, { ...blind, cashierPrincipalId: cashierBlind });
    expect(stillRefused.status).toBe("rejected");
    expect(stillRefused.error?.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect(stillRefused.error?.detail).toContain("blind return");
    const allowed = await applyTicket(f, {
      ...blind,
      cashierPrincipalId: cashierBlind,
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "blind_return",
          supervisorPrincipalId: f.supervisorA,
          reason: "customer known",
        },
      ],
    });
    expect(allowed.status).toBe("accepted");
  });

  it("a return WITH an original ticket needs no blind-return authority", async () => {
    const original = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "20.0000", quantity: "1.000000" }],
    });
    expect(original.status).toBe("accepted");
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      kind: "return",
      returnsClientRef: original.clientRef,
      lines: [{ unitPrice: "20.0000", quantity: "1.000000" }],
    });
    expect(r.status).toBe("accepted");
  });

  it("a limit is read from branch_pos_policy and NOT from the snapshot — a stale snapshot cannot widen it", async () => {
    // Widen only the snapshot, exactly as a compromised or lagging till would see it.
    await withTenant(
      db.migrator,
      ctx(),
      (tx) => tx`
      update app.pos_cashier
         set snapshot = jsonb_set(snapshot, '{limits,maxLineDiscountPct}', '"0.900000"')
       where principal_id = ${f.cashierA}`,
    );
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }],
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_POS_LIMIT_EXCEEDED");
  });

  it("a revoked cashier sells nothing, whatever the till's mirror still says", async () => {
    // The cashier must be revoked AT BRANCH A: `applyTicket` always applies through `terminalA`, and
    // `verifyTicket` looks the row up by (principal, company, BRANCH). Revoking `f.cashierB` — a branch-B
    // cashier — would match no row at branch A and the detail would read "no pos_cashier row …", not
    // "revoked". A fresh branch-A cashier is revoked instead, so `f.cashierA` stays usable for the
    // cases after this one.
    const empRev = await seedEmployee(db, f.seed, {
      employeeNumber: "auth37-ERV",
      homeBranchId: f.branchA,
    });
    const doomed = await seedCashier(db, f.seed, {
      employeeId: empRev,
      branchId: f.branchA,
      pin: "6666",
      permissions: ["pos.ticket.sell"],
    });
    await withTenant(
      db.rw,
      { tenantId: f.seed.tenant, actorId: f.seed.human, requestId: crypto.randomUUID() },
      (tx) => tx`update app.pos_cashier set revoked_at = now() where principal_id = ${doomed}`,
    );
    const r = await applyTicket(f, {
      cashierPrincipalId: doomed,
      lines: [{ unitPrice: "10.0000", quantity: "1.000000" }],
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(r.error?.detail).toContain("revoked");
  });

  it("a cashier of ANOTHER branch is refused at this terminal, and the reason says so", async () => {
    const r = await applyTicket(f, {
      cashierPrincipalId: f.cashierB,
      lines: [{ unitPrice: "10.0000", quantity: "1.000000" }],
    });
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(r.error?.detail).toContain("no pos_cashier row");
  });
  it("a revoked supervisor cannot lift a limit despite a retained branch grant", async () => {
    const employeeId = await seedEmployee(db, f.seed, { employeeNumber: "auth37-REVOKED-SUP" });
    const supervisorPrincipalId = await seedCashier(db, f.seed, {
      employeeId,
      branchId: f.branchA,
      permissions: ["pos.ticket.override"],
    });
    await withTenant(
      db.rw,
      ctx(),
      (tx) =>
        tx`update app.pos_cashier set revoked_at=now() where principal_id=${supervisorPrincipalId}`,
    );
    const before = await countLedger();
    const result = await applyTicket(f, {
      cashierPrincipalId: f.cashierA,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "discount",
          supervisorPrincipalId,
          reason: "stale credential",
        },
      ],
    });
    expect(result.error?.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");
    expect(await countLedger()).toBe(before);
  });
  it("base cashier grants cannot be rescued by a supervisor", async () => {
    const employeeId = await seedEmployee(db, f.seed, { employeeNumber: "auth37-NO-DISCOUNT" });
    const cashierPrincipalId = await seedCashier(db, f.seed, {
      employeeId,
      branchId: f.branchA,
      permissions: ["pos.ticket.sell"],
    });
    const result = await applyTicket(f, {
      cashierPrincipalId,
      lines: [{ unitPrice: "100.0000", quantity: "1.000000", discount: "25.0000" }],
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "discount",
          supervisorPrincipalId: f.supervisorA,
          reason: "cannot create a grant",
        },
      ],
    });
    expect(result.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(result.error?.detail).toContain("pos.ticket.discount");
    const noCredential = await branchActor(
      db,
      f.seed,
      f.branchA,
      ["pos.ticket.sell"],
      "uncredentialed",
    );
    const refused = await applyTicket(f, {
      cashierPrincipalId: noCredential,
      lines: [{ unitPrice: "10.0000", quantity: "1.000000" }],
    });
    expect(refused.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(refused.error?.detail).toContain("no pos_cashier row");
  });
});
