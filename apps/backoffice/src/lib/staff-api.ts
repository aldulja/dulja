import { StaffContextSchema } from "@dulja/contracts/admin/staff-context";
import { CreateEmployeeBody, EmployeeList, EmployeeSchema } from "@dulja/contracts/hr/employee";
import {
  BranchPosPolicyList,
  BranchPosPolicySchema,
  UpsertBranchPosPolicyBody,
} from "@dulja/contracts/pos/branch-pos-policy";
import {
  CashierList,
  CashierSchema,
  CreateCashierBody,
  SetPinBody,
} from "@dulja/contracts/pos/cashier";
import type { z } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

/** The keyset page query every staff directory sends; an empty branch means every accessible one. */
const page = (filterKey: string, branchId: string, cursor: string | null) =>
  new URLSearchParams({
    limit: "1000",
    ...(branchId === "" ? {} : { [filterKey]: branchId }),
    ...(cursor === null ? {} : { cursor }),
  });

export function staffApi(options: AdminApiOptions, companyId: string) {
  const api = createAdminApi(options);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  const cashier = (principalId: string) => `${root}/cashiers/${encodeURIComponent(principalId)}`;
  return {
    context: (request?: RequestOptions) =>
      api.get("/v1/staff-context", StaffContextSchema, request),
    policies: (branchId: string, request?: RequestOptions) =>
      api.get(
        `${root}/branch-pos-policies?${new URLSearchParams({ limit: "1000", "filter[branchId][eq]": branchId })}`,
        BranchPosPolicyList,
        request,
      ),
    savePolicy: (body: z.infer<typeof UpsertBranchPosPolicyBody>, request: SendOptions) =>
      api.send(
        "PUT",
        `${root}/branch-pos-policies`,
        UpsertBranchPosPolicyBody.parse(body),
        BranchPosPolicySchema,
        request,
      ),
    employees: (branchId: string, cursor: string | null, request?: RequestOptions) =>
      api.get(
        `${root}/employees?${page("filter[homeBranchId][eq]", branchId, cursor)}`,
        EmployeeList,
        request,
      ),
    createEmployee: (body: z.infer<typeof CreateEmployeeBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${root}/employees`,
        CreateEmployeeBody.parse(body),
        EmployeeSchema,
        request,
      ),
    cashiers: (branchId: string, cursor: string | null, request?: RequestOptions) =>
      api.get(
        `${root}/cashiers?${page("filter[branchId][eq]", branchId, cursor)}`,
        CashierList,
        request,
      ),
    createCashier: (body: z.infer<typeof CreateCashierBody>, request: SendOptions) =>
      api.send("POST", `${root}/cashiers`, CreateCashierBody.parse(body), CashierSchema, request),
    setPin: (principalId: string, body: z.infer<typeof SetPinBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${cashier(principalId)}/pin`,
        SetPinBody.parse(body),
        CashierSchema,
        request,
      ),
    // The route's body schema is a strict empty object, so `{}` is sent rather than no body at all.
    revokeCashier: (principalId: string, request: SendOptions) =>
      api.send("POST", `${cashier(principalId)}/revoke`, {}, CashierSchema, request),
  };
}
