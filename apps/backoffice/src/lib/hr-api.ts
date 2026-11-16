import { SessionSchema } from "@dulja/contracts";
import { EmployeeSchema } from "@dulja/contracts/hr/employee";
import { HrSettingSchema, UpdateHrSettingBody } from "@dulja/contracts/hr/hr-setting";
import {
  CompensationLineSchema,
  CompensationList,
  OpenCompensationBody,
} from "@dulja/contracts/hr/compensation";
import {
  CreatePayComponentBody,
  PayComponentList,
  PayComponentSchema,
  SetComponentSchemesBody,
  UpdatePayComponentBody,
} from "@dulja/contracts/hr/pay-component";
import { PermitExpiryList } from "@dulja/contracts/hr/permit-expiry";
import {
  EmployeeSensitiveSchema,
  UpdateEmployeeSensitiveBody,
} from "@dulja/contracts/hr/sensitive";
import {
  OpenStatutoryProfileBody,
  StatutoryProfileList,
  StatutoryProfileSchema,
} from "@dulja/contracts/hr/statutory-profile";
import {
  RateTableList,
  RateTableSchema,
  StatutorySchemeList,
} from "@dulja/contracts/hr/statutory-scheme";
import type { z } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

/**
 * 8A Task 13's handwritten fetch layer over 8A's HR routes (Tasks 4, 5, 7, 10, 11). Every body is parsed by the
 * route's own strict contract before it leaves, so a screen cannot send a member the server would refuse. There is
 * no generated client (AGENTS.md).
 */
export function hrApi(options: AdminApiOptions, companyId: string) {
  const api = createAdminApi(options);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  const employee = (id: string) => `${root}/employees/${encodeURIComponent(id)}`;
  const component = (id: string) => `${root}/pay-components/${encodeURIComponent(id)}`;
  const scheme = (id: string) => `${root}/statutory-schemes/${encodeURIComponent(id)}`;
  return {
    /** Who is signed in — the rate-table screen disables "verify" for the principal that loaded a table. */
    session: (request?: RequestOptions) => api.get("/v1/session", SessionSchema, request),
    employee: (id: string, request?: RequestOptions) =>
      api.get(employee(id), EmployeeSchema, request),
    sensitive: (id: string, request?: RequestOptions) =>
      api.get(`${employee(id)}/sensitive`, EmployeeSensitiveSchema, request),
    saveSensitive: (
      id: string,
      body: z.input<typeof UpdateEmployeeSensitiveBody>,
      request: SendOptions,
    ) =>
      api.send(
        "PUT",
        `${employee(id)}/sensitive`,
        UpdateEmployeeSensitiveBody.parse(body),
        EmployeeSensitiveSchema,
        request,
      ),
    profiles: (id: string, request?: RequestOptions) =>
      api.get(`${employee(id)}/statutory-profiles`, StatutoryProfileList, request),
    openProfile: (
      id: string,
      body: z.input<typeof OpenStatutoryProfileBody>,
      request: SendOptions,
    ) =>
      api.send(
        "POST",
        `${employee(id)}/statutory-profiles`,
        OpenStatutoryProfileBody.parse(body),
        StatutoryProfileSchema,
        request,
      ),
    compensation: (id: string, request?: RequestOptions) =>
      api.get(`${employee(id)}/compensation-lines`, CompensationList, request),
    openCompensation: (
      id: string,
      body: z.input<typeof OpenCompensationBody>,
      request: SendOptions,
    ) =>
      api.send(
        "POST",
        `${employee(id)}/compensation-lines`,
        OpenCompensationBody.parse(body),
        CompensationLineSchema,
        request,
      ),
    /** The live catalogue — what a new compensation line may name. */
    payComponents: (request?: RequestOptions) =>
      api.get(`${root}/pay-components`, PayComponentList, request),
    /** Archived rows too: the catalogue screen, and a closed compensation line naming a retired component. */
    allPayComponents: (request?: RequestOptions) =>
      api.get(
        `${root}/pay-components?${new URLSearchParams({ "filter[archived][eq]": "true" })}`,
        PayComponentList,
        request,
      ),
    createPayComponent: (body: z.input<typeof CreatePayComponentBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${root}/pay-components`,
        CreatePayComponentBody.parse(body),
        PayComponentSchema,
        request,
      ),
    renamePayComponent: (
      id: string,
      body: z.input<typeof UpdatePayComponentBody>,
      request: SendOptions,
    ) =>
      api.send(
        "PATCH",
        component(id),
        UpdatePayComponentBody.parse(body),
        PayComponentSchema,
        request,
      ),
    addComponentSchemes: (
      id: string,
      body: z.input<typeof SetComponentSchemesBody>,
      request: SendOptions,
    ) =>
      api.send(
        "PUT",
        `${component(id)}/schemes`,
        SetComponentSchemesBody.parse(body),
        PayComponentSchema,
        request,
      ),
    archivePayComponent: (id: string, request: SendOptions) =>
      api.send("POST", `${component(id)}/archive`, undefined, PayComponentSchema, request),
    schemes: (request?: RequestOptions) =>
      api.get(`${root}/statutory-schemes`, StatutorySchemeList, request),
    rateTables: (schemeId: string, request?: RequestOptions) =>
      api.get(`${scheme(schemeId)}/rate-tables`, RateTableList, request),
    loadRateTable: (schemeId: string, definition: unknown, request: SendOptions) =>
      api.send("POST", `${scheme(schemeId)}/rate-tables`, { definition }, RateTableSchema, request),
    verifyTable: (schemeId: string, version: number, request: SendOptions) =>
      api.send(
        "POST",
        `${scheme(schemeId)}/rate-tables/${version}/verify`,
        undefined,
        RateTableSchema,
        request,
      ),
    /** 8D T10 — the permit half of spec:2091's expiry list (8D T3), behind `hr.employee.read_sensitive`. */
    permitExpiry: (
      query: { withinDays: number; includeTerminated: boolean },
      request?: RequestOptions,
    ) =>
      api.get(
        `${root}/employees/permit-expiry?${new URLSearchParams({
          withinDays: String(query.withinDays),
          includeTerminated: String(query.includeTerminated),
        })}`,
        PermitExpiryList,
        request,
      ),
    settings: (request?: RequestOptions) =>
      api.get(`${root}/hr-settings`, HrSettingSchema, request),
    saveSettings: (body: z.input<typeof UpdateHrSettingBody>, request: SendOptions) =>
      api.send(
        "PUT",
        `${root}/hr-settings`,
        UpdateHrSettingBody.parse(body),
        HrSettingSchema,
        request,
      ),
  };
}

export type HrApi = ReturnType<typeof hrApi>;
