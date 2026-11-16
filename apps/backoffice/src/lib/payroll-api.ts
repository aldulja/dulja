import { AttachmentList } from "@dulja/contracts/accounting/attachment";
import { TransitionBody, TransitionResultSchema } from "@dulja/contracts/accounting/document";
import { EmployeeList } from "@dulja/contracts/hr/employee";
import {
  CreatePayrollRunBody,
  PayrollRunList,
  PayrollRunSchema,
  SetPayrollOverrideBody,
} from "@dulja/contracts/hr/payroll-run";
import { GeneratePayslipsBody, GeneratePayslipsResult } from "@dulja/contracts/hr/payslip";
import type { z } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

export type PayrollRunStatus = z.infer<typeof PayrollRunSchema>["status"];

/**
 * 8B Task 15's handwritten fetch layer over 8B's payroll-run routes (T10, T11) and 2B's GENERIC document transitions
 * — submit, approve and post have no payroll-specific route, so the screen reaches R1 and R2 exactly where every
 * other document does. Every body is parsed by the route's own strict contract before it leaves. The screen computes
 * no figure: every amount it shows is a line the run service wrote (a second payroll arithmetic would be SAH-009 in
 * a browser).
 */
/** 2C's attachment list's largest page (`AttachmentQuery.limit` max 1000). */
const ATTACHMENT_PAGE = 1000;

export function payrollApi(options: AdminApiOptions, companyId: string) {
  const api = createAdminApi(options);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  const run = (id: string) => `${root}/payroll-runs/${encodeURIComponent(id)}`;
  return {
    runs: (
      filter: { status: PayrollRunStatus | null; cursor: string | null },
      request?: RequestOptions,
    ) => {
      const query = new URLSearchParams({ limit: "50" });
      if (filter.status !== null) query.set("filter[status][eq]", filter.status);
      if (filter.cursor !== null) query.set("cursor", filter.cursor);
      return api.get(`${root}/payroll-runs?${query}`, PayrollRunList, request);
    },
    run: (id: string, request?: RequestOptions) => api.get(run(id), PayrollRunSchema, request),
    create: (body: z.input<typeof CreatePayrollRunBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${root}/payroll-runs`,
        CreatePayrollRunBody.parse(body),
        PayrollRunSchema,
        request,
      ),
    recalculate: (id: string, request: SendOptions) =>
      api.send("POST", `${run(id)}/recalculate`, undefined, PayrollRunSchema, request),
    override: (id: string, body: z.input<typeof SetPayrollOverrideBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${run(id)}/overrides`,
        SetPayrollOverrideBody.parse(body),
        PayrollRunSchema,
        request,
      ),
    /** 2B's shared state machine (§4.5.4): R1 and R2 are its triggers, never this screen's checks. */
    transition: (id: string, body: z.input<typeof TransitionBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${root}/documents/${encodeURIComponent(id)}/transitions`,
        TransitionBody.parse(body),
        TransitionResultSchema,
        request,
      ),
    /**
     * 8D T10 — payslips for a POSTED run (8D T5): one PDF attachment per employee, rendered and hashed by the server.
     * The answer carries each file's name and sha256; the bytes are 2C's attachment content route.
     */
    payslips: (id: string, body: z.input<typeof GeneratePayslipsBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${run(id)}/payslips`,
        GeneratePayslipsBody.parse(body),
        GeneratePayslipsResult,
        request,
      ),
    /**
     * Phase 8 review — every attachment on the run, through 2C's list (`?documentId=`), which asks the run's module
     * read code (`hr.payroll.read`) at its branch. The screen keeps the payslips: every earlier generation stays
     * downloadable, each under the sha256 the server recorded when it was given out.
     */
    runAttachments: async (id: string, request?: RequestOptions) => {
      const answer = await api.get(
        `${root}/attachments?${new URLSearchParams({ documentId: id, limit: String(ATTACHMENT_PAGE) })}`,
        AttachmentList,
        request,
      );
      // PRD-25: the route answers one page, oldest first, with no cursor and no range filter, so a full page may
      // have cut off the newest generation; the screen is told rather than shown it as the whole list.
      return { ...answer, complete: answer.items.length < ATTACHMENT_PAGE };
    },
    payslipContent: (attachmentId: string, request?: RequestOptions) =>
      api.download(`${root}/attachments/${encodeURIComponent(attachmentId)}/content`, request),
    /** One page of a branch's employees (6C), for naming the employees of a supplementary or final run. */
    employees: (branchId: string, cursor: string | null, request?: RequestOptions) => {
      const query = new URLSearchParams({ limit: "200", "filter[homeBranchId][eq]": branchId });
      if (cursor !== null) query.set("cursor", cursor);
      return api.get(`${root}/employees?${query}`, EmployeeList, request);
    },
  };
}

export type PayrollApi = ReturnType<typeof payrollApi>;
