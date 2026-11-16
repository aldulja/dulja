-- ── 0106 · a pinned posting_policy never changes ───────────────────────────────────────────────────────
-- Review remediation (Phase 2 review pass, PR #5); §3.4.1 tail number. Depends on 0001 and 0011.
--
-- document.posting_policy_id and ledger_entry.posting_policy_id are the pin spec:1753 relies on (SAH-013):
-- reverseDocument reads the pinned row's definition months later. The API is append-only (ADR 0027), but
-- app_rw holds UPDATE on app.posting_policy and the seed pack's loader upserts `do update` (contracts
-- §3.4.8 — a staging placeholder must not survive the real definition), so a re-run of the seed after an
-- edit to a pack file could rewrite what a posted document was posted under. This guard reconciles the
-- two: a version that NOTHING has posted under may still be replaced (the placeholder case); one that a
-- document or a ledger entry pins is immutable, and the operator bumps the version instead. DELETE is
-- refused outright — there is no grant for it either, and the guard says so to a future one.
create function app.guard_pinned_policy() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ERR_TABLE_IMMUTABLE: posting_policy % is never deleted; a new version supersedes it', old.id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from app.document where posting_policy_id = old.id)
     or exists (select 1 from app.ledger_entry where posting_policy_id = old.id) then
    raise exception 'ERR_TABLE_IMMUTABLE: posting_policy % is pinned by a posted document and cannot change; add a new version (SAH-013, ADR 0027)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger posting_policy_pinned before update or delete on app.posting_policy
  for each row execute function app.guard_pinned_policy();
