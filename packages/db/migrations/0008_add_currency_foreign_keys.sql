-- A currency code is policy, not free text. `app.currency` is where `minor_units`, `pos_rounding_increment` and
-- `rounding_mode` live, and `Money` rounds with them — so a code with no row behind it is an amount whose rounding
-- is undefined. Until now all six currency-code columns in the schema — `company.base_currency`,
-- `exchange_rate.from_currency`/`to_currency`, `document.currency`, `ledger_entry.currency` and
-- `account.currency` — were bare `char(3)`: 'XYZ' was storable, `app.rate_for` would return a rate against it,
-- and `toBase` would convert against policy that does not exist. AGENTS.md:3 puts the financial invariants in
-- the data layer, so the refusal belongs here and not in a handler.
--
-- Every key is composite on (tenant_id, <code>) against `unique (tenant_id, code)`. A reference on the code alone
-- would match another tenant's row — the same reason 0001 §5 made every child key composite — and it would also
-- fail the `composite_fk` rule in src/lint-schema.ts.
--
-- Referential-integrity checks bypass row-level security by design, so these keys resolve under `app_rw` without
-- widening any policy; the tenant_id in the key is what keeps them from seeing across the boundary.
--
-- Two things this migration cannot do for itself, because migrations run before anything writes rows:
--   * A tenant must now define its base currency BEFORE its first company. `src/seed/` and `test/fixtures.ts`
--     both insert `app.company` with no `app.currency` row in existence, and both have to insert one first.
--   * `ADD CONSTRAINT` validates the rows already there. On an empty database that is free; over a database
--     seeded before 0008 it fails until every referenced code has a row, so migrating real data forward needs a
--     repair step in front of this file. Not `not valid` — that would leave `convalidated = false` in the
--     catalogue for good, and the column would stay a place where an old bad row can hide.

alter table app.company add constraint company_base_currency_fk
  foreign key (tenant_id, base_currency) references app.currency(tenant_id, code);

alter table app.exchange_rate add constraint exchange_rate_from_currency_fk
  foreign key (tenant_id, from_currency) references app.currency(tenant_id, code);
alter table app.exchange_rate add constraint exchange_rate_to_currency_fk
  foreign key (tenant_id, to_currency) references app.currency(tenant_id, code);

alter table app.document add constraint document_currency_fk
  foreign key (tenant_id, currency) references app.currency(tenant_id, code);

-- The ledger is append-only, but `forbid_change` guards UPDATE and DELETE **of the ledger**. This key guards the
-- other two directions: an insert naming an undefined code, and a DELETE of a currency that entries were posted
-- against. That second one is the point — a currency with history is archived (`archived_at`), never deleted.
alter table app.ledger_entry add constraint ledger_entry_currency_fk
  foreign key (tenant_id, currency) references app.currency(tenant_id, code);

-- `app.account.currency` is the sixth and last bare currency code in the schema: what a foreign-currency bank or
-- receivable account is denominated in. It was not in the brief's list, but it has the identical defect, and it is
-- free to close *today* and only today — the column is nullable, every writer in the tree is
-- `src/seed/chart-of-accounts.ts:75` (`account.currency ?? null`), no pack file sets it and no route reaches
-- app.account at all, so right now every row in every database has null here and MATCH SIMPLE lets them all
-- through. A later migration would have to repair real data first.
alter table app.account add constraint account_currency_fk
  foreign key (tenant_id, currency) references app.currency(tenant_id, code);
