-- 0018_alter_document_party_fk_and_document_type_module.sql — the deferred document.party_id FK (spec:1759)
-- and the two document_type columns contracts §4.3.4 assigns to 2A. One file does both because 2A's four
-- migrations exhaust 0017–0020 and 0021 belongs to 2B; §3.4.3 allows it and §3.4.2 requires the name to say so.

-- ── 1. The foreign key migration 0001 deferred (spec:1759) ────────────────────────────────────────────
-- app.document.party_id has existed since 0001 with the comment "FK (tenant_id, party_id) → app.party is
-- added by the Phase 2 migration". app.party landed in 0017; this is that key. Composite, never plain:
-- a plain FK to app.party(id) would let one tenant's document name another tenant's party (contracts §3.5.1).
alter table app.document
  add constraint document_party_fk
  foreign key (tenant_id, party_id) references app.party(tenant_id, id);

-- ── 2. document_type.module — the attachment download gate, and nothing else (contracts §4.5.8, §4.14) ──
-- Which module's READ permission may see this document's attachments: the module of the team that files them.
-- NOT the module segment of approval.post — PAYROLL_PAYMENT posts under accounting.payment.post and is 'hr'.
-- The default exists only so this ALTER can run against live rows; every seed file sets it explicitly.
alter table app.document_type
  add column module text not null default 'accounting'
    constraint document_type_module_check check (module in ('accounting', 'inventory', 'hr', 'pos'));

-- ── 3. document_type.archived_at — master data is archived, never deleted (spec:2049) ─────────────────
alter table app.document_type add column archived_at timestamptz;
