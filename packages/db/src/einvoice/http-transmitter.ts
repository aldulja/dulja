// packages/db/src/einvoice/http-transmitter.ts
//
// Turns any conforming EInvoiceProfile into an EInvoiceTransmitter (§4.9.3, ADR 0052).
//
// NOTHING in this file names an authority. Every URL, header name, path and status label comes from
// the profile; `canonicalise` and `qrPayload` come from the caller (ADR 0052 decision 5).

import {
  canonicalJson,
  mapRemoteStatus,
  renderPath,
  resolvePointer,
  type Canonicaliser,
  type EInvoiceCallSpec,
  type EInvoiceCredentials,
  type EInvoiceDocument,
  type EInvoiceProfile,
  type EInvoiceTransmitter,
  type QrPayloadBuilder,
  type TransmissionStatus,
} from "@dulja/domain";
import { createRequestAuthorization } from "./authorization";
import {
  EInvoiceError,
  TransientTransmissionError,
  UnreadableAcknowledgementError,
} from "./errors";
export { TransientTransmissionError } from "./errors";
import { redactResponse, redactText } from "./redact";

export interface ProtocolInput {
  doc?: EInvoiceDocument;
  externalId?: string;
  reason?: string;
}
export interface EInvoiceProtocolCodec {
  request(
    name: "submit" | "poll" | "cancel",
    input: ProtocolInput,
  ): { vars: Readonly<Record<string, string>>; body: string | null };
  outcome(
    name: "submit" | "poll" | "cancel",
    parsed: unknown,
    input: ProtocolInput,
  ): {
    status: TransmissionStatus;
    externalId: string | null;
    unmapped: string | null;
    identifierValues?: readonly string[];
  };
}
export interface HttpTransmitterOptions {
  codec?: EInvoiceProtocolCodec;
  profile: EInvoiceProfile;
  canonicalise: Canonicaliser;
  qrPayload: QrPayloadBuilder;
  /** Injected so a test can force an early abort and exercise the timeout branch. Defaults to the
   *  platform fetch, which reaches a loopback stub server perfectly well on its own. */
  fetchImpl?: typeof fetch;
  /**
   * The environment `readSecret` resolves `credentials.secretRef` against. Defaults to `process.env`,
   * which is what both entrypoints use.
   *
   * **This is a constructor option and NOT something a `fetch` wrapper can supply**, and the reason is
   * the call order below: `call()` reads the secret BEFORE it builds the headers and BEFORE it invokes
   * `doFetch`, so a wrapper that set `process.env` around its own body would run strictly after
   * `readSecret` had already thrown. An earlier draft of this plan did exactly that and every
   * successful-call test in Tasks 4, 5, 7, 8 and 10 would have failed with
   * `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`. It is also the safer seam: no test mutates `process.env`,
   * so two Vitest files in one worker cannot leak a secret into each other.
   */
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface RemoteCallResult {
  status: TransmissionStatus;
  externalId: string | null;
  raw: Record<string, unknown>;
  unmapped: string | null;
  httpStatus: number;
  transient: boolean;
}

/**
 * What this factory returns: §4.9.3's frozen interface plus the two members the transmission log
 * needs and that interface has no room for — `profile.version`, written to
 * `einvoice_transmission.profile_version` (SAH-013), and `lastCall`, which carries the HTTP status
 * and the unmapped remote label into `last_error`. Declared HERE rather than in `registry.ts` so
 * `synthetic.ts` can name it without closing a cycle (registry imports synthetic).
 */
export interface RegisteredTransmitter extends EInvoiceTransmitter {
  readonly profile: EInvoiceProfile;
  /** Diagnostic only; persistence uses the outcome returned by its own call. */
  readonly lastCall: RemoteCallResult | null;
  /**
   * `httpStatus` on `submit` and `poll` is how the transmission log tells an answer the authority
   * GAVE from one it refused (ADR 0053, amendment 2026-10-06): a submit whose `error` or `pending`
   * came on a 2xx with an external id was acknowledged (recorded `submitted`, never resubmitted),
   * and a poll answered non-2xx is never definitive, whatever label its body carries — `rejected`
   * included, which the force-to-`error` rule below deliberately lets through for a 4xx SUBMIT.
   * It is on THIS call's outcome, in this slice's extension type, rather than read from either of
   * the two other places it already appears: `lastCall` is shared by every concurrent call on the
   * transmitter and ADR 0053's verification refinements bar it as a persistence source, and
   * `raw.httpStatus` is `redactResponse`'s storage envelope — an incident responder's projection
   * typed `unknown`, which a state transition should not depend on. §4.9.3's frozen interface is
   * untouched: its `submit` and `poll` still promise what they did, and this widens them.
   */
  submit(
    doc: EInvoiceDocument,
    credentials: EInvoiceCredentials,
  ): Promise<{
    externalId: string;
    status: TransmissionStatus;
    raw: Record<string, unknown>;
    unmapped: string | null;
    httpStatus: number;
  }>;
  poll(
    externalId: string,
    credentials: EInvoiceCredentials,
  ): Promise<{
    status: TransmissionStatus;
    raw: Record<string, unknown>;
    unmapped: string | null;
    httpStatus: number;
  }>;
  cancel(
    externalId: string,
    reason: string,
    credentials: EInvoiceCredentials,
  ): Promise<{ status: TransmissionStatus; raw: Record<string, unknown>; unmapped: string | null }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createHttpTransmitter(opts: HttpTransmitterOptions): RegisteredTransmitter {
  const { profile, canonicalise, qrPayload } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastCall: RemoteCallResult | null = null;
  const authorization = createRequestAuthorization({
    profile,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });

  const call = async (
    spec: EInvoiceCallSpec,
    vars: Readonly<Record<string, string>>,
    body: string | null,
    credentials: EInvoiceCredentials,
    name: "submit" | "poll" | "cancel",
    input: ProtocolInput,
  ): Promise<RemoteCallResult> => {
    const url = `${profile.baseUrl.replace(/\/$/, "")}${renderPath(spec.pathTemplate, vars)}`;
    const controller = new AbortController();
    const timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const sensitive: string[] = [];
    let response: Response;
    let text: string;
    try {
      let material = await authorization.get(credentials, controller.signal);
      sensitive.push(...material.sensitiveValues);
      const headers: Record<string, string> = {
        [profile.auth.header]: material.headerValue,
        accept: "application/json",
      };
      if (profile.auth.kind === "bearer" && profile.auth.clientIdHeader)
        headers[profile.auth.clientIdHeader] = credentials.clientId;
      if (body !== null) headers["content-type"] = "application/json";
      const request = () =>
        doFetch(url, {
          method: spec.method,
          headers,
          redirect: "error",
          ...(body === null ? {} : { body }),
          signal: controller.signal,
        });
      response = await request();
      text = await response.text();
      if (response.status === 401 && profile.auth.kind === "oauth2_client_credentials") {
        authorization.invalidate(credentials, material.headerValue);
        material = await authorization.get(credentials, controller.signal);
        sensitive.push(...material.sensitiveValues);
        headers[profile.auth.header] = material.headerValue;
        response = await request();
        text = await response.text();
      }
    } catch (e) {
      if (e instanceof TransientTransmissionError || e instanceof EInvoiceError) throw e;
      // A connection refusal, a DNS failure and an abort are all "ask again later".
      throw new TransientTransmissionError(
        0,
        `${spec.method} ${spec.pathTemplate} failed: ${redactText((e as Error).message, sensitive)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = text;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      // keep `text`, which redactResponse records as { nonJson: true, length }
    }

    if (response.status >= 500 || response.status === 429) {
      throw new TransientTransmissionError(
        response.status,
        `${spec.method} ${spec.pathTemplate} returned ${response.status}`,
      );
    }

    const decode = () => {
      const decoded = opts.codec
        ? opts.codec.outcome(name, parsed, input)
        : {
            ...mapRemoteStatus(spec, parsed),
            externalId: spec.externalIdPointer
              ? resolvePointer(parsed, spec.externalIdPointer)
              : null,
          };
      const identifiers = [
        decoded.externalId,
        ...("identifierValues" in decoded ? (decoded.identifierValues ?? []) : []),
      ];
      if (
        identifiers.some(
          (id) => typeof id === "string" && sensitive.some((value) => value && id.includes(value)),
        )
      ) {
        throw new Error("remote identifier contains credential material; refusing to persist it");
      }
      return decoded;
    };
    let decoded: ReturnType<typeof decode>;
    try {
      decoded = decode();
    } catch (e) {
      // A 2xx the transmitter cannot read is an answer the authority GAVE, not a fault in reaching
      // it; `submitTransmission` must be able to tell it from one (UnreadableAcknowledgementError).
      // A non-2xx keeps its original error: the authority refused the request and holds nothing.
      if (!response.ok) throw e;
      throw new UnreadableAcknowledgementError(
        response.status,
        redactResponse(parsed, response.status, sensitive),
        redactText((e as Error).message, sensitive),
      );
    }
    const { status, unmapped } = decoded;
    const externalIdRaw = decoded.externalId;
    const result: RemoteCallResult = {
      status:
        !response.ok && ["submitted", "accepted", "cancelled"].includes(status) ? "error" : status,
      externalId: typeof externalIdRaw === "string" && externalIdRaw !== "" ? externalIdRaw : null,
      raw: redactResponse(parsed, response.status, sensitive),
      unmapped: unmapped === null ? null : redactText(unmapped, sensitive),
      httpStatus: response.status,
      transient: false,
    };
    lastCall = result;
    return result;
  };

  return {
    jurisdiction: profile.jurisdiction,
    get profile() {
      return profile;
    },
    get lastCall() {
      return lastCall;
    },

    canonicalise(doc) {
      return canonicalise(doc);
    },
    qrPayload(doc, receipt) {
      return qrPayload(doc, receipt);
    },

    async submit(doc: EInvoiceDocument, credentials) {
      const spec = profile.calls.submit;
      const input = { doc };
      const encoded = opts.codec?.request("submit", input) ?? {
        vars: {},
        body: spec.body === "document" ? canonicalJson(doc) : null,
      };
      const result = await call(spec, encoded.vars, encoded.body, credentials, "submit", input);
      if (result.externalId === null && result.status !== "rejected" && result.status !== "error") {
        // A transmission the log cannot address can never be polled or cancelled, so this is a
        // hard failure rather than a stored row with a null external_id — the DDL's
        // einvoice_transmission_external_id_check would refuse it anyway, and refusing here names
        // the cause instead of surfacing a constraint violation. On a 2xx it is an unreadable
        // ACKNOWLEDGEMENT, which the transmission log records rather than retries (see the class).
        const detail = `submit returned no external id at status ${result.status} (profile ${profile.code}.v${profile.version}, pointer ${spec.externalIdPointer ?? "<none>"})`;
        if (result.httpStatus >= 200 && result.httpStatus < 300)
          throw new UnreadableAcknowledgementError(result.httpStatus, result.raw, detail);
        throw new Error(detail);
      }
      return {
        externalId: result.externalId ?? "",
        status: result.status,
        raw: result.raw,
        unmapped: result.unmapped,
        httpStatus: result.httpStatus,
      };
    },

    async poll(externalId, credentials) {
      const input = { externalId };
      const encoded = opts.codec?.request("poll", input) ?? { vars: { externalId }, body: null };
      const result = await call(
        profile.calls.poll,
        encoded.vars,
        encoded.body,
        credentials,
        "poll",
        input,
      );
      return {
        status: result.status,
        raw: result.raw,
        unmapped: result.unmapped,
        httpStatus: result.httpStatus,
      };
    },

    async cancel(externalId, reason, credentials) {
      const spec = profile.calls.cancel;
      const input = { externalId, reason };
      const encoded = opts.codec?.request("cancel", input) ?? {
        vars: { externalId },
        body: spec.body === "cancellation" ? canonicalJson({ externalId, reason }) : null,
      };
      const result = await call(spec, encoded.vars, encoded.body, credentials, "cancel", input);
      return { status: result.status, raw: result.raw, unmapped: result.unmapped };
    },
  };
}
