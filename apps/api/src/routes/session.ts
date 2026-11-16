import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { SessionSchema } from "@dulja/contracts";
import type { AppEnv } from "../context";
export const sessionRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
sessionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    responses: {
      200: { description: "session", content: { "application/json": { schema: SessionSchema } } },
    },
  }),
  async (context) => {
    const ctx = context.get("ctx");
    const [row] = await context.var.withTenant(
      (tx) =>
        tx<
          { display_name: string; email: string | null }[]
        >`select display_name,email from app.principal where id=${ctx.actorId}`,
    );
    return context.json({
      principalId: ctx.actorId,
      tenantId: ctx.tenantId,
      principalKind: ctx.principalKind,
      aal: ctx.aal,
      displayName: row?.display_name ?? "",
      email: row?.email ?? null,
    });
  },
);
