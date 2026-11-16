import { ReportDefinitionSchema } from "@dulja/contracts";
import { CATALOGUES, type Locale, type TranslationKey } from "@dulja/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { I18nProvider } from "../../src/lib/i18n-provider";
import { RouterAround } from "./router";

/** Shared fixtures for the 7A report screens and the 7C export screen (T15, T13). */
export const COMPANY = "0192cccc-0001-7000-8000-000000000001";
export const CORE = "0192dddd-0001-7000-8000-000000000001";
export const COPY = "0192dddd-0002-7000-8000-000000000002";
export const PERIOD = "0192eeee-0001-7000-8000-000000000001";
export const VIEW = "0192ffff-0001-7000-8000-000000000001";
export const RUN = "0192abab-0001-7000-8000-000000000001";
export const ACTOR = "0192acac-0001-7000-8000-000000000001";
export const CODE = "accounting.trial_balance";

export const definition = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  code: CODE,
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [
    { name: "fiscalPeriodId", kind: "period", required: true },
    { name: "partyId", kind: "party", required: false },
    { name: "isMatched", kind: "enum", required: true, options: ["false", "true"] },
    { name: "currency", kind: "text", required: false },
  ],
  dataset: { source: "account_balance", filters: [] },
  columns: [
    {
      field: "account_code",
      labelEn: "Account",
      labelAr: "الحساب",
      format: "text",
      align: "start",
      width: 70,
    },
    { field: "debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
    { field: "credit", labelEn: "Credit", labelAr: "دائن", format: "money", align: "end" },
  ],
  groups: [],
  totals: [{ field: "debit", fn: "sum" }],
  sort: [{ field: "account_code", dir: "asc" }],
  layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "" },
  tieOut: { kind: "none" },
  ...overrides,
});

export const definitionRow = (
  id: string,
  options: {
    isCore?: boolean;
    version?: number;
    clonedFrom?: string | null;
    archivedAt?: string | null;
    definition?: Record<string, unknown>;
  } = {},
) =>
  ReportDefinitionSchema.parse({
    id,
    companyId: COMPANY,
    code: CODE,
    version: options.version ?? (options.isCore === false ? 3 : 2),
    definition: options.definition ?? definition(),
    clonedFrom: options.clonedFrom ?? null,
    isCore: options.isCore ?? true,
    archivedAt: options.archivedAt ?? null,
    createdAt: "2026-11-01T00:00:00Z",
  });

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });

export const problem = (
  status: number,
  code: string,
  errors?: { path: string; message: string }[],
) =>
  json(
    {
      type: `urn:dulja:error:${code}`,
      title: "Server title",
      status,
      detail: `server detail for ${code}`,
      instance: "/v1/x",
      code,
      remedy: "Server remedy",
      requestId: "req-1",
      ...(errors === undefined ? {} : { errors }),
    },
    status,
  );

/** Every string the screen shows, read from the catalogue the test runs in. */
export const sayIn =
  (locale: Locale) =>
  (key: TranslationKey, vars: Record<string, string> = {}): string =>
    Object.entries(vars).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      CATALOGUES[locale][key] ?? key,
    );

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export function fetchMock(handler: Handler) {
  return vi.fn<typeof fetch>(async (input, init) => handler(new URL(String(input)), init));
}

export function mountWith(
  fetchImpl: typeof fetch,
  locale: Locale,
  screen: (api: {
    baseUrl: string;
    accessToken: () => string | null;
    fetchImpl: typeof fetch;
  }) => ReactNode,
) {
  const api = { baseUrl: "https://example.test", accessToken: () => "token", fetchImpl };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <RouterAround>
      <QueryClientProvider client={cache}>
        <I18nProvider store={{ read: () => locale, write: () => undefined }}>
          {screen(api)}
        </I18nProvider>
      </QueryClientProvider>
    </RouterAround>,
  );
  return userEvent.setup();
}

export const calls = (fetchImpl: ReturnType<typeof fetchMock>, method: string, path: RegExp) =>
  fetchImpl.mock.calls.filter(
    ([input, init]) =>
      (init?.method ?? "GET") === method && path.test(new URL(String(input)).pathname),
  );

/** `saveBlob` hands the bytes to an anchor; jsdom has no object URLs and no downloads, so both are stubbed. */
export function stubDownloads() {
  const created = vi.fn((_blob: Blob) => "blob:report");
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
  const clicks: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    },
  );
  return { created, clicks };
}
