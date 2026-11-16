-- 0074.down.sql — reverse dependency order (§3.4.5). The audit trigger, the tenant_isolation policy and the
-- lookup index all drop with the table; the index is named first so a partial edit cannot leave it behind.
drop index if exists app.report_definition_lookup_idx;
drop table if exists app.report_definition;
