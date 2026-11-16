import {
  AccountList,
  FiscalPeriodList,
  ItemList,
  PartyList,
  ReportDefinitionList,
  ReportDefinitionSchema,
  ReportRunAcceptedSchema,
  ReportRunList,
  ReportRunSchema,
  SavedViewList,
  SavedViewSchema,
  WarehouseList,
  type CreateReportRunBody,
  type CreateSavedViewBody,
} from "@dulja/contracts";
import { MyCompaniesSchema } from "@dulja/contracts/admin/my-companies";
import { z, type ZodType } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

/** The reference kinds a report parameter can name (§4.11.1's `parameter.kind`), each read from the list route
 *  that already serves it. `dimension_value` has no list route a screen can use, so it stays a typed id. */
export type LookupKind = "period" | "account" | "party" | "item" | "warehouse" | "branch";

/** One choice in a parameter's dropdown: the id the run sends and the words the operator reads. */
export interface LookupOption {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  /** A fiscal period has no code or name; the screen formats its two dates in the operator's locale. */
  period?: { startsOn: string; endsOn: string };
}

/** What a parameter's dropdown offers: the choices read, and whether they are every record the route holds. */
export interface LookupResult {
  options: LookupOption[];
  /** False when the list stopped at `LOOKUP_MAX_PAGES` with more pages left; the form then also takes a typed id. */
  complete: boolean;
}

/** `ListQuery`'s maximum page size. */
export const LOOKUP_PAGE_SIZE = 1000;
/**
 * The pages a lookup follows before it stops: 10,000 choices. A list is read to its last `next_cursor`, so a
 * record past the first page can be chosen (7 review); past this cap a dropdown is no longer a usable way to
 * choose, and the form keeps the choices it read and also accepts a typed or pasted id.
 */
export const LOOKUP_MAX_PAGES = 10;

/** A master's choices: its id, code and two names. */
const named = ({
  items,
  complete,
}: {
  items: readonly Pick<LookupOption, "id" | "code" | "nameEn" | "nameAr">[];
  complete: boolean;
}): LookupResult => ({
  options: items.map(({ id, code, nameEn, nameAr }) => ({ id, code, nameEn, nameAr })),
  complete,
});

/** A query string from the members that are set; `null` and `undefined` are left out. */
const query = (params: Record<string, string | null | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ).toString();

/**
 * 7A Task 15's handwritten fetch layer over the report routes (7A Tasks 12–13), the definition, run and saved-view
 * shapes of `packages/contracts`. There is no generated client (AGENTS.md, "Planned Architecture"); every call
 * goes through `createAdminApi`, so a refusal is a problem envelope and a retry keeps its idempotency key.
 */
export function createReportApi(apiOptions: AdminApiOptions, companyId: string) {
  const api = createAdminApi(apiOptions);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  /** Every page of a list route, following `next_cursor` up to `LOOKUP_MAX_PAGES`. */
  async function allPages<T>(
    path: string,
    schema: ZodType<{ items: T[]; next_cursor: string | null }>,
    options: RequestOptions | undefined,
  ): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
      const body: { items: T[]; next_cursor: string | null } = await api.get(
        `${path}?${query({ limit: String(LOOKUP_PAGE_SIZE), cursor })}`,
        schema,
        options,
      );
      items.push(...body.items);
      cursor = body.next_cursor;
      if (cursor === null) return { items, complete: true };
    }
    return { items, complete: false };
  }
  return {
    definitions: (cursor: string | null, code: string | null, options?: RequestOptions) =>
      api.get(
        `${root}/report-definitions?${query({ limit: "1000", cursor, "filter[code][eq]": code })}`,
        ReportDefinitionList,
        options,
      ),
    definition: (id: string, options?: RequestOptions) =>
      api.get(
        `${root}/report-definitions/${encodeURIComponent(id)}`,
        ReportDefinitionSchema,
        options,
      ),
    clone: (id: string, options: SendOptions) =>
      api.send(
        "POST",
        `${root}/report-definitions/${encodeURIComponent(id)}/clone`,
        {},
        ReportDefinitionSchema,
        options,
      ),
    update: (id: string, definition: Record<string, unknown>, options: SendOptions) =>
      api.send(
        "PUT",
        `${root}/report-definitions/${encodeURIComponent(id)}`,
        { definition },
        ReportDefinitionSchema,
        options,
      ),
    archive: (id: string, options: SendOptions) =>
      api.send(
        "POST",
        `${root}/report-definitions/${encodeURIComponent(id)}/archive`,
        undefined,
        z.unknown(),
        options,
      ),
    run: (code: string, body: z.input<typeof CreateReportRunBody>, options: SendOptions) =>
      api.send(
        "POST",
        `${root}/reports/${encodeURIComponent(code)}/runs`,
        body,
        ReportRunAcceptedSchema,
        options,
      ),
    /** `statusUrl` is the path the 202 answered with, `/v1/companies/{companyId}/report-runs/{runId}`. */
    status: (statusUrl: string, options?: RequestOptions) =>
      api.get(statusUrl, ReportRunSchema, options),
    runs: (definitionId: string, options?: RequestOptions) =>
      api.get(
        `${root}/report-runs?${query({ limit: "20", "filter[report_definition_id][eq]": definitionId })}`,
        ReportRunList,
        options,
      ),
    content: (runId: string, options?: RequestOptions) =>
      api.download(`${root}/report-runs/${encodeURIComponent(runId)}/content`, options),
    views: (definitionId: string, options?: RequestOptions) =>
      api.get(
        `${root}/saved-views?${query({ limit: "200", "filter[report_definition_id][eq]": definitionId })}`,
        SavedViewList,
        options,
      ),
    saveView: (body: z.input<typeof CreateSavedViewBody>, options: SendOptions) =>
      api.send("POST", `${root}/saved-views`, body, SavedViewSchema, options),
    archiveView: (id: string, options: SendOptions) =>
      api.send(
        "DELETE",
        `${root}/saved-views/${encodeURIComponent(id)}`,
        undefined,
        z.unknown(),
        options,
      ),
    /**
     * A parameter's choices. Each list route is gated on its own read code (or membership), so a refusal here
     * is answered by the form falling back to a typed id — never by hiding the parameter.
     */
    async lookup(kind: LookupKind, options?: RequestOptions): Promise<LookupResult> {
      switch (kind) {
        case "period": {
          const { items, complete } = await allPages(
            `${root}/fiscal-periods`,
            FiscalPeriodList,
            options,
          );
          return {
            options: items.map(({ id, startsOn, endsOn }) => ({
              id,
              code: startsOn,
              nameEn: endsOn,
              nameAr: null,
              period: { startsOn, endsOn },
            })),
            complete,
          };
        }
        case "account":
          return named(await allPages(`${root}/accounts`, AccountList, options));
        case "party":
          return named(await allPages(`${root}/parties`, PartyList, options));
        case "item":
          return named(await allPages(`${root}/items`, ItemList, options));
        case "warehouse":
          return named(await allPages(`${root}/warehouses`, WarehouseList, options));
        case "branch": {
          // The caller's own branches in this company, from the membership-scoped lookup (ADR 0089; review
          // UI-11 — `/v1/staff-context` answers only seven staff codes). One document, never paged.
          const mine = await api.get("/v1/me/companies", MyCompaniesSchema, options);
          const company = mine.companies.find((c) => c.id === companyId);
          return named({ items: company?.branches ?? [], complete: true });
        }
      }
    },
  };
}

export type ReportApi = ReturnType<typeof createReportApi>;

/**
 * Hands a downloaded artefact to the operator as a file. The content routes need the bearer token, so a plain
 * link cannot reach them; the bytes are fetched through the API door and saved from an object URL.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task, after the click has handed the URL to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
