// Acceptance test 34 (spec:2452) — "Termination closes everything. Setting `terminated_on` — including by direct
// `app_rw` SQL — revokes `pos_cashier` and expires every `role_assignment` in the same transaction (trigger); the next
// catalogue down-sync tombstones the cashier; a till that has applied the cursor rejects the PIN; the employee is
// excluded from the next regular run." — every clause the SERVER owns, plus the re-run of test 20 (catalogue resume)
// that §6.1 row 20 assigns 8C (the termination tombstone). 8C Task 11; migrations 0093 (T10) and 0094 (T11).
//
// **Clause 3's till half is 6B's, and this file says so rather than pretending to run it.** "A till that has applied
// the cursor rejects the PIN" is behaviour of the Electron client's local cashier mirror (§4.10.6), asserted in 6B's
// suite (`apps/pos`). What 8C owns and proves here is the server side: the row leaves `app.pos_cashier_sync` and a
// tombstone arrives on the `cashier` stream at a revision above the till's cursor — which is exactly what a till applies.
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The PRODUCTION withTenant (§4.2.2): root `tests/` never uses the 4-argument test helper.
import {
  currentCatalogueRevision,
  loadPayrollInputs,
  readCatalogue,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedCashier,
  seedTenantV2,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "./support/payroll-money";

let db: Db;
let s: Seed;
let f: MoneyOutFixture;
/** Employee B's login principal — the credential's key, and the id the cashier tombstone carries. */
let terminatedPrincipalId: string;
/** The revision a till that had already synced would be holding when the termination happens. */
let revisionBeforeTermination: bigint;

const ctx = (actor: string): TenantContext => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const asHuman = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, ctx(s.human), fn);
const catalogue = (since: bigint) =>
  asHuman((tx) =>
    readCatalogue(tx, { companyId: s.company, branchId: s.hq, since, limit: 10_000 }),
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test 34");
  f = await moneyOutFixture(db, s); // January's run posted, so employee B has payroll lines and a run they were on

  // 8B's payrollFixture gives its employees no login (its own cases need none). Employee B gets one here — a
  // principal, a till credential at HQ carrying a pos code, and a company-wide role — without editing 8B's fixture
  // (hazard 9). The credential is keyed on the employee's own principal (spec:2097).
  terminatedPrincipalId = await uuidv7(db.admin);
  await withTenant(db.migrator, ctx(s.system), async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${terminatedPrincipalId}, 'human', ${`test:t34:${terminatedPrincipalId}`}, 'Test 34 staff')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${terminatedPrincipalId})`;
    await tx`update app.employee set principal_id = ${terminatedPrincipalId} where id = ${f.employeeBId}`;
  });
  await seedCashier(db, s, {
    employeeId: f.employeeBId,
    branchId: s.hq,
    principalId: terminatedPrincipalId,
    pin: "246810",
    permissions: ["pos.ticket.sell"],
  });
  await grantCodes(db, s, {
    codes: ["hr.employee.read"],
    principalId: terminatedPrincipalId,
    roleCode: "r-t34",
  });

  // Captured BEFORE clause 1 terminates anybody. Clause 2b resumes from it, which is the only way to assert §6.1 row
  // 20's property — a tombstone applied at a bumped revision, reached from a cursor — rather than merely that a full
  // pull contains one. And the credential is LIVE in that pull, so a till holding this cursor knows the PIN.
  revisionBeforeTermination = await asHuman((tx) => currentCatalogueRevision(tx, s.company));
  const before = await catalogue(0n);
  expect(
    before.changes.filter((c) => c.stream === "cashier" && c.op === "upsert").map((c) => c.id),
  ).toContain(terminatedPrincipalId);
}, 300_000);
afterAll(async () => {
  await db.stop();
});

describe("acceptance test 34 — termination closes everything (spec:2452)", () => {
  it("clause 1: by DIRECT app_rw SQL, the cashier is revoked and every assignment expires in ONE transaction", async () => {
    // No route, no service, no handler: the raw statement the Phase 9 importer would issue.
    const done = await asHuman(
      (tx) =>
        tx<{ id: string }[]>`
          update app.employee set terminated_on = '2026-01-20' where id = ${f.employeeBId} returning id`,
    );
    expect(done).toHaveLength(1); // the row was visible, so the trigger fired (Global Constraint 21(b))

    const [cashier] = await db.admin<{ revoked_at: string | null }[]>`
      select revoked_at::text as revoked_at from app.pos_cashier where employee_id = ${f.employeeBId}`;
    expect(cashier!.revoked_at).not.toBeNull();

    const assignments = await db.admin<{ live: boolean }[]>`
      select (ra.expires_at is null or ra.expires_at > now()) as live
        from app.role_assignment ra
        join app.employee e on e.principal_id = ra.principal_id
       where e.id = ${f.employeeBId}`;
    expect(assignments.length).toBeGreaterThan(0); // expired, never deleted (spec:2049)
    expect(assignments.filter((a) => a.live)).toEqual([]);

    // "in the same transaction": the employee's termination and the credential's revocation share one xmin.
    const [same] = await db.admin<{ same: boolean }[]>`
      select (select xmin::text from app.employee where id = ${f.employeeBId})
           = (select xmin::text from app.pos_cashier where principal_id = ${terminatedPrincipalId}) as same`;
    expect(same!.same).toBe(true);
  });

  it("clause 2: the next catalogue down-sync carries the cashier tombstone", async () => {
    const changes = (await catalogue(0n)).changes.filter((c) => c.stream === "cashier");
    expect(changes.filter((c) => c.op === "delete").map((c) => c.id)).toContain(
      terminatedPrincipalId,
    );
    expect(changes.filter((c) => c.op === "upsert").map((c) => c.id)).not.toContain(
      terminatedPrincipalId,
    );
  });

  it("clause 2b (test 20's re-run): a till RESUMING from its own cursor gets the tombstone, not just a full pull", async () => {
    // §6.1 row 20 ("Catalogue resume", 6A's test) lists 8C (termination tombstone) in its re-run column. The property
    // is that a till which had ALREADY synced learns of the termination by resuming from the revision it holds; a
    // tombstone written at or below that cursor would be invisible for ever to exactly the tills that need it.
    const resumed = await catalogue(revisionBeforeTermination);
    const tomb = resumed.changes.find(
      (c) => c.stream === "cashier" && c.op === "delete" && c.id === terminatedPrincipalId,
    );
    expect(tomb).toBeDefined();
    expect(tomb!.revision > revisionBeforeTermination).toBe(true);
    expect(tomb!.row).toBeNull();

    // ...and the resume terminates: a pull from the new high-water mark returns the cashier no more.
    const after = await asHuman((tx) => currentCatalogueRevision(tx, s.company));
    expect(after > revisionBeforeTermination).toBe(true);
    expect(resumed.nextCursor).toBe(after);
    const settled = await catalogue(after);
    expect(
      settled.changes.filter((c) => c.stream === "cashier" && c.id === terminatedPrincipalId),
    ).toEqual([]);
  });

  it("clause 3 (SERVER side): the revoked row is gone from app.pos_cashier_sync, so no till can re-learn the PIN", async () => {
    const rows = await asHuman(
      (tx) => tx<{ id: string }[]>`select id from app.pos_cashier_sync(${s.company}, ${s.hq}, 0)`,
    );
    expect(rows.map((r) => r.id)).not.toContain(terminatedPrincipalId);
  });

  it("clause 3b: the credential cannot be brought back while the employee is terminated (0094)", async () => {
    await expect(
      asHuman(
        (tx) =>
          tx`update app.pos_cashier set revoked_at = null where principal_id = ${terminatedPrincipalId}`,
      ),
    ).rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
  });

  it("clause 4: the employee is excluded from the NEXT REGULAR run", async () => {
    // 8B's loadPayrollInputs admits an employee when `terminated_on is null or terminated_on >= period_start`, so a
    // January leaver is ON January's run — a mid-month leaver must be paid — and OFF February's. Both halves are
    // asserted, because only the pair proves the rule rather than the bound.
    const january = await asHuman((tx) =>
      loadPayrollInputs(tx, {
        companyId: s.company,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        payDate: "2026-02-05",
        kind: "regular",
      }),
    );
    expect(january.employees.map((e) => e.employeeId)).toContain(f.employeeBId);

    const february = await asHuman((tx) =>
      loadPayrollInputs(tx, {
        companyId: s.company,
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        payDate: "2026-03-05",
        kind: "regular",
      }),
    );
    const februaryIds = february.employees.map((e) => e.employeeId);
    expect(februaryIds).not.toContain(f.employeeBId);
    expect(februaryIds).toContain(f.employeeAId); // the run is not empty: only the leaver is gone
  });

  it("clause 4b: a `final` run still reaches them — the last pay is a final PAYROLL (spec:2090)", async () => {
    const final = await asHuman((tx) =>
      loadPayrollInputs(tx, {
        companyId: s.company,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        payDate: "2026-02-05",
        kind: "final",
        employeeIds: [f.employeeBId],
      }),
    );
    expect(final.employees.map((e) => e.employeeId)).toEqual([f.employeeBId]);
  });
});
