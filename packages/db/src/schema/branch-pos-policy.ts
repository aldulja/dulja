import { bigint, boolean, numeric, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const branchPosPolicy = app.table("branch_pos_policy", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  branchId: uuid("branch_id").notNull(),
  maxLineDiscountPct: numeric("max_line_discount_pct", { precision: 9, scale: 6 }).notNull(),
  maxTicketDiscountPct: numeric("max_ticket_discount_pct", { precision: 9, scale: 6 }).notNull(),
  maxVoidAmount: numeric("max_void_amount", { precision: 19, scale: 4 }).notNull(),
  maxPriceOverridePct: numeric("max_price_override_pct", { precision: 9, scale: 6 }).notNull(),
  blindReturnAllowed: boolean("blind_return_allowed").notNull(),
  maxBlindReturnAmount: numeric("max_blind_return_amount", { precision: 19, scale: 4 }).notNull(),
  maxCashInDrawer: numeric("max_cash_in_drawer", { precision: 19, scale: 4 }),
  requireCustomerOver: numeric("require_customer_over", { precision: 19, scale: 4 }),
  roundingIncrement: numeric("rounding_increment", { precision: 19, scale: 4 }).notNull(),
  paidOutAllowed: boolean("paid_out_allowed").notNull(),
  maxPaidOutAmount: numeric("max_paid_out_amount", { precision: 19, scale: 4 }).notNull(),
  revision: bigint("revision", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
