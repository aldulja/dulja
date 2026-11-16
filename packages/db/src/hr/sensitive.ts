import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HrKeyError, type HrKeyRing } from "./keys";

/** The nine §4.12.5 fields, in the column order of migration 0081. Each is stored as `<field>_enc`. */
export const SENSITIVE_FIELDS = [
  "national_id",
  "passport",
  "date_of_birth",
  "residency_category",
  "bank_account",
  "epf_number",
  "socso_number",
  "tax_number",
  "work_permit_expiry",
] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const aad = (employeeId: string, field: SensitiveField): Buffer =>
  Buffer.from(`${employeeId}:${field}`, "utf8");

/** version(1) || nonce(12) || ciphertext || tag(16) — §4.12.5, AES-256-GCM, AAD = `employee_id:column`.
 *  The ONLY module in the repository that calls node:crypto's cipher (ADR 0071). */
export function sealField(
  ring: HrKeyRing,
  employeeId: string,
  field: SensitiveField,
  plaintext: string,
): Buffer {
  const key = ring.current();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(employeeId, field));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([key.version]), nonce, body, cipher.getAuthTag()]);
}

/** Opens one sealed field with the key its own leading byte names. A wrong key, a tampered ciphertext, or a value
 *  moved to another employee or another column fails `decipher.final()` and raises HrKeyError — never an empty
 *  string (ADR 0071). */
export function openField(
  ring: HrKeyRing,
  employeeId: string,
  field: SensitiveField,
  sealed: Buffer,
): string {
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES)
    throw new HrKeyError(`sealed ${field} is ${sealed.length} bytes — too short to be an envelope`);
  const key = ring.forVersion(sealed[0]!);
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const body = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(employeeId, field));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new HrKeyError(
      `sealed ${field} of employee ${employeeId} did not authenticate under key version ${key.version}`,
    );
  }
}
