import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { AppError, PERMISSION, ProblemSchema } from "@dulja/contracts";
import { CatalogueQuery, CataloguePageSchema } from "@dulja/contracts/sync/catalogue";
import { readCatalogue } from "@dulja/db";
import { decodeSyncCursor, encodeSyncCursor } from "@dulja/sync";
import { requirePermission } from "../../middleware/require-permission";
import type { AppEnv } from "../../context";
// apps/api/src/routes/sync/catalogue.ts
export const catalogueRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});
catalogueRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["sync"],
    request: { query: CatalogueQuery },
    middleware: [requirePermission(PERMISSION["pos.sync.pull"], { company: "terminal" })],
    responses: {
      200: {
        description: "a page of catalogue changes",
        content: { "application/json": { schema: CataloguePageSchema } },
      },
      400: {
        description: "malformed cursor",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { since, limit } = c.req.valid("query");
    const t = c.get("terminal");
    let cursor = 0n;
    if (since !== undefined) {
      try {
        cursor = decodeSyncCursor(since).revision;
      } catch {
        throw new AppError(
          "ERR_SYNC_CURSOR_INVALID",
          `\`since\` is not a cursor this server issued`,
        );
      }
    }
    const slice = await c.var.withTenant((tx) =>
      readCatalogue(tx, {
        companyId: t.companyId,
        branchId: t.branchId,
        since: cursor,
        limit,
      }),
    );
    return c.json(
      {
        changes: slice.changes.map((ch) => ({ ...ch, revision: ch.revision.toString() })),
        next_cursor: encodeSyncCursor({ revision: slice.nextCursor }),
        has_more: slice.hasMore,
      },
      200,
    );
  },
);
