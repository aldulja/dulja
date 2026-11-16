import { jsonb, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

export const customFieldValue = app.table(
  "custom_field_value",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    definitionId: uuid("definition_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("custom_field_value_definition_id_entity_id_key").on(table.definitionId, table.entityId),
  ],
);
