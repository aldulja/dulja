// packages/db/src/schema/terminal-enrolment.ts
import { customType, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
const app = pgSchema("app");
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const terminalEnrolment = app.table(
  "terminal_enrolment",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    codeHash: bytea("code_hash").notNull(),
    name: text("name").notNull(),
    terminalCode: text("terminal_code").notNull(),
    issuedBy: uuid("issued_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    terminalId: uuid("terminal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("terminal_enrolment_tenant_id_id_key").on(t.tenantId, t.id),
    // No `unique (company_id, terminal_code)`: migration 0060 reserves the terminal code with the EXCLUSION
    // `terminal_enrolment_terminal_code_excl` (live or redeemed holdings may not overlap; PR 12 review, finding
    // 14), which Drizzle cannot declare — as `fiscal_period`'s exclusion is left undeclared in its mirror.
    // `code_hash bytea not null unique` in the SQL above — a UNIQUE CONSTRAINT, not a plain index. Declaring it
    // as index() here would make the Drizzle diff (§3.4.9, ADR-0002) report a spurious change on every run.
    hash: unique("terminal_enrolment_code_hash_key").on(t.codeHash),
  }),
);
