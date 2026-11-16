-- 0119_admit_transfer_receipt_at_receiving_branch.sql — ADR 0043's amendment "branch-restricted transfers"
-- (proposed 2026-10-23, accepted by the owner 2026-11-04 with every recommended default); ADR 0062's 2026-10-23
-- amendment; contracts §4.5.6. Not a slice: the number comes from Plan Contracts §3.4.1's tail, registered in
-- the same change.
--
-- After 0068 no principal restricted to ONE branch could complete an inter-branch transfer, the seeded
-- branch_manager included, although spec:2160 gives that role "receiving transfers". The dispatch is stamped
-- with the SENDING branch (A) and the corridor belongs to the RECEIVING branch (B, ADR 0043 decision 1), so
-- Form A hid the dispatch from B, `document_parent_visibility` hid its lines, and Form A″ hid B's stock
-- warehouse — the destination the dispatch names — from A. The owner's three answers, and what this file does
-- for each (the application half is in packages/db/src/inventory/transfer.ts and the two transfer routes):
--
-- 1. The receiving branch stamps and gates the receipt. No SQL here: `draftTransferReceipt` stamps the receipt
--    with its corridor's branch, 2B's status trigger then gates its post at B, and Form A's WITH CHECK admits
--    the row to B exactly as it admits any B document.
--
-- 2. Option a — Form A on app.document READS one more row shape, and only that one: a POSTED document whose
--    to_warehouse_id is an in_transit warehouse of a branch the actor is in, i.e. a dispatch into the actor's
--    own corridor. Its header becomes readable at that branch, and through the unchanged USING of
--    `document_parent_visibility` its lines too — which is what the receipt's `receives_against` links and
--    0037's link guard read, so the dispatch's residual open quantity (the record of what never arrived) and
--    0037's refusal of a second receipt both keep working. No other document, no other branch: a third branch
--    is in neither the dispatch's branch nor the corridor's. The policy stays AS RESTRICTIVE; nothing here is
--    SECURITY DEFINER or permissive. The corridor lookup is bound to the document's tenant and company, and is
--    itself subject to app.warehouse's own policies (an in_transit row is visible to every branch, Form A″).
--
--    The widening is a READ. Form A's WITH CHECK is written out as 0068's predicate, so an INSERT, and the new
--    row of every UPDATE, must still be in a branch the actor is in — a receipt-stamping branch cannot write a
--    row that stays the sender's. `document_parent_visibility`'s WITH CHECK asks the same of a line's parent:
--    a line may be written only under a document whose branch the actor is in, not merely one it can read.
--    Without that, a branch could rewrite the sender's posted line `cost` (0113 admits a `cost` change at
--    posted, for the cost replay). Every write path from the receiving branch onto the dispatch is therefore
--    refused: the header's UPDATE and the lines' INSERT and UPDATE by these WITH CHECKs; a move into the
--    receiving branch's own name (the header's `branch_id`, a line's `document_id`) also by 0117's and 0113's
--    freezes; a DELETE of either by 0023's draft-only guards. The widening admits only POSTED documents, and a
--    posted aggregate is frozen at every privilege, so no write path rests on a USING alone.
--
-- 3. The dispatch's create stage is gated at the SOURCE warehouse's branch (the route's gate). The destination
--    is a stock warehouse that Form A″ shows only to its own branch, so the sending branch reaches its corridor
--    through ONE bounded, company-bound lookup, `app.transfer_destination_branch`, which answers one fact — the
--    branch of a live STOCK warehouse of the supplied company in the current tenant — and only to a principal
--    holding a live role in that company. Form A″ already shows every corridor to every branch, so knowing the
--    branch is enough, and Form A″'s USING is unchanged. Its pattern is 0068's `resolve_cashier_employee`:
--    owned by app_auth (NOLOGIN, no BYPASSRLS, assumable only by app_migrator), a fixed search_path, exact
--    column grants it cannot write through, the current tenant bound explicitly and tenant_isolation still
--    applying to app_auth inside it. So that app_auth reads the row at all, Form A″ is scoped to the two data
--    roles exactly as 0068 scoped Form A′ (employee) and terminal_enrolment's Form A for their resolvers; for
--    app_rw and app_migrator it is the same policy, and app_auth gains SELECT on six warehouse columns only.
--    It is no policy's predicate (ADR 0062: SECURITY DEFINER in a predicate would turn a branch hole into a
--    tenancy hole).
--
-- The policy count does not change: still nineteen `branch_isolation` policies plus the one child guard.

-- ── 1. Form A on app.document: the read admits a posted dispatch into the actor's corridor ──────────────
drop policy branch_isolation on app.document;
create policy branch_isolation on app.document as restrictive
  using (app.actor_in_branch(company_id, branch_id)
         or (status = 'posted'
             and exists (select 1 from app.warehouse w
                          where w.tenant_id = document.tenant_id and w.company_id = document.company_id
                            and w.id = document.to_warehouse_id and w.kind = 'in_transit'
                            and app.actor_in_branch(w.company_id, w.branch_id))))
  with check (app.actor_in_branch(company_id, branch_id));

-- ── 2. the child guard: a line is READ under a readable parent, WRITTEN only under a writable one ─────────
drop policy document_parent_visibility on app.document_line;
create policy document_parent_visibility on app.document_line as restrictive
  using (exists (select 1 from app.document d where d.tenant_id=document_line.tenant_id
    and d.company_id=document_line.company_id and d.id=document_line.document_id))
  with check (exists (select 1 from app.document d where d.tenant_id=document_line.tenant_id
    and d.company_id=document_line.company_id and d.id=document_line.document_id
    and app.actor_in_branch(d.company_id, d.branch_id)));

-- ── 3. the bounded, company-bound destination lookup ────────────────────────────────────────────────────
drop policy branch_isolation on app.warehouse;
create policy branch_isolation on app.warehouse as restrictive to app_rw, app_migrator
  using (kind = 'in_transit' or app.actor_in_branch(company_id, branch_id));

grant select (id, tenant_id, company_id, branch_id, kind, archived_at) on app.warehouse to app_auth;
create function app.transfer_destination_branch(p_company_id uuid, p_warehouse_id uuid) returns uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select w.branch_id from app.warehouse w
   where w.tenant_id = app.current_tenant() and w.company_id = p_company_id and w.id = p_warehouse_id
     and w.kind = 'stock' and w.archived_at is null
     and exists (select 1 from app.role_assignment ra
                  where ra.tenant_id = app.current_tenant() and ra.principal_id = app.current_actor()
                    and ra.company_id = p_company_id and (ra.expires_at is null or ra.expires_at > now()))
$$;
comment on function app.transfer_destination_branch(uuid, uuid) is
  'ADR 0043 amendment (owner-approved 2026-11-04), decision 3: the branch of a live stock warehouse of the '
  'supplied company in the current tenant, answered only to a principal holding a live role in that company, '
  'so a sending branch can find the corridor of a destination Form A″ hides from it. Bounded: one column, no '
  'write, owned by app_auth (no BYPASSRLS), never a policy predicate.';
revoke all on function app.transfer_destination_branch(uuid, uuid) from public;
grant execute on function app.transfer_destination_branch(uuid, uuid) to app_rw;
grant create on schema app to app_auth;
alter function app.transfer_destination_branch(uuid, uuid) owner to app_auth;
revoke create on schema app from app_auth;
