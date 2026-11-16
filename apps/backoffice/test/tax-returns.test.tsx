import { TaxCodeList, TaxReturnDetail } from "@dulja/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/lib/i18n-provider";
import { TaxReturnsRoute } from "../src/routes/accounting/tax-returns";
import { RouterAround } from "./support/router";

const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const ID = "0192aaaa-0001-7000-8000-000000000001";
const OTHER = "0192aaaa-0002-7000-8000-000000000002";
const REGIME = "0192bbbb-0001-7000-8000-000000000001";
const row = (id = ID, status: "draft" | "generated" | "filed" = "draft") => ({
  id,
  regimeId: REGIME,
  regimeCode: "SYNTH-MY-v1",
  regimeVersion: 1,
  periodStart: "2026-01-01",
  periodEnd: "2026-03-31",
  status,
  payloadSha256: status === "draft" ? null : "a".repeat(64),
  generatedBy: status === "draft" ? null : ID,
  filedAt: status === "filed" ? "2026-04-01T00:00:00Z" : null,
  attachmentId: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const detail = (
  id = ID,
  status: "draft" | "generated" | "filed" = "generated",
  difference = "0.0000",
) => ({
  taxReturn: row(id, status),
  boxes:
    status === "draft"
      ? []
      : Array.from({ length: 5 }, (_, i) => ({
          code: `BOX-${i}`,
          label: `Box ${i}`,
          amount: "110.0000",
        })),
  payload: status === "draft" ? null : "{}",
  tieOut:
    status === "draft"
      ? []
      : ["2300", "1350"].map((accountCode) => ({
          accountCode,
          boxCodes: ["BOX-0"],
          boxBase: "110.0000",
          ledgerBase: "110.0000",
          difference,
        })),
  currency: "MYR",
});
const codes = {
  items: [
    {
      id: ID,
      regimeId: REGIME,
      regimeCode: "SYNTH-MY-v1",
      regimeVersion: 1,
      code: "SYN-OUT-STD",
      nameEn: "Synthetic",
      nameAr: null,
      rate: "0.11000000",
      kind: "output",
      roundingMode: "HALF_AWAY_FROM_ZERO",
      outputAccountId: OTHER,
      inputAccountId: null,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      archivedAt: null,
    },
  ],
  next_cursor: null,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mockApi(
  opts: {
    status?: "draft" | "generated" | "filed";
    difference?: string;
    generate?: () => Promise<Response>;
    create?: () => Promise<Response>;
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("tax-codes")) return json(codes);
    if (url.pathname.endsWith("generate"))
      return opts.generate ? opts.generate() : json(detail(ID, "generated", opts.difference));
    if (url.pathname.endsWith("tax-returns") && init?.method === "POST")
      return opts.create ? opts.create() : json(row(), 201);
    if (url.pathname.endsWith("tax-returns"))
      return json({ items: [row(ID, opts.status), row(OTHER)], next_cursor: null });
    return json(
      detail(url.pathname.endsWith(OTHER) ? OTHER : ID, opts.status ?? "draft", opts.difference),
    );
  });
}
function mount(
  fetchImpl: typeof fetch,
  options: {
    locale?: "en" | "ar";
    company?: string;
    token?: string | null;
    switching?: boolean;
  } = {},
) {
  const api = {
    baseUrl: "https://example.test",
    accessToken: () => (options.token === undefined ? "token" : options.token),
    fetchImpl,
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Screen() {
    const [company, setCompany] = useState(options.company ?? COMPANY);
    return (
      <>
        {options.switching ? (
          <button onClick={() => setCompany(OTHER)}>Switch company</button>
        ) : null}
        <TaxReturnsRoute api={api} companyId={company} />
      </>
    );
  }
  render(
    <RouterAround>
      <QueryClientProvider client={cache}>
        <I18nProvider store={{ read: () => options.locale ?? "en", write: () => undefined }}>
          <Screen />
        </I18nProvider>
      </QueryClientProvider>
    </RouterAround>,
  );
  return userEvent.setup();
}
/**
 * The wait for a freshly mounted screen's first data: the tax-code or return list. The first test
 * in the file also pays for cold module work, which on a loaded machine outlasts `find*`'s
 * one-second default; nothing about the screen is slow once it has loaded.
 */
const INITIAL_LOAD = { timeout: 5000 };
async function open(user: ReturnType<typeof userEvent.setup>, index = 0) {
  await user.click((await screen.findAllByRole("button", { name: "Open" }, INITIAL_LOAD))[index]!);
  await screen.findByRole("button", { name: "Generate (Ctrl+G)" });
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("option", { name: "SYNTH-MY-v1 v1" }, INITIAL_LOAD);
  await user.selectOptions(screen.getByLabelText("Tax regime and version"), "SYNTH-MY-v1:1");
  await user.type(screen.getByLabelText("Period start"), "2026-01-01");
  await user.type(screen.getByLabelText("Period end"), "2026-03-31");
}
const posts = (fetchImpl: ReturnType<typeof mockApi>) =>
  fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");

describe("tax-return default workflow", () => {
  it("uses the real wire schemas for its fixtures", () => {
    expect(TaxCodeList.safeParse(codes).success).toBe(true);
    expect(TaxReturnDetail.safeParse(detail()).success).toBe(true);
  });
  it("creates a draft with the company path, selected version and dates", async () => {
    const api = mockApi();
    const user = mount(api);
    await fill(user);
    await user.keyboard("{Control>}s{/Control}");
    await screen.findByRole("button", { name: "Generate (Ctrl+G)" });
    expect(posts(api)).toHaveLength(1);
    expect(String(posts(api)[0]![0])).toBe(
      `https://example.test/v1/companies/${COMPANY}/tax-returns`,
    );
    expect(JSON.parse(String(posts(api)[0]![1]!.body))).toEqual({
      regimeCode: "SYNTH-MY-v1",
      regimeVersion: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
    });
    expect(
      screen.getByText("Generate this draft to calculate its boxes and reconciliation."),
    ).toBeVisible();
  });
  it("generates five boxes and both reconciliation rows, with the hash", async () => {
    const api = mockApi();
    const user = mount(api);
    await open(user);
    await user.keyboard("{Control>}g{/Control}");
    expect(await screen.findByText("BOX-4")).toBeVisible();
    const reconciliation = screen.getByTestId("tax-reconciliation");
    expect(within(reconciliation).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("a".repeat(64))).toHaveAttribute("dir", "ltr");
    expect(screen.queryByText("Does not reconcile")).not.toBeInTheDocument();
  });
  it("shows a textual warning as well as color for a nonzero difference", async () => {
    const user = mount(mockApi({ status: "generated", difference: "-0.0100" }));
    await open(user);
    expect(await screen.findAllByText("Does not reconcile")).toHaveLength(2);
    expect(screen.getByTestId("tax-reconciliation").querySelector("tbody tr")).toHaveClass(
      "text-danger",
    );
  });
  it("blocks keyboard and button generation of a filed return", async () => {
    const api = mockApi({ status: "filed" });
    const user = mount(api);
    await open(user);
    expect(screen.getByRole("button", { name: "Generate (Ctrl+G)" })).toBeDisabled();
    await user.keyboard("{Control>}g{/Control}");
    expect(posts(api)).toHaveLength(0);
  });
  it("serializes repeated keyboard and button generation while the request is pending", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const api = mockApi({ generate: () => pending });
    const user = mount(api);
    await open(user);
    await user.keyboard("{Control>}gg{/Control}");
    await user.click(screen.getByRole("button", { name: "Generate (Ctrl+G)" }));
    expect(posts(api)).toHaveLength(1);
    await act(async () => resolve(json(detail())));
    await screen.findByText("BOX-4");
  });
  it("reuses the same generation key after an ambiguous network failure", async () => {
    let count = 0;
    const api = mockApi({
      generate: async () => {
        if (++count === 1) throw new TypeError("network");
        return json(detail());
      },
    });
    const user = mount(api);
    await open(user);
    await user.keyboard("{Control>}g{/Control}");
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate (Ctrl+G)" })).toBeEnabled(),
    );
    await user.keyboard("{Control>}g{/Control}");
    await screen.findByText("BOX-4");
    expect(posts(api)).toHaveLength(2);
    expect(posts(api)[0]![1]!.headers).toEqual(posts(api)[1]![1]!.headers);
  });
  it("reuses a create key after a transport failure and changes it after a definite refusal", async () => {
    let count = 0;
    const api = mockApi({
      create: async () => {
        if (++count === 1) throw new TypeError("network");
        if (count === 2) return json({}, 422);
        return json(row(), 201);
      },
    });
    const user = mount(api);
    await fill(user);
    await user.keyboard("{Control>}s{/Control}");
    await screen.findByRole("alert");
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create draft (Ctrl+S)" })).toBeEnabled(),
    );
    await user.keyboard("{Control>}s{/Control}");
    await screen.findByRole("button", { name: "Generate (Ctrl+G)" });
    const headers = posts(api).map(([, init]) => new Headers(init!.headers).get("idempotency-key"));
    expect(headers[0]).toBe(headers[1]);
    expect(headers[2]).not.toBe(headers[1]);
  });
  it("loads all tax-code pages and preserves return pagination with an encoded regime filter", async () => {
    const fallback = mockApi();
    const api = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("tax-codes"))
        return json({
          items: codes.items,
          next_cursor: url.searchParams.has("cursor") ? null : "codes-next",
        });
      if (url.pathname.endsWith("tax-returns"))
        return json({
          items: [row(url.searchParams.has("cursor") ? OTHER : ID)],
          next_cursor: url.searchParams.has("cursor") ? null : "returns-next",
        });
      return fallback(input, init);
    });
    const user = mount(api);
    await waitFor(() =>
      expect(api.mock.calls.filter(([input]) => String(input).includes("tax-codes"))).toHaveLength(
        2,
      ),
    );
    await user.click(await screen.findByRole("button", { name: "Load more returns" }));
    expect(await screen.findAllByRole("button", { name: "Open" })).toHaveLength(2);
    await user.type(screen.getByLabelText("Filter by regime code"), "SYNTH&");
    await waitFor(() =>
      expect(
        api.mock.calls.some(
          ([input]) =>
            new URL(String(input)).searchParams.get("filter[regimeCode][eq]") === "SYNTH&",
        ),
      ).toBe(true),
    );
  });
  it("preserves generated boxes after a rejected regeneration", async () => {
    const api = mockApi({ status: "generated", generate: async () => json({}, 422) });
    const user = mount(api);
    await open(user);
    await screen.findByText("BOX-4");
    await user.keyboard("{Control>}g{/Control}");
    await screen.findByRole("alert");
    expect(screen.getByText("BOX-4")).toBeVisible();
  });
  it("does not apply an old generation to the newly selected return", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const api = mockApi({ generate: () => pending });
    const user = mount(api);
    await open(user);
    await user.keyboard("{Control>}g{/Control}");
    await open(user, 1);
    await act(async () => resolve(json(detail())));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate (Ctrl+G)" })).toBeEnabled(),
    );
    expect(screen.queryByText("BOX-4")).not.toBeInTheDocument();
  });
  it("drops form, detail and late failures on company change", async () => {
    let reject!: (e: Error) => void;
    const pending = new Promise<Response>((_, r) => {
      reject = r;
    });
    const user = mount(mockApi({ generate: () => pending }), { switching: true });
    await open(user);
    await user.keyboard("{Control>}g{/Control}");
    await user.click(screen.getByRole("button", { name: "Switch company" }));
    await act(async () => reject(new Error("old company")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate (Ctrl+G)" })).not.toBeInTheDocument();
  });
  it.each([{ company: "" }, { token: null }])(
    "makes no requests without a company/session: %j",
    async (options) => {
      const api = mockApi();
      mount(api, options);
      await screen.findByRole("heading", { name: "Tax returns" });
      expect(api).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Create draft (Ctrl+S)" })).toBeDisabled();
    },
  );
  it("resets selection with Ctrl+N and focuses the period start", async () => {
    const user = mount(mockApi());
    await open(user);
    await user.keyboard("{Control>}n{/Control}");
    expect(screen.queryByRole("button", { name: "Generate (Ctrl+G)" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Period start")).toHaveFocus();
  });
  it("reverts the draft fields with Escape without creating or generating", async () => {
    const api = mockApi();
    const user = mount(api);
    await fill(user);
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Period start")).toHaveValue("");
    expect(screen.getByLabelText("Period end")).toHaveValue("");
    expect(screen.getByLabelText("Tax regime and version")).toHaveValue("");
    expect(posts(api)).toHaveLength(0);
  });
  it("translates Arabic chrome and isolates the amounts", async () => {
    const user = mount(mockApi({ status: "generated" }), { locale: "ar" });
    await user.click((await screen.findAllByRole("button", { name: "فتح" }))[0]!);
    await screen.findByText("BOX-4");
    expect(screen.getByRole("heading", { name: "تفاصيل الإقرار" })).toBeVisible();
    expect(
      screen.getByTestId("tax-reconciliation").querySelectorAll('bdi[dir="ltr"]'),
    ).toHaveLength(6);
    expect(screen.queryByText("Ledger reconciliation")).not.toBeInTheDocument();
  });
});
