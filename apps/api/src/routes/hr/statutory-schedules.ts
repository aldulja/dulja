import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, decodeCursor, encodeCursor, ProblemSchema } from "@dulja/contracts";
import {
  GenerateStatutoryScheduleBody,
  SettleStatutoryScheduleBody,
  StatutoryScheduleList,
  StatutoryScheduleQuery,
  StatutoryScheduleSchema,
} from "@dulja/contracts/hr/statutory-schedule";
import { PERMISSION } from "@dulja/contracts/permissions";
import {
  generateStatutorySchedule,
  getAttachment,
  listSchedules,
  readAttachmentContent,
  readSchedule,
  scheduleCsv,
  scheduleFileName,
  settleStatutorySchedule,
  type ObjectStore,
  type StatutoryScheduleResult,
} from "@dulja/db";
import { isCalendarDate } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";
import { IdempotencyHeader } from "../idempotency-header";
import type { RouteModule } from "../index";

const CompanyParams = z.object({ companyId: z.string().uuid() });
const ScheduleParams = CompanyParams.extend({ scheduleId: z.string().uuid() });
const gate = { company: "path:companyId" } as const;
const pay = PERMISSION["hr.payroll.pay"],
  read = PERMISSION["hr.payroll.read"];
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATUTORY_SCHEDULES_PATH = "/v1/companies/:companyId/statutory-schedules";

/** The ONE place a `StatutoryScheduleResult` becomes the wire body: the 201 items, the list items and the detail are
 *  the same object by construction. */
const present = (r: StatutoryScheduleResult): z.infer<typeof StatutoryScheduleSchema> => ({
  scheduleId: r.scheduleId,
  schemeId: r.schemeId,
  schemeCode: r.schemeCode,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  payrollDocumentId: r.payrollDocumentId,
  totalEmployee: r.totalEmployee.toJSON(),
  totalEmployer: r.totalEmployer.toJSON(),
  attachmentId: r.attachmentId,
  remittanceDocumentId: r.remittanceDocumentId,
  employerRegistration: r.employerRegistration ?? null,
  rows: r.rows,
});

/** The cursor is base64url, not signed: a hand-made key that is not a (date, uuid) pair is refused here. */
function scheduleCursor(raw: string | undefined): { periodStart: string; id: string } | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  const periodStart = String(cursor.k[0] ?? "");
  if (cursor.k.length !== 1 || !isCalendarDate(periodStart) || !UUID.test(cursor.id)) {
    throw new AppError("ERR_VALIDATION_FAILED", "cursor is not valid");
  }
  return { periodStart, id: cursor.id };
}

/**
 * 8C T7 — the statutory-schedule module (§4.2.7, round 18 B10, spec:2083). **A factory over the object store**, as
 * 2C's `createAttachmentRoutes(store)` and 7C's `exportRouteModule(store)` are: generation writes the CSV attachment
 * and the CSV download reads it back, and §4.2.3's `AppEnv` carries no `deps` for a handler to read the store from.
 *
 * Every service call is bound to the path's company: another company's schedule is 404.
 */
export function createStatutoryScheduleRoutes(store: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["hr"],
      request: {
        params: CompanyParams,
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: GenerateStatutoryScheduleBody } } },
      },
      // Generating the record is part of paying the authority, and it writes: a mutating code (R7).
      middleware: [requirePermission(pay, gate)],
      responses: {
        201: {
          description:
            "One schedule per scheme the POSTED run touched (or per named scheme), each with the generic CSV attached and its sha256 recorded. Idempotent on (scheme, period, run): a second call returns the same rows.",
          content: { "application/json": { schema: StatutoryScheduleList } },
        },
        400: problem("an invalid body, or a named scheme the run carries no line of"),
        403: problem(
          "forbidden — the generator also needs hr.compensation.read, which the scheme references sit behind, and must see every employee on the run",
        ),
        404: problem("no such payroll run in this company"),
        409: problem("the run is not posted"),
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const body = c.req.valid("json");
      const results = await c.var.withTenant((tx) =>
        generateStatutorySchedule(tx, c.var.ctx, store, {
          companyId,
          payrollDocumentId: body.payrollDocumentId,
          ...(body.schemeIds === undefined ? {} : { schemeIds: body.schemeIds }),
        }),
      );
      return c.json({ items: results.map(present), next_cursor: null }, 201);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["hr"],
      request: { params: CompanyParams, query: StatutoryScheduleQuery },
      middleware: [requirePermission(read, gate)],
      responses: {
        200: {
          description: "Schedules, oldest period first",
          content: { "application/json": { schema: StatutoryScheduleList } },
        },
        400: problem("an unknown or malformed query parameter"),
        403: problem("forbidden"),
      },
    }),
    async (c) => {
      const { companyId } = c.req.valid("param");
      const q = c.req.valid("query");
      const cursor = scheduleCursor(q.cursor);
      const settled = q["filter[settled][eq]"];
      const rows = await c.var.withTenant((tx) =>
        listSchedules(tx, {
          companyId,
          ...(q["filter[schemeId][eq]"] === undefined
            ? {}
            : { schemeId: q["filter[schemeId][eq]"] }),
          ...(q["filter[payrollDocumentId][eq]"] === undefined
            ? {}
            : { payrollDocumentId: q["filter[payrollDocumentId][eq]"] }),
          ...(q["filter[periodStart][gte]"] === undefined
            ? {}
            : { from: q["filter[periodStart][gte]"] }),
          ...(q["filter[periodStart][lte]"] === undefined
            ? {}
            : { to: q["filter[periodStart][lte]"] }),
          ...(settled === undefined ? {} : { settled: settled === "true" }),
          limit: q.limit + 1,
          cursor,
        }),
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const next =
        rows.length > q.limit && last !== undefined
          ? encodeCursor({ k: [last.periodStart], id: last.scheduleId })
          : null;
      return c.json({ items: page.map(present), next_cursor: next }, 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{scheduleId}",
      tags: ["hr"],
      request: { params: ScheduleParams },
      middleware: [requirePermission(read, gate)],
      responses: {
        200: {
          description: "The schedule and its per-employee rows",
          content: { "application/json": { schema: StatutoryScheduleSchema } },
        },
        403: problem("forbidden"),
        404: problem("no such statutory schedule in this company"),
      },
    }),
    async (c) => {
      const { companyId, scheduleId } = c.req.valid("param");
      const result = await c.var.withTenant((tx) => readSchedule(tx, scheduleId, { companyId }));
      return c.json(present(result), 200);
    },
  );

  routes.openapi(
    createRoute({
      method: "get",
      path: "/{scheduleId}/csv",
      tags: ["hr"],
      request: { params: ScheduleParams },
      middleware: [requirePermission(read, gate)],
      responses: {
        200: {
          description:
            "The generic schedule file (⚠️ OD-28's default layout): employee_number, employee_name, scheme_reference, employee_share, employer_share. The ARCHIVED attachment when one is linked (verified against its recorded sha256), else rendered from the record.",
          content: { "text/csv": { schema: z.string() } },
        },
        403: problem("forbidden"),
        404: problem("no such statutory schedule in this company"),
      },
    }),
    async (c) => {
      const { companyId, scheduleId } = c.req.valid("param");
      const { result, attachment } = await c.var.withTenant(async (tx) => {
        const r = await readSchedule(tx, scheduleId, { companyId });
        return {
          result: r,
          attachment: r.attachmentId === null ? null : await getAttachment(tx, r.attachmentId),
        };
      });
      // The archived file is THE record spec:2083 hashes; serving it rather than re-rendering keeps what an officer
      // downloads identical to what was archived, whatever the reader's own visibility of the statutory profiles.
      let csv: string | Uint8Array = scheduleCsv(result);
      if (attachment !== null) {
        try {
          csv = await readAttachmentContent(store, attachment.row);
        } catch (e) {
          // The recorded hash did not match, or the object is gone: never serve the bytes, never echo the key.
          c.var.logger.error(
            { attachment_id: attachment.row.id, err: String(e) },
            "attachment_integrity",
          );
          throw new AppError(
            "ERR_INTERNAL",
            `statutory schedule ${scheduleId}'s file could not be served`,
          );
        }
      }
      return c.body(typeof csv === "string" ? csv : (csv as unknown as ArrayBuffer), 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(scheduleFileName(result))}`,
        "cache-control": "private, no-store",
      });
    },
  );

  routes.openapi(
    createRoute({
      method: "post",
      path: "/{scheduleId}/settle",
      tags: ["hr"],
      request: {
        params: ScheduleParams,
        headers: IdempotencyHeader,
        body: { content: { "application/json": { schema: SettleStatutoryScheduleBody } } },
      },
      middleware: [requirePermission(pay, gate)],
      responses: {
        200: {
          description:
            "Settled: the schedule now names the POSTED PAYMENT to the scheme's authority whose bank leg equals total_employee + total_employer",
          content: { "application/json": { schema: StatutoryScheduleSchema } },
        },
        400: problem(
          "already settled, the document is not a PAYMENT to the scheme's authority, or the payment already settles another schedule",
        ),
        403: problem("forbidden"),
        404: problem("no such statutory schedule, or no such payment, in this company"),
        422: problem(
          "ERR_PAYROLL_REMITTANCE_MISMATCH — the payment is not posted, or moves a different amount out of the bank than the schedule settles",
        ),
      },
    }),
    async (c) => {
      const { companyId, scheduleId } = c.req.valid("param");
      const body = c.req.valid("json");
      // 0091's trigger is the control: a mismatch is 422 ERR_PAYROLL_REMITTANCE_MISMATCH whichever path writes the
      // link, and `fromDatabaseError` lifts the trigger's token to the same row.
      const result = await c.var.withTenant((tx) =>
        settleStatutorySchedule(tx, c.var.ctx, {
          companyId,
          scheduleId,
          remittanceDocumentId: body.remittanceDocumentId,
        }),
      );
      return c.json(present(result), 200);
    },
  );

  return routes;
}

/** Built inside `buildRoutes`, which is the only place the store is in scope (2C's and 7C's shape). One module, one
 *  `PROBES` key (hazard 31). */
export function statutoryScheduleRouteModule(store: ObjectStore): RouteModule {
  return {
    path: STATUTORY_SCHEDULES_PATH,
    router: createStatutoryScheduleRoutes(store),
    permissions: [pay, read],
    auth: "human",
  };
}
