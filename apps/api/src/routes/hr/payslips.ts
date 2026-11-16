import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema } from "@dulja/contracts";
import { GeneratePayslipsBody, GeneratePayslipsResult } from "@dulja/contracts/hr/payslip";
import {
  insertAttachment,
  payslipRows,
  payslipRunState,
  stageAttachment,
  type AttachmentRow,
  type ObjectStore,
  type StagedAttachment,
} from "@dulja/db";
import { intlFormatters } from "@dulja/domain";
import type { AppEnv } from "../../context";
import { requireFilingGenerate } from "../../hr/authorise";
import { PAYSLIP_ENGINE, renderPayslip } from "../../print/payslip";
import { requireReportRead, resolveDefinitionForRun } from "../../reports/authorise";
import { IdempotencyHeader } from "../idempotency-header";

const Params = z.object({ companyId: z.string().uuid(), documentId: z.string().uuid() });
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** The §4.16.1 code a payslip renders from. Its highest live version for the company wins, exactly as a report run
 *  resolves its code (`resolveDefinitionForRun`) — a tenant's clone of `hr.payslip` is the payslip it prints. */
const PAYSLIP_CODE = "hr.payslip";

/**
 * 8D T5 — `POST /v1/companies/{companyId}/payroll-runs/{documentId}/payslips` (spec:2083; amendments A4, A5 and A11,
 * contracts round 19; ADR 0079, a proposal). One PDF per employee of one POSTED run, rendered SYNCHRONOUSLY through
 * 7A's pure layout and 2C's engine, and stored as one `app.attachment` per employee ON THE RUN — so 2C's download
 * gate reads it under the run's module code (`hr` → `hr.payroll.read`). No pg-boss name: `JOBS` stays closed.
 *
 * A normal idempotent write (A5), not a `REPLAY_BY_RERUN` member: it writes, and its JSON answer replays from the
 * stored body. Every generation writes NEW attachment rows and never touches an earlier one, so the hash of what an
 * employee was given is never overwritten (spec:2049).
 *
 * TWO gates, 7A's run shape: the route's own code (`hr.filing.generate`, Task 1's `requireFilingGenerate`) before any
 * row is read, then the definition's read code (`hr.payroll.read` as shipped) resolved from data — a payslip prints
 * posted payroll amounts, which test 32 puts behind that code. Every read is bound to the path's company.
 *
 * Composed onto 8B's `payroll-runs` module by `buildRoutes` — a sub-path of an existing module, so it adds no
 * `PROBES` key (hazard 31); the module's `permissions` gain `hr.filing.generate` (closing LEGACY-047's unrouted code).
 */
export function createPayslipRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

  routes.openapi(
    createRoute({
      method: "post",
      path: "/{documentId}/payslips",
      tags: ["hr"],
      request: {
        params: Params,
        headers: IdempotencyHeader,
        body: {
          required: true,
          content: { "application/json": { schema: GeneratePayslipsBody } },
        },
      },
      middleware: [requireFilingGenerate()],
      // Every status the handler can produce, and none it cannot.
      responses: {
        201: {
          description:
            "One PDF attachment per employee of the run (or of the named employees the run paid), each with its server-computed sha256. `next_cursor` is always null.",
          content: { "application/json": { schema: GeneratePayslipsResult } },
        },
        400: problem("an invalid body"),
        403: problem(
          "the caller lacks hr.filing.generate, or the payslip definition's read code (hr.payroll.read), in this company (ERR_RBAC_FORBIDDEN)",
        ),
        404: problem(
          "no such payroll run in this company, or the hr.payslip report definition is not seeded for it (ERR_NOT_FOUND)",
        ),
        409: problem(
          "the run is not posted, so it has no payroll figures to print (ERR_DOC_STATUS_ILLEGAL)",
        ),
        422: problem("the ADR-0016 engine has no text adapter (ERR_PRINT_ENGINE_UNSUPPORTED)"),
      },
    }),
    async (c) => {
      const { companyId, documentId } = c.req.valid("param");
      const { lang, employeeIds } = c.req.valid("json");

      const state = await c.var.withTenant((tx) =>
        payslipRunState(tx, { companyId, payrollDocumentId: documentId }),
      );
      if (state === null) {
        throw new AppError("ERR_NOT_FOUND", `no payroll run ${documentId} in company ${companyId}`);
      }
      if (state.status !== "posted" && state.status !== "reversed") {
        throw new AppError(
          "ERR_DOC_STATUS_ILLEGAL",
          `payroll run ${documentId} is ${state.status}; a payslip is made of POSTED figures only (spec:2083)`,
        );
      }
      const { definition } = await resolveDefinitionForRun(c, companyId, PAYSLIP_CODE);
      await requireReportRead(c, companyId, definition.permission);

      const { bundles, baseCurrency } = await c.var.withTenant(async (tx) => {
        const [company] = await tx<{ base_currency: string }[]>`
          select base_currency from app.company where id = ${companyId}::uuid`;
        if (company === undefined) {
          throw new AppError("ERR_NOT_FOUND", `company ${companyId} is not visible`);
        }
        return {
          baseCurrency: company.base_currency.trim(),
          bundles: await payslipRows(tx, {
            companyId,
            payrollDocumentId: documentId,
            ...(employeeIds === undefined ? {} : { employeeIds }),
          }),
        };
      });

      // Render and stage OUTSIDE any row transaction: Chromium and the object store hold no row lock and no pooled
      // connection. That holds because this route is a `TRANSACTION_AT_FIRST_WRITE` member (CON-02): the reads above
      // were short transactions of their own, and the request transaction opens at the insert below, which commits
      // with the record of this response. `intlFormatters` is @dulja/domain's — the worker's own formatter adapter is
      // an app's, and apps/api may not import an app (§3.1).
      const formatters = intlFormatters(lang, { currency: baseCurrency });
      const generatedAt = new Date().toISOString();
      const staged: {
        employeeNumber: string;
        input: Parameters<typeof stageAttachment>[2];
        staged: StagedAttachment;
      }[] = [];
      try {
        for (const bundle of bundles) {
          const pdf = await renderPayslip(definition, bundle, {
            lang,
            engine: PAYSLIP_ENGINE,
            formatters,
            currency: baseCurrency,
            generatedAt,
          });
          const input = {
            companyId,
            documentId,
            fileName: pdf.fileName,
            mimeType: "application/pdf",
            bytes: pdf.bytes,
          };
          staged.push({
            employeeNumber: bundle.header.employeeNumber,
            input,
            staged: await stageAttachment(objectStore, c.var.ctx, input),
          });
        }
      } catch (error) {
        // A render that fails part-way leaves no object behind it.
        await Promise.all(
          staged.map((s) => objectStore.delete(s.staged.objectKey).catch(() => undefined)),
        );
        throw error;
      }

      let rows: AttachmentRow[];
      try {
        rows = await c.var.withTenant(async (tx) => {
          const out: AttachmentRow[] = [];
          for (const s of staged) {
            out.push(await insertAttachment(tx, c.var.ctx, objectStore, s.input, s.staged));
          }
          return out;
        });
      } catch (error) {
        // The rows roll back together; their objects go with them (insertAttachment removes only its own).
        await Promise.all(
          staged.map((s) => objectStore.delete(s.staged.objectKey).catch(() => undefined)),
        );
        throw error;
      }

      const items = rows.map((row, i) => ({
        attachmentId: row.id,
        employeeId: bundles[i]!.header.employeeId,
        employeeNumber: staged[i]!.employeeNumber,
        fileName: row.fileName,
        byteSize: row.byteSize,
        sha256: row.sha256,
      }));
      return c.json({ items, next_cursor: null }, 201);
    },
  );
  return routes;
}
