import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { v7 as uuidv7 } from "uuid";
import type { TenantContext } from "../with-tenant";
import { objectKeyFor, type ObjectStore } from "./object-store";

export { MemoryObjectStore, ObjectKeyError, R2ObjectStore, objectKeyFor } from "./object-store";
export type { ObjectStore, R2ObjectStoreOptions, StoredObject } from "./object-store";

/** `app.document_type.module` (§4.3.4, 2A) — the attachment download gate and nothing else (§4.14). */
export type DocumentTypeModule = "accounting" | "inventory" | "hr" | "pos";

/** 25 MiB. Named so the route, the screen and the OpenAPI description agree on one number. */
export const MAX_ATTACHMENT_BYTES = 26_214_400;

export class AttachmentIntegrityError extends Error {
  readonly code = "ERR_ATTACHMENT_INTEGRITY" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "AttachmentIntegrityError";
  }
}

export interface AttachmentRow {
  id: string;
  companyId: string;
  documentId: string | null;
  /** 3A, migration 0031. Exactly one of `documentId` / `lotId` is non-null (`attachment_owner_check`). */
  lotId: string | null;
  objectKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  uploadedBy: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface NewAttachment {
  companyId: string;
  /** 3A: exactly one of the two is given. The check constraint is migration 0031's, and
   *  `UploadAttachmentBody`'s `.refine` mirrors it so a bad body is a 400 rather than a 500. */
  documentId?: string | null;
  lotId?: string | null;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface DbAttachment {
  id: string;
  company_id: string;
  document_id: string | null;
  lot_id: string | null;
  object_key: string;
  file_name: string;
  mime_type: string;
  byte_size: string;
  sha256: Buffer;
  uploaded_by: string;
  archived_at: Date | null;
  created_at: Date;
}

function toRow(r: DbAttachment): AttachmentRow {
  return {
    id: r.id,
    companyId: r.company_id,
    documentId: r.document_id,
    lotId: r.lot_id,
    objectKey: r.object_key,
    fileName: r.file_name,
    mimeType: r.mime_type,
    byteSize: Number(r.byte_size),
    sha256: r.sha256.toString("hex"),
    uploadedBy: r.uploaded_by,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/** What `stageAttachment` produced and `insertAttachment` records: the minted id, its derived key, the digest. */
export interface StagedAttachment {
  id: string;
  objectKey: string;
  sha256: Buffer;
}

/**
 * The half that touches the OBJECT STORE and no database: mints the id (uuidv7, client-side — the same
 * generator the table's default uses, with no round trip), derives the key from it (LEGACY-038), hashes the
 * bytes and writes the object. Called BEFORE the row's transaction opens, so up to 25 MiB of network I/O
 * holds no row lock and no pooled connection. Object first: a rollback afterwards leaves an unreferenced
 * object that 7C's export never sees, whereas a row without an object would be a 404 in a list.
 */
export async function stageAttachment(
  store: ObjectStore,
  ctx: TenantContext,
  input: NewAttachment,
): Promise<StagedAttachment> {
  const id = uuidv7();
  const objectKey = objectKeyFor(ctx.tenantId, id);
  const sha256 = createHash("sha256").update(input.bytes).digest();
  await store.put(objectKey, input.bytes, input.mimeType);
  return { id, objectKey, sha256 };
}

/**
 * The half that touches the DATABASE: the row for an object `stageAttachment` already wrote. A failed
 * insert removes the staged object on a best-effort basis so the store does not accumulate orphans; the
 * insert's own error is what the caller sees either way.
 */
export async function insertAttachment(
  tx: Sql,
  ctx: TenantContext,
  store: ObjectStore,
  input: NewAttachment,
  staged: StagedAttachment,
): Promise<AttachmentRow> {
  try {
    const [row] = await tx<DbAttachment[]>`
      insert into app.attachment (id, tenant_id, company_id, document_id, lot_id, object_key, file_name, mime_type, byte_size, sha256)
      values (${staged.id}, ${ctx.tenantId}, ${input.companyId}, ${input.documentId ?? null},
              ${input.lotId ?? null}, ${staged.objectKey},
              ${input.fileName}, ${input.mimeType}, ${input.bytes.byteLength}, ${staged.sha256})
      returning id, company_id, document_id, lot_id, object_key, file_name, mime_type, byte_size, sha256,
                uploaded_by, archived_at, created_at`;
    return toRow(row!);
  } catch (error) {
    await store.delete(staged.objectKey).catch(() => undefined);
    throw error;
  }
}

/** Both halves in sequence, for a caller that already holds a transaction (the db-tier tests). The API route
 *  calls the two halves itself so the object write stays outside its row transaction. */
export async function createAttachment(
  tx: Sql,
  ctx: TenantContext,
  store: ObjectStore,
  input: NewAttachment,
): Promise<AttachmentRow> {
  return insertAttachment(tx, ctx, store, input, await stageAttachment(store, ctx, input));
}

/** The row plus what its gate needs — the owning type's module and the owning document's branch — in one
 *  query. Null when RLS hides it or it does not exist. */
export async function getAttachment(
  tx: Sql,
  attachmentId: string,
): Promise<{ row: AttachmentRow; module: DocumentTypeModule; branchId: string | null } | null> {
  const [found] = await tx<
    (DbAttachment & { module: DocumentTypeModule | null; branch_id: string | null })[]
  >`
    select a.id, a.company_id, a.document_id, a.lot_id, a.object_key, a.file_name, a.mime_type,
           a.byte_size, a.sha256, a.uploaded_by, a.archived_at, a.created_at, dt.module, d.branch_id
      from app.attachment a
      left join app.document      d  on d.id  = a.document_id
      left join app.document_type dt on dt.id = d.document_type_id
     where a.id = ${attachmentId} and a.archived_at is null`;
  if (!found) return null;
  // A LOT attachment has no document and therefore no module. `requireAttachmentRead`'s lot branch runs
  // BEFORE the module lookup and supplies `inventory.item.read` itself (§4.5.8), so the fallback below is
  // never the gate for one; it stays as the safe direction for any other document-less row.
  return { row: toRow(found), module: found.module ?? "accounting", branchId: found.branch_id };
}

/**
 * RLS reduces `app.attachment` to the caller's tenant, but not to the modules the caller may read, and
 * `companyId` arrives from the URL. `readCodes` — the §4.5.8 map, module → read code — therefore does the
 * second half of the gate at the ROW level: a DOCUMENT attachment is listed only when the caller holds the
 * read code of its owning type's module AT THE OWNING DOCUMENT'S BRANCH (`app.actor_has(code, company,
 * branch)`, the same predicate the download, print and events gates evaluate), so a branch-restricted
 * reader sees exactly what they may download. A module with no row in the map is denied. `limit` applies
 * after the filter, so a page is never short because of rows the caller may not see.
 *
 * **3A made the join OUTER, as 2C's note here said it would.** A LOT attachment has no document and
 * therefore no module, so an inner join would drop every one of them silently — and a silent drop is how a
 * list becomes a lie. `includeLots` is what admits them, defaulting to `false` so 2C's own assertions are
 * unchanged, and `lotReadCode` is the lot rule's own code (`inventory.item.read`, §4.5.8) evaluated at the
 * company with no branch, because a lot has none. Without a `lotReadCode` no lot row is ever listed: the
 * flag alone is not a gate.
 */
export async function listAttachments(
  tx: Sql,
  params: {
    companyId: string;
    documentId?: string | undefined;
    lotId?: string | undefined;
    includeLots?: boolean | undefined;
    lotReadCode?: string | undefined;
    limit: number;
    readCodes: Readonly<Partial<Record<DocumentTypeModule, string>>>;
  },
): Promise<AttachmentRow[]> {
  const entries = Object.entries(params.readCodes).filter(
    (e): e is [DocumentTypeModule, string] => typeof e[1] === "string" && e[1].length > 0,
  );
  const wantsLots = params.includeLots === true && (params.lotReadCode ?? "").length > 0;
  if (entries.length === 0 && !wantsLots) return [];
  const modules = entries.map(([module]) => module);
  const codes = entries.map(([, code]) => code);
  const rows = await tx<DbAttachment[]>`
    select a.id, a.company_id, a.document_id, a.lot_id, a.object_key, a.file_name, a.mime_type,
           a.byte_size, a.sha256, a.uploaded_by, a.archived_at, a.created_at
      from app.attachment a
      left join app.document      d  on d.id  = a.document_id
      left join app.document_type dt on dt.id = d.document_type_id
      left join unnest(${modules}::text[], ${codes}::text[]) as rc(module, code) on rc.module = dt.module
     where a.company_id = ${params.companyId}
       and a.archived_at is null
       and (${params.documentId ?? null}::uuid is null or a.document_id = ${params.documentId ?? null})
       and (${params.lotId ?? null}::uuid is null or a.lot_id = ${params.lotId ?? null})
       and (
         (a.lot_id is null and rc.code is not null
          and app.actor_has(rc.code, a.company_id, d.branch_id))
         or (a.lot_id is not null and ${wantsLots}
             and app.actor_has(${params.lotReadCode ?? null}::text, a.company_id, null))
       )
     order by a.created_at, a.id limit ${params.limit}`;
  return rows.map(toRow);
}

/** ADR 0031: the stored hash is re-computed on every read; a mismatch is refused, never served. */
export async function readAttachmentContent(
  store: ObjectStore,
  row: AttachmentRow,
): Promise<Uint8Array> {
  const object = await store.get(row.objectKey);
  if (!object) {
    throw new AttachmentIntegrityError(`object ${row.objectKey} is missing in the store`);
  }
  const actual = createHash("sha256").update(object.bytes).digest("hex");
  if (actual !== row.sha256) {
    throw new AttachmentIntegrityError(
      `object ${row.objectKey} does not match the recorded sha256`,
    );
  }
  return object.bytes;
}
