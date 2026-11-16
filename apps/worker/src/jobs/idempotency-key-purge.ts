import { withTenant } from "@dulja/db";
import type { JobHandler } from "../handler";
import { log } from "../log";

export const idempotencyKeyPurge: JobHandler<"admin.idempotency_key.purge"> = async (
  sql,
  _job,
  ctx,
) => {
  const purged = await withTenant(sql, ctx, async (tx) => {
    const rows = await tx`delete from app.idempotency_key where expires_at < now() returning key`;
    return rows.count;
  });
  log().info(
    { tenant_id: ctx.tenantId, actor_id: ctx.actorId, request_id: ctx.requestId, purged },
    "idempotency keys purged",
  );
};
