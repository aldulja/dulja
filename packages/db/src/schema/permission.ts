import { boolean, text } from "drizzle-orm/pg-core";
import { app } from "./tenant";
export const permissionTable = app.table("permission", {
  code: text("code").primaryKey(),
  module: text("module").$type<"admin" | "accounting" | "inventory" | "hr" | "pos">().notNull(),
  mutating: boolean("mutating").notNull(),
  description: text("description").notNull(),
});
