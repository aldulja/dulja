import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  seedTenant,
  seedBranch,
  seedEmployee,
  seedCashier,
  grantCodes,
  type Seed,
} from "../fixtures";
import { lintSchema, listApplied, AUDIT_EXEMPT } from "../../src";
import { verifyPin } from "../../src/staff/pin";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "alpha");
  b = await seedTenant(db, "beta");
  // Every read and UPDATE below runs as `a.human` against `app.pos_cashier` and `app.catalogue_tombstone`,
  // both of which carry a `branch_isolation` policy from Task 5's migration 0068 — Form A and Form B. One
  // company-wide grant (no `branchIds`) is what keeps this suite's actor able to see its own rows after
  // that file lands; without it every `toHaveLength(1)` here becomes `0` and the failure looks like a
  // trigger fault rather than a policy. Amendment A15 states the rule; this is its consumer side.
  await grantCodes(db, a);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("app.pos_cashier — the till credential (§4.6.3; spec:1324, 2097)", () => {
  it("migration 65 is applied; the PK is principal_id and there is no id column (§3.5.3)", async () => {
    expect(await listApplied(db.migrator)).toContain(65);
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'pos_cashier' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "branch_id",
      "company_id",
      "created_at",
      "employee_id",
      "pin_hash",
      "pin_updated_at",
      "principal_id",
      "revision",
      "revoked_at",
      "snapshot",
      "snapshot_at",
      "tenant_id",
    ]);
    const [pk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.pos_cashier'::regclass and contype = 'p'`;
    expect(pk!.def).toBe("PRIMARY KEY (principal_id)");
  });

  it("is audit-exempt — an audited copy of a PIN hash is a second copy of a credential", async () => {
    expect(AUDIT_EXEMPT.has("pos_cashier")).toBe(true);
    const triggers = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and c.relname = 'pos_cashier'`;
    // Snapshot revision stamps after catalogue assignment; this exact list pins their names.
    expect(triggers.map((t) => t.tgname).toSorted()).toEqual([
      "catalogue_revision",
      "pos_cashier_is_employee", // 8C T11 (0094): "cashiers are employees", a deferred constraint trigger — no audit
      "pos_cashier_tombstone",
      "snapshot_revision_stamp",
    ]);
  });

  it("seedCashier stores a verifiable Argon2id hash and never the PIN", async () => {
    const e = await seedEmployee(db, a, { employeeNumber: "E-C1" });
    const principalId = await seedCashier(db, a, { employeeId: e, branchId: a.hq, pin: "4321" });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { pin_hash: string; revision: string; revoked_at: string | null }[]
        >`select pin_hash, revision::text as revision, revoked_at from app.pos_cashier where principal_id = ${principalId}`,
    );
    expect(row!.pin_hash).not.toContain("4321");
    expect(await verifyPin("4321", row!.pin_hash)).toBe(true);
    expect(await verifyPin("1111", row!.pin_hash)).toBe(false);
    expect(BigInt(row!.revision)).toBeGreaterThan(0n); // the catalogue_revision trigger fired (§4.10.2)
    expect(row!.revoked_at).toBeNull();
  });

  it("one cashier row per principal, and the employee must be in the same tenant", async () => {
    const e = await seedEmployee(db, a, { employeeNumber: "E-C2" });
    const p = await seedCashier(db, a, { employeeId: e, branchId: a.hq });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.pos_cashier (principal_id, tenant_id, company_id, employee_id, branch_id, pin_hash)
      values (${p}, ${a.tenant}, ${a.company}, ${e}, ${a.hq}, 'x')`,
      ),
    ).rejects.toThrow(/duplicate key/);

    const foreign = await seedEmployee(db, b, { employeeNumber: "E-XT" });
    const p2 = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${p2}, 'human', ${"sub-" + p2}, 'X')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${p2})`;
    });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.pos_cashier (principal_id, tenant_id, company_id, employee_id, branch_id, pin_hash)
      values (${p2}, ${a.tenant}, ${a.company}, ${foreign}, ${a.hq}, 'x')`,
      ),
    ).rejects.toThrow(/violates foreign key/);
  });

  it("setting revoked_at writes a catalogue tombstone so a disconnected till learns of it (test 34)", async () => {
    const e = await seedEmployee(db, a, { employeeNumber: "E-REV" });
    const p = await seedCashier(db, a, { employeeId: e, branchId: a.hq });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`,
    );
    const tombs = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { stream: string; row_id: string; branch_id: string | null }[]
        >`select stream, row_id, branch_id from app.catalogue_tombstone where row_id = ${p}`,
    );
    expect(tombs).toHaveLength(1);
    expect(tombs[0]).toMatchObject({ stream: "cashier", row_id: p, branch_id: a.hq });
  });

  it("re-revoking writes no second tombstone — the trigger fires on the transition only", async () => {
    const e = await seedEmployee(db, a, { employeeNumber: "E-REV2" });
    const p = await seedCashier(db, a, { employeeId: e, branchId: a.hq });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`;
      await tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`;
    });
    const [count] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.catalogue_tombstone where row_id = ${p}`,
    );
    expect(count!.n).toBe(1);
  });

  it("reinstating and revoking again UPDATES the tombstone rather than aborting on its unique key", async () => {
    // app.catalogue_tombstone carries `unique (stream, row_id)` (6A's 0059) and 6A's own trigger upserts
    // for that reason. Reinstatement is the only way back for a cashier — deletion is not admitted
    // (spec:2049) — so revoke -> un-revoke -> revoke is a real sequence, and a bare insert aborts it.
    const e = await seedEmployee(db, a, { employeeNumber: "E-REV3" });
    const p = await seedCashier(db, a, { employeeId: e, branchId: a.hq });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`,
    );
    const [first] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ revision: string }[]>`
      select revision::text as revision from app.catalogue_tombstone where row_id = ${p}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.pos_cashier set revoked_at = null where principal_id = ${p}`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`,
    );
    const tombs = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ revision: string }[]>`
      select revision::text as revision from app.catalogue_tombstone where row_id = ${p}`,
    );
    expect(tombs).toHaveLength(1); // still ONE row
    expect(BigInt(tombs[0]!.revision)).toBeGreaterThan(BigInt(first!.revision)); // carrying the NEW revision
  });

  it("app.pos_cashier_sync is the down-sync stream 6A's readCatalogue calls, and it hides revoked rows", async () => {
    const e = await seedEmployee(db, a, { employeeNumber: "E-SYNC" });
    const p = await seedCashier(db, a, { employeeId: e, branchId: a.hq });
    const live = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          {
            id: string;
            revision: string;
            row: { pin_hash: string; employee_number: string; tenant_id?: string };
          }[]
        >`select id::text as id, revision::text as revision, row from app.pos_cashier_sync(${a.company}, ${a.hq}, 0)`,
    );
    const mine = live.find((r) => r.id === p);
    expect(mine).toBeDefined();
    expect(mine!.row.pin_hash).toMatch(/^\$argon2id\$/); // the till verifies the PIN against this mirror
    expect(mine!.row.employee_number).toBe("E-SYNC");
    expect(mine!.row.tenant_id).toBeUndefined(); // stripped, exactly as 6A strips it on every stream
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`,
    );
    const after = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ id: string }[]>`
      select id::text as id from app.pos_cashier_sync(${a.company}, ${a.hq}, 0)`,
    );
    expect(after.map((r) => r.id)).not.toContain(p); // it leaves as a TOMBSTONE, never as a live upsert
    // and a cashier at another branch is not in this branch's stream at all
    const otherBranch = await seedBranch(db, a, { code: "B-CASHIER" });
    const other = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ id: string }[]>`
      select id::text as id from app.pos_cashier_sync(${a.company}, ${otherBranch}, 0)`,
    );
    expect(other).toHaveLength(0);
  });

  it("tenant B cannot see tenant A's cashiers", async () => {
    const e = await seedEmployee(db, a, { employeeNumber: "E-ISO2" });
    const p = await seedCashier(db, a, { employeeId: e, branchId: a.hq });
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx`select principal_id from app.pos_cashier where principal_id = ${p}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("the catalogue row keeps revisions above the safe JSON integer range exact", async () => {
    await db.admin`select setval('app.catalogue_revision_seq', 9007199254740993, true)`;
    const employee = await seedEmployee(db, a, { employeeNumber: "E-BIGREV" });
    const principal = await seedCashier(db, a, { employeeId: employee, branchId: a.hq });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          {
            revision: string;
            row: { revision: string; employee_number: string };
          }[]
        >`select revision::text as revision, "row" from app.pos_cashier_sync(${a.company},${a.hq},0) where id=${principal}`,
    );
    expect(BigInt(row!.revision)).toBeGreaterThan(9007199254740993n);
    expect(row!.row.revision).toBe(row!.revision);
    expect(row!.row.employee_number).toBe("E-BIGREV");
  });

  it("the schema linter reports zero violations after 0065", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
