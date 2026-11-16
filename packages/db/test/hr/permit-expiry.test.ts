import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHrKeyRing, DEV_HR_KEY } from "../../src/hr/keys";
import { writeSensitive } from "../../src/hr/employee-sensitive";
import { permitExpiry } from "../../src/hr/permit-expiry";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

// 8D T3 — the permit half of spec:2091 (8D amendment A3). The values are synthetic and the dates are chosen relative
// to "today" in SQL, so the window cases hold whatever day the suite runs on.

const RING = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });

describe("permitExpiry — the permit half of spec:2091 (8D amendment A3)", () => {
  let db: Db;
  let s: Seed;
  let outsider: string; // holds hr.employee.read only
  let soon: string; // today + 10 in company time
  let late: string; // today + 400

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "permit-expiry");
    await grantCodes(db, s, { codes: ["hr.employee.read", "hr.employee.read_sensitive"] });
    outsider = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${outsider}, ${`stub:outsider-${outsider}`}, 'human', 'Outsider')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${outsider})`;
    });
    await grantCodes(db, s, {
      codes: ["hr.employee.read"],
      principalId: outsider,
      roleCode: "clerk-8d",
    });

    const [dates] = await db.admin<{ soon: string; late: string }[]>`
      select to_char((now() at time zone 'Asia/Kuala_Lumpur')::date + 10, 'YYYY-MM-DD') as soon,
             to_char((now() at time zone 'Asia/Kuala_Lumpur')::date + 400, 'YYYY-MM-DD') as late`;
    soon = dates!.soon;
    late = dates!.late;

    const lapsed = await seedEmployee(db, s, { employeeNumber: "E-2001" });
    const noPermit = await seedEmployee(db, s, { employeeNumber: "E-2002" });
    const soonEmp = await seedEmployee(db, s, { employeeNumber: "E-2003" });
    const lateEmp = await seedEmployee(db, s, { employeeNumber: "E-2004" });
    const leaver = await seedEmployee(db, s, { employeeNumber: "E-2005" });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await writeSensitive(tx, RING, lapsed, { work_permit_expiry: "2026-02-15" });
      await writeSensitive(tx, RING, noPermit, { national_id: "SYNTH-0001" });
      await writeSensitive(tx, RING, soonEmp, { work_permit_expiry: soon });
      await writeSensitive(tx, RING, lateEmp, { work_permit_expiry: late });
      await writeSensitive(tx, RING, leaver, { work_permit_expiry: soon });
    });
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`update app.employee set terminated_on = '2026-01-31' where id = ${leaver}`;
    });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  const list = (actor: string, withinDays: number, includeTerminated?: boolean) =>
    withTenant(db.rw, s.tenant, actor, (tx) =>
      permitExpiry(tx, RING, {
        companyId: s.company,
        withinDays,
        ...(includeTerminated === undefined ? {} : { includeTerminated }),
      }),
    );

  it("lists only employees whose DECRYPTED permit falls inside the window, soonest first, with the day count", async () => {
    const rows = await list(s.human, 30);
    expect(rows.map((r) => r.employeeNumber)).toEqual(["E-2001", "E-2003"]);
    expect(rows[0]!.workPermitExpiry).toBe("2026-02-15");
    expect(rows[0]!.daysRemaining).toBeLessThan(0); // lapsed: a lapsed permit is always listed
    expect(rows[1]!.workPermitExpiry).toBe(soon);
    expect(rows[1]!.daysRemaining).toBe(10);
    for (const r of rows) expect(Number.isInteger(r.daysRemaining)).toBe(true);
  });

  it("a wider window admits the later permit; an employee with no permit is never listed", async () => {
    const rows = await list(s.human, 1000);
    expect(rows.map((r) => r.employeeNumber)).toEqual(["E-2001", "E-2003", "E-2004"]);
    expect(rows.at(-1)!.daysRemaining).toBe(400);
  });

  it("a terminated employee is listed only when asked for", async () => {
    expect((await list(s.human, 30, true)).map((r) => r.employeeNumber)).toEqual([
      "E-2001",
      "E-2003",
      "E-2005",
    ]);
  });

  it("returns an EMPTY list — not an error, not a partial row — without hr.employee.read_sensitive", async () => {
    expect(await list(outsider, 100_000)).toEqual([]);
  });

  it("a second tenant sees nothing (spec:106)", async () => {
    const other = await seedTenantV2(db, "permit-expiry-b");
    const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      permitExpiry(tx, RING, { companyId: s.company, withinDays: 100_000 }),
    );
    expect(rows).toEqual([]);
  });
});
