import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import {
  LoadRateTableBody,
  RateTableList,
  RateTableSchema,
  StatutoryListQuery,
  StatutorySchemeList,
} from "@dulja/contracts/hr/statutory-scheme";
import { PERMISSION } from "@dulja/contracts/permissions";
import { parseRateTable, RateTableValidationError, type RateTable } from "@dulja/domain/payroll";
import {
  listRateTables,
  listSchemes,
  loadRateTable,
  RateTableNotVerifiableError,
  verifyRateTable,
  type RateTableRow,
  type StatutoryScheme,
} from "@dulja/db";
import type { Sql } from "postgres";
import type { AppEnv } from "../../context";
import { requireAnyPermission, requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const SchemeParams = CompanyParams.extend({ schemeId: z.string().uuid() });
const VersionParams = SchemeParams.extend({ version: z.coerce.number().int().min(1) });
const gate = { company: "path:companyId" } as const;
const manage = PERMISSION["hr.statutory_table.manage"],
  verify = PERMISSION["hr.statutory_table.verify"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const toDto = (t: RateTableRow) => ({
  id: t.id,
  schemeId: t.schemeId,
  schemeCode: t.schemeCode,
  version: t.version,
  effectiveFrom: t.effectiveFrom,
  effectiveTo: t.effectiveTo,
  definition: t.definition,
  source: t.source,
  loadedBy: t.loadedBy,
  verifiedBy: t.verifiedBy,
  verifiedAt: t.verifiedAt,
});

/** The scheme, bound to the PATH company. RLS bounds the tenant only and the gate asked the code at the path
 *  company, so a scheme id of a sibling company is the same 404 as an unknown one (the 8A employee-scope rule). */
const requireScheme = async (
  tx: Sql,
  companyId: string,
  schemeId: string,
): Promise<StatutoryScheme> => {
  const scheme = (await listSchemes(tx, companyId)).find((s) => s.id === schemeId);
  if (scheme === undefined)
    throw new AppError("ERR_NOT_FOUND", `statutory scheme ${schemeId} was not found`);
  return scheme;
};

const tableOf = async (tx: Sql, schemeId: string, id: string): Promise<RateTableRow> => {
  const row = (await listRateTables(tx, schemeId)).find((t) => t.id === id);
  if (row === undefined) throw new AppError("ERR_NOT_FOUND", `rate table ${id} was not found`);
  return row;
};

/** 8A T10 — statutory schemes, the break-glass rate-table load and its verification (amendment A7, ADR 0073). There
 *  is no create-a-scheme route: schemes are seed-pack data. Reads admit either statutory-table code, because the
 *  verifier (the accountant) must read what they sign and the loader what they loaded. */
export const statutorySchemeRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

statutorySchemeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["hr"],
    request: { params: CompanyParams, query: StatutoryListQuery },
    middleware: [requireAnyPermission([manage, verify], gate)],
    responses: {
      200: {
        description: "Every scheme of the company, by code",
        content: { "application/json": { schema: StatutorySchemeList } },
      },
      403: problem("forbidden"),
    },
  }),
  async (c) => {
    const { companyId } = c.req.valid("param");
    const items = await c.var.withTenant((tx) => listSchemes(tx, companyId));
    return c.json({ items, next_cursor: null }, 200);
  },
);

statutorySchemeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{schemeId}/rate-tables",
    tags: ["hr"],
    request: { params: SchemeParams, query: StatutoryListQuery },
    middleware: [requireAnyPermission([manage, verify], gate)],
    responses: {
      200: {
        description: "Every version of the scheme's table, newest first, verified or not",
        content: { "application/json": { schema: RateTableList } },
      },
      403: problem("forbidden"),
      404: problem("no such scheme in this company"),
    },
  }),
  async (c) => {
    const { companyId, schemeId } = c.req.valid("param");
    const items = await c.var.withTenant(async (tx) => {
      await requireScheme(tx, companyId, schemeId);
      return (await listRateTables(tx, schemeId)).map(toDto);
    });
    return c.json({ items, next_cursor: null }, 200);
  },
);

statutorySchemeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{schemeId}/rate-tables",
    tags: ["hr"],
    request: {
      params: SchemeParams,
      headers: IdempotencyHeader,
      body: { content: { "application/json": { schema: LoadRateTableBody } } },
    },
    middleware: [requirePermission(manage, gate)],
    responses: {
      201: {
        description: "Loaded, UNVERIFIED — a different principal verifies it",
        content: { "application/json": { schema: RateTableSchema } },
      },
      400: problem("the definition does not satisfy urn:dulja:rate-table:1"),
      403: problem("forbidden"),
      404: problem("no such scheme in this company"),
      409: problem("the scheme already has a table of this version"),
    },
  }),
  async (c) => {
    const { companyId, schemeId } = c.req.valid("param");
    let definition: RateTable;
    try {
      definition = parseRateTable(c.req.valid("json").definition);
    } catch (e) {
      if (e instanceof RateTableValidationError)
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          "the rate-table definition does not satisfy urn:dulja:rate-table:1",
          { errors: e.errors },
        );
      throw e;
    }
    const dto = await c.var.withTenant(async (tx) => {
      const scheme = await requireScheme(tx, companyId, schemeId);
      if (definition.scheme !== scheme.code)
        throw new AppError(
          "ERR_VALIDATION_FAILED",
          `the definition declares scheme "${definition.scheme}"; this scheme is "${scheme.code}"`,
          { errors: [{ path: "/scheme", message: `must be "${scheme.code}"` }] },
        );
      const id = await loadRateTable(tx, {
        schemeId,
        version: definition.version,
        effectiveFrom: definition.effective_from,
        effectiveTo: definition.effective_to ?? null,
        definition,
        source: `${definition.source.authority} / ${definition.source.publication} / retrieved ${definition.source.retrieved_on}`,
      });
      return toDto(await tableOf(tx, schemeId, id));
    });
    return c.json(dto, 201);
  },
);

statutorySchemeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{schemeId}/rate-tables/{version}/verify",
    tags: ["hr"],
    request: { params: VersionParams, headers: IdempotencyHeader },
    middleware: [requirePermission(verify, gate)],
    responses: {
      200: {
        description: "Verified by this principal",
        content: { "application/json": { schema: RateTableSchema } },
      },
      403: problem("forbidden"),
      404: problem("no such scheme or version in this company"),
      409: problem("the caller loaded this table, or it is already verified"),
    },
  }),
  async (c) => {
    const { companyId, schemeId, version } = c.req.valid("param");
    const dto = await c.var.withTenant(async (tx) => {
      await requireScheme(tx, companyId, schemeId);
      const table = (await listRateTables(tx, schemeId)).find((t) => t.version === version);
      if (table === undefined)
        throw new AppError(
          "ERR_NOT_FOUND",
          `scheme ${schemeId} has no rate table version ${version}`,
        );
      // The trigger is the control (spec:2080): it raises SQLSTATE 23514 with the token ERR_HR_SELF_VERIFY when the
      // actor is the loader, and fromDatabaseError turns it into a 409. No pre-flight here — a second check would be
      // a second place to get the rule wrong.
      try {
        await verifyRateTable(tx, table.id);
      } catch (e) {
        if (e instanceof RateTableNotVerifiableError)
          throw new AppError(
            "ERR_HR_SELF_VERIFY",
            `rate table version ${version} of scheme ${schemeId} is already verified; a verified table is frozen`,
          );
        throw e;
      }
      return toDto(await tableOf(tx, schemeId, table.id));
    });
    return c.json(dto, 200);
  },
);

export const statutorySchemeRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/statutory-schemes",
  router: statutorySchemeRoutes,
  // Exactly the two codes the module evaluates (§4.2.7, amendment A7 — no third code).
  permissions: [manage, verify],
  auth: "human",
};
