import { char, date, numeric, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 / §4.8.2 — the as-of open-item ageing snapshot (4B, migration 0048). An ASYNCHRONOUS
 * projection (spec:1204): rebuilt by `accounting.projection.rebuild` from `app.party_ageing_rows`, the one
 * definition of the ageing arithmetic, and compared row for row — never written by the posting service.
 * There is no `id` column — the natural key `(company_id, party_id, currency, as_of, bucket)` IS the key,
 * which is why `lint-schema.ts` carries the table in `NO_ID_TABLES` and in `AUDIT_EXEMPT` (§3.5.3).
 *
 * `bucket` is `text`, not a Drizzle enum (§3.4.4, hazard 11); its vocabulary is the migration's named
 * CHECK `party_ageing_bucket_check`, which lives in the migration only: Drizzle spells a table CHECK with its
 * `sql` tag, which `no-bare-db` refuses outside a `tx`.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const partyAgeing = app.table(
  "party_ageing",
  {
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    partyId: uuid("party_id").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    // `mode: "string"`: the snapshot date is a calendar date, not an instant (spec:2039).
    asOf: date("as_of", { mode: "string" }).notNull(),
    bucket: text("bucket").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull().default("0"),
    baseAmount: numeric("base_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "party_ageing_pkey",
      columns: [table.companyId, table.partyId, table.currency, table.asOf, table.bucket],
    }),
  ],
);
