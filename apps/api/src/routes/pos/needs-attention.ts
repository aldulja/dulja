// apps/api/src/routes/pos/needs-attention.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError,
  PERMISSION,
  ProblemSchema,
  TimestampSchema,
  UuidSchema,
  decodeCursor,
  encodeCursor,
} from "@dulja/contracts";
import {
  NeedsAttentionList,
  NeedsAttentionQuery,
  ResolveNeedsAttentionBody,
} from "@dulja/contracts/sync/needs-attention";
import { listNeedsAttention, resolveNeedsAttention } from "@dulja/db";
import { staffBranchGate } from "../staff-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { AppEnv } from "../../context";

export const needsAttentionRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

/**
 * **Two operations, and no third.** A needs-attention row is never deleted (§3.5.4 pins the `app_rw` DELETE
 * list at five tables and 2B is its only extender); it is closed by `resolved_at`. There is no PATCH either:
 * every column but the resolution is written by `applyBatch` from the ticket, and a hand-edited error code
 * would make the queue lie about why the till was refused.
 *
 * **A `GET` gated by a `mutating: true` code is legal**, and it is worth saying why once. R7 (spec:2178)
 * forbids gating an *unsafe method* with a `mutating: false` code — `assertRouteGates` raises
 * `ERR_ROUTE_GATE_READONLY` at boot for that — and says nothing about the reverse. §4.16.1's
 * `accounting.unreconciled_items` is the registered precedent, *"mutating-gated by design: only a reconciler
 * sees it"*, and the same reading applies here: the queue shows refused tickets with their reasons, and the
 * person who may see them is the person who may act on them.
 */
needsAttentionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["pos"],
    request: { params: z.object({ companyId: UuidSchema }), query: NeedsAttentionQuery },
    middleware: [staffBranchGate(PERMISSION["pos.needs_attention.resolve"])],
    responses: {
      200: {
        description: "the shop queue, newest first",
        content: { "application/json": { schema: NeedsAttentionList } },
      },
      400: {
        description: "bad cursor",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const q = c.req.valid("query");
    // 0B's list codec, not the sync one: §4.2.8's `{ k, id }` keyset position is a different thing from
    // §4.10.1's revision cursor, and using either for the other is hazard 9. T1's own comment says so.
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    if (
      cursor !== null &&
      (cursor.k.length !== 1 ||
        !TimestampSchema.safeParse(cursor.k[0]).success ||
        !UuidSchema.safeParse(cursor.id).success)
    )
      throw new AppError(
        "ERR_VALIDATION_FAILED",
        "cursor must contain one timestamp and a queue row id",
      );
    const rows = await c.var.withTenant((tx) =>
      listNeedsAttention(tx, {
        companyId,
        ...(q["filter[branchId][eq]"] === undefined ? {} : { branchId: q["filter[branchId][eq]"] }),
        ...(q["filter[resolved][eq]"] === undefined
          ? {}
          : { open: q["filter[resolved][eq]"] === "false" }),
        cursor: cursor === null ? null : { createdAt: String(cursor.k[0]), id: cursor.id },
        limit: q.limit + 1,
      }),
    );
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items.at(-1);
    return c.json(
      {
        items,
        next_cursor: hasMore && last ? encodeCursor({ k: [last.createdAt], id: last.id }) : null,
      },
      200,
    );
  },
);

needsAttentionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/resolve",
    tags: ["pos"],
    request: {
      headers: IdempotencyHeader,
      params: z.object({ companyId: UuidSchema, id: UuidSchema }),
      body: { content: { "application/json": { schema: ResolveNeedsAttentionBody } } },
    },
    middleware: [staffBranchGate(PERMISSION["pos.needs_attention.resolve"])],
    responses: {
      204: { description: "resolved" },
      404: {
        description: "no open row with that id",
        content: { "application/problem+json": { schema: ProblemSchema } },
      },
    },
  }),
  async (c) => {
    const { companyId, id } = c.req.valid("param");
    const { note } = c.req.valid("json");
    // `resolved_by` is NOT a parameter anywhere on this path: `resolveNeedsAttention` sets it from `ctx` and
    // `app.stamp_actor` overwrites it from the session regardless (SAH-044). A caller cannot name a resolver.
    await c.var.withTenant((tx) => resolveNeedsAttention(tx, c.get("ctx"), companyId, id, note));
    return c.body(null, 204);
  },
);
