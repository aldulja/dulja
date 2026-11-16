alter default privileges for role app_migrator in schema app revoke select, insert, update on tables from app_rw;
drop table if exists app.idempotency_key;
drop table if exists app.pos_terminal;

drop procedure if exists app_meta.attach_stamp(regclass, text);
drop function if exists app.stamp_actor() cascade;
drop procedure if exists app_meta.attach_audit(regclass, text, text);
drop function if exists app.audit_row() cascade;
drop table if exists app.audit_log;
drop function if exists app.audit_chain();

drop table if exists app.ledger_entry_dimension;
drop table if exists app.ledger_entry;
drop function if exists app.assert_document_balanced();
drop function if exists app.assert_period_open();
drop function if exists app.forbid_change();

alter table if exists app.role_assignment_branch drop constraint if exists role_assignment_branch_dim_fk;
alter table if exists app.document drop constraint if exists document_branch_fk;
drop table if exists app.dimension_value;
drop table if exists app.dimension_type;
drop table if exists app.document;
drop type if exists app.document_status;
drop table if exists app.document_number_void;
drop table if exists app.document_series;
drop table if exists app.posting_policy;
drop table if exists app.document_type;

alter table if exists app.company drop constraint if exists company_fx_rounding_account_fk;
drop table if exists app.account;
drop type if exists app.account_type;
drop table if exists app.fiscal_period;
drop type if exists app.period_status;
drop function if exists app.keep_last_admin_assignment() cascade;
drop function if exists app.keep_last_admin_permission() cascade;
drop function if exists app.assert_assignment_kind() cascade;
drop function if exists app.forbid_self_grant() cascade;
drop function if exists app.actor_has(text, uuid, uuid);
drop table if exists app.role_assignment_branch;
drop table if exists app.role_assignment;
drop table if exists app.role_permission;
drop table if exists app.permission;
drop table if exists app.role;
drop table if exists app.company;

-- Reverse of the Task 5 section of 0001_foundations.sql.
drop function if exists app.resolve_principal(text);
drop policy if exists principal_in_tenant on app.principal;
drop policy if exists principal_update_in_tenant on app.principal;
drop table if exists app.membership;
drop table if exists app.principal;
drop type if exists app.principal_kind;
drop table if exists app.tenant;
drop procedure if exists app_meta.enable_tenant_rls(regclass);
drop function if exists app.current_actor();
drop function if exists app.current_tenant();
drop schema if exists app;
