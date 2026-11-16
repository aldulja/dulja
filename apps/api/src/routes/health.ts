import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
export const healthRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
healthRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
      },
    },
  }),
  (context) => context.json({ status: "ok" as const }),
);
