export { discover, down, listApplied, up, type Migration } from "./migrate";
export { listStaffContext, type StaffContextRow } from "./staff/context";
export { AUDIT_EXEMPT, IMMUTABLE, lintSchema, type Violation } from "./lint-schema";
export {
  resolvePrincipal,
  systemContext,
  TenantContextError,
  withTenant,
  type ResolvedPrincipal,
  type TenantContext,
} from "./with-tenant";
export * as schema from "./schema";
export {
  createJobClient,
  JobNotInsertedError,
  JOB_NAMES,
  JOBS,
  queuePolicy,
  startEnqueueClient,
  STATELY_JOBS,
  type EnqueueOptions,
  type JobClient,
  type JobEnvelope,
  type JobName,
  type JobPayload,
  type QueuePolicy,
} from "./jobs/enqueue";
export { eachTenant } from "./jobs/tenants";
// Phase 7 second review, finding 7 — the leased-row machinery `report_run` and `export_job` share.
export {
  FAILURE_DETAIL_MAX,
  claimLeased,
  LEASE_FOLLOW_UP_MARGIN_SECONDS,
  leaseFence,
  leaseFollowUpKey,
  leaseFollowUpOptions,
  leaseJobOptions,
  leaseState,
  renewLeased,
  type Lease,
  type LeaseJobOptions,
  type LeaseRenewal,
  type LeaseState,
} from "./jobs/lease";
export { createDb, PoolerUrlError, type DbOptions } from "./client";
export { chainHashExpression, verifyChain, type ChainResult } from "./audit/verify-chain";
export {
  checkAccountBalanceProjection,
  checkAuditChain,
  checkEmployeeYtdProjection,
  checkLedgerBalance,
  checkStockOnHandProjection,
  COST_LAYER_CHECK,
  EMPLOYEE_YTD_CHECK,
  listPeriodReopens,
  projectionChecks,
  recordIntegrityIncident,
  registerProjectionCheck,
  runIntegrityCheck,
  SERIES_GAP_CHECK,
  STOCK_ON_HAND_CHECK,
  type AuditChainResult,
  type EmployeeYtdCheckOptions,
  type IntegrityCheckOptions,
  type IntegrityReport,
  type LedgerBalanceOptions,
  type LedgerImbalance,
  type PeriodReopen,
  type PeriodReopenOptions,
  type ProjectionCheck,
  type ProjectionMismatch,
} from "./integrity";
export {
  listPeriodsAwaitingClose,
  recordMonthEndReady,
  type MonthEndReady,
  type PeriodAwaitingClose,
} from "./periods/month-end";
export {
  createFiscalYear,
  FiscalYearOverlapError,
  fiscalYearBounds,
  fiscalYearStartMonth,
  type FiscalYearResult,
  type PeriodBounds,
} from "./periods/fiscal-year";
export {
  trialBalance,
  trialBalanceFingerprint,
  type AccountType,
  type TrialBalanceParams,
  type TrialBalanceRow,
} from "./reports/trial-balance";
export {
  accountLedger,
  accountOpeningBalance,
  type LedgerParams,
  type LedgerRow,
} from "./reports/ledger";
// 3D T10 — the inventory half of spec:2300's minimal report set, beside 1B's two. Every name carries
// `Report` because 3A's `StockOnHandRow` already leaves this barrel from `./inventory/stock` and one name
// may leave it through exactly one module (TS2308).
export {
  stockOnHand,
  stockOnHandTotals,
  type StockOnHandReportParams,
  type StockOnHandReportRow,
} from "./reports/stock-on-hand";
export { salesByItem, type SalesByItemParams, type SalesByItemRow } from "./reports/sales-by-item";
// 4B T3 — the `accounting.ageing` read (§4.16.3); `./ar-ap` below already carries the ageing projection.
export { agedBalance, type AgedBalanceParams, type AgedBalanceRow } from "./reports/ageing";
// 7A T5 — the report engine's own barrel (the dataset registry and its seam). 1B's, 3D's and 4B's report
// readers above keep their direct exports: 7B re-expresses them over exactly those import paths.
export * from "./reports";
export { rateFor } from "./rates/rate-for";
export { currency as currencyTable } from "./schema/currency";
export { exchangeRate as exchangeRateTable } from "./schema/exchange-rate";
export {
  createDimensionType,
  createDimensionValue,
  listDimensionTypes,
  listDimensionValues,
  type CreateDimensionTypeInput,
  type CreateDimensionValueInput,
  type DimensionTypeRow,
  type DimensionValueRow,
} from "./dimensions/service";
export { dimensionType as dimensionTypeTable } from "./schema/dimension-type";
export { dimensionValue as dimensionValueTable } from "./schema/dimension-value";
export {
  createDefinition,
  getValues,
  listDefinitions,
  setValues,
  type CreateDefinitionInput,
  type CustomFieldDefinitionRow,
  type CustomFieldEntity,
  type CustomFieldValueRow,
  type SetValuesResult,
} from "./custom-fields/service";
export { customFieldDefinition as customFieldDefinitionTable } from "./schema/custom-field-definition";
export { customFieldValue as customFieldValueTable } from "./schema/custom-field-value";
export { whoCan, type PrincipalWithPermission } from "./rbac/who-can";
export {
  incompatiblePairsIn,
  isCeilingExempt,
  missingAtTenantScope,
  missingCeilingAtTenantScope,
  missingCeilingForAssignment,
} from "./rbac/role-ceiling";
export * from "./posting";
export {
  allocateLandedCost,
  allocateLandedCostForDocument,
  applyMovements,
  invalidateFrom,
  landedCostByLine,
  LandedCostError,
  landedCostSummary,
  listLandedCost,
  loadSentinelLots,
  lockStockKeys,
  mergeStockOnHand,
  MOVEMENTS_PER_BATCH,
  openLayersFor,
  openLayersOf,
  rebuildStockValuation,
  receiptValue,
  replay,
  VALUATION_PAGE,
  valuationAsOf,
  type AllocateLandedCostInput,
  type AllocationShare,
  type AllocationTarget,
  type CostLayerRow,
  type LandedCostMethod,
  type LandedCostRow,
  type LandedCostSummaryRow,
  type OpenLayersParams,
  type StockKey,
  type StockValuationRebuildResult,
  type ValuationParams,
  type ValuationRow,
} from "./costing";
export {
  MemoryObjectStore,
  ObjectKeyError,
  R2ObjectStore,
  objectKeyFor,
  type ObjectStore,
  type R2ObjectStoreOptions,
  type StoredObject,
} from "./attachment/object-store";
export {
  AttachmentIntegrityError,
  MAX_ATTACHMENT_BYTES,
  createAttachment,
  getAttachment,
  insertAttachment,
  listAttachments,
  readAttachmentContent,
  stageAttachment,
  type AttachmentRow,
  type DocumentTypeModule,
  type NewAttachment,
  type StagedAttachment,
} from "./attachment";
export * from "./print";
export {
  ITEM_ACCOUNT_DEFAULTS,
  archiveItem,
  createItem,
  getItem,
  listItems,
  resolveItemAccounts,
  updateItem,
  type ItemAccountOverrides,
  type ItemAccounts,
  type ItemKind,
  type ItemRow,
  type NewItem,
} from "./inventory/items";
// `UnitConversionMissingError` is deliberately NOT on this line: Task 1 exports it from
// `./inventory/errors` below, and one name may leave the barrel through exactly one module (TS2308).
export {
  convertToBase,
  createUnit,
  listUnitConversions,
  listUnits,
  replaceUnitConversions,
  resolveUnitConversion,
  type UnitConversionRow,
  type UnitRow,
} from "./inventory/units";
export { ItemAccountUnresolvedError, UnitConversionMissingError } from "./inventory/errors";
export {
  archiveWarehouse,
  createWarehouse,
  getWarehouse,
  listWarehouses,
  updateWarehouse,
  warehouseTree,
  type WarehouseKind,
  type WarehouseNode,
  type WarehouseRow,
} from "./inventory/warehouses";
export {
  SENTINEL_LOT_CODE,
  createLot,
  listLots,
  pickLotsFefo,
  sentinelLotId,
  type FefoPick,
  type LotRow,
} from "./inventory/lots";
export {
  EXPIRY_HORIZON_DAYS,
  listNearExpiryLots,
  recordExpiryWarning,
  type NearExpiryLot,
} from "./inventory/expiry";
export {
  archivePriceList,
  createPriceList,
  getPriceList,
  listPriceListLines,
  listPriceLists,
  replacePriceListLines,
  resolvePrice,
  updatePriceList,
  type PriceListLineInput,
  type PriceListLineRow,
  type PriceListRow,
  type PriceQuery,
  type ResolvedPrice,
} from "./inventory/prices";
export {
  createPromotion,
  listPromotions,
  updatePromotion,
  type PromotionKind,
  type PromotionRow,
} from "./inventory/promotions";
export { listStockOnHand, type StockOnHandRow } from "./inventory/stock";
// 3C T4 — the fulfilment seam. `linkFulfilment` writes `app.document_link`; `openQuantity` reads the
// derived `app.document_open_quantity` view (migration 0037). Neither is a protected posting table
// (contracts §4.3.2), so both are written and read by their routes rather than by the posting service.
export {
  linkFulfilment,
  listLinks,
  openQuantity,
  type DocumentLinkRow,
  type FulfilmentLineInput,
  type LinkFulfilmentInput,
  type LinkKind,
  type OpenQuantityRow,
} from "./documents/link";
// 3D T5 — this slice's inventory services, collected behind `./inventory/index.ts` so one line covers the
// slice. It re-exports only 3D's own modules; 3A's eight inventory modules stay individually exported
// above, because one name may leave this barrel through exactly one module (TS2308).
export * from "./inventory";
// 4A T1 — the AR/AP services behind `./ar-ap/index.ts`, one line for the slice (payment terms first; the
// invoice, credit-note, settlement and allocation modules join that barrel in later tasks).
export * from "./ar-ap";
// 4B T4 — `item_profitability` (contracts §4.6.1, amendment 6): the read, the MERGE-and-zero rebuild, the
// compare and ITEM_PROFITABILITY_CHECK, which `./integrity` registers in 1B's projectionChecks.
export * from "./projections";

export * from "./tax";

export * from "./einvoice";

export * from "./sync";
export * from "./staff/branch-pos-policy";

export * from "./staff/attendance";

export * from "./staff/cashier";

export * from "./staff/employee";

export { lockTenantAuditSerial } from "./costing/invalidate";

export * from "./staff/pin";

export * from "./sync/limits";
export * from "./sync/batch-queue";

export * from "./schema/shift";
export * from "./schema/till-event";
export * from "./schema/till-banking-link";

export * from "./posting/till";

export * from "./reports/pos";

// 7C T5 — the tenant data export's job store (spec:2186, contracts §4.6.1).
export * from "./export";
export * from "./hr";

// 8B T1 — the payroll run's two 1:1 extension tables (migration 0087, §4.12.6). Read mirrors only.
export { payrollRun } from "./schema/payroll-run";
export { payrollLine } from "./schema/payroll-line";
// 8C T1 — the statutory schedule (migration 0091, §4.6.1, round 18 B11). Read mirror only.
export { statutorySchedule } from "./schema/statutory-schedule";
// 8C T2 — the YTD projection and its cut-over openings (migration 0092, §4.12.8). Read mirrors only.
export { employeeYtd, employeeYtdOpening } from "./schema/employee-ytd";
// 9B T2 — the import_batch service (migration 0102, contracts §4.13.3, round 20 C7 and C16 item 9).
export * from "./import";
