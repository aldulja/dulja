import {
  TaxCodeList,
  TaxReturnDetail,
  TaxReturnList,
  TaxReturnSchema,
  type CreateTaxReturnBody,
} from "@dulja/contracts";
import type { z } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

/** Reuse the application's schema-checked HTTP door, including problem envelopes and retry keys. */
export function createTaxApi(apiOptions: AdminApiOptions, companyId: string) {
  const api = createAdminApi(apiOptions);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  return {
    codes: (cursor: string | null, options?: RequestOptions) =>
      api.get(
        `${root}/tax-codes?${new URLSearchParams({ limit: "1000", ...(cursor === null ? {} : { cursor }) })}`,
        TaxCodeList,
        options,
      ),
    returns: (regimeCode: string, cursor: string | null, options?: RequestOptions) =>
      api.get(
        `${root}/tax-returns?${new URLSearchParams({ limit: "100", ...(regimeCode === "" ? {} : { "filter[regimeCode][eq]": regimeCode }), ...(cursor === null ? {} : { cursor }) })}`,
        TaxReturnList,
        options,
      ),
    detail: (id: string, options?: RequestOptions) =>
      api.get(`${root}/tax-returns/${encodeURIComponent(id)}`, TaxReturnDetail, options),
    create: (body: z.infer<typeof CreateTaxReturnBody>, options: SendOptions) =>
      api.send("POST", `${root}/tax-returns`, body, TaxReturnSchema, options),
    generate: (id: string, options: SendOptions) =>
      api.send(
        "POST",
        `${root}/tax-returns/${encodeURIComponent(id)}/generate`,
        {},
        TaxReturnDetail,
        options,
      ),
  };
}
