import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const app = pgSchema("app");
export const tenantTable = app.table("tenant", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
