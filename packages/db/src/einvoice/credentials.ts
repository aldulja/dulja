// packages/db/src/einvoice/credentials.ts
//
// The ONE place a secret NAME becomes a secret VALUE, and it happens inside the transmitter's own
// call. §4.9.3 freezes `EInvoiceCredentials.secretRef` as "name of the Cloudflare secret, never the
// value", so the credentials object that crosses every seam carries only the name; the value is
// read here, used once, and never returned, logged or stored.

import type { EInvoiceCredentials } from "@dulja/domain";
import { EInvoiceError } from "./errors";

/** §3.11's enumerated names. `containerSecrets(env, entrypoint)` supplies exactly these, so the
 *  code admits exactly these — the DDL's `^EINVOICE_[A-Z0-9_]+$` pattern is wider on purpose, so a
 *  second authority is a §3.11 row and a member here rather than a migration. */
export const EINVOICE_SECRET_NAMES = ["EINVOICE_CLIENT_SECRET"] as const;
export type EInvoiceSecretName = (typeof EINVOICE_SECRET_NAMES)[number];

export interface CompanyEInvoiceSettings {
  readonly transmitter: string | null;
  readonly clientId: string | null;
  readonly credentialRef: string | null;
}

export function credentialsFor(settings: CompanyEInvoiceSettings): EInvoiceCredentials {
  if (
    settings.transmitter === null ||
    settings.clientId === null ||
    settings.credentialRef === null
  ) {
    throw new EInvoiceError(
      "ERR_EINVOICE_NOT_ENABLED",
      "this company has no e-invoice transmitter configured (app.company.einvoice_transmitter is null)",
    );
  }
  return { clientId: settings.clientId, secretRef: settings.credentialRef };
}

/**
 * Resolve a secret NAME to its value. Two refusals, both fail-closed:
 *   - a name §3.11 does not enumerate, so a column pointed at `DATABASE_URL` cannot become an
 *     Authorization header even if a future migration widens the CHECK;
 *   - an unset variable, which is `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` naming the variable —
 *     the deploy is misconfigured, and a 422 that says which name is missing is what an operator
 *     can act on. The VALUE never appears in the message.
 */
export function readSecret(
  secretRef: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!(EINVOICE_SECRET_NAMES as readonly string[]).includes(secretRef)) {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `${secretRef} is not an enumerated secret name (§3.11 names ${EINVOICE_SECRET_NAMES.join(", ")})`,
    );
  }
  const value = env[secretRef];
  if (value === undefined || value === "") {
    throw new EInvoiceError(
      "ERR_EINVOICE_TRANSMITTER_UNAVAILABLE",
      `${secretRef} is not set in this environment`,
    );
  }
  return value;
}
