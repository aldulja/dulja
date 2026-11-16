-- ── 0077. Report-filter indexes (SAH-070 "index coverage is thin on exactly the columns reports filter by";
--          contracts §2.8's 7B card, round 14 amendments A7 and A17) ──────────────────────────────────────
-- Indexes only — no column, constraint, function, grant or row — so this is an EXPAND step (§3.4.7) that can
-- deploy under load. Not `create index concurrently`: §3.4.3 runs each migration file whole in one transaction.
--
-- Each index below is a filter pair the 7B EXPLAIN gate (packages/db/test/reports/7b-report-indexes.test.ts)
-- found the planner could not SEEK on: the column was either in no index, or behind a key column the report
-- does not bind (inventory_movement_chrono_idx puts item_id before effective_date), or only in a PARTIAL index
-- whose predicate a report's WHERE never states (lot_expiry_idx, price_list_line_item_idx and cost_layer's two
-- carry `archived_at is null` / `invalidated_at is null`, and a ReportDefinition filter cannot express
-- "is null"). Every table here belongs to a spent range (0A, 1B, 2B, 3A, 3B), which is why they live in 7B's
-- own number (A7). Low-selectivity enumerations (document status, event kind, audit action, account type,
-- warehouse kind, promotion kind) are deliberately NOT indexed — SAH-070's own table names that class as one
-- an index does not help — and are the gate's closed RESIDUAL list.

-- accounting.document_register and inventory.count_register: the register's REQUIRED date range across every
-- type. 1B's document_company_period_status_idx leads with fiscal_period_id.
create index document_company_date_idx
  on app.document (company_id, effective_date);

-- Every `document_type_code` filter (document_register, count_register, transfer_register, journal_register,
-- movement_register, document_event_log) reaches app.document through document_type_id, by type then date.
create index document_company_type_date_idx
  on app.document (company_id, document_type_id, effective_date);

-- The branch cut of document_register, count_register and general_ledger (`d.branch_id`).
create index document_company_branch_date_idx
  on app.document (company_id, branch_id, effective_date);

-- accounting.document_event_log's required window. 2B's document_event_document_idx is (document_id,
-- occurred_at) — right for one document's history, useless for a company-wide event log.
create index document_event_company_time_idx
  on app.document_event (company_id, occurred_at);

-- inventory.movement_register and inventory.transfer_register's required date range across items. 3A's
-- inventory_movement_chrono_idx has item_id and warehouse_id between the two. `posting_seq` follows because the
-- register's order is §4.3.5's chronological key (effective_date, posting_seq, …).
create index inventory_movement_company_date_idx
  on app.inventory_movement (company_id, effective_date, posting_seq);

-- The registers' optional warehouse cut, which the chrono index holds behind item_id.
create index inventory_movement_company_warehouse_date_idx
  on app.inventory_movement (company_id, warehouse_id, effective_date);

-- inventory.stock_ageing reads EVERY layer of an item (consumed and invalidated included), so neither of 3B's
-- partial layer indexes can serve it.
create index cost_layer_company_item_warehouse_idx
  on app.cost_layer (company_id, item_id, warehouse_id);

-- inventory.stock_on_hand's warehouse cut; the primary key holds warehouse_id behind item_id.
create index stock_on_hand_company_warehouse_idx
  on app.stock_on_hand (company_id, warehouse_id);

-- inventory.valuation's REQUIRED as-of date, then its warehouse cut; the primary key holds as_of last.
create index stock_valuation_company_as_of_idx
  on app.stock_valuation (company_id, as_of, warehouse_id);

-- inventory.expiry_list's required horizon. 3A's lot_expiry_idx is partial on `archived_at is null`.
create index lot_company_expires_idx
  on app.lot (company_id, expires_on);

-- inventory.price_list's item cut. 3A's price_list_line_item_idx is partial on `archived_at is null`; the
-- unique key leads with price_list_id. app.price_list_line has no company column.
create index price_list_line_item_any_idx
  on app.price_list_line (item_id);

-- accounting.audit_log's required window, its table cut and its actor cut. app.audit_log has no company column
-- (the chain is per tenant); 0A's audit_log_tenant_seq_idx is (tenant_id, seq desc) for the chain walk.
create index audit_log_tenant_time_idx
  on app.audit_log (tenant_id, occurred_at);
create index audit_log_tenant_table_time_idx
  on app.audit_log (tenant_id, table_name, occurred_at);
create index audit_log_tenant_actor_time_idx
  on app.audit_log (tenant_id, actor_id, occurred_at);

-- ── 7C's report filters (contracts round 15, A17 as executed; [7 remediation], 2026-11-06) ──────────────────
-- 7C's EXPLAIN gate found seven selective filters no index could seek on and recorded them as a closed UNSERVED
-- list, because 7C's own range (0078–0079) is the export's. 0077 has been applied to no deployed database, so
-- under the owner's 2026-11-06 direction to complete Phase 7 they join 7B's here rather than take a new number
-- (the 0044–0050 precedent of amending an unapplied migration in place). Every table is again a spent range's
-- (4A, 5A, 6A, 6D).

-- accounting.party_statement's REQUIRED partyId, then its required date range. The 1B and 7B document indexes
-- above put the date or the type before any party column.
create index document_company_party_date_idx
  on app.document (company_id, party_id, effective_date);

-- accounting.allocation_register's optional partyId. 4A's two allocation indexes are partial on
-- `unallocated_at is null` and key on the documents, not the party.
create index allocation_company_party_idx
  on app.allocation (company_id, party_id);

-- pos.sales_by_branch, pos.sales_by_cashier and pos.z_report's date range. The dataset's `opened_on` is the
-- company-timezone date of opened_at; a range on it compiles to bounds on opened_at itself
-- (`DatasetColumn.localDateOf`), which this index seeks. 6D's shift_branch_opened_idx puts branch_id first.
create index shift_company_opened_idx
  on app.shift (company_id, opened_at);

-- pos.sales_by_cashier's optional cashier, then the date range.
create index shift_company_cashier_opened_idx
  on app.shift (company_id, opened_principal_id, opened_at);

-- pos.needs_attention's optional branch over the WHOLE log. 6A's needs_attention_open_idx has these keys but is
-- partial on `resolved_at is null`, which a definition filter cannot state (isOpen is a computed field).
create index needs_attention_company_branch_created_idx
  on app.needs_attention (company_id, branch_id, created_at);

-- pos.needs_attention's optional fromDate: `created_on` compiles to bounds on created_at, as opened_on does.
create index needs_attention_company_created_idx
  on app.needs_attention (company_id, created_at);

-- accounting.tax_return_view's REQUIRED fiscal period. 5A's tax_transaction_period_idx keys (company_id,
-- regime_id, effective_date) — the return's own read path, which binds a regime and a date range.
create index tax_transaction_company_period_idx
  on app.tax_transaction (company_id, fiscal_period_id);
