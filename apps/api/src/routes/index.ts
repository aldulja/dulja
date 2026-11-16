import { shiftRouteModule } from "./pos/shifts";
import { employeeRouteModule } from "./hr/employees";
import { composeEmployeeRouter } from "./hr/employees-composed";
import { payComponentRouteModule } from "./hr/pay-components";
import { payrollAccountRouteModule } from "./hr/payroll-accounts";
import { statutorySchemeRouteModule } from "./hr/statutory-schemes";
import { hrSettingRouteModule } from "./hr/hr-settings";
import { payrollRunRouteModule } from "./hr/payroll-runs";
import { createPayslipRoutes } from "./hr/payslips";
import { payrollPaymentRouteModule } from "./hr/payroll-payments";
import { employeeAdvanceRouteModule } from "./hr/employee-advances";
import { statutoryScheduleRouteModule } from "./hr/statutory-schedules";
import { cashierRouteModule } from "./pos/cashiers";
import { attendanceEventRouteModule } from "./hr/attendance-events";
import { leaveRouteModule } from "./hr/leave";
import { ticketRoutes } from "./sync/tickets";
import { needsAttentionRoutes } from "./pos/needs-attention";
import { catalogueRoutes } from "./sync/catalogue";
import { terminalRoutes } from "./admin/terminals";
import { enrolmentRoutes } from "./sync/enrolments";
import { branchPosPolicyRouteModule } from "./pos/branch-pos-policies";
import { staffContextRouteModule } from "./staff-context";
import { meRouteModule } from "./me";
import { OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSION, type PermissionCode } from "@dulja/contracts/permissions";
import {
  createHrKeyRing,
  DEV_HR_KEY,
  MemoryObjectStore,
  type HrKeyRing,
  type ObjectStore,
} from "@dulja/db";
import type { AppEnv } from "../context";
import { healthRoutes } from "./health";
import { sessionRoutes } from "./session";
import type { AuthAdmin } from "../ports";
import { StubAuthAdmin } from "../auth-admin";
import { createUserRoutes } from "./admin/users";
import { roleRoutes } from "./admin/roles";
import { roleAssignmentRoutes } from "./admin/role-assignments";
import { auditLogRoutes } from "./admin/audit-log";
import { companyRoutes } from "./companies";
import { currenciesRoutes } from "./admin/currencies";
import { exchangeRatesRoutes } from "./admin/exchange-rates";
import { dimensionTypesRoutes } from "./admin/dimension-types";
import { customFieldDefinitionsRoutes, customFieldValuesRoutes } from "./admin/custom-fields";
import { accountRoutes } from "./accounting/accounts";
import { fiscalPeriodRoutes, fiscalYearRoutes } from "./accounting/fiscal-periods";
import { DOCUMENT_STAGE_CODES, documentRoutes } from "./accounting/documents";
import { partyRoutes } from "./accounting/parties";
import { paymentTermRouteModule } from "./accounting/payment-terms";
import { reportDefinitionRouteModule } from "./accounting/report-definitions";
import { savedViewRouteModule } from "./accounting/saved-views";
import { bankStatementRouteModule } from "./accounting/bank-statements";
import { ATTACHMENTS_PATH, createAttachmentRoutes } from "./accounting/attachments";
import { PRINT_TEMPLATES_PATH, printTemplateRoutes } from "./accounting/print-templates";
import { documentTypeRoutes } from "./admin/document-types";
import { ledgerRoutes } from "./accounting/ledger";
import { reportsRouteModule } from "./accounting/reports";
import {
  createReportRunRoutes,
  REPORT_RUN_PERMISSIONS,
  REPORT_RUN_ROUTE_PATH,
} from "./accounting/report-runs";
import { itemRoutes } from "./inventory/items";
import { unitRoutes } from "./inventory/units";
import { warehouseRoutes } from "./inventory/warehouses";
import { priceListRoutes } from "./inventory/price-lists";
import { promotionRoutes } from "./inventory/promotions";
import { stockRoutes } from "./inventory/stock";
import { valuationRouteModule } from "./inventory/valuation";
import {
  EINVOICE_PERMISSION,
  einvoiceTransmissionRouteModule,
} from "./accounting/einvoice-transmissions";
import { taxCodeRouteModule } from "./accounting/tax-codes";
import { taxReturnRouteModule } from "./accounting/tax-returns";
import { exportRouteModule } from "./admin/exports";
import { importRouteModule } from "./admin/import";
import { jobStatusRouteModule } from "./admin/job-status";
export { IdempotencyHeader } from "./idempotency-header";
export interface RouteModule {
  readonly path: string;
  readonly router: OpenAPIHono<AppEnv>;
  readonly permissions: readonly PermissionCode[];
  readonly auth: "human" | "terminal" | "public";
}
/** 8B's payroll-run router plus 8D's payslip sub-router, composed once at `buildRoutes` time — 8A's
 *  `composeEmployeeRouter` shape: 8B's `payrollRunRoutes` const is left untouched and the payslip routes, a factory
 *  over the object store, are mounted beside it on a fresh router. */
function composePayrollRunRouter(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();
  routes.route("/", payrollRunRouteModule.router);
  routes.route("/", createPayslipRoutes(objectStore));
  return routes;
}

export function buildRoutes(deps: {
  authAdmin: AuthAdmin;
  objectStore: ObjectStore;
  /** 8A (amendment A8) — the HR field-encryption key ring the employee sub-resources seal and open with. */
  hrKeys: HrKeyRing;
}): readonly RouteModule[] {
  return [
    {
      path: "/v1/sync/tickets",
      router: ticketRoutes,
      permissions: [PERMISSION["pos.sync.push"]],
      auth: "terminal",
    },
    {
      path: "/v1/companies/:companyId/needs-attention",
      router: needsAttentionRoutes,
      permissions: [PERMISSION["pos.needs_attention.resolve"]],
      auth: "human",
    },
    // apps/api/src/routes/index.ts — inside buildRoutes(deps), in the returned array.
    {
      path: "/v1/admin/terminals",
      router: terminalRoutes,
      permissions: [PERMISSION["admin.terminal.manage"]],
      auth: "human",
    },
    { path: "/v1/sync/enrol", router: enrolmentRoutes, permissions: [], auth: "public" },
    // The till's signed catalogue pull (6A). Without its own module the path has no owner, `authMode` falls
    // back to "human" and a till's signature is refused as a missing session.
    {
      path: "/v1/sync/catalogue",
      router: catalogueRoutes,
      permissions: [PERMISSION["pos.sync.pull"]],
      auth: "terminal",
    },
    // 6C: the staff directory, cashier, attendance and branch policy modules and the staff screens' context.
    // 8A T4 (amendment A16, 6C-FIRST): 6C's employees module spread and widened with 8A's sub-resources. Its
    // `path` is unchanged, so PROBES gains nothing (PROBES is keyed by RouteModule.path — hazard 31).
    {
      ...employeeRouteModule,
      router: composeEmployeeRouter(deps.hrKeys),
      permissions: [
        ...employeeRouteModule.permissions,
        PERMISSION["hr.employee.read_sensitive"],
        PERMISSION["hr.compensation.read"],
        PERMISSION["hr.compensation.manage"],
      ],
    },
    // 8A T7 (amendment A7): the pay-component catalogue — one new module, one PROBES key.
    payComponentRouteModule,
    // ADR 0097 (full review PRD-08): the route form of `seed:payroll-accounts`.
    payrollAccountRouteModule,
    // 8A T10 (amendment A7): statutory schemes, the break-glass rate-table load and its verification.
    statutorySchemeRouteModule,
    // 8A T11 (⚠️ OD-23): company HR settings, under admin.company.manage (§3.6.2 — no seventh code).
    hrSettingRouteModule,
    // 8B T10: payroll runs — calculate, recalculate, read, list. Submit/approve/post are 2B's transitions route.
    // 8D T5 (amendment A4): the payslip sub-path `POST …/{documentId}/payslips` composed onto the SAME module — its
    // `path` is unchanged, so PROBES gains nothing (hazard 31) — and the module's permissions gain the route's code,
    // hr.filing.generate (§3.6.2; it closes LEGACY-047's unrouted catalogue code, round 19 A13 item 8).
    {
      ...payrollRunRouteModule,
      router: composePayrollRunRouter(deps.objectStore),
      permissions: [...payrollRunRouteModule.permissions, PERMISSION["hr.filing.generate"]],
    },
    // 8C T6 (round 18 B10): money out — the payroll payment batch and the employee advance, two modules, two PROBES
    // keys. Submit/approve/post are 2B's transitions route under accounting.payment.approve / .post.
    payrollPaymentRouteModule,
    employeeAdvanceRouteModule,
    // 8C T7 (round 18 B10): statutory schedules — a factory over the store, as 2C's attachments and 7C's exports are.
    statutoryScheduleRouteModule(deps.objectStore),
    // 8D T8 (⚠️ OD-13 answered build, round 19 A14): the leave register — one new module, one PROBES key (hazard 31).
    leaveRouteModule,
    cashierRouteModule(deps.authAdmin),
    attendanceEventRouteModule,
    branchPosPolicyRouteModule,
    staffContextRouteModule,
    // 2026-11-15 review UI-03/UI-11 (ADR 0089): the membership-scoped company and branch selector.
    meRouteModule,

    { path: "/healthz", router: healthRoutes, permissions: [], auth: "public" },
    { path: "/v1/session", router: sessionRoutes, permissions: [], auth: "human" },
    {
      path: "/v1/admin/users",
      router: createUserRoutes(deps.authAdmin),
      permissions: ["admin.user.manage"],
      auth: "human",
    },
    {
      path: "/v1/admin/roles",
      router: roleRoutes,
      permissions: ["admin.role.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/role-assignments",
      router: roleAssignmentRoutes,
      permissions: ["admin.role.assign"],
      auth: "human",
    },
    {
      path: "/v1/companies",
      router: companyRoutes,
      permissions: ["admin.company.manage", EINVOICE_PERMISSION.file],
      auth: "human",
    },
    {
      path: "/v1/admin/audit-log",
      router: auditLogRoutes,
      permissions: ["admin.audit_log.read"],
      auth: "human",
    },
    {
      path: "/v1/admin/currencies",
      router: currenciesRoutes,
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/exchange-rates",
      router: exchangeRatesRoutes,
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/dimension-types",
      router: dimensionTypesRoutes,
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/custom-field-definitions",
      router: customFieldDefinitionsRoutes,
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/custom-fields",
      router: customFieldValuesRoutes,
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/accounts",
      router: accountRoutes,
      permissions: ["accounting.account.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/fiscal-periods",
      router: fiscalPeriodRoutes,
      permissions: ["accounting.period.close", "accounting.period.reopen"],
      auth: "human",
    },
    // ADR 0097 (full review PRD-05): creating a fiscal year, under the period lifecycle's close code.
    {
      path: "/v1/companies/:companyId/fiscal-years",
      router: fiscalYearRoutes,
      permissions: ["accounting.period.close"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/documents",
      router: documentRoutes,
      // 2A, contracts §4.5.4: the codes a document route may evaluate are resolved from the effective
      // policy, so the module declares the explicit union every type-seeding slice appends to. 2B adds the
      // two static gates its routes carry; DOCUMENT_STAGE_CODES itself stays "codes a policy may name".
      permissions: [
        ...DOCUMENT_STAGE_CODES,
        PERMISSION["accounting.document.reverse"], // the reverse route's gate — 2B's catalogue row
        PERMISSION["accounting.ledger.read"], // the events route's module read code
        // The overrides route's gate reads its code from the body (OVERRIDE_CODES in documents.ts), so the
        // catalogued members are declared here; 6A adds pos.ticket.override when it catalogues it.
        PERMISSION["inventory.negative_stock.override"],
        PERMISSION["accounting.credit_limit.override"],
      ],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/ledger-entries",
      router: ledgerRoutes,
      permissions: ["accounting.ledger.read"],
      auth: "human",
    },
    reportsRouteModule,
    // 7A T12 (contracts §4.11.2, ADR 0067): the report-run status resource `POST …/reports/{code}/runs`
    // points at. A factory, because its content route needs the object store.
    {
      path: REPORT_RUN_ROUTE_PATH,
      router: createReportRunRoutes(deps.objectStore),
      permissions: REPORT_RUN_PERMISSIONS,
      auth: "human",
    },
    // 7A T13 (contracts §4.11.2): clone and edit a report without a release, and saved views — archived,
    // never deleted. Definition writes are admin.company.manage; a saved view carries no code (§3.6.1).
    reportDefinitionRouteModule,
    savedViewRouteModule,
    // 7C T6 (contracts §4.2.7, A11/A12): the tenant data export, gated admin.data.export at company scope. A
    // factory, because its download route (T9) needs the object store.
    exportRouteModule(deps.objectStore),
    // 9B T9 (contracts §4.2.7, round 20 C2/C4/C17): the cut-over load's bulk endpoint, under admin.company.manage at
    // company scope, and spec:2206's generic job-status resource — one PROBES key each (hazard 31).
    importRouteModule,
    jobStatusRouteModule,
    taxCodeRouteModule,
    taxReturnRouteModule,
    einvoiceTransmissionRouteModule,
    // 2A (contracts §4.2.7): the two configuration modules through which a tenant adds a document type
    // and its parties without a line of code.
    {
      path: "/v1/companies/:companyId/document-types",
      router: documentTypeRoutes,
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: ATTACHMENTS_PATH,
      router: createAttachmentRoutes(deps.objectStore),
      // 2C, contracts §4.5.8: the upload's gate is resolved from the document's policy, so it cannot be
      // derived from source and DOCUMENT_STAGE_CODES is the explicit union §4.5.4 keeps for exactly this
      // reason; the list and download gates are the owning module's read code. 8B: an `hr` document's
      // attachments are read under the payroll read code (MODULE_READ_CODE's hr row), which no other module
      // gates, so this module declares it.
      permissions: [
        ...DOCUMENT_STAGE_CODES,
        PERMISSION["accounting.ledger.read"],
        PERMISSION["hr.payroll.read"],
      ],
      auth: "human",
    },
    {
      path: PRINT_TEMPLATES_PATH,
      router: printTemplateRoutes,
      // 2C, contracts §3.6.2: print templates are maintained under admin.company.manage.
      permissions: ["admin.company.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/parties",
      router: partyRoutes,
      // 4A T3: `creditLimit` is written only by a holder of the override code — a field-level check inside
      // the POST and PATCH handlers (spec:2158), so the module declares the code it evaluates.
      permissions: ["accounting.party.manage", PERMISSION["accounting.credit_limit.override"]],
      auth: "human",
    },
    // 4A T1 (contracts §4.2.7): payment terms, under accounting.party.manage — spec:2158 gives the clerk who
    // maintains customers and vendors their credit terms too. The one new module 4A mounts.
    paymentTermRouteModule,
    shiftRouteModule,
    // 4B T8 (contracts §4.8.3): bank reconciliation — statement import, match/unmatch and the reconciliation,
    // under accounting.bank.reconcile. The one new module 4B mounts, and so its one PROBES key (hazard 31).
    bankStatementRouteModule,
    // 3A (contracts §3.6.2, assumption 11): the head-office catalogue. Reads take inventory.item.read and
    // every write inventory.item.manage — warehouses, units and unit conversions included, because §3.6.1
    // closes the vocabulary at five inventory codes and spec:2159/2160 give neither `warehouse` nor
    // `branch_manager` any catalogue authority.
    {
      path: "/v1/companies/:companyId/items",
      router: itemRoutes,
      permissions: ["inventory.item.read", "inventory.item.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/units",
      router: unitRoutes,
      permissions: ["inventory.item.read", "inventory.item.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/warehouses",
      router: warehouseRoutes,
      permissions: ["inventory.item.read", "inventory.item.manage"],
      auth: "human",
    },
    // 3A T12: prices and promotions under inventory.price.manage, the stock read under inventory.stock.read.
    // `stock-on-hand` is an ordinary LIST module and deliberately not a ReportCode — inventory.stock_on_hand
    // is 3D's (§4.16.1, hazard 4).
    {
      path: "/v1/companies/:companyId/price-lists",
      router: priceListRoutes,
      permissions: ["inventory.price.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/promotions",
      router: promotionRoutes,
      permissions: ["inventory.price.manage"],
      auth: "human",
    },
    {
      path: "/v1/companies/:companyId/stock-on-hand",
      router: stockRoutes,
      permissions: ["inventory.stock.read"],
      auth: "human",
    },
    // 3B T10 (amendment A8): the valuation read and the open cost layers, under inventory.cost.read. An
    // ordinary list module and NOT §4.16.1's `inventory.valuation` ReportCode, which is 3D's on the
    // `reports` module.
    valuationRouteModule,
  ];
}
export const ROUTES = buildRoutes({
  authAdmin: new StubAuthAdmin(),
  objectStore: new MemoryObjectStore(),
  // ROUTES is enumerated, never served from, so the ring only has to exist: DEV_HR_KEY is legal here for the
  // same reason MemoryObjectStore is, and createApp receives the real ring through AppDeps.
  hrKeys: createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }),
});
