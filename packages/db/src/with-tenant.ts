import type { Sql } from "postgres";

export interface TenantContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
}
export interface ResolvedPrincipal {
  readonly principalId: string;
  readonly tenantId: string;
  readonly kind: "human" | "system" | "terminal";
}

export class TenantContextError extends Error {
  constructor(
    readonly code: "ERR_TENANT_CONTEXT_MISSING" | "ERR_TENANT_CONTEXT_NESTED",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TenantContextError";
  }
}

function isTransaction(sql: Sql): boolean {
  return typeof (sql as unknown as { savepoint?: unknown }).savepoint === "function";
}

function state(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function runOnce<T>(sql: Sql, ctx: TenantContext, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin("isolation level read committed", async (tx) => {
    await tx`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.actor_id', ${ctx.actorId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/** A transaction-local tenant context. It retries precisely one deadlock or serialization failure. */
export async function withTenant<T>(
  sql: Sql,
  ctx: TenantContext,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  if (!ctx.tenantId || !ctx.actorId)
    throw new TenantContextError("ERR_TENANT_CONTEXT_MISSING", "tenantId and actorId are required");
  if (isTransaction(sql))
    throw new TenantContextError(
      "ERR_TENANT_CONTEXT_NESTED",
      "pass the existing transaction to nested helpers",
    );
  try {
    return await runOnce(sql, ctx, fn);
  } catch (error) {
    if (["40P01", "40001"].includes(state(error) ?? "")) return runOnce(sql, ctx, fn);
    throw error;
  }
}

/** The sole pre-tenant identity lookup, backed by the restricted SECURITY DEFINER function. */
export async function resolvePrincipal(
  sql: Sql,
  authSubject: string,
): Promise<ResolvedPrincipal[]> {
  const rows = await sql<
    { principal_id: string; tenant_id: string; kind: ResolvedPrincipal["kind"] }[]
  >`select principal_id, tenant_id, kind from app.resolve_principal(${authSubject})`;
  return rows.map((row) => ({
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    kind: row.kind,
  }));
}

export async function systemContext(
  sql: Sql,
  tenantId: string,
  requestId: string,
): Promise<TenantContext> {
  const principal = (await resolvePrincipal(sql, `system:${tenantId}`)).find(
    (row) => row.tenantId === tenantId && row.kind === "system",
  );
  if (!principal)
    throw new TenantContextError(
      "ERR_TENANT_CONTEXT_MISSING",
      `tenant ${tenantId} has no system principal`,
    );
  return { tenantId, actorId: principal.principalId, requestId };
}
