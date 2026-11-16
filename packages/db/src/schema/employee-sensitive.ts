import { customType, pgSchema, smallint, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");
/** `bytea` has no first-class Drizzle column; the driver hands back a Buffer either way. Every `*_enc` column is
 *  an AES-256-GCM envelope opened only by packages/db/src/hr/sensitive.ts (ADR 0071) — never read it raw. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** 8A, migration 0081 — §4.12.5. Keyed on employee_id (NO_ID_TABLES), no company_id of its own. */
export const employeeSensitive = app.table("employee_sensitive", {
  employeeId: uuid("employee_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  nationalIdEnc: bytea("national_id_enc"),
  passportEnc: bytea("passport_enc"),
  dateOfBirthEnc: bytea("date_of_birth_enc"),
  residencyCategoryEnc: bytea("residency_category_enc"),
  bankAccountEnc: bytea("bank_account_enc"),
  epfNumberEnc: bytea("epf_number_enc"),
  socsoNumberEnc: bytea("socso_number_enc"),
  taxNumberEnc: bytea("tax_number_enc"),
  workPermitExpiryEnc: bytea("work_permit_expiry_enc"),
  keyVersion: smallint("key_version").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
