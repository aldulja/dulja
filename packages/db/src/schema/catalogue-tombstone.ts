// packages/db/src/schema/catalogue-tombstone.ts
import { bigint, index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
const app = pgSchema("app");
export const catalogueTombstone = app.table(
  "catalogue_tombstone",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    stream: text("stream").notNull(),
    rowId: uuid("row_id").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    branchId: uuid("branch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("catalogue_tombstone_tenant_id_id_key").on(t.tenantId, t.id),
    streamRow: unique("catalogue_tombstone_stream_row_id_key").on(t.stream, t.rowId),
    cursor: index("catalogue_tombstone_cursor_idx").on(t.companyId, t.revision),
  }),
);
