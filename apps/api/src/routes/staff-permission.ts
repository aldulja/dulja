import type { Sql } from "postgres";
import type { MiddlewareHandler } from "hono";
import { AppError, UuidSchema } from "@dulja/contracts";
import type { PermissionCode } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { markPermissionGate } from "../middleware/require-permission";
/** A directory gate admits branch assignments; each resource stays subject to branch RLS. */
export function staffBranchGate(code: PermissionCode): MiddlewareHandler<AppEnv> {
  return markPermissionGate(
    async (c, next) => {
      const companyId = c.req.param("companyId");
      if (!UuidSchema.safeParse(companyId).success)
        throw new AppError("ERR_VALIDATION_FAILED", "companyId must be a UUID");
      const [allowed] = await c.var.withTenant(
        (tx) =>
          tx<
            { ok: boolean }[]
          >`select exists(select 1 from app.dimension_value v join app.dimension_type t on t.id=v.dimension_type_id and t.tenant_id=v.tenant_id where t.company_id=${companyId ?? null}::uuid and t.code='BRANCH' and v.archived_at is null and app.actor_has(${code},t.company_id,v.id)) as ok`,
      );
      if (!allowed?.ok)
        throw new AppError(
          "ERR_RBAC_FORBIDDEN",
          `principal does not hold ${code} in an accessible branch`,
        );
      await next();
    },
    [code],
  );
}
export async function assertStaffBranchPermission(
  tx: Sql,
  code: PermissionCode,
  companyId: string,
  branchId: string,
): Promise<void> {
  const [row] = await tx<
    { ok: boolean }[]
  >`select app.actor_has(${code},${companyId},${branchId}) as ok`;
  if (!row?.ok)
    throw new AppError("ERR_RBAC_FORBIDDEN", `principal does not hold ${code} in this branch`);
}
