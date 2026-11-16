// The whole cross-slice surface of @dulja/importer (contracts §4.13.1, "What `@dulja/importer` exports", and §4.13.2
// for 9B's loader surface below). Nothing outside those two lists is added.
export { createReader, type LegacyReader } from "./reader";
export type { LegacyPredicate } from "./legacy/predicate";
export type {
  LegacyColumn,
  LegacyColumnKind,
  LegacyConstraint,
  LegacyDriver,
  LegacyRow,
  LegacyScalar,
  SelectSpec,
} from "./legacy/types";
export { FixtureLegacyDriver, type LegacyCorpus } from "./drivers/fixture";
export { connectOdbc, OdbcLegacyDriver, redactDsn, type OdbcOptions } from "./drivers/odbc";
export { scope, DATE_COLUMN_CANDIDATES, type ScopeReport, type TableScope } from "./scope";
export { LEGACY_MODULES, ALL_LEGACY_TABLES, moduleOf, type LegacyModule } from "./legacy/modules";
export { profile, type ProfileOptions, type ProfileReport } from "./profile";
export { ReportWriter, toCsv, type ArtefactEntry, type ArtefactIndex } from "./artefacts";
export { reconcile, RECONCILIATION_KINDS, type ReconciliationReport } from "./reconcile";
export { AGGREGATE_RULES, type AggregateRule, type AggregateConfidence } from "./legacy/aggregates";
export {
  EMPLOYEE_MATCH_STRATEGIES,
  employeeMapping,
  normaliseLegacyName,
  type EmployeeMatchStatus,
  type EmployeeMatchStrategy,
} from "./reconcile/employee-mapping";
export {
  catalogueTemplates,
  classifyTemplate,
  templateStem,
  TEMPLATE_GROUP_RULES,
  type TemplateCatalogue,
  type TemplateEntry,
  type TemplateGroup,
} from "./catalogue/templates";
// 9B — the loader surface (contracts §4.13.2 with round 20's C8, C9, C12–C15, and the 9B plan's N1–N5).
export {
  LoadError,
  type LoadContext,
  type Loader,
  type LoaderReport,
  type LoadErrorCode,
  type LoadReport,
  type LoadResult,
  type RefResolver,
  type SkipRecord,
  type SourceColumn,
} from "./load/types";
export { preflight, type PreflightFinding, type PreflightReport } from "./load/preflight";
export {
  assertImportTarget,
  IMPORT_TARGET_ENV,
  importTargetFromEnv,
  type ImportTarget,
} from "./load/target";
export { refResolver } from "./load/refs";
export {
  ACCOUNT_MAP_TARGETS,
  loaderFor,
  loaders,
  orderLoaders,
  SENSITIVE_TARGETS,
} from "./load/registry";
export {
  baseCurrency,
  cutOverDate,
  EMPTY_TARGET,
  loadSource,
  loadSourceFromEnv,
  READ_BATCH,
  runLoad,
  setLoadSource,
  type LoadSource,
  type LoadSourceFactory,
} from "./load/run";
export {
  dateOf,
  flagOf,
  moneyOf,
  optionalDateOf,
  optionalText,
  payMoneyOf,
  quantityOf,
  rationalOf,
  requireText,
  SENSITIVE_TEXT_LIMIT,
  sensitiveOf,
} from "./load/scalar";
// 9B Task 4 — the master-data loaders and the owner's account map (9B plan N6, N14).
export {
  ACCOUNT_CODE_PATTERN,
  assertAccountMap,
  readAccountMap,
  treatmentOf,
  type AccountMap,
  type AccountMapEntry,
  type AccountTreatment,
} from "./load/account-map";
export { accountLoader, accountMap, clearAccountMap, setAccountMap } from "./load/accounts";
export { itemLoader } from "./load/items";
export { lotLoader } from "./load/lots";
export { partyLoader } from "./load/parties";
export { codeFromName, unitLoader } from "./load/units";
export { warehouseLoader } from "./load/warehouses";
// 9B Task 5 — the one document writer and the trial-balance opening (9B plan N7, N8).
export {
  draftAndPost,
  OPENING_BRANCH_CODE,
  type ImportedDocument,
  type ImportedLine,
} from "./load/document";
export {
  openingBalanceLoader,
  SUSPENSE_CODE,
  type OpeningBalanceTarget,
} from "./load/opening-balance";
// 9B Task 6 — opening stock at a cost recomputed by 3B's engine (9B plan N8, §5.1 #6).
export { OPENING_STOCK_LINES_PER_DOCUMENT, openingStockLoader } from "./load/opening-stock";
// 9B Task 15 — ⚠️ OD-27, Part VII #7 (SAH-022): MatOpens.Job asked of the customer's data before opening stock loads.
export {
  assertNoJobPartition,
  JOB_PARTITIONED_TABLES,
  type JobPartitionFinding,
} from "./load/matopens-guard";
export {
  replayLegacyMovements,
  sortLegacyMovements,
  type LegacyMovement,
  type OpeningPosition,
  type RecostResult,
} from "./load/recost";
// 9B Task 7 — open AR/AP items, one OPENING_BALANCE per open legacy document (9B plan N10, ADR 0085).
export { openItemLoader, type OpenItemTarget } from "./load/open-items";
// 9B Task 8 — the employee master, its sealed fields, and the cut-over YTD opening (9B plan N10, §5.1 #11–#12).
export {
  assertYtdReconciles,
  clearKeyRing,
  employeeLoader,
  employeeYtdOpeningLoader,
  SENSITIVE_SOURCES,
  setKeyRing,
  type EmployeeTarget,
  type EmployeeYtdTarget,
} from "./load/employees";
// 9B Task 13 — ⚠️ OD-16: the historical POS loader, exported and tested but NOT in `loaders` (default: start clean).
export { MPOS_SOURCE_TABLES, mposLoader, type HistoricalTicket } from "./load/mpos";
// 9B Task 10 — the cut-over reconciliation, Phase 9's definition of done computed (9B plan N9, ADR 0086).
export {
  explain,
  reconcileCutOver,
  type Comparison,
  type CutOverReconciliation,
} from "./load/reconcile-cut-over";
