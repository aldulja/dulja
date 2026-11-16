import { index, numeric, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Mirror of app.bank_match (4B, migration 0050; contracts §4.8.3, ADR 0048). Reads only — every write goes
 * through `match` / `unmatch` in packages/db/src/ar-ap/reconciliation.ts, and neither writes a ledger,
 * projection or document row: a match is this row and nothing else (acceptance test 39, spec:2457).
 *
 * `amount` is a MAGNITUDE in the statement's currency; the direction is the statement line's sign. The three
 * CHECKs (`bank_match_amount_check`, `bank_match_kind_check`, `bank_match_unmatch_pair_check`) and the
 * `bank_match_guard` trigger live in the migration only: Drizzle spells a table CHECK with its `sql` tag,
 * which `no-bare-db` refuses outside a `tx`. Both indexes are PARTIAL (`where unmatched_at is null`) in the
 * migration; the mirror names their columns.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const bankMatch = app.table(
  "bank_match",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    statementLineId: uuid("statement_line_id").notNull(),
    reconcilableKind: text("reconcilable_kind").notNull(),
    reconcilableDocumentId: uuid("reconcilable_document_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    matchedBy: uuid("matched_by").notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull(),
    unmatchedBy: uuid("unmatched_by"),
    unmatchedAt: timestamp("unmatched_at", { withTimezone: true }),
    unmatchReason: text("unmatch_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("bank_match_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("bank_match_live_idx").on(table.statementLineId, table.reconcilableDocumentId),
    index("bank_match_document_idx").on(table.reconcilableDocumentId),
  ],
);
