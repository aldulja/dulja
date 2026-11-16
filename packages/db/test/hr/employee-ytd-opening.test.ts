import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  listEmployeeYtdOpening,
  OpeningError,
  upsertEmployeeYtdOpening,
  type EmployeeYtdOpeningInput,
} from "../../src/hr/opening";
import { startDb, withTenant, type Db } from "../harness";
import { grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";

// 8C T9 — the cut-over openings (spec:2084; contracts round 18 B14). 9B's importer is the only caller; there is no
// route. Figures are arbitrary synthetic values (hazard 1): no rate, threshold or ceiling is implied by any of them.

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let employeeId: string;
const ctx = () => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const asHuman = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, s.tenant, s.human, fn);

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Openings");
  // app.employee carries 6C's RESTRICTIVE branch_isolation (Form A′) and seedTenant grants s.human nothing — Global
  // Constraint 21(a): without a role the employee is invisible and every load is ERR_NOT_FOUND.
  await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
  employeeId = await seedEmployee(db, s, { employeeNumber: "E-OPEN-1" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const opening = (over: Partial<EmployeeYtdOpeningInput> = {}): EmployeeYtdOpeningInput => ({
  companyId: s.company,
  employeeId,
  year: 2026,
  gross: Money.of("500.0000", MYR),
  net: Money.of("450.0000", MYR),
  byComponent: { BASIC: "500.0000" },
  byScheme: { SCHEME_A: { employee: "25.0000", employer: "50.0000" } },
  source: "legacy:run-7",
  ...over,
});

describe("upsertEmployeeYtdOpening (spec:2084; round 18 B14)", () => {
  it("inserts on the natural key, stamps loaded_by from the session (LEGACY-044) and returns the row id", async () => {
    const id = await asHuman((tx) => upsertEmployeeYtdOpening(tx, ctx(), opening()));
    const [row] = await db.admin<
      { gross: string; net: string; source: string; loaded_by: string; by_component: unknown }[]
    >`
      select gross::text as gross, net::text as net, source, loaded_by, by_component
        from app.employee_ytd_opening where id = ${id}`;
    expect(row).toEqual({
      gross: "500.0000",
      net: "450.0000",
      source: "legacy:run-7",
      loaded_by: s.human,
      by_component: { BASIC: "500.0000" },
    });
  });

  it("a second load for the same (company, employee, year) UPDATES rather than duplicating", async () => {
    await asHuman((tx) =>
      upsertEmployeeYtdOpening(
        tx,
        ctx(),
        opening({ gross: Money.of("600.0000", MYR), source: "manual:corrected" }),
      ),
    );
    const rows = await db.admin<{ gross: string; source: string; loaded_by: string }[]>`
      select gross::text as gross, source, loaded_by from app.employee_ytd_opening
       where company_id = ${s.company} and employee_id = ${employeeId} and tax_year = 2026`;
    expect(rows).toEqual([{ gross: "600.0000", source: "manual:corrected", loaded_by: s.human }]);
  });

  it("refuses a figure that is not fixed-scale, naming the key", async () => {
    await expect(
      asHuman((tx) =>
        upsertEmployeeYtdOpening(tx, ctx(), opening({ byComponent: { BASIC: "500.00" } })),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: byComponent\.BASIC is "500\.00"/);
    await expect(
      asHuman((tx) =>
        upsertEmployeeYtdOpening(
          tx,
          ctx(),
          opening({ byScheme: { SCHEME_A: { employee: "25", employer: "50.0000" } } }),
        ),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: byScheme\.SCHEME_A\.employee/);
  });

  it("refuses a blank source, a foreign currency and a year out of range", async () => {
    await expect(
      asHuman((tx) => upsertEmployeeYtdOpening(tx, ctx(), opening({ source: "  " }))),
    ).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });
    await expect(
      asHuman((tx) =>
        upsertEmployeeYtdOpening(
          tx,
          ctx(),
          opening({ net: Money.of("450.0000", currency("USD")) }),
        ),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: net is in USD/);
    await expect(
      asHuman((tx) => upsertEmployeeYtdOpening(tx, ctx(), opening({ year: 1999 }))),
    ).rejects.toBeInstanceOf(OpeningError);
  });

  it("refuses an employee of another company or tenant — ERR_NOT_FOUND", async () => {
    const other = await seedTenantV2(db, "Openings other");
    await expect(
      asHuman((tx) => upsertEmployeeYtdOpening(tx, ctx(), opening({ companyId: other.company }))),
    ).rejects.toThrow(/ERR_NOT_FOUND: employee .* is not an employee of company /);
  });

  it("an actor who cannot see the employee (no role, so branch isolation hides it) is refused, never written", async () => {
    const stranger = await seedTenantV2(db, "Openings stranger");
    const hidden = await seedEmployee(db, stranger, { employeeNumber: "E-HIDDEN" });
    await expect(
      withTenant(db.rw, stranger.tenant, stranger.human, (tx) =>
        upsertEmployeeYtdOpening(
          tx,
          { tenantId: stranger.tenant, actorId: stranger.human, requestId: ctx().requestId },
          opening({ companyId: stranger.company, employeeId: hidden }),
        ),
      ),
    ).rejects.toMatchObject({ code: "ERR_NOT_FOUND" });
  });

  it("writes NO row into app.employee_ytd — the projection is posting-service-only (B14)", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.employee_ytd where company_id = ${s.company}`;
    expect(row!.n).toBe(0);
  });

  it("the opening is tenant-isolated: a second tenant reads none of it", async () => {
    const other = await seedTenantV2(db, "Openings isolation");
    const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      listEmployeeYtdOpening(tx, { companyId: s.company, year: 2026 }),
    );
    expect(rows).toEqual([]);
  });

  it("listEmployeeYtdOpening returns the employee number and the figures, ordered by number", async () => {
    const rows = await asHuman((tx) =>
      listEmployeeYtdOpening(tx, { companyId: s.company, year: 2026 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employeeId,
      employeeNumber: "E-OPEN-1",
      year: 2026,
      gross: "600.0000",
      net: "450.0000",
      byScheme: { SCHEME_A: { employee: "25.0000", employer: "50.0000" } },
      source: "manual:corrected",
      loadedBy: s.human,
    });
  });
});
