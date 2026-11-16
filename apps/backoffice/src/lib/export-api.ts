import {
  ExportAcceptedSchema,
  ExportJobList,
  ExportJobSchema,
  type CreateExportBody,
} from "@dulja/contracts";
import type { z } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

/**
 * 7C Task 13's handwritten fetch layer over the four tenant-export routes (7C Task 9, ADRs 0069/0070), all under
 * `admin.data.export` and each answering only its requester. There is no generated client (AGENTS.md).
 */
export function createExportApi(apiOptions: AdminApiOptions, companyId: string) {
  const api = createAdminApi(apiOptions);
  const root = `/v1/companies/${encodeURIComponent(companyId)}/exports`;
  return {
    /** The status resource of one export: what a 202's `statusUrl` names, and what a listed row reaches. */
    statusUrlFor: (exportJobId: string) => `${root}/${encodeURIComponent(exportJobId)}`,
    request: (body: z.input<typeof CreateExportBody>, options: SendOptions) =>
      api.send("POST", root, body, ExportAcceptedSchema, options),
    list: (options?: RequestOptions) => api.get(`${root}?limit=50`, ExportJobList, options),
    status: (statusUrl: string, options?: RequestOptions) =>
      api.get(statusUrl, ExportJobSchema, options),
    content: (exportJobId: string, options?: RequestOptions) =>
      api.download(`${root}/${encodeURIComponent(exportJobId)}/content`, options),
  };
}
