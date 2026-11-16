import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import {
  EmployeeSensitiveSchema,
  UpdateEmployeeSensitiveBody,
} from "@dulja/contracts/hr/sensitive";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  readSensitive,
  writeSensitive,
  type HrKeyRing,
  type SensitiveField,
  type SensitiveRow,
  type SensitiveValues,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import { requireEmployeeInCompany } from "./employee-scope";

const Params = z.object({ companyId: z.string().uuid(), employeeId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** wire (camelCase) → column (snake_case). One map; the route never builds a column name by hand. */
const TO_COLUMN = {
  nationalId: "national_id",
  passport: "passport",
  dateOfBirth: "date_of_birth",
  residencyCategory: "residency_category",
  bankAccount: "bank_account",
  epfNumber: "epf_number",
  socsoNumber: "socso_number",
  taxNumber: "tax_number",
  workPermitExpiry: "work_permit_expiry",
} as const satisfies Record<string, SensitiveField>;

const toDto = (row: SensitiveRow) => ({
  employeeId: row.employeeId,
  keyVersion: row.keyVersion,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt,
  nationalId: row.values.national_id ?? null,
  passport: row.values.passport ?? null,
  dateOfBirth: row.values.date_of_birth ?? null,
  residencyCategory: row.values.residency_category ?? null,
  bankAccount: row.values.bank_account ?? null,
  epfNumber: row.values.epf_number ?? null,
  socsoNumber: row.values.socso_number ?? null,
  taxNumber: row.values.tax_number ?? null,
  workPermitExpiry: row.values.work_permit_expiry ?? null,
});

/**
 * A FACTORY, exactly as `createUserRoutes(authAdmin)` and `createAttachmentRoutes(objectStore)` are — which is
 * the reason `buildRoutes` takes deps at all (§4.2.7). The key ring is closed over, so no handler reads a key from
 * `process.env` and no `c.get("hrKeys")` exists anywhere. The ring is never dereferenced at build time, only inside
 * a handler, so a `deps()` that omits it still builds the router.
 */
export function createSensitiveRoutes(hrKeys: HrKeyRing): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{employeeId}/sensitive",
      tags: ["hr"],
      request: { params: Params },
      middleware: [requirePermission(PERMISSION["hr.employee.read_sensitive"], gate)],
      responses: {
        200: {
          description: "The decrypted row",
          content: { "application/json": { schema: EmployeeSensitiveSchema } },
        },
        403: problem("forbidden"),
        404: problem("no such employee in this company, or no sensitive record"),
      },
    }),
    async (c) => {
      const { companyId, employeeId } = c.req.valid("param");
      const row = await c.var.withTenant(async (tx) => {
        await requireEmployeeInCompany(tx, companyId, employeeId);
        return readSensitive(tx, hrKeys, employeeId);
      });
      if (row === null)
        throw new AppError(
          "ERR_NOT_FOUND",
          `employee ${employeeId} has no sensitive record, or you cannot see it`,
        );
      return c.json(toDto(row), 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "put",
      path: "/{employeeId}/sensitive",
      tags: ["hr"],
      request: {
        params: Params,
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: UpdateEmployeeSensitiveBody } } },
      },
      // TWO codes, one on each layer, and the split is forced rather than chosen. R7 (spec:2178) is enforced
      // at boot by `assertRouteGates`, which refuses an unsafe method gated by a `mutating: false` code, so the
      // read-sensitive code cannot gate a PUT. The pre-flight is therefore the compensation MANAGE code; the
      // confidentiality half is migration 0081's RESTRICTIVE `sensitive_gate`, which carries no `with check`
      // and so applies its `using` predicate (the read-sensitive test) to the write as well. A principal
      // holding only the manage code clears the middleware and is refused by RLS with 42501, which
      // `fromDatabaseError` maps to ERR_RLS_DENIED.
      middleware: [requirePermission(PERMISSION["hr.compensation.manage"], gate)],
      responses: {
        200: {
          description: "Stored",
          content: { "application/json": { schema: EmployeeSensitiveSchema } },
        },
        403: problem("forbidden, or refused by the sensitive gate"),
        404: problem("no such employee in this company"),
        409: problem("a principal may not write their own sensitive record (R4)"),
      },
    }),
    async (c) => {
      const { companyId, employeeId } = c.req.valid("param");
      const body = c.req.valid("json") as Record<string, string | null | undefined>;
      const values: SensitiveValues = {};
      for (const [wire, column] of Object.entries(TO_COLUMN)) {
        const v = body[wire];
        if (v !== undefined) values[column] = v;
      }
      const row = await c.var.withTenant(async (tx) => {
        await requireEmployeeInCompany(tx, companyId, employeeId);
        await writeSensitive(tx, hrKeys, employeeId, values);
        return readSensitive(tx, hrKeys, employeeId);
      });
      if (row === null)
        throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} is not visible to you`);
      return c.json(toDto(row), 200);
    },
  );

  return routes;
}
