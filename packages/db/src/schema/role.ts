import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const roleTable = app.table("role", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  code: text("code").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  description: text("description"),
  isSystem: boolean("is_system").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
