// apps/pos/src/main/errors.ts
import type { ErrCode } from "@dulja/contracts";

/** A literal SUBSET of `ErrCode` and never a new code. `packages/contracts/src/errors.ts` is the one file
 *  every code is enumerated in (spec:2051) and `apps/pos` is app tier, so it imports the type directly. */
export type TillErrorCode = Extract<
  ErrCode,
  | "ERR_TILL_PIN_INVALID"
  | "ERR_TILL_LIMIT_EXCEEDED"
  | "ERR_TILL_CATALOGUE_STALE"
  | "ERR_TILL_STORE_CORRUPT"
  // `ERR_MONEY_CURRENCY_MISMATCH` is 0D's and is raised here rather than re-wrapped: `draftTicket`,
  // `closeShift` and `tender` all refuse a mixed-currency ticket, and a till-specific alias for a code the
  // domain already registers would be the second spelling §4.2.4 exists to prevent.
  | "ERR_VALIDATION_FAILED"
  | "ERR_NOT_FOUND"
  | "ERR_RBAC_FORBIDDEN"
  | "ERR_MONEY_CURRENCY_MISMATCH"
  // 0C's "wait for the window and retry" code, raised by `authenticateCashier`'s PIN lockout (LEGACY-028). The
  // same reasoning as the line above: the registry already has the meaning, so the till does not mint a second.
  | "ERR_RATE_LIMITED"
  // 6A's refusal of an expired, used or unknown enrolment code, passed through from the server rather than
  // re-wrapped, so the enrol screen can say the code is the problem (PR 12 verification, 2026-10-23).
  | "ERR_TERMINAL_ENROLMENT_INVALID"
>;

export class TillError extends Error {
  constructor(
    readonly code: TillErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TillError";
  }
}
