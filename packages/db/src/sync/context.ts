// packages/db/src/sync/context.ts
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";
import { withTenant } from "../with-tenant";
import { resolveTerminalPrincipal } from "./identity";
import { SyncError } from "./enrolment";

export interface TerminalRow {
  terminalId: string;
  tenantId: string;
  companyId: string;
  branchId: string;
  principalId: string;
  code: string | null;
  revokedAt: string | null;
  /** SPKI DER. Carried here so `terminalAuth`'s signed path verifies a signature without resolving the
   *  terminal a second time; the token path simply never reads it. */
  devicePublicKey: Buffer;
}

/**
 * Resolves a terminal id to the context every later statement runs under. Two steps, and the order matters:
 * `app.resolve_principal` runs with NO tenant (it is the SECURITY DEFINER door), and only then can the
 * `pos_terminal` row be read under RLS as the terminal itself. Reading the row first, as a superuser or with
 * a guessed tenant, would be SAH-026 with extra steps.
 *
 * `revoked_at` is returned rather than thrown on, because the two callers answer differently: `terminalAuth`
 * raises `ERR_TERMINAL_REVOKED` (403), and the `pos.sync.apply` handler abandons the batch to needs-attention.
 *
 * `device_public_key` comes back in the same read. It is only ever needed on the signed path, but fetching it
 * here is what lets `terminalAuth` resolve a terminal **once per request** instead of twice.
 */
export async function terminalContext(
  sql: Sql,
  terminalId: string,
  requestId: string,
): Promise<{ ctx: TenantContext; terminal: TerminalRow }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(terminalId))
    throw new SyncError("ERR_TERMINAL_SIGNATURE_INVALID", "unknown terminal");
  const resolved = await resolveTerminalPrincipal(sql, terminalId);
  if (resolved.length !== 1 || resolved[0]!.kind !== "terminal") {
    throw new SyncError("ERR_TERMINAL_SIGNATURE_INVALID", "unknown terminal");
  }
  const { principalId, tenantId } = resolved[0]!;
  const ctx: TenantContext = { tenantId, actorId: principalId, requestId };
  const rows = await withTenant(
    sql,
    ctx,
    (tx) => tx<
      {
        company_id: string;
        branch_id: string;
        code: string | null;
        revoked_at: string | null;
        device_public_key: Buffer;
      }[]
    >`select company_id, branch_id, code, revoked_at, device_public_key
         from app.pos_terminal where id = ${terminalId}`,
  );
  if (rows.length !== 1) throw new SyncError("ERR_TERMINAL_SIGNATURE_INVALID", "unknown terminal");
  return {
    ctx,
    terminal: {
      terminalId,
      tenantId,
      principalId,
      companyId: rows[0]!.company_id,
      branchId: rows[0]!.branch_id,
      code: rows[0]!.code,
      revokedAt: rows[0]!.revoked_at,
      devicePublicKey: rows[0]!.device_public_key,
    },
  };
}
