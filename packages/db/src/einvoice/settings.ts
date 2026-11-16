// packages/db/src/einvoice/settings.ts (5B)
//
// The WRITE half only. The read is Task 5's `companySettings(tx, companyId)` and this module does not
// restate it — two ways to read one row is hazard 9.
//
// Nothing here validates the all-three-or-none rule: the CHECK in migration 0057 is the control and
// `EinvoiceSettingsBody` (packages/contracts) is what turns the refusal into a 400 before it reaches
// the database. A service that re-checked would be a third spelling of one rule.

import type { Sql } from "postgres";
import { EInvoiceError } from "./errors";
import type { CompanyEInvoiceSettings } from "./credentials";
import type { TransmitterCode } from "./registry";

export interface WriteEinvoiceSettingsInput {
  companyId: string;
  transmitter: TransmitterCode | null;
  clientId: string | null;
  credentialRef: string | null;
}

/** One UPDATE, inside the caller's `withTenant` transaction. `app_meta.attach_stamp` on `app.company`
 *  fills `updated_by` and the audit trigger writes the before/after row — which is what makes test 13
 *  cover these three columns without this function doing anything about it. */
export async function writeEinvoiceSettings(
  tx: Sql,
  input: WriteEinvoiceSettingsInput,
): Promise<CompanyEInvoiceSettings> {
  const rows = await tx<
    {
      einvoice_transmitter: string | null;
      einvoice_client_id: string | null;
      einvoice_credential_ref: string | null;
    }[]
  >`
    update app.company
       set einvoice_transmitter   = ${input.transmitter},
           einvoice_client_id     = ${input.clientId},
           einvoice_credential_ref = ${input.credentialRef}
     where id = ${input.companyId}
    returning einvoice_transmitter, einvoice_client_id, einvoice_credential_ref
  `;
  if (rows.length === 0) {
    // RLS reduced the row set to zero: either the company is another tenant's or it does not exist.
    // Both answer 404 at the edge — a 403 would confirm the id names something (§3.7.2).
    throw new EInvoiceError(
      "ERR_NOT_FOUND",
      `company ${input.companyId} is not visible in this tenant`,
    );
  }
  const r = rows[0]!;
  return {
    transmitter: r.einvoice_transmitter,
    clientId: r.einvoice_client_id,
    credentialRef: r.einvoice_credential_ref,
  };
}
