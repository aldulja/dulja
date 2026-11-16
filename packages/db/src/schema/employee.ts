import { date, index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const employee = app.table(
  "employee",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    partyId: uuid("party_id").notNull(),
    employeeNumber: text("employee_number").notNull(),
    homeBranchId: uuid("home_branch_id").notNull(),
    principalId: uuid("principal_id"),
    hiredOn: date("hired_on").notNull(),
    terminatedOn: date("terminated_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 8A, migration 0080 — appended, never reordered.
    position: text("position"),
    employmentType: text("employment_type"),
    statutoryProfileNote: text("statutory_profile_note"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // 8D, migration 0098 (contracts round 19, 8D A2) — appended, never reordered.
    contractEndsOn: date("contract_ends_on"),
    // 9B, migration 0101 (contracts §4.13.3) — the legacy employee number.
    legacyRef: text("legacy_ref"),
  },
  // 9B, migration 0101 — partial (`where legacy_ref is not null`) in the migration only.
  (table) => [index("employee_legacy_ref_idx").on(table.companyId, table.legacyRef)],
);
