// spec:2273 — "the HR field-encryption key (§4.6, rotated with re-encryption as a pg-boss job)". ADR 0080.
//
// The whole correctness argument is that this file re-uses 8A's envelope unchanged: `openField` reads the version out
// of each value's own byte 0 and asks the ring for THAT key, `sealField` writes under the ring's current one. Nothing
// here parses an envelope beyond reading that one byte, and nothing here touches node:crypto.
import type { Sql } from "postgres";
import type { HrKeyRing } from "./keys";
import { openField, sealField, SENSITIVE_FIELDS, type SensitiveField } from "./sensitive";

/** One batch's outcome. `lastEmployeeId` is the keyset cursor for the next batch; null when the batch was empty. */
export interface RotationBatch {
  scanned: number;
  rotated: number;
  lastEmployeeId: string | null;
}
/** A whole rotation's outcome, accumulated by the `hr.encryption_key.rotate` handler over its batches. */
export interface RotationResult {
  batches: number;
  scanned: number;
  rotated: number;
}
export interface RotationBatchOptions {
  /** Rows per batch — one short transaction each (spec:1368). */
  batchSize: number;
  /** The keyset cursor: the batch starts after this employee id. Null for the first batch. */
  afterEmployeeId: string | null;
  /** Narrow the rotation to one company's employees. Omitted: every employee the tenant session can see. */
  companyId?: string | null;
}

type Columns = Record<`${SensitiveField}_enc`, Buffer | null>;
interface Raw extends Columns {
  employee_id: string;
  key_version: number;
}

const column = (f: SensitiveField): `${SensitiveField}_enc` => `${f}_enc`;

/**
 * Re-seals ONE batch of `app.employee_sensitive` rows whose `key_version` is below the ring's current version, and
 * returns the cursor for the next batch.
 *
 * - **Per column, not per row.** Each value is opened under the version in its own envelope byte, so a row half-moved
 *   by a partial write (`writeSensitive` re-seals only what it touched, and `key_version` records the OLDEST version
 *   any column still carries — ADR 0071) is repaired rather than refused. A value already at the current version is
 *   kept byte for byte.
 * - **A NULL stays NULL.** Sealing the empty string would turn "no passport on file" into "a blank passport".
 * - **Idempotent.** `key_version < current` is the selection predicate: a row a completed batch advanced is never
 *   selected again, so a re-run after a crash is a no-op over everything already done. It is not an optimisation.
 * - **No lost update.** The batch's rows are read `for update`, so an HR clerk's concurrent `writeSensitive` waits for
 *   this batch's commit and then applies over the re-sealed row, instead of being overwritten by the old value.
 * - **Refuses loudly.** A value sealed under a version the ring does not carry raises `HrKeyError` from `openField`
 *   and the batch's transaction rolls back — the rotation never writes a value it could not open.
 *
 * `updated_by` is in no list here: 0081's `stamp_updated_by` trigger stamps the session's actor (the job runs as the
 * tenant's system principal, hazard 20), and the `audit_row` trigger records the update under that principal.
 */
export async function rotateSensitiveBatch(
  tx: Sql,
  ring: HrKeyRing,
  opts: RotationBatchOptions,
): Promise<RotationBatch> {
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1)
    throw new RangeError(`batchSize must be a positive integer; received ${opts.batchSize}`);
  const current = ring.current().version;
  const companyId = opts.companyId ?? null;
  // Keyset on employee_id, so a batch never re-reads a row a previous batch already advanced, and a row written
  // mid-rotation at the current version is simply not selected.
  const rows = await tx<Raw[]>`
    select s.employee_id, s.key_version,
           s.national_id_enc, s.passport_enc, s.date_of_birth_enc, s.residency_category_enc, s.bank_account_enc,
           s.epf_number_enc, s.socso_number_enc, s.tax_number_enc, s.work_permit_expiry_enc
      from app.employee_sensitive s
     where s.key_version < ${current}::smallint
       and (${opts.afterEmployeeId}::uuid is null or s.employee_id > ${opts.afterEmployeeId}::uuid)
       and (${companyId}::uuid is null
            or exists (select 1 from app.employee e where e.id = s.employee_id and e.company_id = ${companyId}::uuid))
     order by s.employee_id
     limit ${opts.batchSize}
       for update of s`;
  if (rows.length === 0) return { scanned: 0, rotated: 0, lastEmployeeId: null };

  let rotated = 0;
  for (const row of rows) {
    const next = {} as Columns;
    for (const field of SENSITIVE_FIELDS) {
      const sealed = row[column(field)];
      if (sealed === null) {
        next[column(field)] = null;
        continue;
      }
      // Open first, ALWAYS — even a value already at the current version — so a value that does not authenticate
      // (tampered, moved, or sealed under a key the ring lacks) refuses the batch instead of being carried forward.
      const plaintext = openField(ring, row.employee_id, field, sealed);
      next[column(field)] =
        sealed[0] === current ? sealed : sealField(ring, row.employee_id, field, plaintext);
    }
    await tx`
      update app.employee_sensitive
         set national_id_enc        = ${next.national_id_enc}::bytea,
             passport_enc           = ${next.passport_enc}::bytea,
             date_of_birth_enc      = ${next.date_of_birth_enc}::bytea,
             residency_category_enc = ${next.residency_category_enc}::bytea,
             bank_account_enc       = ${next.bank_account_enc}::bytea,
             epf_number_enc         = ${next.epf_number_enc}::bytea,
             socso_number_enc       = ${next.socso_number_enc}::bytea,
             tax_number_enc         = ${next.tax_number_enc}::bytea,
             work_permit_expiry_enc = ${next.work_permit_expiry_enc}::bytea,
             key_version            = ${current}::smallint,
             updated_at             = now()
       where employee_id = ${row.employee_id}::uuid`;
    rotated += 1;
  }
  return { scanned: rows.length, rotated, lastEmployeeId: rows[rows.length - 1]!.employee_id };
}
