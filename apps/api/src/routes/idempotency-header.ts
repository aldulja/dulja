import { z } from "@hono/zod-openapi";
export const IdempotencyHeader = z.object({
  "Idempotency-Key": z
    .string()
    .min(1)
    .max(200)
    .openapi({ description: "Required for unsafe methods" }),
});
