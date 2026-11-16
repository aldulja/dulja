// packages/domain/src/tax/einvoice.ts
//
// The e-invoicing PORT (§4.9.3 with the 2026-10-02 additive receipt/auth amendment)
// and the profile types of ADR 0052.
//
// This file is PURE: no `node:` import, no `fetch`, no filesystem. `packages/contracts` imports
// `packages/domain` and `apps/backoffice` bundles `packages/contracts` with Vite, so a `node:crypto`
// import here breaks the browser build. Hashing lives in `packages/db/src/einvoice/` (§4.2.1's
// "pure TS, no I/O, no framework").
//
// NOTHING in this file names an authority's endpoint, header, field or version (hazard 2, spec:2226).

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { DocumentSnapshot } from "../posting/evaluate";
import schema from "../../einvoice-profile.schema.json" with { type: "json" };

// ── §4.9.3 and its additive receipt amendment ─────────────────────────────────────────────────

export interface EInvoiceDocument {
  documentId: string;
  number: string;
  issuedAt: string;
  supplier: unknown;
  buyer: unknown;
  lines: unknown[];
  totals: unknown;
  hash: string /* sha256 of the canonical payload; authority transport hashes encoded document bytes */;
}

export type TransmissionStatus =
  | "pending"
  | "submitted"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "error";

export interface EInvoiceCredentials {
  readonly clientId: string;
  readonly secretRef: string /* name of the Cloudflare secret, never the value */;
}

export interface EInvoiceTransmitter {
  readonly jurisdiction: "MY";
  canonicalise(doc: DocumentSnapshot): EInvoiceDocument;
  qrPayload(doc: EInvoiceDocument, receipt: { externalId: string; raw?: unknown }): string;
  submit(
    doc: EInvoiceDocument,
    credentials: EInvoiceCredentials,
  ): Promise<{ externalId: string; status: TransmissionStatus; raw: unknown }>;
  poll(
    externalId: string,
    credentials: EInvoiceCredentials,
  ): Promise<{ status: TransmissionStatus; raw: unknown }>;
  cancel(
    externalId: string,
    reason: string,
    credentials: EInvoiceCredentials,
  ): Promise<{ status: TransmissionStatus; raw: unknown }>;
}

// ── ADR 0052 — the six labels as data, and the two function types a profile needs ─────────────

/** Registry order, matching the CHECK in migration 0057 and the Zod enum in §4.2.8's DTOs. */
export const TRANSMISSION_STATUSES: readonly TransmissionStatus[] = [
  "pending",
  "submitted",
  "accepted",
  "rejected",
  "cancelled",
  "error",
];

const STATUS_SET: ReadonlySet<string> = new Set<string>(TRANSMISSION_STATUSES);

export function isTransmissionStatus(value: unknown): value is TransmissionStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/** `canonicalise` and `qrPayload` as standalone types: `createHttpTransmitter` takes them as
 *  parameters because their CONTENT is ADR-0051 prose, not a call shape (ADR 0052 decision 5). */
export type Canonicaliser = (doc: DocumentSnapshot) => EInvoiceDocument;
export type QrPayloadBuilder = (
  doc: EInvoiceDocument,
  receipt: { externalId: string; raw?: unknown },
) => string;

// ── canonicalJson — the one deterministic serialiser ──────────────────────────────────────────

export { CanonicalJsonError, canonicalJson } from "./canonical";

// ── the profile ───────────────────────────────────────────────────────────────────────────────

export type EInvoiceCallName = "submit" | "poll" | "cancel";
export type EInvoiceBodyKind = "document" | "cancellation" | "none";

export interface EInvoiceCallSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly pathTemplate: string;
  readonly body?: EInvoiceBodyKind;
  readonly externalIdPointer?: string;
  readonly statusPointer: string;
  readonly statusMap: Readonly<Record<string, TransmissionStatus>>;
  readonly errorPointer?: string;
}

export interface BearerEInvoiceAuthSpec {
  readonly kind: "bearer";
  readonly header: string;
  readonly scheme?: string;
  readonly clientIdHeader?: string;
}

export interface OAuthEInvoiceAuthSpec {
  readonly kind: "oauth2_client_credentials";
  readonly header: string;
  readonly tokenUrl: string;
  readonly scope?: string;
}
export type EInvoiceAuthSpec = BearerEInvoiceAuthSpec | OAuthEInvoiceAuthSpec;

export interface EInvoiceProfile {
  readonly code: "synthetic" | "myinvois";
  readonly version: number;
  readonly jurisdiction: "MY";
  readonly source: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly auth: EInvoiceAuthSpec;
  readonly calls: Readonly<Record<EInvoiceCallName, EInvoiceCallSpec>>;
}

export class EInvoiceProfileError extends Error {
  constructor(
    message: string,
    readonly errors: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "EInvoiceProfileError";
  }
}

/**
 * One Ajv instance for the process, compiled once — the shape 1A's `parsePolicy` uses (ADR 0022),
 * **including its entry point**. `einvoice-profile.schema.json` declares
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"` and uses `$defs`, and Ajv's DEFAULT
 * export only knows draft-07: `ajv.compile(schema)` would throw
 * `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. `ajv/dist/2020` is the
 * 2020-12 entry point, and it is what 1A (`parsePolicy`), 5A, 7A and 8A all import for the same reason.
 *
 * Compiled on first use, not at import, for `posting/evaluate.ts`'s reason: the desktop renderers'
 * CSP refuses the `new Function` Ajv compiles with, and they import this barrel.
 */
let compiled: ValidateFunction<EInvoiceProfile> | undefined;
const profileValidator = (): ValidateFunction<EInvoiceProfile> =>
  (compiled ??= new Ajv2020({
    allErrors: true,
    strict: true,
    useDefaults: false,
  }).compile<EInvoiceProfile>(schema));

/**
 * Validate a candidate profile. Throws `EInvoiceProfileError` whose `errors` are
 * `{ path, message }` pairs with `path` a JSON Pointer into the rejected profile — the same shape
 * §4.4.2's `PolicyValidation.errors` produces, so a loader reports both alike.
 *
 * A malformed profile is a DEPLOYMENT defect, not a caller error, so this throws a plain named
 * class and not an `AppError`: the loader refuses to register the transmitter, and every caller
 * then gets `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from the registry — fail-closed, and with a
 * message that names the file rather than a 500 from a network timeout.
 */
export function parseProfile(value: unknown): EInvoiceProfile {
  const validate = profileValidator();
  if (validate(value)) return value;
  const errors = (validate.errors ?? []).map((e: ErrorObject) => ({
    path: e.instancePath === "" ? "/" : e.instancePath,
    message: `${e.message ?? "is invalid"}${e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""}`,
  }));
  const summary = errors.map((e) => `${e.path} ${e.message}`).join("; ");
  throw new EInvoiceProfileError(`e-invoice profile is invalid: ${summary}`, errors);
}

// ── RFC 6901, path rendering, status mapping ──────────────────────────────────────────────────

/** RFC 6901. Returns `undefined` for any token that does not resolve — a remote response that
 *  omits a member is a status-mapping question, not an exception. */
export function resolvePointer(value: unknown, pointer: string): unknown {
  let cursor: unknown = value;
  for (const rawToken of pointer.split("/").slice(1)) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      cursor = cursor[parseInt(token, 10)];
    } else {
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return cursor;
}

/**
 * Substitute `{name}` placeholders, percent-encoding every value. Throws on a placeholder with no
 * variable AND on a variable the template does not use: the second is what catches a profile whose
 * `poll` path forgot `{externalId}` and would otherwise poll a collection endpoint for ever.
 */
export function renderPath(template: string, vars: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`renderPath: no value for {${name}} in ${template}`);
    used.add(name);
    return encodeURIComponent(value);
  });
  for (const name of Object.keys(vars)) {
    if (!used.has(name)) {
      throw new Error(`renderPath: unused variable ${name} — ${template} interpolates none`);
    }
  }
  return rendered;
}

/**
 * Map the authority's own status label onto §4.9.3's six.
 *
 * An UNMAPPED label becomes `"error"` and is returned as `unmapped` so the caller can record it in
 * `last_error`. It deliberately does NOT throw and deliberately does NOT default to `"accepted"`:
 * an authority that adds a label must produce a visible state, never a false acceptance. This is
 * the whole of LEGACY-020's "a mismatched return refuses to run, rather than producing a wrong number"
 * applied to a transmission.
 *
 * `"error"` here is what the authority SAID, not what the transmission log records. The log
 * (packages/db's transmission service, ADR 0053 as amended 2026-10-06) decides by whether the
 * authority already holds the document:
 *   - on a POLL it always does, so only `submitted`, `accepted`, `rejected` and `cancelled` from a
 *     2xx answer are recorded; an `"error"` or `"pending"`, or any label on a non-2xx answer, leaves
 *     the row `submitted` with the diagnostic in `last_error`, and the worker's poll keeps asking
 *     until its limit, after which an operator's poll route asks again;
 *   - on a SUBMIT answered 2xx with an external id it does too, and an `"error"` or `"pending"` is
 *     recorded `submitted` (pollable, never resubmittable) with the diagnostic in `last_error`;
 *   - only a submit the authority did not acknowledge — a non-2xx answer, or one with no usable
 *     external id — is recorded `"error"`, which is resubmittable.
 */
export function mapRemoteStatus(
  spec: EInvoiceCallSpec,
  raw: unknown,
): { status: TransmissionStatus; unmapped: string | null } {
  const found = resolvePointer(raw, spec.statusPointer);
  if (found === undefined || found === null) return { status: "error", unmapped: "<absent>" };
  const label = typeof found === "string" ? found : String(found);
  const mapped = spec.statusMap[label];
  if (mapped === undefined) return { status: "error", unmapped: label };
  return { status: mapped, unmapped: null };
}
