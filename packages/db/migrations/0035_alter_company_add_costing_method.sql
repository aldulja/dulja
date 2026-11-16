-- ── 0035. The company's costing method ──────────────────────────────────────────────
-- contracts §4.7.3, last line, verbatim. spec:1214: "v1 costing method: weighted average (AVCO),
-- matching the old system and the business's expectations. ⚠️ Owner to confirm. FIFO is supported by the
-- same layer model … and can be enabled per company later without a schema change."
--
-- OD-06 (contracts §2.12) is the owner's confirmation of the DEFAULT below. Both labels are admitted
-- whatever the answer, because both are implemented (packages/domain/src/costing/engine.ts) — the answer
-- decides which one a newly seeded company starts on.
--
-- A text column with a CHECK rather than a Postgres enum: contracts §3.2's Enumerations rule, and §3.4.4's
-- gotcha — an enum label cannot be referenced in the migration that adds it, and this file's own `default`
-- references the label.
alter table app.company
  add column costing_method text not null default 'avco'
    constraint company_costing_method_check check (costing_method in ('avco', 'fifo'));
-- The constraint is named explicitly, not left to Postgres's generated name, for the reason contracts §4.3.4
-- names for document_line_kind_check: a later slice that widens or drops it must be able to name it, and a
-- generated name is not a contract.
