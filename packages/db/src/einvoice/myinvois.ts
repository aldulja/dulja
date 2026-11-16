/** Public transport protocol from ADR 0051. Field mapping and signing remain explicit dependencies. */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  parseProfile,
  type Canonicaliser,
  type EInvoiceDocument,
  type EInvoiceProfile,
} from "@dulja/domain";
import { EInvoiceError } from "./errors";
import {
  createHttpTransmitter,
  type EInvoiceProtocolCodec,
  type HttpTransmitterOptions,
} from "./http-transmitter";

interface Reference {
  version: 1;
  submissionUid: string;
  uuid: string;
}
const refused = (detail: string): never => {
  throw new EInvoiceError("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE", detail);
};
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return refused("authority returned a malformed response");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    return refused("authority returned an invalid identifier");
  return value;
}
function encodeReference(submissionUid: unknown, uuid: unknown): string {
  return `submission-v1:${Buffer.from(canonicalJson({ version: 1, submissionUid: identifier(submissionUid), uuid: identifier(uuid) })).toString("base64url")}`;
}
function decodeReference(value: string): Reference {
  if (!/^submission-v1:[A-Za-z0-9_-]+$/.test(value) || value.length > 1024)
    return refused("authority receipt reference is malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice("submission-v1:".length), "base64url").toString("utf8"),
    );
  } catch {
    return refused("authority receipt reference is malformed");
  }
  const data = record(parsed);
  if (data.version !== 1) return refused("authority receipt version is unsupported");
  return { version: 1, submissionUid: identifier(data.submissionUid), uuid: identifier(data.uuid) };
}

export type AuthorityDocumentEncoder = (document: EInvoiceDocument) => {
  format: "JSON" | "XML";
  bytes: string;
};

/** Hash exactly the encoded bytes, not an internal DTO or an independently serialized copy. */
function prepareSubmission(
  document: EInvoiceDocument,
  encode: AuthorityDocumentEncoder,
): { body: string; hash: string } {
  const encoded = encode(document);
  const bytes = Buffer.from(encoded.bytes, "utf8");
  // ADR 0051 cites the published 300 KB document limit. Reject before acquiring credentials/calling.
  if (!bytes.length || bytes.length > 300_000)
    return refused("encoded authority document is empty or exceeds the published document limit");
  if (!["JSON", "XML"].includes(encoded.format))
    return refused("encoded authority document has an unsupported format");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    hash,
    body: canonicalJson({
      documents: [
        {
          format: encoded.format,
          document: bytes.toString("base64"),
          documentHash: hash,
          codeNumber: document.number,
        },
      ],
    }),
  };
}
export function encodeMyInvoisSubmission(
  document: EInvoiceDocument,
  encode: AuthorityDocumentEncoder,
): string {
  return prepareSubmission(document, encode).body;
}

export function myInvoisValidationLink(
  portalBaseUrl: string,
  externalId: string,
  raw: unknown,
): string {
  const ref = decodeReference(externalId);
  const envelope = record(raw);
  const receipt = "httpStatus" in envelope && "body" in envelope ? record(envelope.body) : envelope;
  const rows = Array.isArray(receipt.documentSummary) ? receipt.documentSummary : [receipt];
  const matching = rows.map(record).filter((row) => row.uuid === ref.uuid);
  if (matching.length !== 1)
    return refused("validation receipt does not identify exactly one matching document");
  const row = matching[0]!;
  if (row.status !== "Valid") return refused("validation receipt does not report a valid document");
  const longId = identifier(row.longId);
  const base = new URL(portalBaseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "127.0.0.1"))
  )
    return refused("validation portal URL is invalid");
  return `${base.origin}/${encodeURIComponent(ref.uuid)}/share/${encodeURIComponent(longId)}`;
}

/** No default mapper, document version, taxpayer identity or certificate is inferred here. */
export function createMyInvoisTransport(
  options: {
    profile: EInvoiceProfile;
    portalBaseUrl: string;
    canonicalise: Canonicaliser;
    encodeDocument: AuthorityDocumentEncoder;
  } & Pick<HttpTransmitterOptions, "fetchImpl" | "env">,
) {
  const profile = parseProfile(options.profile);
  if (
    profile.code !== "myinvois" ||
    profile.auth.kind !== "oauth2_client_credentials" ||
    !profile.source.includes("0051")
  )
    return refused("authority transport requires an OAuth profile citing ADR 0051");
  const status = (value: unknown) => {
    const mapped = profile.calls.poll.statusMap[String(value)];
    return { status: mapped ?? ("error" as const), unmapped: mapped ? null : String(value) };
  };
  const prepared = new WeakMap<EInvoiceDocument, string>();
  const canonicalise: Canonicaliser = (snapshot) => {
    const document = options.canonicalise(snapshot);
    const encoded = prepareSubmission(document, options.encodeDocument);
    const result = { ...document, hash: encoded.hash };
    prepared.set(result, encoded.body);
    return result;
  };
  const codec: EInvoiceProtocolCodec = {
    request(name, input) {
      if (name === "submit") {
        let body = prepared.get(input.doc!);
        if (!body) {
          const encoded = prepareSubmission(input.doc!, options.encodeDocument);
          if (encoded.hash !== input.doc!.hash)
            return refused("authority document bytes do not match the recorded document hash");
          body = encoded.body;
        }
        return { vars: {}, body };
      }
      const ref = decodeReference(input.externalId!);
      if (name === "poll") return { vars: { externalId: ref.submissionUid }, body: null };
      if (!input.reason?.trim() || input.reason.length > 300)
        return refused("cancellation reason must contain 1–300 characters");
      return {
        vars: { externalId: ref.uuid },
        body: canonicalJson({ status: "cancelled", reason: input.reason }),
      };
    },
    outcome(name, parsed, input) {
      const data = record(parsed);
      if (name === "submit") {
        const accepted = Array.isArray(data.acceptedDocuments)
          ? data.acceptedDocuments.map(record)
          : [];
        const rejected = Array.isArray(data.rejectedDocuments)
          ? data.rejectedDocuments.map(record)
          : [];
        const match = accepted.filter((row) => row.invoiceCodeNumber === input.doc!.number);
        const rejection = rejected.filter((row) => row.invoiceCodeNumber === input.doc!.number);
        if (rejection.length === 1 && match.length === 0)
          return { status: "rejected", externalId: null, unmapped: null };
        if (match.length !== 1 || rejection.length !== 0)
          return {
            status: "error",
            externalId: null,
            unmapped: "submission response has no unique matching document",
          };
        const submissionUid = identifier(data.submissionUID);
        const uuid = identifier(match[0]!.uuid);
        return {
          status: "submitted",
          externalId: encodeReference(submissionUid, uuid),
          identifierValues: [submissionUid, uuid],
          unmapped: null,
        };
      }
      const ref = decodeReference(input.externalId!);
      if (name === "poll") {
        if (data.submissionUid !== ref.submissionUid || !Array.isArray(data.documentSummary))
          return {
            status: "error",
            externalId: null,
            unmapped: "submission receipt does not match recorded submission",
          };
        const matches = data.documentSummary.map(record).filter((row) => row.uuid === ref.uuid);
        if (matches.length !== 1)
          return {
            status: "error",
            externalId: null,
            unmapped: "submission receipt has no unique matching document",
          };
        return { ...status(matches[0]!.status), externalId: null };
      }
      if (data.uuid !== ref.uuid)
        return {
          status: "error",
          externalId: null,
          unmapped: "cancellation receipt does not match recorded document",
        };
      const mapped = profile.calls.cancel.statusMap[String(data.status)];
      return {
        status: mapped ?? "error",
        externalId: null,
        unmapped: mapped ? null : String(data.status),
      };
    },
  };
  return createHttpTransmitter({
    profile,
    canonicalise,
    codec,
    qrPayload: (_doc, receipt) =>
      myInvoisValidationLink(options.portalBaseUrl, receipt.externalId, receipt.raw),
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
