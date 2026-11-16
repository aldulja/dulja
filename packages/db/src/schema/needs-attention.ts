// packages/db/src/schema/needs-attention.ts
import { sql as expression } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
const app = pgSchema("app");
export const needsAttention = app.table(
  "needs_attention",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    terminalId: uuid("terminal_id"),
    clientRef: uuid("client_ref").notNull(),
    payload: jsonb("payload").notNull(),
    errorCode: text("error_code").notNull(),
    errorDetail: text("error_detail").notNull(),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("needs_attention_tenant_id_id_key").on(t.tenantId, t.id),
    companyRef: unique("needs_attention_company_id_client_ref_key").on(t.companyId, t.clientRef),
    // The SQL above declares this index PARTIAL — `where resolved_at is null`. The predicate belongs in the
    // mirror too: §3.4.9's Drizzle diff is the migration source of truth, and a mirror declaring the full index
    // would make the diff report a change on every run — the same reason `code_hash` is `unique()` and not
    // `index()` one file up.
    open: index("needs_attention_open_idx")
      .on(t.companyId, t.branchId, t.createdAt)
      .where(expression`resolved_at is null`),
    // 0077, 7C's filters — NOT partial: pos.needs_attention reads the whole log, resolved rows included.
    companyBranchCreated: index("needs_attention_company_branch_created_idx").on(
      t.companyId,
      t.branchId,
      t.createdAt,
    ),
    companyCreated: index("needs_attention_company_created_idx").on(t.companyId, t.createdAt),
  }),
);
