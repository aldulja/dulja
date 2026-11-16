import type { Sql } from "postgres";
import type { HrKeyRing } from "./keys";
import { openField, sealField, SENSITIVE_FIELDS, type SensitiveField } from "./sensitive";

export type SensitiveValues = Partial<Record<SensitiveField, string | null>>;
export interface SensitiveRow {
  employeeId: string;
  keyVersion: number;
  updatedBy: string;
  updatedAt: string;
  values: SensitiveValues;
}
interface Raw {
  employee_id: string;
  key_version: number;
  updated_by: string;
  updated_at: string;
  national_id_enc: Buffer | null;
  passport_enc: Buffer | null;
  date_of_birth_enc: Buffer | null;
  residency_category_enc: Buffer | null;
  bank_account_enc: Buffer | null;
  epf_number_enc: Buffer | null;
  socso_number_enc: Buffer | null;
  tax_number_enc: Buffer | null;
  work_permit_expiry_enc: Buffer | null;
}

/** null means "absent OR hidden by sensitive_gate" — indistinguishable on purpose (spec:2450). */
export async function readSensitive(
  tx: Sql,
  ring: HrKeyRing,
  employeeId: string,
): Promise<SensitiveRow | null> {
  const [row] = await tx<Raw[]>`
    select employee_id, key_version, updated_by,
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
           national_id_enc, passport_enc, date_of_birth_enc, residency_category_enc, bank_account_enc,
           epf_number_enc, socso_number_enc, tax_number_enc, work_permit_expiry_enc
      from app.employee_sensitive where employee_id = ${employeeId}::uuid`;
  if (row === undefined) return null;
  const values: SensitiveValues = {};
  for (const f of SENSITIVE_FIELDS) {
    const sealed = row[`${f}_enc` as const];
    values[f] = sealed === null ? null : openField(ring, row.employee_id, f, sealed);
  }
  return {
    employeeId: row.employee_id,
    keyVersion: row.key_version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    values,
  };
}

/**
 * Upserts the fields present in `values` and leaves the rest alone; an explicit null clears one. Every touched
 * field is sealed under the ring's CURRENT key, and `key_version` is never accepted from a caller.
 *
 * **`key_version` is the OLDEST version any column of the row still carries, not the newest.** A partial write
 * during or after a rotation re-seals only what it touched, so a row whose untouched columns are still version 1
 * must not claim version 2: 8D's `hr.encryption_key.rotate` scans by this column, and a row that over-claimed
 * would be skipped and then become unreadable the day `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` is retired. `least()`
 * holds it down — except on a FULL write, which is what a rotation batch performs: every column is re-sealed, so
 * the row genuinely is at the current version. Decryption never depends on this column — `openField` reads the
 * version from each envelope's own leading byte (ADR 0071).
 *
 * The insert is `insert … select … from app.employee` so `tenant_id` comes from the employee row, never the
 * caller, and an employee the reader cannot see yields no row — a silent no-op rather than a foreign-key error
 * that leaks existence. `updated_by` is in neither list: migration 0081's `stamp_updated_by` trigger stamps the
 * session's actor on every INSERT and UPDATE (amendment A19).
 */
export async function writeSensitive(
  tx: Sql,
  ring: HrKeyRing,
  employeeId: string,
  values: SensitiveValues,
): Promise<void> {
  const version = ring.current().version;
  const sealedOf = (f: SensitiveField): Buffer | null => {
    const v = values[f];
    return v === undefined || v === null ? null : sealField(ring, employeeId, f, v);
  };
  const touched = new Set(SENSITIVE_FIELDS.filter((f) => values[f] !== undefined));
  const full = touched.size === SENSITIVE_FIELDS.length;
  const t = (f: SensitiveField): boolean => touched.has(f);
  await tx`
    insert into app.employee_sensitive (
      employee_id, tenant_id, key_version,
      national_id_enc, passport_enc, date_of_birth_enc, residency_category_enc, bank_account_enc,
      epf_number_enc, socso_number_enc, tax_number_enc, work_permit_expiry_enc)
    select e.id, e.tenant_id, ${version}::smallint,
      ${sealedOf("national_id")}::bytea, ${sealedOf("passport")}::bytea, ${sealedOf("date_of_birth")}::bytea,
      ${sealedOf("residency_category")}::bytea, ${sealedOf("bank_account")}::bytea,
      ${sealedOf("epf_number")}::bytea, ${sealedOf("socso_number")}::bytea, ${sealedOf("tax_number")}::bytea,
      ${sealedOf("work_permit_expiry")}::bytea
      from app.employee e where e.id = ${employeeId}::uuid
    on conflict (employee_id) do update set
      key_version            = case when ${full}::boolean then excluded.key_version
                                    else least(app.employee_sensitive.key_version, excluded.key_version) end,
      updated_at             = now(),
      national_id_enc        = case when ${t("national_id")}::boolean        then excluded.national_id_enc        else app.employee_sensitive.national_id_enc end,
      passport_enc           = case when ${t("passport")}::boolean           then excluded.passport_enc           else app.employee_sensitive.passport_enc end,
      date_of_birth_enc      = case when ${t("date_of_birth")}::boolean      then excluded.date_of_birth_enc      else app.employee_sensitive.date_of_birth_enc end,
      residency_category_enc = case when ${t("residency_category")}::boolean then excluded.residency_category_enc else app.employee_sensitive.residency_category_enc end,
      bank_account_enc       = case when ${t("bank_account")}::boolean       then excluded.bank_account_enc       else app.employee_sensitive.bank_account_enc end,
      epf_number_enc         = case when ${t("epf_number")}::boolean         then excluded.epf_number_enc         else app.employee_sensitive.epf_number_enc end,
      socso_number_enc       = case when ${t("socso_number")}::boolean       then excluded.socso_number_enc       else app.employee_sensitive.socso_number_enc end,
      tax_number_enc         = case when ${t("tax_number")}::boolean         then excluded.tax_number_enc         else app.employee_sensitive.tax_number_enc end,
      work_permit_expiry_enc = case when ${t("work_permit_expiry")}::boolean then excluded.work_permit_expiry_enc else app.employee_sensitive.work_permit_expiry_enc end`;
}
