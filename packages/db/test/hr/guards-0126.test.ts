import type { Sql } from "postgres";
/**
 * Migration 0126 — DBS-09 and DBS-10 (full review 2026-11-15).
 *  - DBS-09: `employee.company_id` is immutable after insert. Both RESTRICTIVE gates (`sensitive_gate`,
 *    `compensation_gate`) derive the company from the employee row, so moving an employee into a company where the
 *    writer holds the HR codes opened that employee's sealed columns and compensation (ADR 0074 amendment).
 *  - DBS-10: the UPDATE that verifies a rate table may change only `verified_at` and `verified_by`, and only a
 *    holder of `hr.statutory_table.verify` in the scheme's company may make it — otherwise the verifier writes and
 *    signs the content in one statement and LEGACY-020's four eyes are two names over one hand (ADR 0073 amendment).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  grantCodes,
  seedEmployee,
  seedRateTable,
  seedStatutoryScheme,
  seedTenant,
  type Seed,
} from "../fixtures";

let db: Db;
let a: Seed;
let verifier: string;
let bystander: string;
let schemeId: string;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "0126-hr-guards");
  verifier = await uuidv7(db.admin);
  bystander = await uuidv7(db.admin);
  await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
    for (const [id, n] of [
      [verifier, "Verifier"],
      [bystander, "Bystander"],
    ] as const) {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${id}, ${`sub-${id}`}, 'human', ${n})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    }
  });
  await grantCodes(db, a, { codes: ["hr.employee.manage", "hr.statutory_table.manage"] });
  await grantCodes(db, a, { codes: ["hr.statutory_table.verify"], principalId: verifier });
  await grantCodes(db, a, { codes: ["hr.payroll.read"], principalId: bystander });
  schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH0126" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("0126 — employee.company_id is immutable (DBS-09)", () => {
  // As the system principal, whom every gate admits in every company: the column itself is refused, not the
  // writer's reach (the finding's writer held roles in both companies).
  it("an employee never moves to another company of the tenant", async () => {
    const employeeId = await seedEmployee(db, a, { employeeNumber: "E-MOVE" });
    const other = await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${a.tenant}, 'COMP-0126', 'Other company', 'MYR') returning id`;
      return c!.id;
    });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`update app.employee set company_id = ${other} where id = ${employeeId}`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*company/);
    const [row] = await db.admin<{ company_id: string }[]>`
      select company_id from app.employee where id = ${employeeId}`;
    expect(row!.company_id).toBe(a.company);
  });
});

describe("0126 — the verifying UPDATE changes only the verification (DBS-10, LEGACY-020)", () => {
  it("a verifier cannot rewrite the definition or source in the statement that signs it", async () => {
    const id = await seedRateTable(db, a, { schemeId, version: 1 });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        verifier,
        (tx) => tx`
          update app.statutory_rate_table
             set definition = '{"rate":"0.01"}'::jsonb, source = 'edited by verifier',
                 verified_at = now(), verified_by = app.current_actor()
           where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_VERIFY/);
    const edits = [
      (tx: Sql) => tx`update app.statutory_rate_table
                         set effective_from = '2025-01-01', verified_at = now(), verified_by = app.current_actor()
                       where id = ${id}`,
      (tx: Sql) => tx`update app.statutory_rate_table
                         set effective_to = '2026-12-31', verified_at = now(), verified_by = app.current_actor()
                       where id = ${id}`,
      (tx: Sql) => tx`update app.statutory_rate_table
                         set version = 7, verified_at = now(), verified_by = app.current_actor()
                       where id = ${id}`,
    ];
    for (const edit of edits) {
      await expect(withTenant(db.rw, a.tenant, verifier, edit)).rejects.toThrow(
        /ERR_HR_SELF_VERIFY/,
      );
    }
    const [row] = await db.admin<{ source: string; verified_at: string | null }[]>`
      select source, verified_at::text from app.statutory_rate_table where id = ${id}`;
    expect(row).toEqual({ source: "Dulja test fixture / synthetic", verified_at: null });
  });

  it("only a holder of hr.statutory_table.verify in the scheme's company signs a table", async () => {
    const id = await seedRateTable(db, a, { schemeId, version: 2 });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        bystander,
        (tx) => tx`
          update app.statutory_rate_table set verified_at = now(), verified_by = app.current_actor() where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN.*hr\.statutory_table\.verify/);
  });

  it("the verification itself, by a different holder of the code, still signs", async () => {
    const id = await seedRateTable(db, a, { schemeId, version: 3 });
    await withTenant(
      db.rw,
      a.tenant,
      verifier,
      (tx) => tx`
        update app.statutory_rate_table set verified_at = now(), verified_by = app.current_actor() where id = ${id}`,
    );
    const [row] = await db.admin<{ verified_by: string }[]>`
      select verified_by from app.statutory_rate_table where id = ${id}`;
    expect(row!.verified_by).toBe(verifier);
  });
});
