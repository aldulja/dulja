import { bigint } from "drizzle-orm/pg-core";
import { date, numeric, pgSchema, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** Mirror of app.tax_code (migration 0053). `rate` is `numeric(19,8)`; Drizzle returns it as a STRING and
 *  every consumer keeps it a string — `no-number-money` (§3.7.5) matches /rate|tax/i. */
export const taxCode = app.table(
  "tax_code",
  {
    id: uuid("id").primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    regimeId: uuid("regime_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    rate: numeric("rate", { precision: 19, scale: 8 }).notNull(),
    kind: text("kind").notNull().$type<"output" | "input" | "exempt" | "zero" | "out_of_scope">(),
    roundingMode: text("rounding_mode")
      .notNull()
      .$type<"HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO">(),
    outputAccountId: uuid("output_account_id"),
    inputAccountId: uuid("input_account_id"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byCode: unique("tax_code_company_id_code_effective_from_key").on(
      t.companyId,
      t.code,
      t.effectiveFrom,
    ),
  }),
);
