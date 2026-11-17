import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { ObjectStore } from "../attachment/object-store";
import { tarGz, toCsv, toJson, type TarEntry } from "./archive";
import { exportSchemaDocument } from "./schema";
import type { ExportJobRow } from "./store";
import { resolveExportGates } from "./tables";

export interface ExportManifestTable {
  name: string;
  rowCount: number;
  gate: string | null;
  files: string[];
}
/** One attachment whose bytes are in the archive. Its object-store key is NOT here: a store key never
 *  reaches the wire (LEGACY-038, `NEVER_EXPORTED.attachment`); `path` is where the bytes are in the archive. */
export interface ExportManifestAttachment {
  id: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  path: string;
}
export type ExportAttachmentOmission = "module_not_readable" | "object_missing" | "digest_mismatch";
export interface ExportManifest {
  formatVersion: 1;
  exportJobId: string;
  companyId: string;
  generatedAt: string;
  format: "csv" | "json" | "both";
  tables: ExportManifestTable[];
  excluded: { table: string; gate: string }[];
  /** Rows kept out of a table that IS in the archive: a gated module's documents' rows (Phase 8 review — the `hr`
   *  documents without `hr.payroll.read`). Empty when the requester holds every module gate. */
  excludedRows: { table: string; gate: string; module: string }[];
  attachments: ExportManifestAttachment[];
  attachmentsOmitted: { id: string; reason: ExportAttachmentOmission }[];
}
export interface ExportResult {
  bytes: Uint8Array;
  sha256: Uint8Array;
  manifest: ExportManifest;
  tableCount: number;
  rowCount: number;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** `attachments/<id>-<file name>`, with anything a tar reader or a file system would choke on replaced and
 *  the length bounded so the path fits USTAR's 100-byte name. The id prefix is what makes the name unique;
 *  the original name survives in `manifest.attachments[].fileName`. */
function attachmentPath(id: string, fileName: string): string {
  const safe = fileName.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `attachments/${id}-${safe}`;
}

interface AttachmentCandidate {
  id: string;
  object_key: string;
  file_name: string;
  byte_size: string;
  sha256: string;
  module: string | null;
  is_lot: boolean;
}

/**
 * Opens ONE short tenant transaction, runs `fn` in it and commits — the caller's `withTenant` bound to its
 * principal, e.g. `(fn) => withTenant(sql, ctx, fn)`. `runExport` calls it once, for the database half only.
 */
export type ExportReadTransaction = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;

/** What the database half reads: every table entry and the attachment rows, in archive order, with each
 *  attachment's readability already decided from the job's RECORDED gates. */
interface ExportSnapshot {
  entries: TarEntry[];
  tables: ExportManifestTable[];
  excluded: { table: string; gate: string }[];
  excludedRows: { table: string; gate: string; module: string }[];
  rowCount: number;
  attachments: (AttachmentCandidate & { readable: boolean })[];
}

/**
 * Builds the archive for one `export_job` row (spec:2186, spec:1067, ADR 0069), in two halves:
 *
 * 1. **the rows**, through `read` — one short tenant transaction that reads the gates, `schema.json`, every
 *    included table and the attachment ROWS, and commits;
 * 2. **the bytes**, through `store`, after that transaction has committed — never inside it (hazard 20,
 *    spec:1368; Phase 7 review, finding 5). One `withTenant` around the whole function held an `app_rw`
 *    connection and its snapshot open across every object-store round-trip, one per attachment.
 *
 * It writes NOTHING: the caller decides where the archive goes, which keeps `packages/db` free of the worker's
 * wiring and makes the function testable without a store round-trip.
 *
 * **What is deterministic, exactly.** The output is a function of the rows the included tables hold, the job
 * row (its id, format and recorded gates), `generatedAt` and the attachment bytes: run twice over the same
 * state with the same `generatedAt`, it returns the same bytes. Two DIFFERENT jobs never do — the manifest
 * names its own job — and when the requester holds `admin.audit_log.read`, `tables/audit_log.*` carries the
 * earlier exports' own status writes, which are part of the books' audit trail, not noise. The tables are read
 * one statement at a time under the read transaction's `read committed` isolation, so an export taken while
 * other requests post is not one snapshot across tables (ADR 0069's Consequences). An attachment's bytes are
 * fetched after the rows are read: an object removed or replaced in between is named in
 * `attachmentsOmitted` (`object_missing`, `digest_mismatch`), never shipped under a digest it does not have.
 */
export async function runExport(
  read: ExportReadTransaction,
  store: ObjectStore,
  input: { job: ExportJobRow; tenantId: string; generatedAt: string },
): Promise<ExportResult> {
  const { job } = input;
  const snapshot = await read((tx) => readExportRows(tx, input));
  const { entries, tables } = snapshot;

  const attachments: ExportManifestAttachment[] = [];
  const attachmentsOmitted: ExportManifest["attachmentsOmitted"] = [];
  for (const row of snapshot.attachments) {
    if (!row.readable) {
      attachmentsOmitted.push({ id: row.id, reason: "module_not_readable" });
      continue;
    }
    const stored = await store.get(row.object_key);
    if (stored === null) {
      attachmentsOmitted.push({ id: row.id, reason: "object_missing" });
      continue;
    }
    // The manifest states the RECORDED digest (spec:1067), so bytes that no longer match it are named
    // rather than shipped under a digest they do not have.
    if (hex(stored.bytes) !== row.sha256) {
      attachmentsOmitted.push({ id: row.id, reason: "digest_mismatch" });
      continue;
    }
    const path = attachmentPath(row.id, row.file_name);
    entries.push({ path, bytes: stored.bytes });
    attachments.push({
      id: row.id,
      fileName: row.file_name,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      path,
    });
  }

  const manifest: ExportManifest = {
    formatVersion: 1,
    exportJobId: job.id,
    companyId: job.companyId,
    generatedAt: input.generatedAt,
    format: job.format,
    tables,
    excluded: snapshot.excluded,
    excludedRows: snapshot.excludedRows,
    attachments,
    attachmentsOmitted,
  };
  // manifest.json last: it describes every entry before it, and its order is fixed like the rest.
  entries.push({ path: "manifest.json", bytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`) });

  const bytes = tarGz(entries);
  return {
    bytes,
    sha256: new Uint8Array(createHash("sha256").update(bytes).digest()),
    manifest,
    tableCount: tables.length,
    rowCount: snapshot.rowCount,
  };
}

/** The database half of `runExport`: everything it reads, inside the caller's one read transaction. No object
 *  store call happens here — `runExport` fetches the bytes after this transaction has committed. */
async function readExportRows(
  tx: Sql,
  input: { job: ExportJobRow; generatedAt: string },
): Promise<ExportSnapshot> {
  const { job } = input;
  // The REQUESTER's authority, never the acting principal's: the job runs as the tenant's system principal,
  // which holds every code (ADR 0070).
  const { included, excluded, excludedRows, scope } = await resolveExportGates(tx, {
    principalId: job.requestedBy,
    companyId: job.companyId,
  });

  const entries: TarEntry[] = [];
  const tables: ExportManifestTable[] = [];
  let rowCount = 0;

  // schema.json first, so a reader can parse the layout before anything else.
  const schema = await exportSchemaDocument(tx, {
    companyId: job.companyId,
    tables: included,
    generatedAt: input.generatedAt,
  });
  entries.push({ path: "schema.json", bytes: utf8(`${JSON.stringify(schema, null, 2)}\n`) });

  for (const table of included) {
    const rows = await table.rows(tx, job.companyId, scope);
    const files: string[] = [];
    if (job.format === "csv" || job.format === "both") {
      const path = `tables/${table.name}.csv`;
      files.push(path);
      entries.push({ path, bytes: utf8(toCsv(table.columns, rows)) });
    }
    if (job.format === "json" || job.format === "both") {
      const path = `tables/${table.name}.json`;
      files.push(path);
      entries.push({ path, bytes: utf8(toJson(rows)) });
    }
    tables.push({ name: table.name, rowCount: rows.length, gate: table.gate, files });
    rowCount += rows.length;
  }

  if (!job.includeAttachments) {
    return {
      entries,
      tables,
      excluded: [...excluded],
      excludedRows: [...excludedRows],
      rowCount,
      attachments: [],
    };
  }
  // The requester's RECORDED modules decide which attachments leave (§4.5.8, ADR 0070): `MODULE_READ_CODE`
  // lives in `apps/api`, which this package may not import, and the job's own principal holds every code.
  // A lot attachment is the separate `inventory.item.read` rule, recorded as `lot_attachments`.
  const candidates = await tx<AttachmentCandidate[]>`
    select a.id, a.object_key, a.file_name, a.byte_size::text as byte_size,
           encode(a.sha256, 'hex') as sha256, dt.module::text as module, (a.lot_id is not null) as is_lot
      from app.attachment a
      left join app.document      d  on d.id  = a.document_id
      left join app.document_type dt on dt.id = d.document_type_id
     where a.company_id = ${job.companyId}::uuid and a.archived_at is null
     order by a.created_at, a.id`;
  const modules = new Set(job.readableModules);
  return {
    entries,
    tables,
    excluded: [...excluded],
    excludedRows: [...excludedRows],
    rowCount,
    // `getAttachment`'s fallback: a document-less, lot-less row is judged as `accounting`.
    attachments: candidates.map((row) => ({
      ...row,
      readable: row.is_lot ? job.lotAttachments : modules.has(row.module ?? "accounting"),
    })),
  };
}
