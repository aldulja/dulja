import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { PostingError } from "./errors";
import { issueDocument } from "./issue";

/** contracts §4.3.1 — the seven labels of `app.document_status` (migration 0001). 1A never exported the type,
 *  so it lives here beside the first function whose signature needs it. */
export type DocumentStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "issued"
  | "void"
  | "posted"
  | "reversed";

/**
 * The two transaction settings `app.document_status_after()` reads (contracts §4.5.2). They are the convention
 * for spec:2172's "reason from a transaction setting": `set_config(…, true)` is transaction-local, so the value
 * dies with the transaction and can never leak into the next request on a pooled connection.
 *
 * Both are always written, never only one — otherwise a second transition in the same transaction would
 * silently inherit the first one's reason.
 */
export async function setEventContext(
  tx: Sql,
  input: { reason?: string | null; attributedTo?: string | null },
): Promise<void> {
  await tx`select set_config('app.event_reason', ${input.reason ?? ""}, true),
                  set_config('app.event_attributed_to', ${input.attributedTo ?? ""}, true)`;
}

export interface TransitionResult {
  documentId: string;
  from: DocumentStatus;
  to: DocumentStatus;
  eventId: string;
  number?: bigint;
}

/**
 * Every status change other than post, void and reverse (contracts §4.5.4). It performs no check of its own:
 * the BEFORE UPDATE OF status trigger applies the matrix, R1 and R2, and the AFTER trigger writes the event
 * (ADR 0029). `to: "issued"` delegates to `issueDocument`, which owns the advisory lock and the numbering
 * (contracts §4.3.6) — a bare `update … set status = 'issued'` would leave the document numberless.
 *
 * Throws `ERR_NOT_FOUND` when the document is invisible under RLS; every other failure arrives as a Postgres
 * error carrying an `ERR_*` token, which `apps/api`'s `fromDatabaseError` maps to the wire `Problem`.
 */
export async function transitionDocument(
  tx: Sql,
  ctx: TenantContext,
  input: {
    documentId: string;
    to: Exclude<DocumentStatus, "posted" | "void" | "reversed">;
    reason?: string;
    attributedTo?: string;
  },
): Promise<TransitionResult> {
  const [before] = await tx<{ status: DocumentStatus }[]>`
    select status::text as status from app.document where id = ${input.documentId} for update`;
  if (!before) {
    throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  }

  await setEventContext(tx, {
    reason: input.reason ?? null,
    attributedTo: input.attributedTo ?? null,
  });

  let number: bigint | undefined;
  if (input.to === "issued") {
    ({ number } = await issueDocument(tx, ctx, { documentId: input.documentId }));
  } else {
    await tx`update app.document set status = ${input.to}::app.document_status where id = ${input.documentId}`;
  }

  // uuidv7 is time-ordered, so `order by id desc` is the insertion order — `occurred_at` cannot be, because
  // now() is the transaction start and every event written in one transaction shares it.
  const [event] = await tx<{ id: string }[]>`
    select id from app.document_event
     where document_id = ${input.documentId} and event_kind = 'transition'
     order by id desc limit 1`;
  if (!event) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      `document ${input.documentId} recorded no transition event`,
    );
  }

  // Cleared so a later statement in the same transaction cannot inherit this reason.
  await setEventContext(tx, {});

  return {
    documentId: input.documentId,
    from: before.status,
    to: input.to,
    eventId: event.id,
    ...(number === undefined ? {} : { number }),
  };
}

/** contracts §4.3.1. The three codes the system will ever put on an override event. */
export type OverrideCode =
  | "inventory.negative_stock.override"
  | "accounting.credit_limit.override"
  | "pos.ticket.override";

/**
 * The override door (contracts §4.5.3, R8 spec:2179). This is the ONE place in the codebase that inserts a
 * `document_event` row directly; `document_event_override_guard` is what makes that safe — it refuses the row
 * unless `attributed_to ?? actor_id` holds `code` at the document's branch and is neither the document's
 * `created_by` nor its `attributed_to` (SAH-027, SAH-048).
 *
 * Back office: `attributedTo` is omitted and the acting principal is the second principal. POS (6C): the
 * terminal acts and `attributedTo` is the supervisor whose PIN authorised it (spec:1324, hazard 19).
 *
 * An `accounting.credit_limit.override` approves an AMOUNT (code review 2026-09-29): 0045's
 * `document_event_credit_override_amount` stamps the document's base total on the event, and credit control
 * admits the document only while its base total does not exceed it. The same trigger refuses one on a
 * document that is no longer draft, submitted or approved (ERR_DOC_STATUS_ILLEGAL) — the control fires at
 * `→ issued`, so an override recorded later approves nothing.
 *
 * An `inventory.negative_stock.override` approves the document's STOCK LINES (code review 2, migration 0114):
 * `document_event_stock_override_digest` stamps `app.document_stock_digest` on the event, and both consumers
 * (`app.assert_stock_available`, `applyMovements`) admit a shortfall only through `app.stock_override_admits`,
 * i.e. while the lines still match. It may be recorded up to `issued` (acceptance test 7 records it there) and
 * is refused on a posted, void or reversed document. Re-keying the lines after it means recording it again.
 */
export async function recordOverride(
  tx: Sql,
  ctx: TenantContext,
  input: { documentId: string; code: OverrideCode; reason: string; attributedTo?: string },
): Promise<{ eventId: string }> {
  const [doc] = await tx<
    { id: string }[]
  >`select id from app.document where id = ${input.documentId}`;
  if (!doc) {
    throw new PostingError("ERR_NOT_FOUND", `no document ${input.documentId} in this tenant`);
  }

  const [row] = await tx<{ id: string }[]>`
    insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status,
                                    override_code, attributed_to, reason)
    select ${ctx.tenantId}, d.company_id, d.id, 'override', d.status, d.status,
           ${input.code}, ${input.attributedTo ?? null}, ${input.reason}
      from app.document d where d.id = ${input.documentId}
    returning id`;
  return { eventId: row!.id };
}

export interface DocumentEventRow {
  id: string;
  eventKind: "transition" | "override";
  fromStatus: DocumentStatus;
  toStatus: DocumentStatus;
  overrideCode: string | null;
  actorId: string;
  attributedTo: string | null;
  occurredAt: string;
  reason: string | null;
}

/** The document's timeline, oldest first. Ordered by `id` for the reason `transitionDocument` gives above. */
export async function listDocumentEvents(tx: Sql, documentId: string): Promise<DocumentEventRow[]> {
  return tx<DocumentEventRow[]>`
    select id,
           event_kind                                as "eventKind",
           from_status::text                         as "fromStatus",
           to_status::text                           as "toStatus",
           override_code                             as "overrideCode",
           actor_id                                  as "actorId",
           attributed_to                             as "attributedTo",
           to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "occurredAt",
           reason
      from app.document_event
     where document_id = ${documentId}
     order by id`;
}
