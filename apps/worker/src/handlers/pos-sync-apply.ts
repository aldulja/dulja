import type { Sql, TransactionSql } from "postgres";
import { TicketBatchBody } from "@dulja/contracts/sync/ticket";
import {
  applyBatch,
  terminalContext,
  withTenant,
  upsertNeedsAttention,
  SyncError,
  type TenantContext,
  type TerminalRow,
  type TicketBatchInput,
} from "@dulja/db";
import { registerHandler, type JobHandler } from "../handler";
import { jobs } from "../jobs";

/** Queued tickets retain the authenticated terminal actor, including revocation checks at execution. */
export const posSyncApply: JobHandler<"pos.sync.apply"> = async (sql, job) => {
  const { terminalId, batch: payload } = job.payload;
  const { ctx, terminal } = await terminalContext(sql, terminalId, job.requestId);
  if (terminal.tenantId !== job.tenantId)
    throw new SyncError("ERR_TERMINAL_SIGNATURE_INVALID", "terminal does not belong to job tenant");
  const batch = TicketBatchBody.parse(payload);
  if (batch.terminalId !== terminalId)
    throw new SyncError(
      "ERR_TERMINAL_SIGNATURE_INVALID",
      "batch does not belong to queued terminal",
    );
  await withTenant(sql, ctx, async (tx) => {
    const [current] = await tx<
      { revoked: boolean }[]
    >`select revoked_at is not null as revoked from app.pos_terminal where id=${terminalId}`;
    if (!current || current.revoked) {
      await quarantineBatch(tx, ctx, terminal, batch);
      return;
    }
    await applyBatch(
      tx,
      ctx,
      {
        terminalId,
        companyId: terminal.companyId,
        branchId: terminal.branchId,
        principalId: terminal.principalId,
        jobs: jobs(),
      },
      batch,
    );
  });
};

export function registerPosSyncHandlers(): void {
  registerHandler("pos.sync.apply", posSyncApply);
}

async function quarantineBatch(
  tx: Sql,
  ctx: TenantContext,
  terminal: TerminalRow,
  batch: TicketBatchInput,
): Promise<void> {
  for (const ticket of batch.tickets) {
    try {
      await (tx as unknown as TransactionSql).savepoint((sp) =>
        upsertNeedsAttention(sp as unknown as Sql, ctx, {
          companyId: terminal.companyId,
          branchId: terminal.branchId,
          terminalId: terminal.terminalId,
          clientRef: ticket.clientRef,
          payload: ticket,
          errorCode: "ERR_TERMINAL_REVOKED",
          errorDetail: `terminal ${terminal.terminalId} was revoked before this batch was applied; retain the ticket for a manager`,
        }),
      );
    } catch (error) {
      // An already-owned quarantine reference stays with its original terminal.
      if (!(error instanceof SyncError && error.code === "ERR_VALIDATION_FAILED")) throw error;
    }
  }
}
