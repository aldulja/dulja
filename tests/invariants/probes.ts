import { readFileSync } from "node:fs";
import { join } from "node:path";
import { einvoiceFixture } from "./support/einvoice";
import { PAYROLL_PACK_ROOT } from "./support/payroll";

import { enableEinvoice } from "@dulja/db/test/einvoice-stub";
import {
  recordPending,
  listTransmissions,
  createTaxReturn,
  createReportRun,
  createSavedView,
  upsertHrSetting,
  createLeaveType,
  requestLeave,
} from "@dulja/db";
import {
  createImportRun,
  createJobClient,
  IMPORT_RUN_JOB_OPTIONS,
  importStatement,
  withTenant,
  type JobName,
} from "@dulja/db";
import { createHrKeyRing, DEV_HR_KEY, writeSensitive } from "@dulja/db";
import { setHrKeyRing } from "@dulja/worker/hr-keys";
import {
  draftDocument,
  grantCodes,
  seedAccount,
  seedTerminal,
  seedShift,
  seedBranch,
  seedBranchPosPolicy,
  seedCurrency,
  seedDocumentType,
  seedItem,
  seedEmployee,
  seedPayComponent,
  seedPayrollRun,
  seedRateTable,
  seedStatutoryScheme,
  SYNTH_RATE_TABLE_V1,
  seedCashier,
  seedLot,
  seedParty,
  seedPaymentTerm,
  seedPriceList,
  seedRate,
  seedReportDefinition,
  seedExportJob,
  installBoss,
  stopBoss,
  seedWarehouse,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_RECEIPT_COST_POLICY,
} from "./support/post-inventory";

/** 8C T6 — a DRAFT money-out document of `code` (the type seeded from its shipped envelope) in the owner's company,
 *  written as the tenant's system principal (branch isolation admits it). Returns the document id. */
async function seedMoneyOutDraft(
  db: Db,
  owner: Seed,
  code: "PAYROLL_PAYMENT" | "EMPLOYEE_ADVANCE",
  series: string,
): Promise<string> {
  const envelope = JSON.parse(
    readFileSync(join(PAYROLL_PACK_ROOT, `document-types/${code}.json`), "utf8"),
  ) as { policy: unknown };
  const typeId = await seedDocumentType(db, owner, { code, module: "hr", policy: envelope.policy });
  return withTenant(
    db.rw,
    { tenantId: owner.tenant, actorId: owner.system, requestId: `probe-${code}` },
    async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.document (tenant_id, company_id, document_type_id, series, branch_id, effective_date, currency)
        values (${owner.tenant}, ${owner.company}, ${typeId}, ${series}, ${owner.hq}, '2026-01-15', 'MYR')
        returning id`;
      return row!.id;
    },
  );
}

export interface IsolationProbe {
  seed(db: Db, owner: Seed): Promise<{ path: string; method: string; body?: unknown }>;
  expect: 400 | 401 | 403 | 404;
}

/** A minimal plain-dataset definition, shared by the `report-runs` route probe (7A T12) and the
 *  `reporting.render` job probe (7A T11). */
const RENDER_PROBE_DEFINITION = {
  version: 1,
  code: "accounting.trial_balance",
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

/** 9B T9 — the owner's one QUEUED import run, per owner tenant: migration 0103 admits one live run per company, and
 *  both 9B route probes (and the job probe) seed into the same victim. Written as the route writes it. */
const ownerImportRuns = new Map<string, Promise<string>>();
function seedOwnerImportRun(db: Db, owner: Seed): Promise<string> {
  let seeded = ownerImportRuns.get(owner.tenant);
  if (!seeded) {
    seeded = uuidv7(db.admin).then((requestId) =>
      withTenant(db.rw, { tenantId: owner.tenant, actorId: owner.human, requestId }, (tx) =>
        createImportRun(tx, { companyId: owner.company, cutOverDate: "2026-01-31", dryRun: true }),
      ).then((run) => run.id),
    );
    ownerImportRuns.set(owner.tenant, seeded);
  }
  return seeded;
}

export const PROBES: Readonly<Record<string, IsolationProbe>> = {
  "/v1/companies/:companyId/imports": {
    // 9B T9 (C4). Tenant B owns a queued import run; tenant A reads it by B's company and id. The company-scoped
    // gate's actor_has('admin.company.manage', <B's company>) is false before any row is read, so the answer is 403 —
    // and RLS would hide B's run anyway. POST and the list inherit this key (hazard 31).
    async seed(db, owner) {
      const runId = await seedOwnerImportRun(db, owner);
      return { path: `/v1/companies/${owner.company}/imports/${runId}`, method: "GET" };
    },
    expect: 403,
  },
  "/v1/jobs": {
    // 9B T9 (C2/C17). Tenant B's `admin.import.run` job, enqueued through the real JobClient on B's transaction for
    // B's real run; tenant A polls its id. `pgboss.job` has no RLS (§4.2.6), so the route's bound is the envelope's
    // `tenantId` and then the run's own RLS-bound row: A gets the one 404 every unknown id gets. pg-boss is installed
    // here because this suite's API never needed it before; `installBoss` is idempotent over an installed schema.
    async seed(db, owner) {
      const runId = await seedOwnerImportRun(db, owner);
      const boss = await installBoss(db, ["admin.import.run"]);
      try {
        const requestId = await uuidv7(db.admin);
        const jobId = await withTenant(
          db.rw,
          { tenantId: owner.tenant, actorId: owner.human, requestId },
          (tx) =>
            createJobClient(boss).enqueue(
              tx,
              "admin.import.run",
              {
                tenantId: owner.tenant,
                requestId,
                payload: {
                  companyId: owner.company,
                  runId,
                  cutOverDate: "2026-01-31",
                  dryRun: true,
                },
              },
              IMPORT_RUN_JOB_OPTIONS,
            ),
        );
        return { path: `/v1/jobs/${jobId}`, method: "GET" };
      } finally {
        await stopBoss(boss);
      }
    },
    expect: 404,
  },
  "/v1/companies/:companyId/shifts": {
    // The directory gate refuses a path company in another tenant before reading any shift.
    async seed(db, owner) {
      const terminal = await seedTerminal(db, owner, { code: "PROBE" });
      const shiftId = await seedShift(db, owner, {
        terminalId: terminal.terminalId,
        cashierPrincipalId: owner.human,
      });
      return { path: `/v1/companies/${owner.company}/shifts/${shiftId}`, method: "GET" };
    },
    expect: 403,
  },

  "/v1/companies/:companyId/employees": {
    async seed(db, owner) {
      await seedEmployee(db, owner, { employeeNumber: "PROBE-EMPLOYEE" });
      return { path: `/v1/companies/${owner.company}/employees`, method: "GET" };
    },
    expect: 403,
  },
  // 8A T7 (amendment A7): the pay-component catalogue. The gate refuses a path company in another tenant before any
  // row is read. The employee sub-resources (sensitive, statutory profiles, compensation lines) live on the
  // employees module above and inherit its key (hazard 31).
  "/v1/companies/:companyId/pay-components": {
    async seed(db, owner) {
      const id = await seedPayComponent(db, owner, { code: "PROBE-BASIC", kind: "earning" });
      return {
        path: `/v1/companies/${owner.company}/pay-components/${id}`,
        method: "PATCH",
        body: { nameEn: "renamed by the attacker" },
      };
    },
    expect: 403,
  },
  // 8A T10 (amendment A7): one key for the statutory-scheme module. The attacker posts a break-glass load against the
  // victim's scheme; `requirePermission` refuses a path company of another tenant before any row is read.
  "/v1/companies/:companyId/statutory-schemes": {
    async seed(db, owner) {
      const schemeId = await seedStatutoryScheme(db, owner, { code: "PROBE" });
      return {
        path: `/v1/companies/${owner.company}/statutory-schemes/${schemeId}/rate-tables`,
        method: "POST",
        body: { definition: { ...SYNTH_RATE_TABLE_V1, scheme: "PROBE" } },
      };
    },
    expect: 403,
  },
  // 8A T11 (⚠️ OD-23): the victim's settings row exists; the attacker PUTs over it. `requirePermission` refuses a
  // path company of another tenant before any row is read (403, the T7 reason).
  "/v1/companies/:companyId/hr-settings": {
    async seed(db, owner) {
      await withTenant(
        db.rw,
        { tenantId: owner.tenant, actorId: owner.system, requestId: "probe-hr-settings" },
        (tx) =>
          upsertHrSetting(tx as never, {
            companyId: owner.company,
            prorationRule: "calendar_days",
            payDay: 25,
          }),
      );
      return {
        path: `/v1/companies/${owner.company}/hr-settings`,
        method: "PUT",
        body: { prorationRule: "working_days", payDay: 1 },
      };
    },
    expect: 403,
  },
  // 8B T10: one key for the payroll-run module. The victim holds a draft run (the PAYROLL type from the shipped pack,
  // one employee, §4.17's `seedPayrollRun`); the attacker GETs it under the victim's company. `requirePermission`
  // refuses a path company of another tenant before any row is read (403, the 8A probes' reason).
  "/v1/companies/:companyId/payroll-runs": {
    async seed(db, owner) {
      const envelope = JSON.parse(
        readFileSync(join(PAYROLL_PACK_ROOT, "document-types/PAYROLL.json"), "utf8"),
      ) as { policy: unknown };
      await seedDocumentType(db, owner, { code: "PAYROLL", module: "hr", policy: envelope.policy });
      const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-PAYROLL" });
      const documentId = await seedPayrollRun(db, owner, {
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        employeeIds: [employeeId],
      });
      return { path: `/v1/companies/${owner.company}/payroll-runs/${documentId}`, method: "GET" };
    },
    expect: 403,
  },
  // 8C T6 (round 18 B10): one key per money-out module. The victim holds a DRAFT of the type from the shipped pack
  // (no posted run is needed to name one by id); the attacker GETs it under the victim's company and
  // `requirePermission` refuses a path company of another tenant before any row is read (403, the 8B probe's reason).
  "/v1/companies/:companyId/payroll-payments": {
    async seed(db, owner) {
      const documentId = await seedMoneyOutDraft(db, owner, "PAYROLL_PAYMENT", "PAYB");
      return {
        path: `/v1/companies/${owner.company}/payroll-payments/${documentId}`,
        method: "GET",
      };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/employee-advances": {
    async seed(db, owner) {
      const documentId = await seedMoneyOutDraft(db, owner, "EMPLOYEE_ADVANCE", "ADV");
      return {
        path: `/v1/companies/${owner.company}/employee-advances/${documentId}`,
        method: "GET",
      };
    },
    expect: 403,
  },
  // 8C T7 (round 18 B10): the third money-out key. The victim holds a schedule row (a synthetic scheme of its own and
  // a draft document standing in for the run — the row's FKs are all the probe needs); the attacker GETs it under the
  // victim's company and `requirePermission` refuses a path company of another tenant before any row is read (403).
  "/v1/companies/:companyId/statutory-schedules": {
    async seed(db, owner) {
      const schemeId = await seedStatutoryScheme(db, owner, { code: "PROBE_SCHEDULE" });
      const documentId = await draftDocument(db, owner);
      const scheduleId = await withTenant(
        db.rw,
        { tenantId: owner.tenant, actorId: owner.system, requestId: "probe-statutory-schedule" },
        async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into app.statutory_schedule (tenant_id, company_id, scheme_id, period_start, period_end,
                                                payroll_document_id, total_employee, total_employer, currency)
            values (${owner.tenant}, ${owner.company}, ${schemeId}, '2026-01-01', '2026-01-31',
                    ${documentId}, 0, 0, 'MYR')
            returning id`;
          return row!.id;
        },
      );
      return {
        path: `/v1/companies/${owner.company}/statutory-schedules/${scheduleId}`,
        method: "GET",
      };
    },
    expect: 403,
  },
  // 8D T8 (⚠️ OD-13 answered build, round 19 A14): one key for the leave register. The victim holds a REQUESTED
  // record; the attacker posts a decision on it under the victim's company. `requirePermission` refuses a path company
  // of another tenant before any row is read (403, the 8A–8C probes' reason) — the record is never decided.
  "/v1/companies/:companyId/leave-records": {
    async seed(db, owner) {
      const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-LEAVE" });
      const recordId = await withTenant(
        db.rw,
        { tenantId: owner.tenant, actorId: owner.system, requestId: "probe-leave" },
        async (tx) => {
          const leaveTypeId = await createLeaveType(tx as never, {
            companyId: owner.company,
            code: "annual",
            nameEn: "Annual leave",
            nameAr: null,
            paid: true,
          });
          return requestLeave(tx as never, {
            companyId: owner.company,
            employeeId,
            leaveTypeId,
            startsOn: "2026-07-01",
            endsOn: "2026-07-02",
            days: "2.00",
            reason: null,
          });
        },
      );
      return {
        path: `/v1/companies/${owner.company}/leave-records/${recordId}/decision`,
        method: "POST",
        body: { decision: "approved" },
      };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/cashiers": {
    async seed(db, owner) {
      const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-CASHIER" });
      await seedCashier(db, owner, { employeeId, branchId: owner.hq });
      return { path: `/v1/companies/${owner.company}/cashiers`, method: "GET" };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/attendance-events": {
    async seed(db, owner) {
      const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-ATTENDANCE" });
      await withTenant(
        db.rw,
        { tenantId: owner.tenant, actorId: owner.system, requestId: "probe-attendance" },
        (tx) =>
          tx`insert into app.attendance_event (tenant_id,company_id,employee_id,branch_id,kind,occurred_at) values (${owner.tenant},${owner.company},${employeeId},${owner.hq},'clock_in',now())`,
      );
      return { path: `/v1/companies/${owner.company}/attendance-events`, method: "GET" };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/branch-pos-policies": {
    async seed(db, owner) {
      const branchId = await seedBranch(db, owner, { code: "PROBE-POS-POLICY" });
      await seedBranchPosPolicy(db, owner, { branchId });
      return { path: `/v1/companies/${owner.company}/branch-pos-policies`, method: "GET" };
    },
    expect: 403,
  },
  // The projection is the caller's own staff branches, so there is no owner row to name: the attacker, who
  // holds no staff code in any branch, is refused before an empty projection could answer anything.
  "/v1/staff-context": {
    async seed(db, owner) {
      await seedEmployee(db, owner, { employeeNumber: "PROBE-CONTEXT" });
      return { path: "/v1/staff-context", method: "GET" };
    },
    expect: 403,
  },
  "/v1/sync/tickets": {
    seed: async () => ({
      path: "/v1/sync/tickets",
      method: "POST",
      body: {
        terminalId: "00000000-0000-7000-8000-000000000000",
        batchId: "00000000-0000-7000-8000-000000000001",
        tickets: [],
        shifts: [],
        tillEvents: [],
      },
    }),
    expect: 401,
  },
  "/v1/companies/:companyId/needs-attention": {
    seed: async (_db, owner) => ({
      path: `/v1/companies/${owner.company}/needs-attention`,
      method: "GET",
    }),
    expect: 403,
  },
  "/v1/sync/catalogue": {
    seed: async () => ({ path: "/v1/sync/catalogue", method: "GET" }),
    // The harness's attacker presents a HUMAN token, which `terminalAuth` refuses before any catalogue read,
    // so this 401 proves the identity layer and nothing about the catalogue's tenant scoping. The stronger
    // cross-tenant case — a terminal in tenant A sees zero rows of tenant B's catalogue — needs an enrolled,
    // signing terminal, which a probe cannot make; it is asserted in apps/api/test/routes/sync/catalogue.test.ts.
    expect: 401,
  },
  // tests/invariants/probes.ts — two entries (§4.2.7, Task 0 amendment 8).
  "/v1/admin/terminals": {
    async seed(_db, owner) {
      return {
        path: "/v1/admin/terminals/enrolments",
        method: "POST",
        body: { companyId: owner.company, branchId: owner.hq, name: "Till", terminalCode: "P1" },
      };
    },
    // The harness's attacker holds only 0B's five admin codes, so `admin.terminal.manage` is refused before
    // the handler runs. The stronger cases — an attacker who DOES hold the code in its own company asking to
    // enrol into another company of its tenant, and into a second tenant's company — are asserted in
    // apps/api/test/routes/sync/enrolment.test.ts ("binds list, revocation and issuance …"), where a
    // grant can be arranged; a probe cannot grant.
    expect: 403,
  },
  "/v1/sync/enrol": {
    async seed() {
      return {
        path: "/v1/sync/enrol",
        method: "POST",
        body: { code: "A".repeat(32), devicePublicKey: "AA==" },
      };
    },
    // A public, bearer-secret door: the only thing a caller can present is a code, and a code that is not a
    // code is 400 whichever tenant asks. There is no row to reach across, which is exactly why this is the
    // recorded value rather than a 403.
    expect: 400,
  },

  "/v1/companies/:companyId/tax-codes": {
    async seed(db, owner) {
      const id = await seedAccount(db, owner, {
        code: "2300",
        nameEn: "Tax control",
        type: "liability",
      });
      const { seedTaxCode } = await import("@dulja/db/test");
      const { taxCodeId } = await seedTaxCode(db, owner);
      void id;
      return { path: `/v1/companies/${owner.company}/tax-codes/${taxCodeId}`, method: "GET" };
    },
    expect: 403, // company-first permission gate refuses every foreign-company path uniformly
  },
  "/v1/companies/:companyId/tax-returns": {
    async seed(db, owner) {
      const { seedTaxCode } = await import("@dulja/db/test");
      const { regimeId } = await seedTaxCode(db, owner, {
        code: "PROBE-ZERO",
        kind: "zero",
        rate: "0.00000000",
      });
      const row = await withTenant(db.rw, ctxFor(owner, "tax-return-probe"), (tx) =>
        createTaxReturn(tx, ctxFor(owner, "tax-return-probe"), {
          companyId: owner.company,
          regimeId,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
        }),
      );
      return { path: `/v1/companies/${owner.company}/tax-returns/${row.id}`, method: "GET" };
    },
    expect: 403, // company-first permission gate refuses every foreign-company path uniformly
  },
  "/v1/companies/:companyId/einvoice-transmissions": {
    async seed(db, owner) {
      // The OWNER's transmission. The harness then requests it as the attacker, whose token carries
      // a different tenant; RLS makes the row invisible and `getTransmission` raises ERR_NOT_FOUND.
      const f = await einvoiceFixture(db, owner);
      const { transmissionId } = await f.postOptedInDocument();
      return {
        path: `/v1/companies/${owner.company}/einvoice-transmissions/${transmissionId}`,
        method: "GET",
      };
    },
    expect: 403, // company-first permission gate refuses every foreign-company path uniformly
  },

  "/healthz": { seed: () => Promise.resolve({ path: "/healthz", method: "GET" }), expect: 404 },
  "/v1/session": {
    seed: () => Promise.resolve({ path: "/v1/session", method: "GET" }),
    expect: 404,
  },
  "/v1/me": {
    // ADR 0089 (review UI-03/UI-11). The caller's own companies: tenant A is answered 200 with its own company only,
    // so the 200 branch applies and B's audit log stays untouched. The body's two-tenant and two-company bounds are
    // asserted in `apps/api/test/routes/me-companies.test.ts`; `expect` is the type's placeholder, never reached.
    seed: () => Promise.resolve({ path: "/v1/me/companies", method: "GET" }),
    expect: 404,
  },
  "/v1/admin/users": {
    seed: (_db, owner) =>
      Promise.resolve({ path: `/v1/admin/users/${owner.human}/expire`, method: "POST", body: {} }),
    expect: 404,
  },
  "/v1/admin/roles": {
    seed: async (db, owner) => {
      const roleId = await uuidv7(db.admin);
      await db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${owner.tenant}, true), set_config('app.actor_id', ${owner.system}, true)`;
        await tx`insert into app.role (id, tenant_id, code, name_en)
                 values (${roleId}, ${owner.tenant}, 'probe', 'Probe')`;
      });
      return { path: `/v1/admin/roles/${roleId}`, method: "PATCH", body: { nameEn: "Stolen" } };
    },
    expect: 404,
  },
  "/v1/companies": {
    seed: (_db, owner) =>
      Promise.resolve({ path: `/v1/companies/${owner.company}`, method: "GET" }),
    expect: 404,
  },
  "/v1/companies/:companyId/role-assignments": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/role-assignments`,
        method: "POST",
        body: { principalId: owner.human, roleId: owner.hq },
      }),
    expect: 403,
  },
  "/v1/admin/audit-log": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/admin/audit-log?actorId=${owner.human}&limit=100`,
        method: "GET",
      }),
    expect: 404,
  },
  "/v1/admin/currencies": {
    async seed(_db, owner) {
      // MYR is already the tenant's, from seedTenant — which is what makes the POST below a duplicate.
      return {
        path: "/v1/admin/currencies",
        method: "POST",
        body: { companyId: owner.company, code: "MYR", nameEn: "duplicate" },
      };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/exchange-rates": {
    async seed(db, owner) {
      await seedCurrency(db, owner, { code: "USD" });
      await seedRate(db, owner, {
        from: "USD",
        to: "MYR",
        on: "2026-01-01",
        rate: "4.68000000",
      });
      return {
        path: `/v1/companies/${owner.company}/exchange-rates`,
        method: "GET",
      };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/dimension-types": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/dimension-types`,
        method: "GET",
      }),
    expect: 403,
  },
  "/v1/companies/:companyId/custom-field-definitions": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/custom-field-definitions?entity=document`,
        method: "GET",
      }),
    expect: 403,
  },
  "/v1/companies/:companyId/custom-fields": {
    async seed(db, owner) {
      const documentId = await draftDocument(db, owner);
      return {
        path: `/v1/companies/${owner.company}/custom-fields/document/${documentId}`,
        method: "GET",
      };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/fiscal-periods": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/fiscal-periods/${owner.period}/close`,
        method: "POST",
        body: {},
      }),
    expect: 403,
  },
  // ADR 0097 (full review PRD-05): the attacker creates a year in the victim's company; the company-scoped gate
  // refuses a path company of another tenant before any period is read or written.
  "/v1/companies/:companyId/fiscal-years": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/fiscal-years`,
        method: "POST",
        body: { fiscalYear: 2031, startMonth: 1 },
      }),
    expect: 403,
  },
  // ADR 0097 (full review PRD-08): the attacker links the victim's payroll accounts; refused at the gate.
  "/v1/companies/:companyId/payroll-accounts": {
    async seed(db, owner) {
      await seedPayComponent(db, owner, { code: "PROBE-LINK", kind: "earning" });
      return { path: `/v1/companies/${owner.company}/payroll-accounts`, method: "POST", body: {} };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/documents": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/documents`,
        method: "POST",
        body: {
          documentTypeCode: "JOURNAL",
          effectiveDate: "2026-01-15",
          currency: "MYR",
          branchId: owner.hq,
          lines: [
            { lineNo: 1, accountId: owner.cash, debit: "1.0000" },
            { lineNo: 2, accountId: owner.sales, credit: "1.0000" },
          ],
        },
      }),
    // 403: the create gate `requireDocumentPermission("create")` asks COMPANY FIRST (code review 2, S3) —
    // the cross-tenant caller holds no role in B's company, so it is refused on the company before the type
    // is looked up, and the refusal confirms nothing about B's types or ids. (From 2A until that review the
    // gate looked the type up first and answered 404, which let a caller outside the company tell a real id
    // from a random one.) No row of B is read or written either way (the audit count below).
    expect: 403,
  },
  "/v1/companies/:companyId/reports": {
    seed: (_db, owner) =>
      // Tenant A asks for tenant B's company and period. RLS makes the rows invisible and
      // requirePermission's actor_has(code, <B's company>) is false, so the answer is 403 either way.
      Promise.resolve({
        path: `/v1/companies/${owner.company}/reports/accounting.trial_balance?fiscalPeriodId=${owner.period}`,
        method: "GET",
      }),
    expect: 403,
  },
  "/v1/companies/:companyId/report-runs": {
    // 7A T12. Tenant B owns a definition and a queued run; tenant A asks for it by B's company and B's run id.
    // The export gate's actor_has(code, <B's company>) is false before any row is read, so the answer is 403
    // whether or not the run exists, and RLS would hide it anyway.
    async seed(db, owner) {
      const definitionId = await seedReportDefinition(db, owner, {
        code: "accounting.trial_balance",
        definition: RENDER_PROBE_DEFINITION,
      });
      const ctx = {
        tenantId: owner.tenant,
        actorId: owner.human,
        requestId: await uuidv7(db.admin),
      };
      const run = await withTenant(db.rw, ctx, (tx) =>
        createReportRun(tx, {
          companyId: owner.company,
          reportDefinitionId: definitionId,
          parameters: {},
          format: "csv",
          lang: "en",
        }),
      );
      return { path: `/v1/companies/${owner.company}/report-runs/${run.id}`, method: "GET" };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/exports": {
    // 7C T6. Tenant B owns a queued export; tenant A lists B's company's exports. The company-scoped gate's
    // actor_has('admin.data.export', <B's company>) is false before any row is read, so the answer is 403 —
    // and RLS would hide B's job anyway. Task 9's sub-paths inherit this key (contracts A12).
    async seed(db, owner) {
      await seedExportJob(db, owner);
      return { path: `/v1/companies/${owner.company}/exports`, method: "GET" };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/report-definitions": {
    // 7A T13. Reads are membership only, so no gate answers first: tenant A asks for tenant B's definition by
    // B's company and id, RLS hides the row, `getReportDefinition` returns null and the handler answers 404.
    async seed(db, owner) {
      const definitionId = await seedReportDefinition(db, owner, {
        code: "accounting.trial_balance",
        definition: RENDER_PROBE_DEFINITION,
        // The victim tenant is shared across probes, and the report-runs probe holds version 1.
        definitionVersion: 2,
      });
      return {
        path: `/v1/companies/${owner.company}/report-definitions/${definitionId}`,
        method: "GET",
      };
    },
    expect: 404,
  },
  "/v1/companies/:companyId/saved-views": {
    // 7A T13. The module carries no permission code; RLS hides B's view, so the answer is 404. The store's
    // owner check (403) is reachable only for a row the caller can already see, which a cross-tenant probe
    // never can.
    async seed(db, owner) {
      const definitionId = await seedReportDefinition(db, owner, {
        code: "accounting.trial_balance",
        definition: RENDER_PROBE_DEFINITION,
        definitionVersion: 3,
      });
      const view = await withTenant(
        db.rw,
        { tenantId: owner.tenant, actorId: owner.human, requestId: await uuidv7(db.admin) },
        (tx) =>
          createSavedView(tx, {
            companyId: owner.company,
            reportDefinitionId: definitionId,
            nameEn: "Probe view",
            parameters: {},
            shared: true,
          }),
      );
      return {
        path: `/v1/companies/${owner.company}/saved-views/${view.id}`,
        method: "GET",
      };
    },
    expect: 404,
  },
  "/v1/companies/:companyId/ledger-entries": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/ledger-entries`,
        method: "GET",
      }),
    expect: 403,
  },
  "/v1/companies/:companyId/accounts": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/accounts`,
        method: "POST",
        // requirePermission refuses the company before any row is read.
        body: { code: "9998", nameEn: "Stolen", type: "asset" },
      }),
    expect: 403,
  },
  // 2A — the two configuration modules (contracts §4.2.7, hazard 31).
  "/v1/companies/:companyId/document-types": {
    seed: (_db, owner) =>
      Promise.resolve({ path: `/v1/companies/${owner.company}/document-types`, method: "GET" }),
    expect: 403,
  },
  // 2C — attachments (contracts §4.5.8). A GET on the download sub-path, not the upload: `IsolationProbe.seed`
  // returns `body?: unknown` and the harness JSON-stringifies it, so a FormData could not travel. The download
  // is the sharper probe anyway. `requireAttachmentRead` asks COMPANY FIRST (code review 2, S3): the
  // cross-tenant caller holds no role in B's company, so the answer is 403 on the company, before the row is
  // read — the same 403 a random id gets, so it confirms nothing about the id. B's row is also invisible
  // under the caller's RLS session, which is why the answer was 404 before that review.
  "/v1/companies/:companyId/attachments": {
    async seed(db, owner) {
      const documentId = await draftDocument(db, owner);
      const attachmentId = await uuidv7(db.admin);
      await db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${owner.tenant}, true), set_config('app.actor_id', ${owner.system}, true)`;
        await tx`
          insert into app.attachment (id, tenant_id, company_id, document_id, object_key, file_name,
                                      mime_type, byte_size, sha256)
          values (${attachmentId}, ${owner.tenant}, ${owner.company}, ${documentId},
                  ${`${owner.tenant}/${attachmentId}`}, 'probe.pdf', 'application/pdf', 1, decode('00', 'hex'))`;
      });
      // No object is written to any store: the 403 is raised by the middleware, before any read of content.
      return {
        path: `/v1/companies/${owner.company}/attachments/${attachmentId}/content`,
        method: "GET",
      };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/print-templates": {
    seed: (_db, owner) =>
      Promise.resolve({ path: `/v1/companies/${owner.company}/print-templates`, method: "GET" }),
    // requirePermission refuses the foreign company before the handler runs (admin.company.manage).
    expect: 403,
  },
  "/v1/companies/:companyId/parties": {
    seed: async (db, owner) => {
      const partyId = await seedParty(db, owner, { code: "PROBE" });
      return { path: `/v1/companies/${owner.company}/parties/${partyId}`, method: "GET" };
    },
    // requirePermission refuses the foreign company before the handler runs: actor_has(code, <B's company>)
    // is false for a principal of tenant A, and RLS would hide the row in any case.
    expect: 403,
  },
  // 4A T1 — the one new module 4A mounts; its sub-paths inherit this key (hazard 31).
  "/v1/companies/:companyId/payment-terms": {
    async seed(db, owner) {
      // The victim's own term, in the victim's company. The attacker asks for it by the victim's companyId.
      await seedPaymentTerm(db, owner, { code: "VICTIM-NET30" });
      return { path: `/v1/companies/${owner.company}/payment-terms`, method: "GET" };
    },
    // requirePermission evaluates actor_has(accounting.party.manage, <B's company>) inside the attacker's
    // tenant, where B's company is invisible, so the gate answers ERR_RBAC_FORBIDDEN before the handler runs.
    expect: 403,
  },
  // 4B T8 — the one module 4B mounts; its six sub-paths inherit this key (hazard 31).
  "/v1/companies/:companyId/bank-statements": {
    async seed(db, owner) {
      // The victim imports a statement onto its own bank account; the harness then asks for its lines as the
      // OTHER tenant, by the victim's companyId and statement id. `seedAccount` is idempotent on the code, and
      // no other suite reaches this probe, so the one import per victim cannot collide on its statement date.
      const bankAccountId = await seedAccount(db, owner, {
        code: "1100",
        nameEn: "Bank",
        type: "asset",
      });
      const ctx = ctxFor(owner, "probe-bank-statement");
      const { statementId } = await withTenant(db.rw, ctx, (tx) =>
        importStatement(tx, ctx, {
          companyId: owner.company,
          bankAccountId,
          csv: "2026-01-05,PROBE,X,10.00",
          mapping: {
            statement: {
              statementDate: "2026-01-31",
              openingBalance: "0.0000",
              closingBalance: "10.0000",
            },
            columns: { valueDate: 0, description: 1, reference: 2, amount: 3 },
            dateFormat: "YYYY-MM-DD",
            hasHeader: false,
          },
        }),
      );
      return {
        path: `/v1/companies/${owner.company}/bank-statements/${statementId}/lines`,
        method: "GET",
      };
    },
    // requirePermission evaluates actor_has(accounting.bank.reconcile, <B's company>) inside the attacker's
    // tenant, where B's company is invisible, so the gate answers ERR_RBAC_FORBIDDEN before the handler runs.
    expect: 403,
  },
  // 3A — the head-office catalogue (hazard 31: one entry per RouteModule.path, and a sub-path needs none).
  "/v1/companies/:companyId/items": {
    seed: async (db, owner) => {
      const { itemId } = await seedItem(db, owner, { code: "PROBE-ITEM" });
      return { path: `/v1/companies/${owner.company}/items/${itemId}`, method: "GET" };
    },
    // requirePermission refuses the foreign company before any row is read.
    expect: 403,
  },
  "/v1/companies/:companyId/units": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/units`,
        method: "POST",
        body: { code: "PROBE-UNIT", nameEn: "Probe" },
      }),
    expect: 403,
  },
  "/v1/companies/:companyId/warehouses": {
    seed: async (db, owner) => {
      const warehouseId = await seedWarehouse(db, owner, { code: "PROBE-WH" });
      return { path: `/v1/companies/${owner.company}/warehouses/${warehouseId}`, method: "GET" };
    },
    expect: 403,
  },
  // 3A T12 — prices, promotions and the stock read.
  "/v1/companies/:companyId/price-lists": {
    seed: async (db, owner) => {
      const priceListId = await seedPriceList(db, owner, { code: "PROBE-PL" });
      return { path: `/v1/companies/${owner.company}/price-lists/${priceListId}`, method: "GET" };
    },
    expect: 403,
  },
  "/v1/companies/:companyId/promotions": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/promotions`,
        method: "POST",
        body: { code: "PROBE-PROMO", nameEn: "Probe", kind: "percent_off", definition: {} },
      }),
    expect: 403,
  },
  "/v1/companies/:companyId/stock-on-hand": {
    seed: (_db, owner) =>
      Promise.resolve({ path: `/v1/companies/${owner.company}/stock-on-hand`, method: "GET" }),
    expect: 403,
  },
  // 3B T10. Keyed by the module path exactly; `/layers` is a sub-path and needs no key of its own
  // (hazard 31). `asOf` is required, so the probe carries one — without it the attacker would be refused
  // at validation and the 403 would prove nothing about the gate.
  "/v1/companies/:companyId/valuation": {
    seed: (_db, owner) =>
      Promise.resolve({
        path: `/v1/companies/${owner.company}/valuation?asOf=2026-12-31`,
        method: "GET",
      }),
    expect: 403,
  },
};

export const TENANT_FREE = new Set(["/healthz", "/v1/session"]);

export interface JobIsolationProbe {
  seed(db: Db, attacker: Seed, victim: Seed): Promise<void>;
  survivors(db: Db, victim: Seed): Promise<number>;
  payload?(db: Db, attacker: Seed, victim: Seed): Promise<unknown>;
  expectedErrorCode?: string;
}

/** A wire `Money` in the seed company's currency (`MYR`, plan0A's seed constant): the amount stays a string. */
const myr = (amount: string) => ({ amount, currency: "MYR" });

/** The `TenantContext` builder the entries below share — the PRODUCTION three-argument `withTenant`'s
 *  first argument (hazard 15, §4.2.12: "Root `tests/` use the production one"). */
const ctxFor = (s: Seed, label: string) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: label,
});

/**
 * One posted receipt, and therefore one open `cost_layer`, in the victim's company (3B Task 9 Step 4). Local
 * to this file rather than registered in contracts §4.17.1: the probe registry is test-tier code and §4.17.1
 * registers no per-probe helper.
 *
 * The layer is created by the REAL `postDocument`, because `app.cost_layer` may only be written by the
 * posting service and a hand-inserted row would not prove the job leaves a real one alone. `recordingJobs()`
 * stands in for the `JobClient` step 14 wants: this receipt is the newest document in its company, so nothing
 * is back-dated and nothing is enqueued.
 */
async function seedCostLayerFixture(db: Db, victim: Seed): Promise<void> {
  // Once per victim tenant. Both 3B probes below seed "the same fixture" into the SAME victim, and a second
  // run would re-upsert STOCK_RECEIPT_TEST's version 1 — which the first run's post has pinned, so
  // `posting_policy_pinned` refuses it (ERR_TABLE_IMMUTABLE, ADR 0027) — and re-create VICTIM-COST/V-COST.
  let seeded = costLayerFixtures.get(victim.tenant);
  if (!seeded) {
    seeded = seedCostLayerFixtureOnce(db, victim);
    costLayerFixtures.set(victim.tenant, seeded);
  }
  return seeded;
}
const costLayerFixtures = new Map<string, Promise<void>>();

async function seedCostLayerFixtureOnce(db: Db, victim: Seed): Promise<void> {
  // A bare `grantCodes(db, victim)` grants NOTHING; the receipt policy's `approval.post` is evaluated by 2B's
  // R2 inside the posting transaction.
  await grantCodes(db, victim, { codes: ["accounting.journal.post"] });
  const documentTypeId = await seedDocumentType(db, victim, {
    code: "STOCK_RECEIPT_TEST",
    module: "inventory",
    policy: STOCK_RECEIPT_COST_POLICY,
  });
  // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1) and the receipt below carries no lot.
  const { itemId } = await seedItem(db, victim, { code: "VICTIM-COST", trackLots: false });
  const warehouseId = await seedWarehouse(db, victim, { code: "V-COST" });
  await postInventoryDocument(db, victim, {
    documentTypeId,
    warehouseId,
    jobs: recordingJobs(),
    effectiveDate: "2026-02-05",
    lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "4.0000" }],
  });
}

/** The victim's one queued report run, per victim tenant, so `payload` can hand its id to the attacker's job. */
const victimReportRuns = new Map<string, string>();
/** The victim's one queued export job, per victim tenant, for the same reason (7C T8). */
const victimExportJobs = new Map<string, string>();

/** 8D T7 — the rotation probe's two rings: rows are sealed under v1 and the attacker's job runs under v2 (with v1 as
 *  its previous key), so the job HAS something to rotate — a probe under a v1 ring would rotate nothing anywhere and
 *  prove nothing. `Buffer.alloc(32, 9)` is a fixed synthetic key, never a deployed one. */
const PROBE_RING_V1 = createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 });
const PROBE_RING_V2 = createHrKeyRing({
  current: Buffer.alloc(32, 9).toString("base64"),
  currentVersion: 2,
  previous: DEV_HR_KEY,
});

export const JOB_PROBES: Readonly<Partial<Record<JobName, JobIsolationProbe>>> = {
  "pos.cashier.compare": {
    async seed(db, attacker, victim) {
      for (const owner of [attacker, victim]) {
        const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-COMPARE" });
        const cashier = await seedCashier(db, owner, {
          employeeId,
          branchId: owner.hq,
          permissions: ["pos.ticket.sell"],
        });
        // Fault injection only in the test tier; the comparison must report it without repairing.
        await withTenant(
          db.migrator,
          { tenantId: owner.tenant, actorId: owner.system, requestId: "compare-fault-probe" },
          (tx) =>
            tx`update app.pos_cashier set snapshot='{"codes":[],"limits":{}}'::jsonb where principal_id=${cashier}`,
        );
      }
    },
    async survivors(db, victim) {
      const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.pos_cashier c
        where c.tenant_id=${victim.tenant} and c.snapshot->'codes'='[]'::jsonb and c.snapshot->'limits'='{}'::jsonb
          and not exists(select 1 from app.audit_log a where a.tenant_id=c.tenant_id and a.table_name='cashier_snapshot_drift')`;
      return row!.n;
    },
  },
  "pos.sync.apply": {
    // The attacker's envelope carries the VICTIM's terminal and one ticket for it, on the victim's own shift
    // and item (6A T12). The handler's tenant guard must refuse it before `applyBatch` runs; without that
    // guard `terminalContext` would apply the batch inside the victim's tenant, as the victim's terminal.
    // The ticket is parse-valid (`TicketBatchBody`), so a missing guard is not masked by a ZodError on an empty
    // batch: it would reach the apply path, which either posts it (one more `document`) or refuses it into the
    // needs-attention queue (one more `needs_attention` row) — `survivors` counts both, so either way it rises.
    async seed(db, _attacker, victim) {
      const { generateKeyPairSync } = await import("node:crypto");
      const publicKey = generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "der",
      });
      const { terminalId } = await seedTerminal(db, victim, {
        code: "PROBE",
        devicePublicKey: publicKey,
      });
      await seedItem(db, victim, { code: "VICTIM-POS", trackLots: false });
      await seedShift(db, victim, { terminalId, cashierPrincipalId: victim.human });
    },
    async payload(db, _attacker, victim) {
      const [row] = await db.admin<
        { terminal_id: string; shift_id: string; item_id: string; unit_id: string }[]
      >`select t.id as terminal_id, sh.id as shift_id, i.id as item_id, i.base_unit_id as unit_id
          from app.pos_terminal t
          join app.shift sh on sh.terminal_id = t.id
          join app.item i on i.company_id = t.company_id and i.code = 'VICTIM-POS'
         where t.tenant_id = ${victim.tenant} and t.code = 'PROBE'`;
      // Strings throughout, exactly as the wire carries them: Money is never a JS number (`myr`), and
      // `catalogueRevision` is a decimal string (`BigintString`).
      return {
        terminalId: row!.terminal_id,
        batch: {
          terminalId: row!.terminal_id,
          batchId: await uuidv7(db.admin),
          tickets: [
            {
              clientRef: await uuidv7(db.admin),
              shiftId: row!.shift_id,
              cashierPrincipalId: victim.human,
              customerId: null,
              newCustomer: null,
              kind: "sale",
              returnsClientRef: null,
              currency: "MYR",
              soldAt: new Date().toISOString(),
              lines: [
                {
                  lineNo: 1,
                  itemId: row!.item_id,
                  lotId: null,
                  quantity: "1.000000",
                  unitId: row!.unit_id,
                  unitPrice: myr("10.0000"),
                  discount: myr("0.0000"),
                  taxCodeId: null,
                  taxAmount: myr("0.0000"),
                  total: myr("10.0000"),
                },
              ],
              tenders: [{ tenderNo: 1, method: "cash", amount: myr("10.0000"), reference: null }],
              events: [],
              attendance: [],
              catalogueRevision: "0",
            },
          ],
          shifts: [],
          tillEvents: [],
        },
      };
    },
    expectedErrorCode: "ERR_TERMINAL_SIGNATURE_INVALID",
    async survivors(db, victim) {
      const [row] = await db.admin<{ n: number }[]>`
        select ((select count(*) from app.document where tenant_id = ${victim.tenant})
              + (select count(*) from app.needs_attention where tenant_id = ${victim.tenant}))::int as n`;
      return row!.n;
    },
  },
  "accounting.tax.submit": {
    async seed(db, attacker, victim) {
      // The VICTIM owns a pending transmission; the attacker's tenant runs the job with the
      // victim's transmission id in the payload. RLS must make it invisible and the handler must
      // treat it as a no-op, leaving the victim's row untouched (§3.7.2).
      const documentId = await draftDocument(db, victim);
      await enableEinvoice(db, victim);
      await withTenant(
        db.rw,
        {
          tenantId: victim.tenant,
          actorId: victim.human,
          requestId: "00000000-0000-7000-8000-000000000000",
        },
        (tx) =>
          recordPending(tx, { documentId, companyId: victim.company, transmitter: "synthetic" }),
      );
      void attacker;
    },
    async survivors(db, victim) {
      const rows = await withTenant(
        db.rw,
        {
          tenantId: victim.tenant,
          actorId: victim.human,
          requestId: "00000000-0000-7000-8000-000000000000",
        },
        (tx) => listTransmissions(tx, { companyId: victim.company, limit: 100 }),
      );
      return rows.filter((r) => r.status === "pending" && r.attempts === 0).length;
    },
  },

  "inventory.cost.replay": {
    async seed(db, attacker, victim) {
      // The victim gets one layer; the job then runs for the ATTACKER's tenant.
      await seedCostLayerFixture(db, victim);
      void attacker;
    },
    async survivors(db, victim) {
      const [row] = await withTenant(
        db.rw,
        ctxFor(victim, "probe-survivors"),
        (tx) => tx<{ n: number }[]>`
          select count(*)::int as n from app.cost_layer where invalidated_at is null`,
      );
      return row!.n;
    },
  },
  "inventory.projection.rebuild": {
    // The same fixture the replay probe uses: one real posted receipt, and therefore one open cost_layer
    // and one (item, warehouse) pair the victim's rebuild WOULD write a stock_valuation row for. The
    // harness then runs the job for the ATTACKER's tenant, so a rebuild that leaked would materialise the
    // victim's pair; under FORCE RLS it writes nothing at all (3B Task 11 Step 4, hazard 31).
    async seed(db, attacker, victim) {
      await seedCostLayerFixture(db, victim);
      void attacker;
    },
    async survivors(db, victim) {
      const [row] = await withTenant(
        db.rw,
        ctxFor(victim, "probe-survivors"),
        (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.stock_valuation`,
      );
      return row!.n;
    },
  },
  "accounting.projection.rebuild": {
    // The victim owns a NON-ZERO party_ageing snapshot row that no fresh computation produces (the victim
    // has no documents), dated on the run date the handler defaults `asOf` to — the harness passes an empty
    // payload. A rebuild that leaked into the victim's company would zero that stale key; under FORCE RLS the
    // attacker's run sees no victim company at all, and the row survives (4B Task 3, hazard 31). Task 4's
    // second write, the item_profitability rebuild, gets the same bait: a non-zero row no fresh computation
    // produces, which a leaking rebuild would zero.
    async seed(db, attacker, victim) {
      const partyId = await seedParty(db, victim, { code: "V-AGEING" });
      const { itemId } = await seedItem(db, victim, { code: "V-PROFIT", trackLots: false });
      await withTenant(db.rw, ctxFor(victim, "probe-seed"), async (tx) => {
        await tx`
          insert into app.party_ageing
            (tenant_id, company_id, party_id, currency, as_of, bucket, amount, base_amount)
          values (${victim.tenant}, ${victim.company}, ${partyId}, 'MYR',
                  ${new Date().toISOString().slice(0, 10)}::date, 'current', 5, 5)`;
        await tx`
          insert into app.item_profitability
            (tenant_id, company_id, item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base)
          values (${victim.tenant}, ${victim.company}, ${itemId}, ${victim.period}, 1, 5, 2, 3)`;
      });
      void attacker;
    },
    async survivors(db, victim) {
      const [row] = await withTenant(
        db.rw,
        ctxFor(victim, "probe-survivors"),
        (tx) => tx<{ n: number }[]>`
          select (select count(*)::int from app.party_ageing where amount <> 0 or base_amount <> 0)
               + (select count(*)::int from app.item_profitability
                   where quantity_sold <> 0 or revenue_base <> 0 or cogs_base <> 0 or margin_base <> 0)
                 as n`,
      );
      return row!.n;
    },
  },
  "inventory.lot.expiry_warning": {
    async seed(db, attacker, victim) {
      const { itemId } = await seedItem(db, victim, { code: "VICTIM-LOT", trackLots: true });
      const warehouseId = await seedWarehouse(db, victim, { code: "V-CHILL" });
      const lotId = await seedLot(db, victim, { itemId, code: "V-B1", expiresOn: "2026-01-20" });
      await withTenant(
        db.rw,
        ctxFor(victim, "probe-seed"),
        (tx) => tx`
          insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
          values (${victim.tenant}, ${victim.company}, ${itemId}, ${warehouseId}, ${lotId}, 5.000000)`,
      );
      void attacker;
    },
    /** The victim's lot row must still be there after the job ran for the attacker with the victim's ids. */
    async survivors(db, victim) {
      const [row] = await withTenant(
        db.rw,
        ctxFor(victim, "probe-survivors"),
        (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.lot where code = 'V-B1'`,
      );
      return row!.n;
    },
  },
  "admin.idempotency_key.purge": {
    async seed(db, _attacker, victim) {
      await withTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) },
        (tx) =>
          tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, response_code, expires_at) values (${victim.tenant}, ${victim.human}, 'victim-expired', sha256('x'), 200, '2026-01-01T00:00:00Z'::timestamptz)`,
      );
    },
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) },
        async (tx) =>
          (await tx<{ n: number }[]>`select count(*)::int as n from app.idempotency_key`)[0]!.n,
      ),
  },
  "accounting.period.month_end": {
    // Nothing to seed: seedTenant's open 2026-01 period is overdue at any asOf after January, so a run for
    // the attacker writes a month_end_ready row for the ATTACKER's period. The survivor count is the
    // victim's audit_log, which must gain no such row.
    seed: () => Promise.resolve(),
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) },
        async (tx) =>
          (await tx<{ n: number }[]>`select count(*)::int as n from app.audit_log`)[0]!.n,
      ),
  },
  "reporting.render": {
    // The victim owns a definition and a QUEUED run; the attacker's job is handed the victim's run id (7A T11).
    // `claimReportRun` runs under the attacker's tenant, where RLS hides the row, so the claim returns null
    // and the handler stops before it reads, renders or stores anything. The attacker owns a definition too,
    // so nothing about its own tenant makes the run fail for a different reason.
    async seed(db, attacker, victim) {
      await seedReportDefinition(db, attacker, {
        code: "accounting.trial_balance",
        definition: RENDER_PROBE_DEFINITION,
      });
      const definitionId = await seedReportDefinition(db, victim, {
        code: "accounting.trial_balance",
        definition: RENDER_PROBE_DEFINITION,
      });
      const run = await withTenant(db.rw, ctxFor(victim, await uuidv7(db.admin)), (tx) =>
        createReportRun(tx, {
          companyId: victim.company,
          reportDefinitionId: definitionId,
          parameters: {},
          format: "csv",
          lang: "en",
        }),
      );
      victimReportRuns.set(victim.tenant, run.id);
    },
    payload: (_db, _attacker, victim) =>
      Promise.resolve({ runId: victimReportRuns.get(victim.tenant)! }),
    // Still queued, and no status move audited: a leaked claim would write `running` and an audit row.
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        ctxFor(victim, await uuidv7(db.admin)),
        async (tx) =>
          (
            await tx<{ n: number }[]>`
              select ((select count(*) from app.report_run where status = 'queued')
                    + (select count(*) from app.audit_log where table_name = 'report_run'))::int as n`
          )[0]!.n,
      ),
  },
  "admin.import.run": {
    // 9B T9. The victim owns a QUEUED import run and the attacker's job is handed its id and company. The claim runs
    // under the attacker's tenant, where RLS hides the row, so it returns null, the lease read finds nothing, and the
    // handler stops before it opens the legacy source or writes a row. The attacker owns a queued run of its own, so
    // nothing about its tenant makes the run stop for a different reason.
    async seed(db, attacker, victim) {
      await seedOwnerImportRun(db, attacker);
      await seedOwnerImportRun(db, victim);
    },
    payload: async (db, _attacker, victim) => ({
      companyId: victim.company,
      runId: await seedOwnerImportRun(db, victim),
      cutOverDate: "2026-01-31",
      dryRun: true,
    }),
    // Still queued, and no status move audited: a leaked claim would write `running` and an update row.
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        ctxFor(victim, await uuidv7(db.admin)),
        async (tx) =>
          (
            await tx<{ n: number }[]>`
              select ((select count(*) from app.import_run where status = 'queued')
                    + (select count(*) from app.audit_log
                        where table_name = 'import_run' and action = 'update'))::int as n`
          )[0]!.n,
      ),
  },
  "admin.export.run": {
    // The victim owns a QUEUED export job and the attacker's job is handed its id (7C T8, ADR 0070). The claim
    // runs under the attacker's tenant, where RLS hides the row, so it returns null and the handler stops
    // before it reads a table or writes an object. The attacker owns a queued job of its own, so nothing
    // about its tenant makes the run stop for a different reason.
    async seed(db, attacker, victim) {
      await seedExportJob(db, attacker);
      victimExportJobs.set(victim.tenant, await seedExportJob(db, victim));
    },
    payload: (_db, _attacker, victim) =>
      Promise.resolve({ exportJobId: victimExportJobs.get(victim.tenant)! }),
    // Still queued, and no status move audited: a leaked claim would write `running` and an update row.
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        ctxFor(victim, await uuidv7(db.admin)),
        async (tx) =>
          (
            await tx<{ n: number }[]>`
              select ((select count(*) from app.export_job where status = 'queued')
                    + (select count(*) from app.audit_log
                        where table_name = 'export_job' and action = 'update'))::int as n`
          )[0]!.n,
      ),
  },
  "accounting.ledger.integrity_check": {
    async seed(db, _attacker, victim) {
      await withTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) },
        (tx) => tx`update app.company set name = 'Victim HQ' where id = ${victim.company}`,
      );
    },
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.human, requestId: await uuidv7(db.admin) },
        async (tx) =>
          (await tx<{ n: number }[]>`select count(*)::int as n from app.audit_log`)[0]!.n,
      ),
  },
  "hr.rate_table.lapse_warning": {
    // The victim owns a verified table lapsing inside the horizon; the attacker's run is handed the victim's company
    // id. RLS keeps the read to the attacker's tenant, which has a scheme and nothing lapsing, so no warning is
    // written anywhere — and above all no sentinel row lands in the victim's audit chain.
    async seed(db, attacker, victim) {
      const scheme = await seedStatutoryScheme(db, victim, { code: "VICTIM" });
      await seedRateTable(db, victim, {
        schemeId: scheme,
        verified: true,
        definition: {
          ...SYNTH_RATE_TABLE_V1,
          effective_from: "2026-01-01",
          effective_to: "2026-12-31",
        },
      });
      await seedStatutoryScheme(db, attacker, { code: "ATTACKER" });
    },
    payload: (_db, _attacker, victim) =>
      Promise.resolve({ companyId: victim.company, asOf: "2026-11-15" }),
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        ctxFor(victim, await uuidv7(db.admin)),
        async (tx) =>
          (
            await tx<{ n: number }[]>`
              select ((select count(*) from app.statutory_rate_table)
                    + (select count(*) from app.audit_log
                        where table_name = 'rate_table_lapse_warning'))::int as n`
          )[0]!.n,
      ),
  },
  "hr.employee_ytd.rebuild": {
    // Both tenants hold an `employee_ytd` row no posted run produces — drift a run of the job reports. The attacker's
    // own run sees its drift and writes its sentinel into ITS chain; the victim's projection row and audit chain are
    // untouched (RLS bounds the rebuild, the projection and app.record_system_event to the envelope's tenant). The rows
    // are fault injection through the admin connection: only the posting service may write the table (spec:98).
    async seed(db, attacker, victim) {
      for (const owner of [attacker, victim]) {
        const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-YTD" });
        await db.admin`
          insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year, gross, net)
          values (${owner.tenant}, ${owner.company}, ${employeeId}, 2026, 100.0000, 90.0000)`;
      }
    },
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        ctxFor(victim, await uuidv7(db.admin)),
        async (tx) =>
          (
            await tx<{ n: number }[]>`
              select ((select count(*) from app.employee_ytd where gross = 100.0000)
                    + (select count(*) from app.audit_log
                        where table_name = 'employee_ytd_drift'))::int as n`
          )[0]!.n,
      ),
  },
  "hr.encryption_key.rotate": {
    // Both tenants hold an employee_sensitive row sealed under v1. The attacker's run (under a v2 ring) re-seals ITS
    // row; the victim's row must survive at key_version 1 with its v1 envelope byte — RLS bounds the job's read and
    // update to the envelope's tenant. Written and read as each tenant's SYSTEM principal: sensitive_gate admits it,
    // and the harness grants the seeded humans nothing.
    async seed(db, attacker, victim) {
      for (const owner of [attacker, victim]) {
        const employeeId = await seedEmployee(db, owner, { employeeNumber: "PROBE-ROTATE" });
        await withTenant(
          db.rw,
          { tenantId: owner.tenant, actorId: owner.system, requestId: await uuidv7(db.admin) },
          (tx) => writeSensitive(tx, PROBE_RING_V1, employeeId, { national_id: "SYNTH-PROBE" }),
        );
      }
    },
    // The worker's ring is module state composed at boot (8D A12); the probe injects the v2 ring the way the job's own
    // test does, immediately before the attacker's run. No other job reads it.
    async payload() {
      setHrKeyRing(PROBE_RING_V2);
      return { batchSize: 1 };
    },
    survivors: async (db, victim) =>
      withTenant(
        db.rw,
        { tenantId: victim.tenant, actorId: victim.system, requestId: await uuidv7(db.admin) },
        async (tx) =>
          (
            await tx<{ n: number }[]>`
              select count(*)::int as n from app.employee_sensitive
               where key_version = 1 and get_byte(national_id_enc, 0) = 1`
          )[0]!.n,
      ),
  },
};
