-- 0119.down.sql — restores 0068's three policies exactly as 0068 wrote them, and removes the bounded lookup and
-- its grant. Development and CI only (spec:2057).
drop function app.transfer_destination_branch(uuid, uuid);
revoke select (id, tenant_id, company_id, branch_id, kind, archived_at) on app.warehouse from app_auth;

drop policy branch_isolation on app.warehouse;
create policy branch_isolation on app.warehouse as restrictive
  using (kind = 'in_transit' or app.actor_in_branch(company_id, branch_id));

drop policy document_parent_visibility on app.document_line;
create policy document_parent_visibility on app.document_line as restrictive
  using (exists (select 1 from app.document d where d.tenant_id=document_line.tenant_id
    and d.company_id=document_line.company_id and d.id=document_line.document_id))
  with check (exists (select 1 from app.document d where d.tenant_id=document_line.tenant_id
    and d.company_id=document_line.company_id and d.id=document_line.document_id));

drop policy branch_isolation on app.document;
create policy branch_isolation on app.document as restrictive using (app.actor_in_branch(company_id, branch_id));
