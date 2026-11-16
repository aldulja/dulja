-- ── 0113 · app.document_line is frozen once its document leaves draft ──────────────────────────────────
-- Phase 4 code-review pass (not a slice); allocated from the §3.4.1 tail (register row 0113–0115).
--
-- spec:574 (LEGACY-041) "issued financial documents are immutable"; spec:501 and 2223 (LEGACY-031) "immutability is
-- enforced on the whole document aggregate (header + lines + projections)"; spec:2049 "Financial rows: never —
-- reversal only"; spec:2173 makes the data layer, not the handler, the control. 0023 guarded DELETE at the
-- draft boundary and nothing guarded INSERT or UPDATE, so an app_rw session could rewrite the amount and the
-- account of a POSTED line — and reverseDocument then mirrored the tampered line, not the ledger — add a line
-- to a posted document, or re-key an APPROVED payment after the checker approved it (R1's premise is that the
-- approver approves the figures that will post). `PUT …/lines` refused a non-draft only in its handler.
--
-- The one column that may still change after draft is `cost`, and only at the statuses its two writers run
-- at — contracts §4.3.2's closed list ("document_line: cost only, 3A+") and ADR 0038 note 2:
--   issued            applyMovements, postDocument step 9, after step 7 issued the document and before step 13
--                     marks it posted (packages/db/src/costing/apply-movements.ts) — and ONLY there, inside the
--                     posting transaction: the document carries step 8's `posting_seq` and the line already has
--                     the `inventory_movement` step 9 inserts before it writes the cost. An issued document
--                     outside a posting transaction has neither. Without this, `issued` admitted a cost from
--                     anyone at any time, and applyMovements' receipt-value branch 1 (`line.cost` set → the
--                     layer's value) then priced the post from it: the maker of an approved, issued STOCK_COUNT
--                     re-keyed its surplus's value before the checker posted it, and R1 approved a figure that
--                     did not post (code review 3, R2);
--   posted, reversed  the cost replay, which rewrites the CURRENT answer (packages/db/src/costing/replay.ts).
-- Every other post-draft writer in the tree INSERTs onto a draft it has just created (reverseDocument's mirror,
-- the replay's COST_ADJUSTMENT, the 4A conversions) or UPDATEs a draft it has checked (link.ts'
-- priceFromSource, count.ts' recordCounts, PUT …/lines), and none of them is touched by this file.
--
-- A LATER expand/contract migration that backfills a new column on non-draft lines must amend this guard in
-- its own migration — the trigger may never be disabled, not even for a backfill (AGENTS.md). The freeze
-- compares whole rows (`to_jsonb(new) - 'cost'`), so a column a later slice adds is frozen with no edit here.
--
-- Residuals this file does not close: any app_rw principal may still rewrite `cost` on a posted line,
-- because the replay is itself app_rw; and an app_rw session that inserts an `inventory_movement` row by hand
-- (the posting service's INSERT grant, which the posting-only-tables lint and nothing in the database confines
-- to postDocument) and sets `posting_seq` can still write `cost` on an issued line. Closing either needs a
-- SECURITY DEFINER writer or another design — an ADR.
--
-- One status earlier, every column of a DRAFT line is writable — its `cost`, its `amount` and its two count
-- columns alike — and applyMovements prices a receipt from a `cost` standing on the line (branch 1) or from
-- its `amount` (branch 3). A COUNTED line (both count columns set: a STOCK_COUNT surplus, a TRANSFER_RECEIPT)
-- is valued from the layers or the dispatch whatever figure stands on it (code review 3, R2). The count
-- columns are no control on their own: the draft write that sets `cost` or `amount` can clear one of them,
-- which also drops the line from readCountSheet. So under an approval-required policy postDocument's step 6g
-- refuses a line that moves stock, whose rules chose its direction from the sign of its variance and which
-- lacks either count column, and step 6e refuses a moved line that meets no rule (a line whose `kind` the
-- maker changed). What remains: a custom approval-required type whose receipt line is neither counted nor
-- sign-chosen (a GOODS_RECEIPT under `approval.required`, say) is still priced from a `cost` its maker wrote
-- by hand at draft, a column the API never writes and shows only to `inventory.cost.read`. Confining branch 1 to reversal mirrors
-- would change §4.7.2's receipt-value rule, and `reverses_document_id` is a draft column too — an ADR's call.

create function app.document_line_frozen_after_draft() returns trigger language plpgsql as $$
declare
  v_status     app.document_status;
  v_old_status app.document_status;
begin
  -- The parent the row belongs to AFTER this write. NULL means the parent is not visible: the composite FK
  -- (tenant_id, document_id) answers that case, exactly as 0023's delete guard leaves it to the cascade.
  select d.status into v_status from app.document d where d.id = new.document_id;
  if v_status = 'draft' then
    -- Re-read under a row lock, so an edit and a concurrent issue or post of the same document serialise:
    -- issue and post take FOR NO KEY UPDATE / FOR UPDATE on the document, which FOR SHARE conflicts with,
    -- and the lock-wait re-reads the committed status. Only drafts are locked — a non-draft never returns to
    -- draft, and locking there would add deadlock edges between the cost replay and reverseDocument.
    select d.status into v_status from app.document d where d.id = new.document_id for share;
  end if;

  if tg_op = 'INSERT' then
    if v_status is not null and v_status <> 'draft' then
      raise exception 'ERR_DOC_NOT_DRAFT: document % is %; a line can be added only to a draft (spec:574, 2224)',
        new.document_id, v_status using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE that moves the line to another document: both documents must be drafts. Otherwise a draft line
  -- could be re-parented onto a posted document, which is the INSERT above by another route.
  if new.document_id is distinct from old.document_id then
    select d.status into v_old_status from app.document d where d.id = old.document_id;
    if v_old_status = 'draft' then
      select d.status into v_old_status from app.document d where d.id = old.document_id for share;
    end if;
    if (v_status is not null and v_status <> 'draft')
       or (v_old_status is not null and v_old_status <> 'draft') then
      raise exception 'ERR_DOC_NOT_DRAFT: a line moves from document % (%) to document % (%); only between drafts (spec:574, 2224)',
        old.document_id, v_old_status, new.document_id, v_status using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if v_status is null or v_status = 'draft' then
    return new;
  end if;

  -- A non-draft line: every column but `cost` is frozen, whole-row, so no column list here can go stale.
  if (to_jsonb(new) - 'cost') is distinct from (to_jsonb(old) - 'cost') then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is %; its line % cannot be changed — an issued document is voided and a posted one is reversed (spec:574, 2049, 2224)',
      new.document_id, v_status, old.line_no using errcode = 'check_violation';
  end if;
  if new.cost is distinct from old.cost then
    if v_status = 'issued' then
      -- Inside the posting transaction only (the header comment's `issued` row): step 8 has numbered the
      -- document and step 9 has inserted this line's movement. Two facts, because `posting_seq` alone is one
      -- UPDATE of the header away from anyone, and a movement is a row of the posting service's own table.
      if not exists (select 1 from app.document d where d.id = new.document_id and d.posting_seq is not null)
         or not exists (select 1 from app.inventory_movement m
                         where m.tenant_id = new.tenant_id and m.document_id = new.document_id
                           and m.line_no = new.line_no) then
        raise exception 'ERR_DOC_NOT_DRAFT: document % is issued; document_line.cost is written at issued only inside the posting transaction, by postDocument step 9 once step 8 has set posting_seq and the line has its movement (contracts §4.3.2, spec:2173)',
          new.document_id using errcode = 'check_violation';
      end if;
    elsif v_status not in ('posted', 'reversed') then
      raise exception 'ERR_DOC_NOT_DRAFT: document % is %; document_line.cost is written only by the posting service at issued and by the cost replay at posted or reversed (contracts §4.3.2, ADR 0038)',
        new.document_id, v_status using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
comment on function app.document_line_frozen_after_draft() is
  'Code review 2 (Phase 4): refuses INSERT into, and UPDATE of, a line of a non-draft document, except a cost '
  'change at issued inside the posting transaction (applyMovements, once posting_seq is set and the line has '
  'its movement; code review 3) or at posted/reversed (the cost replay). ERR_DOC_NOT_DRAFT. A backfill of a '
  'new column on non-draft lines amends this function in its own migration; the trigger is never disabled.';

-- BEFORE triggers fire in name order, so this runs AFTER document_line_base_quantity (0032) and sees the
-- derived base quantity: a re-keyed unit_quantity on a posted line is refused through the quantity it derives.
create trigger document_line_frozen_after_draft before insert or update on app.document_line
  for each row execute function app.document_line_frozen_after_draft();
