import { customType, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
/** Terminal identity created by 0001, extended by 0061 with the numbering code. */
export const posTerminal = app.table(
  "pos_terminal",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    devicePublicKey: bytea("device_public_key").notNull(),
    enrolledBy: uuid("enrolled_by").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("pos_terminal_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pos_terminal_principal_id_key").on(t.principalId),
    unique("pos_terminal_company_id_code_key").on(t.companyId, t.code),
  ],
);
