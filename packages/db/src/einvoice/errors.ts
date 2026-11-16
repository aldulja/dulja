// packages/db/src/einvoice/errors.ts
//
// `AppError` lives in @dulja/contracts and 0B's dependency-rule lint pins packages/db to
// ['@dulja/domain'] (§3.1), so packages/db cannot import it. This is the same declared exception
// `PostingError` is (§4.2.4) and 3C's `LandedCostError` is: a named class with a `readonly code`
// that is a LITERAL SUBSET of `ErrCode`, translated once by the route module (Task 8).

export type EInvoiceErrorCode =
  | "ERR_EINVOICE_NOT_ENABLED"
  | "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE"
  | "ERR_EINVOICE_STATUS_ILLEGAL"
  | "ERR_NOT_FOUND"; // a transmission id that does not resolve under RLS

export class EInvoiceError extends Error {
  constructor(
    readonly code: EInvoiceErrorCode,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "EInvoiceError";
  }
}

/**
 * The authority ANSWERED 2xx, and the transmitter refuses to record what it said: a codec that cannot
 * read the receipt, an identifier carrying credential material, or a submit with no addressable
 * external id. It is not a transport fault — the request reached the authority and may have been
 * taken in — so `submitTransmission` records it as an `error` OUTCOME instead of rethrowing it for
 * pg-boss, whose retry would POST the same document again (ADR 0053, amendment 2026-10-06).
 *
 * It IS an `EInvoiceError` with ERR_EINVOICE_TRANSMITTER_UNAVAILABLE, the code the codec's own
 * refusals already carried, so every caller that does not single it out (poll, cancel, the routes)
 * behaves as before; `message` is the original refusal's, so the transmitter's tests still match it.
 * `raw` is `redactResponse`'s envelope and is safe to store.
 */
export class UnreadableAcknowledgementError extends EInvoiceError {
  constructor(
    readonly httpStatus: number,
    readonly raw: Record<string, unknown>,
    detail: string,
  ) {
    super("ERR_EINVOICE_TRANSMITTER_UNAVAILABLE", detail);
    this.name = "UnreadableAcknowledgementError";
  }
}

/** A retryable transport/login fault; exported from the original HTTP module for compatibility. */
export class TransientTransmissionError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "TransientTransmissionError";
  }
}
