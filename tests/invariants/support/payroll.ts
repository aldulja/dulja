import { readFileSync } from "node:fs";
import { join } from "node:path";
// The PRODUCTION `withTenant(sql, ctx, fn)` from `@dulja/db` (§4.2.2): the 4-argument test helper stays in
// `packages/db/test/harness.ts`, and the tests tier passes a `TenantContext`.
import {
  calculatePayrollRun,
  ensureEmployeeDimensionValue,
  linkPayrollAccounts,
  postDocument,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedEmployee,
  seedPayComponent,
  seedRateTable,
  seedStatutoryScheme,
  SYNTH_RATE_TABLE_V1,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { REPO_ROOT } from "../../support/source";
import { ensureOpenPeriods } from "./post-inventory";

// 8B T10 — contracts round 17, amendment A7 (§4.17.1). The ONE payroll corpus the 8B suites (and 8C/8D) build on.

/** The pack root every payroll test reads its seed files from. */
export const PAYROLL_PACK_ROOT = join(REPO_ROOT, "packages/db/seed/my");

/**
 * The synthetic table of §4.12.4. 8A's amendment A5 made `SYNTH_RATE_TABLE_V1` (packages/db/test/fixtures.ts) the
 * one home of a fixture's rate figures; 8B T12 ships the same table as `packages/db/seed/test/statutory/SYNTH/v1.json`
 * and asserts the two agree. Invented numbers, a rate of no authority anywhere (spec:2080, hazard 1).
 */
export const SYNTH_TABLE: Record<string, unknown> = SYNTH_RATE_TABLE_V1;

export interface PayrollFixture {
  documentTypeId: string;
  employeeAId: string;
  employeeBId: string;
  branchB: string;
  componentBasicId: string;
  componentAdvanceId: string;
  schemeId: string;
  rateTableId: string;
  salariesPayableAccountId: string;
  /** A SECOND human principal holding hr.payroll.approve, .post and .read — R1 needs a different actor. */
  approver: string;
  /**
   * A THIRD principal holding `hr.statutory_table.verify`, for a test that verifies a table of its own. It did NOT
   * verify `rateTableId` — 8A's `seedRateTable` verifies as `s.system`, already a different principal from the
   * `s.human` that loaded it.
   */
  verifier: string;
}

const ctxOf = (s: Seed, actorId: string): TenantContext => ({
  tenantId: s.tenant,
  actorId,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/**
 * Seeds everything a payroll test needs, once per `Seed`: twelve open 2026 periods, the eleven §4.15 accounts, the
 * PAYROLL type and policy, one statutory scheme (`EPF`, so `linkPayrollAccounts` wires 2411/5311) carrying the
 * synthetic table verified by a different principal, two pay components, two employees in two branches (E-0001 at
 * `s.hq`, E-0002 at `branchB`) each on BASIC 2000.0000 from 2026-01-01, and the two extra principals.
 *
 * `s.human` is granted `hr.compensation.read` (a company-wide role): 8A's RESTRICTIVE `compensation_gate` refuses a
 * compensation insert or read without it, and 6C's `branch_isolation` hides employees from an actor with no role.
 * Callers grant the `hr.payroll.*` codes they need on top.
 *
 * NOT idempotent, on purpose: call it once per `Seed` (a regression file that shares a seed mints its own tenant).
 */
export async function payrollFixture(db: Db, s: Seed): Promise<PayrollFixture> {
  // Plan 0A's seedTenant opens January only (February closed, March locked) and nothing after; every 8B suite that
  // names another month needs this first. Idempotent: it reopens 0A's three and inserts months 4–12.
  await ensureOpenPeriods(db, s, 2026);
  await grantCodes(db, s, { codes: ["hr.compensation.read"] });

  const chart = JSON.parse(
    readFileSync(join(PAYROLL_PACK_ROOT, "chart-of-accounts/8b-payroll.json"), "utf8"),
  ) as {
    code: string;
    nameEn: string;
    type: "asset" | "liability" | "equity" | "income" | "expense";
    isGroup?: boolean;
  }[];
  for (const row of chart) {
    if (row.isGroup === true) continue; // seedAccount creates leaves; the presentation parent is the pack's
    await seedAccount(db, s, { code: row.code, nameEn: row.nameEn, type: row.type });
  }
  const [payable] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = '2400'`;

  const envelope = JSON.parse(
    readFileSync(join(PAYROLL_PACK_ROOT, "document-types/PAYROLL.json"), "utf8"),
  ) as { policy: unknown };
  const documentTypeId = await seedDocumentType(db, s, {
    code: "PAYROLL",
    module: "hr",
    policy: envelope.policy,
  });

  const componentBasicId = await seedPayComponent(db, s, { code: "BASIC", kind: "earning" });
  const componentAdvanceId = await seedPayComponent(db, s, {
    code: "ADV_RECOVERY",
    kind: "deduction",
  });
  const schemeId = await seedStatutoryScheme(db, s, { code: "EPF" });
  const rateTableId = await seedRateTable(db, s, {
    schemeId,
    version: 1,
    definition: SYNTH_TABLE,
    verified: true,
  });
  const [loaded] = await db.admin<{ loaded_by: string; verified_by: string }[]>`
    select loaded_by::text as loaded_by, verified_by::text as verified_by
      from app.statutory_rate_table where id = ${rateTableId}`;
  // Asserted, not assumed: spec:2080's whole content is that these two differ.
  if (loaded!.loaded_by === loaded!.verified_by) {
    throw new Error("payrollFixture: seedRateTable verified a table with its own loader");
  }
  const verifier = await secondApprover(db, s, ["hr.statutory_table.verify"]);

  const branchB = await seedBranch(db, s, { code: "BR2", nameEn: "Branch Two" });
  const employeeAId = await seedEmployee(db, s, { employeeNumber: "E-0001" });
  const employeeBId = await seedEmployee(db, s, {
    employeeNumber: "E-0002",
    homeBranchId: branchB,
  });

  const approver = await secondApprover(db, s, [
    "hr.payroll.approve",
    "hr.payroll.post",
    "hr.payroll.read",
  ]);

  await withTenant(db.rw, ctxOf(s, s.human), async (tx) => {
    // T4's wiring step, inline: the fixture seeds the chart itself rather than running the seed CLI. `EPF` is a
    // §4.15 scheme code, so the linker wires 2411/5311 and names nothing missing for it.
    await linkPayrollAccounts(tx, s.company);
    // The advance-recovery component relieves 1400. The linker set 5300 on every component with no account; this
    // overwrites it for the one component the operator decides recovers advances (T4 Step 2).
    const [adv] = await tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '1400'`;
    await tx`update app.pay_component set expense_account_id = ${adv!.id} where id = ${componentAdvanceId}`;
    await tx`
      insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
      values (${s.tenant}, ${componentBasicId}, ${schemeId})`;
    // One compensation line per employee, effective for the whole of 2026. No `company_id`: 8A's
    // `app.compensation_line` takes its company through `employee_id`.
    for (const employeeId of [employeeAId, employeeBId]) {
      await tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
        values (${s.tenant}, ${employeeId}, ${componentBasicId}, '2026-01-01', '2000.0000')`;
      await ensureEmployeeDimensionValue(tx, s.company, employeeId);
    }
    await tx`
      insert into app.company_hr_setting (tenant_id, company_id, proration_rule, pay_day)
      values (${s.tenant}, ${s.company}, 'calendar_days', 5)
      on conflict (company_id) do nothing`;
  });

  return {
    documentTypeId,
    employeeAId,
    employeeBId,
    branchB,
    componentBasicId,
    componentAdvanceId,
    schemeId,
    rateTableId,
    salariesPayableAccountId: payable!.id,
    approver,
    verifier,
  };
}

/** A further human principal, a member of the tenant, holding `codes` company-wide — R1's "the actor differs from
 *  every submitted actor". Minted the way 8A's `hrFixture` mints its principals. Returns the principal id. */
export async function secondApprover(db: Db, s: Seed, codes: readonly string[]): Promise<string> {
  const principalId = await uuidv7(db.admin);
  await withTenant(db.migrator, ctxOf(s, s.system), async (tx) => {
    await tx`insert into app.principal (id, auth_subject, kind, display_name)
             values (${principalId}, ${`human:payroll:${principalId}`}, 'human',
                     ${`Payroll principal ${principalId.slice(-8)}`})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
  });
  await grantCodes(db, s, {
    codes: [...codes],
    principalId,
    roleCode: `payroll-${principalId.slice(-12)}`,
  });
  return principalId;
}

/** Drafts, submits, approves and posts a run through the REAL state machine (`s.human` prepares and submits,
 *  `f.approver` approves and posts). `s.human` must hold `hr.payroll.prepare`. Returns the document id. */
export async function postPayrollRun(
  db: Db,
  s: Seed,
  f: PayrollFixture,
  input: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    effectiveDate: string;
    kind?: "regular" | "supplementary" | "final";
    employeeIds?: readonly string[];
  },
): Promise<string> {
  const r = await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    calculatePayrollRun(tx, ctxOf(s, s.human), {
      companyId: s.company,
      kind: input.kind ?? "regular",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payDate: input.payDate,
      effectiveDate: input.effectiveDate,
      branchId: s.hq,
      ...(input.employeeIds === undefined ? {} : { employeeIds: input.employeeIds }),
    }),
  );
  await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    transitionDocument(tx, ctxOf(s, s.human), { documentId: r.documentId, to: "submitted" }),
  );
  await withTenant(db.rw, ctxOf(s, f.approver), (tx) =>
    transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }),
  );
  await withTenant(db.rw, ctxOf(s, f.approver), (tx) =>
    postDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId }),
  );
  return r.documentId;
}
