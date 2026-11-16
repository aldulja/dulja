import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluatePolicy, parsePolicy } from "@dulja/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSnapshot, PostingError, resolvePolicy } from "../../src/posting";
import { ensureEmployeeDimensionValue } from "../../src/hr/employee-dimension";
import { linkPayrollAccounts } from "../../src/hr/accounts";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedEmployee,
  seedPayComponent,
  seedStatutoryScheme,
  seedTenantV2,
  type Seed,
} from "../fixtures";

// 8B Task 9 (contracts round 17, amendment A11): `loadSnapshot` fills the three slots 2A's evaluator already
// reads — `refs.components`, `refs.schemes` and `LineSnapshot.payroll`. The evaluator gains no branch.

const PAYROLL_ENVELOPE = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../seed/my/document-types/PAYROLL.json"), "utf8"),
) as { policy: unknown };

let db: Db;
let s: Seed;
let typeId: string;
let employeeId: string;
let employeeDimValueId: string;
let basicId: string;
let advanceId: string;
let schemeId: string;
let payableId: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Snapshot");
  // A company-wide role (granting nothing): 6C's branch_isolation on app.employee and Form A on app.document admit
  // an actor with a live assignment in the company, and seedTenant gives `s.human` none (contracts §4.1).
  await grantCodes(db, s, { codes: [] });
  for (const [code, nameEn, type] of [
    ["1400", "Staff advances", "asset"],
    ["2400", "Salaries payable", "liability"],
    ["2411", "Statutory payable — EPF", "liability"],
    ["5300", "Salaries expense", "expense"],
    ["5311", "Employer contribution — EPF", "expense"],
  ] as const)
    await seedAccount(db, s, { code, nameEn, type });

  typeId = await seedDocumentType(db, s, {
    code: "PAYROLL",
    module: "hr",
    policy: PAYROLL_ENVELOPE.policy,
  });
  employeeId = await seedEmployee(db, s, { employeeNumber: "E-2001" });
  basicId = await seedPayComponent(db, s, { code: "BASIC", kind: "earning" });
  advanceId = await seedPayComponent(db, s, { code: "ADV_RECOVERY", kind: "deduction" });
  schemeId = await seedStatutoryScheme(db, s, { code: "EPF" });
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    // The advance-recovery component points at 1400 BEFORE the linker runs, so the linker's `is null` clause is
    // what leaves it alone (8B Task 4).
    const [adv] = await tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '1400'`;
    await tx`update app.pay_component set expense_account_id = ${adv!.id} where id = ${advanceId}`;
    await linkPayrollAccounts(tx, s.company);
    employeeDimValueId = await ensureEmployeeDimensionValue(tx, s.company, employeeId);
  });
  const [p] = await db.admin<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = '2411'`;
  payableId = p!.id;
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const accountId = async (code: string): Promise<string> =>
  (
    await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = ${code}`
  )[0]!.id;

describe("loadSnapshot fills the payroll slots 2A's evaluator reads (§4.4.2, amendment A11)", () => {
  it("refs.components carries every live pay_component of the company, keyed by id", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "PAY",
      effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000" }],
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.refs.components[basicId]).toEqual({
      id: basicId,
      code: "BASIC",
      kind: "earning",
      expenseAccountId: await accountId("5300"),
      payableAccountId: null,
    });
    expect(snap.refs.components[advanceId]).toMatchObject({
      kind: "deduction",
      expenseAccountId: await accountId("1400"),
    });
  });

  it("refs.schemes carries every statutory_scheme of the company, with its two account ids", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "PAY",
      effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000" }],
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.refs.schemes[schemeId]).toEqual({
      id: schemeId,
      code: "EPF",
      payableAccountId: payableId,
      expenseAccountId: await accountId("5311"),
    });
  });

  it("LineSnapshot.payroll is the payroll_line row, with the EMPLOYEE dimension value id resolved", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "PAY",
      effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000", dimensions: { BRANCH: s.hq } }],
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, amount)
        values (${d.lineIds[0]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${basicId}, '1000.0000')`,
    );
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.lines[0]!.payroll).toEqual({
      employeeId,
      employeeDimensionValueId: employeeDimValueId,
      componentId: basicId,
      schemeId: null,
      share: null,
    });
  });

  it("a line with NO payroll_line row has `payroll: null`, and no rule matches it", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "PAY",
      effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000" }],
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    expect(snap.lines[0]!.payroll).toBeNull();
    const { definition } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      resolvePolicy(tx, typeId, "2026-01-31"),
    );
    expect(evaluatePolicy(parsePolicy(definition), snap).ledgerLines).toEqual([]);
  });

  it("a payroll line whose employee has no EMPLOYEE dimension value refuses, naming the line", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "PAY",
      effectiveDate: "2026-01-31",
      lines: [{ kind: "payroll", amount: "1000.0000", dimensions: { BRANCH: s.hq } }],
    });
    const orphan = await seedEmployee(db, s, { employeeNumber: "E-2099" });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, amount)
        values (${d.lineIds[0]!}, ${s.tenant}, ${s.company}, ${orphan}, ${basicId}, '1000.0000')`;
    });
    // The trigger made the value; renaming its code is the only way to orphan an employee from it without DDL.
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`update app.dimension_value set code = 'E-2099-OLD' where code = 'E-2099'`,
    );
    const refused = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      loadSnapshot(tx, d.documentId),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PostingError);
    expect((refused as PostingError).code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect((refused as PostingError).detail).toContain(d.lineIds[0]!);
    expect((refused as PostingError).detail).toContain("ensureEmployeeDimensionValue");
  });

  it("the whole PAYROLL policy evaluates over a filled snapshot — every rule reaches its account", async () => {
    const d = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "PAY",
      effectiveDate: "2026-01-31",
      lines: [
        { kind: "payroll", lineNo: 1, amount: "1000.0000", dimensions: { BRANCH: s.hq } }, // earning
        { kind: "payroll", lineNo: 2, amount: "50.0000", dimensions: { BRANCH: s.hq } }, // employee share
        { kind: "payroll", lineNo: 3, amount: "100.0000", dimensions: { BRANCH: s.hq } }, // employer share
        {
          kind: "account",
          lineNo: 4,
          credit: "950.0000",
          dimensions: { BRANCH: s.hq },
          accountId: await accountId("2400"),
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, amount)
               values (${d.lineIds[0]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${basicId}, '1000.0000')`;
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, scheme_id, share, amount)
               values (${d.lineIds[1]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${schemeId}, 'employee', '50.0000')`;
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, scheme_id, share, amount)
               values (${d.lineIds[2]!}, ${s.tenant}, ${s.company}, ${employeeId}, ${schemeId}, 'employer', '100.0000')`;
      await tx`insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
               values (${d.lineIds[3]!}, ${s.tenant}, ${s.company}, ${employeeId}, '950.0000')`;
    });
    const snap = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, d.documentId));
    const { definition } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      resolvePolicy(tx, typeId, "2026-01-31"),
    );
    const plan = evaluatePolicy(parsePolicy(definition), snap);

    // 5 ledger lines: earning debit, employee-share credit, employer-share debit + credit, net-pay credit.
    expect(plan.ledgerLines).toHaveLength(5);
    // A9: every planned amount is a MAGNITUDE and `side` carries the direction.
    for (const l of plan.ledgerLines) expect(l.amount.isNegative()).toBe(false);
    // Every line carries BOTH dimensions, and BRANCH is the LINE's, not the document's (amendment A3).
    for (const l of plan.ledgerLines) {
      expect(Object.keys(l.dimensions).toSorted()).toEqual(["BRANCH", "EMPLOYEE"]);
      expect(l.dimensions["EMPLOYEE"]).toBe(employeeDimValueId);
    }
    const zero = plan.ledgerLines[0]!.amount.subtract(plan.ledgerLines[0]!.amount);
    const sum = (side: "debit" | "credit") =>
      plan.ledgerLines.filter((l) => l.side === side).reduce((a, l) => a.add(l.amount), zero);
    expect(sum("debit").equals(sum("credit"))).toBe(true); // 1000 + 100 == 50 + 100 + 950
    expect(sum("debit").toString()).toBe("1100.0000");
  });
});
