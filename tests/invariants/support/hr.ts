import { PERMISSION } from "@dulja/contracts/permissions";
import {
  grantCodes,
  seedEmployee,
  seedStatutoryScheme,
  seedTenantV2,
  uuidv7,
  withTenant,
  type Db,
  type Seed,
} from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app"; // TYPE only, exactly as pos.ts does

/** The ONE HR corpus (contracts round 16, A6). 8B, 8C and 8D re-use it; nothing else builds a second one. */
export interface HrFixture {
  api: StartedApi;
  db: Db;
  seed: Seed;
  companyId: string;
  /** holds every hr.* code 8A seeds bar the verify half, plus 6C's two when 6C has merged, and admin.company.manage */
  officer: string;
  /** holds hr.statutory_table.verify AND .manage (the accountant shape; A6), plus hr.employee.read under 6C */
  checker: string;
  /** a member holding hr.employee.read only under 6C, nothing under 8A-FIRST (the clerk shape) */
  outsider: string;
  /** `"hr.employee.read" in PERMISSION` — 6C's routes and codes are present */
  sixC: boolean;
  /** three: E-1001, E-1002, E-1003 — and E-1003 IS `officer`, the R4 subject every later case uses */
  employees: { id: string; number: string; principalId: string | null }[];
  /** one app.statutory_scheme of the company, code "SYNTH" (8A Task 8) */
  schemeId: string;
}

/** **The 6C branch, decided by the catalogue rather than by a person.** `PERMISSION` is built from `PERMISSIONS`,
 *  so a missing key IS the absence of 6C's catalogue row, with no database round trip. `grantCodes` inserts
 *  `role_permission` rows that reference `app.permission`, so granting an unseeded code would be a foreign-key
 *  error in set-up. On this branch 6C has merged (contracts round 16: `6C-FIRST`). */
const SIX_C = "hr.employee.read" in PERMISSION;

/** The 8A codes the officer always holds. `admin.company.manage` is 0B's and is here for 8A Task 11. */
const OFFICER_CODES_8A = [
  "hr.employee.read_sensitive",
  "hr.compensation.read",
  "hr.compensation.manage",
  "hr.pay_component.manage",
  "hr.statutory_table.manage",
  "admin.company.manage",
] as const;
/** 6C's two, added only when 6C has merged. */
const OFFICER_CODES_6C = ["hr.employee.read", "hr.employee.manage"] as const;

/**
 * Builds the HR corpus on a running API. **The caller supplies the API; this file never calls `startApi()`** —
 * the settled shape of a §4.17.1 fixture that needs one (6A's `posFixture(api, name)`, 6C's
 * `staffFixture(api, name)`), because §3.1 lets the `tests` workspace reach `apps/api` only through
 * `createApp()` and `./routes`. `name` is the tenant name handed to `seedTenantV2`, so two fixtures built on one
 * API do not collide.
 */
export async function hrFixture(api: StartedApi, name = "hr"): Promise<HrFixture> {
  const db = api.db;
  const seed = await seedTenantV2(db, name);
  const mint = async (displayName: string): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, seed.tenant, seed.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${id}, ${`human:${name}:${id}`}, 'human', ${displayName})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${seed.tenant}, ${id})`;
    });
    return id;
  };
  const officer = await mint("HR Officer");
  const checker = await mint("Accountant");
  const outsider = await mint("Clerk");
  await grantCodes(db, seed, {
    codes: [...OFFICER_CODES_8A, ...(SIX_C ? OFFICER_CODES_6C : [])],
    principalId: officer,
    roleCode: "hr-officer",
  });
  // The checker holds MANAGE as well as VERIFY on purpose: 8A Task 10 proves that a principal holding both codes
  // still cannot verify what it loaded. R6 forbids one SEEDED role holding both (§4.2.5); a test role is not a
  // seeded role, and the data-layer trigger is what makes the rule hold anyway.
  await grantCodes(db, seed, {
    codes: [
      "hr.statutory_table.verify",
      "hr.statutory_table.manage",
      ...(SIX_C ? ["hr.employee.read"] : []),
    ],
    principalId: checker,
    roleCode: "hr-checker",
  });
  // The outsider is a MEMBER holding no HR code beyond 6C's directory read, so the directory cases can prove that
  // reading the roster still yields no sensitive field. Under 8A-FIRST the grant is skipped, not made empty.
  if (SIX_C)
    await grantCodes(db, seed, {
      codes: ["hr.employee.read"],
      principalId: outsider,
      roleCode: "hr-outsider",
    });
  await api.loadPrincipals();

  const employees: HrFixture["employees"] = [];
  for (const [number, principalId] of [
    ["E-1001", null],
    ["E-1002", null],
    ["E-1003", officer],
  ] as const) {
    const id = await seedEmployee(db, seed, {
      employeeNumber: number,
      ...(principalId === null ? {} : { principalId }),
    });
    employees.push({ id, number, principalId });
  }
  // E-1003 IS the officer: every R4 case in 8A and in 8B/8C uses it, so no test builds a self-referencing employee
  // of its own and gets the direction of the check wrong.
  // Schemes are seed-pack data (ADR 0073) and NO route creates one, so a suite that expected the list endpoint to
  // hand it a scheme would find an empty list and fail in set-up rather than on its own case.
  const schemeId = await seedStatutoryScheme(db, seed, { code: "SYNTH" });
  return {
    api,
    db,
    seed,
    companyId: seed.company,
    officer,
    checker,
    outsider,
    sixC: SIX_C,
    employees,
    schemeId,
  };
}

export const hrActor = (f: HrFixture, who: "officer" | "checker" | "outsider"): string => f[who];

// This file exports THREE names and re-exports nothing. `problemOf` is 0B's, and every consumer imports it from
// `tests/support/api` directly; a re-export here would be a second path to one helper (hazard 9).
