// packages/db/src/schema/shift.ts — a READ mirror (§3.4.9). Every write in this slice is a tagged template.
import { char, index, numeric, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const shift = app.table(
  "shift",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    terminalId: uuid("terminal_id").notNull(),
    openedPrincipalId: uuid("opened_principal_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    openingFloat: numeric("opening_float", { precision: 19, scale: 4 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedPrincipalId: uuid("closed_principal_id"),
    countedCash: numeric("counted_cash", { precision: 19, scale: 4 }),
    expectedCash: numeric("expected_cash", { precision: 19, scale: 4 }),
    overShort: numeric("over_short", { precision: 19, scale: 4 }),
    overShortDocumentId: uuid("over_short_document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("shift_tenant_id_id_key").on(t.tenantId, t.id),
    // 0070 declares the index `opened_at desc` (the Z-report history reads newest first).
    branchOpenedIdx: index("shift_branch_opened_idx").on(
      t.companyId,
      t.branchId,
      t.openedAt.desc(),
    ),
    // 0077, 7C's filters — the POS reports' date range (opened_on compiles to opened_at bounds) and their
    // cashier cut.
    companyOpenedIdx: index("shift_company_opened_idx").on(t.companyId, t.openedAt),
    companyCashierOpenedIdx: index("shift_company_cashier_opened_idx").on(
      t.companyId,
      t.openedPrincipalId,
      t.openedAt,
    ),
  }),
);
