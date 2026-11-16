export { app, tenantTable } from "./tenant";
export { principalTable } from "./principal";
export { membershipTable } from "./membership";
export { companyTable } from "./company";
export { roleTable } from "./role";
export { permissionTable } from "./permission";
export { rolePermissionTable } from "./role-permission";
export { roleAssignmentTable } from "./role-assignment";
export { roleAssignmentBranchTable } from "./role-assignment-branch";
export { dimensionType as dimensionTypeTable } from "./dimension-type";
export { dimensionValue as dimensionValueTable } from "./dimension-value";
export { auditLogTable } from "./audit-log";
export { idempotencyKeyTable } from "./idempotency-key";
export { currency as currencyTable } from "./currency";
export { exchangeRate as exchangeRateTable } from "./exchange-rate";
export { customFieldDefinition as customFieldDefinitionTable } from "./custom-field-definition";
export { customFieldValue as customFieldValueTable } from "./custom-field-value";
export { account as accountTable } from "./account";
export { fiscalPeriod as fiscalPeriodTable } from "./fiscal_period";
export { document as documentTable } from "./document";
export { ledgerEntry as ledgerEntryTable } from "./ledger-entry";
export { documentLine as documentLineTable } from "./document_line";
export { accountBalance as accountBalanceTable } from "./account_balance";
export { party as partyTable } from "./party";
export { documentType as documentTypeTable } from "./document_type";
export { documentEvent as documentEventTable } from "./document-event";
export { attachment as attachmentTable } from "./attachment";
export { printTemplate as printTemplateTable } from "./print-template";
export { unitOfMeasure as unitOfMeasureTable } from "./unit_of_measure";
export { item as itemTable } from "./item";
export { unitConversion as unitConversionTable } from "./unit_conversion";
export { warehouse as warehouseTable } from "./warehouse";
export { lot as lotTable } from "./lot";
export { variant as variantTable } from "./variant";
export { priceList as priceListTable } from "./price_list";
export { priceListLine as priceListLineTable } from "./price_list_line";
export { promotion as promotionTable } from "./promotion";
export { inventoryMovement as inventoryMovementTable } from "./inventory_movement";
export { stockOnHand as stockOnHandTable } from "./stock_on_hand";
export { costLayer as costLayerTable } from "./cost-layer";
export { costConsumption as costConsumptionTable } from "./cost-consumption";
export { costBooking as costBookingTable } from "./cost-booking";
export { stockValuation as stockValuationTable } from "./stock-valuation";
export { documentLink as documentLinkTable } from "./document-link";
// A VIEW, not a table, so it carries no `…Table` suffix and `schema-mirror.test.ts` does not count it:
// Drizzle marks a view with `drizzle:ViewBaseConfig`, never `drizzle:Name` (migration 0037).
export { documentOpenQuantity as documentOpenQuantityView } from "./document-open-quantity";
export { landedCostAllocation as landedCostAllocationTable } from "./landed-cost-allocation";
export { paymentTerm as paymentTermTable } from "./payment-term";
export { allocation as allocationTable } from "./allocation";
export {
  bankStatement as bankStatementTable,
  bankStatementLine as bankStatementLineTable,
} from "./bank-statement";
export { bankMatch as bankMatchTable } from "./bank-match";
export { partyAgeing as partyAgeingTable } from "./party-ageing";
export { itemProfitability as itemProfitabilityTable } from "./item-profitability";

export { taxRegime as taxRegimeTable } from "./tax-regime";
export { taxCode as taxCodeTable } from "./tax-code";
export { taxTransaction as taxTransactionTable } from "./tax-transaction";
export { taxReturn as taxReturnTable } from "./tax-return";

export { einvoiceTransmission as einvoiceTransmissionTable } from "./einvoice-transmission";

export { catalogueTombstone as catalogueTombstoneTable } from "./catalogue-tombstone";
export { terminalEnrolment as terminalEnrolmentTable } from "./terminal-enrolment";
export { terminalRequestGuard as terminalRequestGuardTable } from "./terminal-request-guard";
export { needsAttention as needsAttentionTable } from "./needs-attention";
export { posTerminal as posTerminalTable } from "./pos-terminal";
export { employee as employeeTable } from "./employee";
export { posCashier as posCashierTable } from "./pos-cashier";
export { branchPosPolicy as branchPosPolicyTable } from "./branch-pos-policy";

export { attendanceEventTable } from "./attendance-event";

export { shift as shiftTable } from "./shift";
export { tillEvent as tillEventTable } from "./till-event";
export { tillBankingLink as tillBankingLinkTable } from "./till-banking-link";

export { reportDefinition as reportDefinitionTable } from "./report-definition";
export { savedView as savedViewTable } from "./saved-view";
export { reportRun as reportRunTable } from "./report-run";
export { exportJob as exportJobTable } from "./export-job";

export { employeeSensitive as employeeSensitiveTable } from "./employee-sensitive";
export { employeeStatutoryProfile as employeeStatutoryProfileTable } from "./employee-statutory-profile";
export {
  payComponent as payComponentTable,
  payComponentScheme as payComponentSchemeTable,
} from "./pay-component";
export { compensationLine as compensationLineTable } from "./compensation-line";
export { statutoryScheme as statutorySchemeTable } from "./statutory-scheme";
export { statutoryRateTable as statutoryRateTableTable } from "./statutory-rate-table";
export { companyHrSetting as companyHrSettingTable } from "./company-hr-setting";

export { payrollRun as payrollRunTable } from "./payroll-run";
export { payrollLine as payrollLineTable } from "./payroll-line";
export { statutorySchedule as statutoryScheduleTable } from "./statutory-schedule";
export {
  employeeYtd as employeeYtdTable,
  employeeYtdOpening as employeeYtdOpeningTable,
} from "./employee-ytd";

// 8D Task 8 — ⚠️ OD-13 answered build (migration 0096): the leave register's four read mirrors.
export { leaveType as leaveTypeTable } from "./leave-type";
export { leaveEntitlement as leaveEntitlementTable } from "./leave-entitlement";
export { leaveRecord as leaveRecordTable } from "./leave-record";
export { publicHoliday as publicHolidayTable } from "./public-holiday";

// 9B Task 2 (migration 0102, contracts round 20 C7): the Phase 9 load's idempotence ledger.
export { importBatch as importBatchTable } from "./import-batch";
// 9B Task 9 (migration 0103, contracts round 20 C17): the record of one cut-over load started through the API.
export { importRun as importRunTable } from "./import-run";
