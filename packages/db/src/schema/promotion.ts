import { bigint } from "drizzle-orm/pg-core";
import { index, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the offer body 6B interprets at the till and 6A down-syncs (3A, migration 0030;
 * spec:1062). `kind` is closed to `percent_off | amount_off | bundle` by `promotion_kind_check`, and
 * `definition` is stored and read by **no code in slice 3A**. `branch_id` is nullable and null means
 * every branch (spec:1312). There is no `archived_at`: a promotion is retired by setting `ends_at`,
 * which is what a date-windowed offer means.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const promotion = app.table(
  "promotion",
  {
    id: uuid("id").primaryKey(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull().$type<"percent_off" | "amount_off" | "bundle">(),
    definition: jsonb("definition").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    branchId: uuid("branch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("promotion_company_id_code_key").on(table.companyId, table.code),
    unique("promotion_tenant_id_id_key").on(table.tenantId, table.id),
    index("promotion_window_idx").on(table.companyId, table.startsAt, table.endsAt),
    // `promotion_kind_check` and `promotion_window_check` live in the migration only: Drizzle spells a
    // table CHECK with its `sql` tag, which `no-bare-db` refuses outside a `tx`.
  ],
);
