import { date, index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.8.1 — which settlement paid which invoice (4A, migration 0046; spec:1042). Reads only: every
 * write goes through `allocateSettlement` / `unallocate` in packages/db/src/ar-ap/allocation.ts, and neither
 * writes a ledger row — the settlement's own posting relieved the control account (spec:2457).
 *
 * `amount` is in the SETTLED document's currency, `settlement_amount` in the SETTLEMENT's (4B — equal to
 * `amount` on a same-currency row); `base_amount` and `fx_difference` are in the company's base currency.
 * The four CHECKs (`allocation_amount_check`, `allocation_settlement_amount_check`,
 * `allocation_distinct_check`, `allocation_unallocated_on_check`) live in the migration only: Drizzle spells
 * a table CHECK with its `sql` tag, which `no-bare-db` refuses outside a `tx`. The two indexes are PARTIAL
 * (`where unallocated_at is null`) in the migration; the mirror names their columns.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const allocation = app.table(
  "allocation",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    partyId: uuid("party_id").notNull(),
    settlementDocumentId: uuid("settlement_document_id").notNull(),
    settledDocumentId: uuid("settled_document_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    settlementAmount: numeric("settlement_amount", { precision: 19, scale: 4 }).notNull(),
    baseAmount: numeric("base_amount", { precision: 19, scale: 4 }).notNull(),
    fxDifference: numeric("fx_difference", { precision: 19, scale: 4 }).notNull(),
    /** Code review B1: the allocation's accounting date, stamped by 0046's allocation_guard. */
    effectiveDate: date("effective_date").notNull(),
    allocatedBy: uuid("allocated_by").notNull(),
    unallocatedAt: timestamp("unallocated_at", { withTimezone: true }),
    unallocatedBy: uuid("unallocated_by"),
    unallocationReason: text("unallocation_reason"),
    /** B1: the un-allocation's accounting date, stamped by allocation_guard with `unallocated_at`. */
    unallocatedOn: date("unallocated_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("allocation_tenant_id_id_key").on(table.tenantId, table.id),
    index("allocation_settlement_idx").on(table.settlementDocumentId),
    index("allocation_settled_idx").on(table.settledDocumentId),
    // 0077, 7C's filters — NOT partial: accounting.allocation_register's party cut, un-allocations included.
    index("allocation_company_party_idx").on(table.companyId, table.partyId),
  ],
);
