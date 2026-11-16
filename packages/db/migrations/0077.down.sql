-- 0077.down.sql — reverse of 0077, in reverse creation order (§3.4.5). Dropping an index never touches a row,
-- and 0077 creates nothing else: no table, column, constraint, function or grant.
drop index if exists app.tax_transaction_company_period_idx;
drop index if exists app.needs_attention_company_created_idx;
drop index if exists app.needs_attention_company_branch_created_idx;
drop index if exists app.shift_company_cashier_opened_idx;
drop index if exists app.shift_company_opened_idx;
drop index if exists app.allocation_company_party_idx;
drop index if exists app.document_company_party_date_idx;
drop index if exists app.audit_log_tenant_actor_time_idx;
drop index if exists app.audit_log_tenant_table_time_idx;
drop index if exists app.audit_log_tenant_time_idx;
drop index if exists app.price_list_line_item_any_idx;
drop index if exists app.lot_company_expires_idx;
drop index if exists app.stock_valuation_company_as_of_idx;
drop index if exists app.stock_on_hand_company_warehouse_idx;
drop index if exists app.cost_layer_company_item_warehouse_idx;
drop index if exists app.inventory_movement_company_warehouse_date_idx;
drop index if exists app.inventory_movement_company_date_idx;
drop index if exists app.document_event_company_time_idx;
drop index if exists app.document_company_branch_date_idx;
drop index if exists app.document_company_type_date_idx;
drop index if exists app.document_company_date_idx;
