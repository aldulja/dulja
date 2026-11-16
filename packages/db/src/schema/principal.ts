import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const principalTable = app.table("principal", {
  id: uuid("id").primaryKey(),
  kind: text("kind").$type<"human" | "system" | "terminal">().notNull(),
  authSubject: text("auth_subject").notNull(),
  email: text("email"),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
