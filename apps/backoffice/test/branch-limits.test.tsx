import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/lib/i18n-provider";
import { BranchLimitsRoute } from "../src/routes/pos/branch-limits";
import { RouterAround } from "./support/router";

const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const BRANCH = "0192aaaa-0001-7000-8000-000000000001";
const policy = {
  id: BRANCH,
  branchId: BRANCH,
  maxLineDiscountPct: "0.150000",
  maxTicketDiscountPct: "0.100000",
  maxVoidAmount: "100.0000",
  maxPriceOverridePct: "0.050000",
  blindReturnAllowed: false,
  maxBlindReturnAmount: "50.0000",
  maxCashInDrawer: null,
  requireCustomerOver: "1000.0000",
  roundingIncrement: "0.0500",
  paidOutAllowed: false,
  maxPaidOutAmount: "0.0000",
  revision: "9007199254740993",
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function mount(locale: "en" | "ar", items: unknown[] = [policy]) {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    // As a real fetch does, refuse to send a request whose signal is already aborted.
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const url = String(input);
    if (url.endsWith("staff-context"))
      return json({
        companies: [
          {
            id: COMPANY,
            code: "MY",
            name: "Company",
            baseCurrency: "MYR",
            branches: [
              {
                id: BRANCH,
                code: "HQ",
                nameEn: "Head office",
                nameAr: "المقر الرئيسي",
              },
            ],
          },
        ],
      });
    if (init?.method === "PUT") return json({ ...policy, ...JSON.parse(String(init.body)) });
    return json({ items, next_cursor: null });
  });
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterAround>
          <I18nProvider store={{ read: () => locale, write: () => undefined }}>
            <BranchLimitsRoute
              api={{ baseUrl: "https://example.test", accessToken: () => "staff", fetchImpl }}
            />
          </I18nProvider>
        </RouterAround>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { user: userEvent.setup(), fetchImpl };
}
describe("branch policy screen", () => {
  it.each(["en", "ar"] as const)(
    "edits exact limits and optional clearing with the keyboard in %s",
    async (locale) => {
      const { user, fetchImpl } = mount(locale);
      const line = await screen.findByLabelText(
        locale === "en" ? "Maximum line discount (%)" : "أقصى خصم للسطر (%)",
      );
      expect(line).toHaveValue("15.0000");
      await user.clear(line);
      await user.type(line, "12.3456");
      const customer = screen.getByLabelText(
        locale === "en" ? "Require customer above (optional)" : "إلزام العميل فوق مبلغ (اختياري)",
      );
      await user.clear(customer);
      const save = screen.getByRole("button", { name: locale === "en" ? "Save" : "حفظ" });
      save.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1),
      );
      const request = fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT")!;
      expect(String(request[0])).toBe(
        `https://example.test/v1/companies/${COMPANY}/branch-pos-policies`,
      );
      expect(JSON.parse(String(request[1]?.body))).toMatchObject({
        branchId: BRANCH,
        maxLineDiscountPct: "0.123456",
        requireCustomerOver: null,
        maxCashInDrawer: null,
        roundingIncrement: "0.0500",
      });
      expect(request[1]?.headers).toHaveProperty("idempotency-key");
      expect(request[1]?.signal?.aborted).toBe(false);
      // StrictMode's development remount must not leave the form holding an aborted signal: the save
      // reaches the API and the form comes back for the next edit.
      await waitFor(() => expect(save).toBeEnabled());
      expect(
        document.querySelector('[dir="' + (locale === "ar" ? "rtl" : "ltr") + '"]'),
      ).not.toBeNull();
    },
  );
  // UI-05: OD-10 put paid-outs in the branch's own settings, set in the back office.
  it.each(["en", "ar"] as const)(
    "switches paid-outs on with a maximum, keyboard only, in %s",
    async (locale) => {
      const { user, fetchImpl } = mount(locale);
      const allowed = await screen.findByRole("checkbox", {
        name: locale === "en" ? "Paid-outs allowed" : "السماح بالدفع من الصندوق",
      });
      expect(allowed).not.toBeChecked();
      allowed.focus();
      await user.keyboard(" ");
      expect(allowed).toBeChecked();
      const maximum = screen.getByLabelText(
        locale === "en" ? "Maximum paid-out" : "الحد الأقصى للدفع من الصندوق",
      );
      expect(maximum).toHaveValue("0.0000");
      await user.clear(maximum);
      await user.type(maximum, "200.5");
      screen.getByRole("button", { name: locale === "en" ? "Save" : "حفظ" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1),
      );
      const request = fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT")!;
      const body = JSON.parse(String(request[1]?.body)) as Record<string, unknown>;
      expect(body.paidOutAllowed).toBe(true);
      // A decimal string on the wire, never a JSON number.
      expect(body.maxPaidOutAmount).toBe("200.5000");
    },
  );
  // PRD-21: a branch with no policy row must not get "customer required above 0" and "drawer cap 0".
  it("leaves the optional limits empty for a branch with no policy, and saves them as null", async () => {
    const { user, fetchImpl } = mount("en", []);
    const customer = await screen.findByLabelText("Require customer above (optional)");
    expect(customer).toHaveValue("");
    expect(screen.getByLabelText("Maximum cash in drawer (optional)")).toHaveValue("");
    const line = screen.getByLabelText("Maximum line discount (%)");
    await user.clear(line);
    await user.type(line, "10");
    screen.getByRole("button", { name: "Save" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1),
    );
    const request = fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({
      maxLineDiscountPct: "0.100000",
      requireCustomerOver: null,
      maxCashInDrawer: null,
      paidOutAllowed: false,
    });
  });
});
