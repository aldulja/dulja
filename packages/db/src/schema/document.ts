import {
  bigint,
  boolean,
  char,
  date,
  index,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** The document header (0001 §6), plus the Phase 1 posting_seq of contracts §4.3.5. */
export const document = app.table(
  "document",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentTypeId: uuid("document_type_id").notNull(),
    postingPolicyId: uuid("posting_policy_id"),
    status: text("status").notNull(),
    series: text("series").notNull(),
    fiscalPeriodId: uuid("fiscal_period_id"),
    number: bigint("number", { mode: "bigint" }),
    effectiveDate: date("effective_date").notNull(),
    partyId: uuid("party_id"),
    taxInclusive: boolean("tax_inclusive").notNull().default(false),
    currency: char("currency", { length: 3 }).notNull(),
    exchangeRate: numeric("exchange_rate", { precision: 19, scale: 8 }).notNull(),
    rateSource: text("rate_source"),
    reversesDocumentId: uuid("reverses_document_id"),
    clientRef: uuid("client_ref"),
    terminalId: uuid("terminal_id"),
    shiftId: uuid("shift_id"),
    branchId: uuid("branch_id").notNull(),
    attributedTo: uuid("attributed_to"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    postedBy: uuid("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    // 1A, contracts §4.3.5 — set once at post, unique per company, gaps immaterial.
    postingSeq: bigint("posting_seq", { mode: "bigint" }),
    // 2C, migration 0027 (contracts §4.3.4) — the expand half; nullable, no default (ADR 0033).
    notes: text("notes"),
    // 3A, migration 0031 (contracts §4.3.4's 3A header row) — the header default; a line's own
    // warehouse_id overrides it, and to_warehouse_id is the transfer destination 3D's TRANSFER reads.
    warehouseId: uuid("warehouse_id"),
    toWarehouseId: uuid("to_warehouse_id"),
    // 4A, migration 0045 (contracts §4.3.4) — the payment term PINNED at draft from the party and never
    // re-read (LEGACY-013). The due date is derived (app.payment_due_date) and has no column.
    paymentTermId: uuid("payment_term_id"),
    // 9B, migration 0101 (contracts §4.13.3) — the legacy number as a string (LEGACY-051); never `number`.
    legacyRef: text("legacy_ref"),
  },
  (table) => [
    unique("document_company_id_posting_seq_key").on(table.companyId, table.postingSeq),
    // 1B, migration 0016 (LEGACY-070) — the accounting.ledger report's document join and the fiscal-period
    // screen's per-period counts filter (company_id, fiscal_period_id[, status]); the unique above puts
    // `series` between the two filtered columns.
    index("document_company_period_status_idx").on(
      table.companyId,
      table.fiscalPeriodId,
      table.status,
    ),
    // 7B, migration 0077 (LEGACY-070) — the registers' required date range, their type cut and their branch
    // cut, each seekable after `company_id`.
    index("document_company_date_idx").on(table.companyId, table.effectiveDate),
    index("document_company_type_date_idx").on(
      table.companyId,
      table.documentTypeId,
      table.effectiveDate,
    ),
    index("document_company_branch_date_idx").on(
      table.companyId,
      table.branchId,
      table.effectiveDate,
    ),
    // 0077, 7C's filters — accounting.party_statement's required party, then its date range.
    index("document_company_party_date_idx").on(
      table.companyId,
      table.partyId,
      table.effectiveDate,
    ),
    // 9B, migration 0101 — `where legacy_ref is not null` lives in the migration only (`item_barcode_idx`'s reason).
    index("document_legacy_ref_idx").on(table.companyId, table.legacyRef),
  ],
);
