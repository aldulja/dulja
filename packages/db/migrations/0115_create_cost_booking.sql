-- 0115_create_cost_booking.sql
-- The Phase 4 code-review pass (not a slice), under Plan Contracts §3.4.1's tail rule: registered as the
-- third number of that branch's 0113–0115 row before this file existed. ADR 0038 decisions 4 and 5; findings
-- C1 and C2 of the second code review.
--
-- What the ledger carries for one ISSUE movement's cost, and whether that figure is settled. The cost replay
-- (packages/db/src/costing/replay.ts) books a COST_ADJUSTMENT of `after − before` per movement, and before this
-- table it derived both from app.cost_consumption: a movement was "still to do" while its consumption rows were
-- invalidated, and "before" was the latest invalidated generation. Neither survives the cases that matter:
--   - a run that recosted a movement and could not book it (no open period — the incident path — or a crash
--     between the forward pass and the adjustment) left VALID rows behind, so the next run found nothing in
--     scope and the difference was never posted (C1);
--   - a generation with no consumption row at all — an issue no open layer covered — leaves no trace, because
--     cost_consumption.quantity > 0 and layer_id is NOT NULL (0034), so the next run compared against an OLDER
--     generation and booked the same reversal again, every run (C2).
-- A row per movement is not ADR 0038's rejected per-ITEM watermark: nobody "remembers to set" it. It is written
-- by the same statements that invalidate or rewrite that movement's consumptions, on the same transaction.
--
-- Derived, like cost_layer and cost_consumption: AUDIT_EXEMPT (lint-schema.ts) and no *_by column, because a
-- booking is arithmetic over movements, not something a principal did. Nothing in this migration writes a row:
-- FORCE ROW LEVEL SECURITY binds app_migrator and a migration has no tenant set.

create table app.cost_booking (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  -- An ISSUE movement (quantity < 0): a receipt's value is immutable and is never recosted (decision 1). The
  -- costing code writes company_id from the movement row itself, which is what binds the two.
  movement_id  uuid not null,
  -- What the ledger carries for this movement's cost: its immutable inventory_movement.value magnitude until a
  -- replay books a difference, then the value that replay booked. A magnitude, like cost_consumption.value.
  booked_value numeric(19,4) not null check (booked_value >= 0),
  -- null      settled: the ledger carries the current answer.
  -- 'recost'  the consumption set is not current (a back-dated post or a replay invalidated it) and the
  --           forward pass must recompute it; the replay starts no later than the earliest such movement.
  -- 'booking' the forward pass has recomputed it and the difference from booked_value is not yet posted.
  pending      text check (pending in ('recost', 'booking')),
  booked_at    timestamptz,                                  -- the last replay booking, null until one
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, movement_id),                           -- one booking per movement; the upserts' conflict key
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, movement_id) references app.inventory_movement(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.cost_booking');
-- No attach_audit (AUDIT_EXEMPT) and no attach_stamp (no *_by column), for cost_layer's reasons (0034).

-- The replay's two reads: the rows still to recompute (its start) and the rows still to book (its step 4).
create index cost_booking_pending_idx on app.cost_booking (company_id, pending) where pending is not null;

-- app_rw receives select, insert and update through app_migrator's default privileges (plan0A:2564). DELETE is
-- not granted: contracts §3.5.4 pins that list, and a settled booking is updated, never removed.
