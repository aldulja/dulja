-- 0023_grant_document_draft_delete_and_add_series_gaps.sql ────────────────────────────────────────────────
-- Two halves of one guarantee (ADR 0030).
--   (a) spec:2049 admits genuine deletion for drafts, and both cases "write an audit row first";
--       spec:2224 forbids deleting a posted document at any privilege level (LEGACY-041).
--   (b) spec:2222 wants numbering gapless-PROVABLE, and spec:2288 makes that the Phase 2 definition of done.
-- The DELETE grant below is the ONE extension of the pinned app_rw DELETE list in the whole of v1
-- (contracts §3.5.4); every other table is archived with archived_at.

-- ── 1. the guards, created BEFORE the grant so no window exists in which DELETE is unguarded ──────────
create function app.forbid_delete_unless_draft() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is %; an issued document is voided and a posted one is reversed (spec:2049, 2224)',
      old.id, old.status using errcode = 'check_violation';
  end if;
  return old;
end $$;

create trigger document_delete_draft_only before delete on app.document
  for each row execute function app.forbid_delete_unless_draft();

-- The child guard. document_line cascades from document (the composite FK is ON DELETE CASCADE, 1A migration
-- 0011), and during a cascade the parent row is already gone — so the guard refuses only when a NON-DRAFT
-- parent is still visible. That is exactly the direct `delete from app.document_line where document_id = <a
-- posted document>` case, which the grant below would otherwise permit one row at a time.
create function app.forbid_line_delete_unless_draft() returns trigger language plpgsql as $$
declare
  v_status app.document_status;
begin
  select d.status into v_status from app.document d where d.id = old.document_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is %; its lines cannot be deleted (spec:2224)',
      old.document_id, v_status using errcode = 'check_violation';
  end if;
  return old;
end $$;

create trigger document_line_delete_draft_only before delete on app.document_line
  for each row execute function app.forbid_line_delete_unless_draft();

-- ── 2. the grant (contracts §3.5.4 row two — the only one this system ever adds) ─────────────────────
-- app.audit_row() is already attached to both tables and fires AFTER DELETE with the before-image, which is
-- spec:2049's "both write an audit row first". No flag can suppress it (LEGACY-030).
grant delete on app.document, app.document_line to app_rw;

-- ── 3. the gapless proof (contracts §4.5.5; spec:2222, 2288) ─────────────────────────────────────────
-- Every number the counter has issued that is neither a document nor a recorded void. Zero rows for every
-- (company, series, period) is the definition-of-done proof; the 1B integrity job reports any non-empty result.
-- `stable` and unqualified reads, so it runs under the caller's RLS and proves only the caller's tenancy.
create function app.series_gaps(p_company uuid, p_series text, p_period uuid)
returns table (number bigint) language sql stable as $$
  select g.n from app.document_series s
  cross join lateral generate_series(1, s.next_number - 1) as g(n)
  where s.company_id = p_company and s.series = p_series and s.fiscal_period_id = p_period
    and not exists (select 1 from app.document d
                     where d.company_id = p_company and d.series = p_series
                       and d.fiscal_period_id = p_period and d.number = g.n)
    and not exists (select 1 from app.document_number_void v
                     where v.company_id = p_company and v.series = p_series
                       and v.fiscal_period_id = p_period and v.number = g.n)
$$;
