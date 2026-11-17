-- ── 0025 · app.attachment ─────────────────────────────────────────────────────────────────────────
-- spec:1067 (§3.0.4 Attachments row), spec:1138 (R2, opaque server-generated ids), spec:1192
-- (§3.3 Attachment under Document). Contracts §4.5.8 fixes these columns.
-- LEGACY-038: the object key is derived from the server-minted uuidv7 primary key and is NEVER built
-- from anything the client sends; the unique constraint makes a duplicate key impossible.

-- ── 1. the table ──────────────────────────────────────────────────────────────────────────────────
create table app.attachment (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  document_id  uuid,                                                  -- lot_id uuid is added by 3A (migration 0031)
  object_key   text not null unique,                                  -- '<tenant_id>/<id>' — server-generated (LEGACY-038)
  file_name    text not null,
  mime_type    text not null,
  byte_size    bigint not null check (byte_size >= 0),
  sha256       bytea not null,                                        -- spec:1067 "SHA-256 recorded per file"
  uploaded_by  uuid not null default app.current_actor() references app.principal(id),
  archived_at  timestamptz,                                           -- spec:2049 master data is archived, never deleted
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id)
);

-- ── 2. lookups ────────────────────────────────────────────────────────────────────────────────────
-- the document panel lists a document's attachments; the export job (7C) walks a company's.
create index attachment_document_idx on app.attachment (document_id) where document_id is not null;
create index attachment_company_idx  on app.attachment (company_id, created_at);

-- ── 3. tenancy, audit, actor stamping (spec:106, spec:1370, §3.3) ─────────────────────────────────
call app_meta.enable_tenant_rls('app.attachment');
call app_meta.attach_audit('app.attachment');                          -- test 13: every upload audited
call app_meta.attach_stamp('app.attachment', 'uploaded_by');           -- LEGACY-044: the server supplies the actor

-- app_rw receives select/insert/update through the default privileges of migration 0001. No DELETE grant:
-- §3.5.4 pins the list and 2B is the only slice that extends it. Removal is `archived_at`.
