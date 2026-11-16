import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CATALOGUES, type TranslationKey } from "@dulja/i18n";
import { I18nProvider } from "../src/lib/i18n-provider";
import { EmployeesRoute } from "../src/routes/hr/employees";
import { CashiersRoute } from "../src/routes/pos/cashiers";
import { RouterAround } from "./support/router";

const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const EMPLOYEE = "0192aaaa-0001-7000-8000-000000000001";
const OTHER_EMPLOYEE = "0192aaaa-0002-7000-8000-000000000002";
const BRANCH = "0192bbbb-0001-7000-8000-000000000001";
const OTHER_BRANCH = "0192bbbb-0002-7000-8000-000000000002";
const PRINCIPAL = "0192dddd-0001-7000-8000-000000000001";
/** The login a created till credential gives its employee. */
const CREATED_PRINCIPAL = "0192dddd-0002-7000-8000-000000000002";
const employee = {
  id: EMPLOYEE,
  partyId: EMPLOYEE,
  employeeNumber: "EMP-001",
  homeBranchId: BRANCH,
  principalId: PRINCIPAL,
  hiredOn: "2026-01-01",
  terminatedOn: null,
  createdAt: "2026-01-01T00:00:00Z",
  // 8A — migration 0080's three wire fields (EmployeeSchema).
  position: null,
  employmentType: null,
  archivedAt: null,
};
/** A second, unlinked employee, so search has something to hide and a credential has someone to name. */
const otherEmployee = {
  ...employee,
  id: OTHER_EMPLOYEE,
  partyId: OTHER_EMPLOYEE,
  employeeNumber: "ADM-002",
  principalId: null,
};
/** `employeeNumber` is the bounded projection the cashier list carries for itself (`CashierSchema`). */
const cashier = {
  principalId: PRINCIPAL,
  employeeId: EMPLOYEE,
  employeeNumber: "EMP-001",
  branchId: BRANCH,
  pinUpdatedAt: "2026-01-01T00:00:00Z",
  revokedAt: null,
  revision: "9007199254740993",
  snapshot: { codes: ["pos.ticket.sell"], limits: {}, revision: "9007199254740993" },
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const problem = (status: number, code: string, detail: string, instance: string) =>
  new Response(
    JSON.stringify({
      type: `urn:dulja:error:${code}`,
      title: code,
      status,
      detail,
      instance,
      code,
      remedy: "Ask an administrator for access.",
      requestId: `${code}-request`,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

interface MountOptions {
  /** The ordinary employee directory answers 403, as it does for a PIN manager without `hr.employee.read`. */
  directoryDenied?: boolean;
  /** Every unsafe request answers this refusal instead of succeeding. */
  refuseWrites?: { status: number; code: string; detail: string };
  /** Unsafe requests wait for this, so a test can look at the screen while one is in flight. */
  holdWrites?: Promise<void>;
}

/** A promise the test settles by hand. */
function held(): { promise: Promise<void>; release: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, release: () => settle?.() };
}

function mount(kind: "employees" | "cashiers", locale: "en" | "ar", options: MountOptions = {}) {
  /** Employees a created till credential has linked, as `POST /cashiers` does through `linkEmployeePrincipal`. */
  const linked = new Set<string>();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("staff-context"))
      return json({
        companies: [
          {
            id: COMPANY,
            code: "MY",
            name: "Company",
            baseCurrency: "MYR",
            branches: [
              { id: BRANCH, code: "HQ", nameEn: "Head office", nameAr: "المقر الرئيسي" },
              { id: OTHER_BRANCH, code: "BR2", nameEn: "Second branch", nameAr: "الفرع الثاني" },
            ],
          },
        ],
      });
    if (init?.method === "POST") {
      await options.holdWrites;
      if (options.refuseWrites) {
        const { status, code, detail } = options.refuseWrites;
        return problem(status, code, detail, url.pathname);
      }
      if (url.pathname.endsWith("/employees"))
        return json({ ...employee, ...JSON.parse(String(init.body)) });
      if (url.pathname.endsWith("/revoke"))
        return json({ ...cashier, revokedAt: "2026-02-01T00:00:00Z" });
      if (url.pathname.endsWith("/cashiers")) {
        const created = JSON.parse(String(init.body)) as { employeeId: string };
        linked.add(created.employeeId);
      }
      return json(cashier);
    }
    if (url.pathname.endsWith("/employees")) {
      if (options.directoryDenied)
        return problem(
          403,
          "ERR_RBAC_FORBIDDEN",
          "Employee directory is outside your authority",
          url.pathname,
        );
      return json({
        items: [employee, otherEmployee].map((row) =>
          linked.has(row.id) ? { ...row, principalId: CREATED_PRINCIPAL } : row,
        ),
        next_cursor: null,
      });
    }
    return json({ items: [cashier], next_cursor: null });
  });
  const api = { baseUrl: "https://example.test", accessToken: () => "staff", fetchImpl };
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterAround>
          <I18nProvider store={{ read: () => locale, write: () => undefined }}>
            {kind === "employees" ? <EmployeesRoute api={api} /> : <CashiersRoute api={api} />}
          </I18nProvider>
        </RouterAround>
      </QueryClientProvider>
    </StrictMode>,
  );
  const say = (key: TranslationKey): string => {
    const text = CATALOGUES[locale][key];
    if (text === undefined) throw new Error(`${locale} has no ${key}`);
    return text;
  };
  const posts = () => fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");
  return { user: userEvent.setup(), fetchImpl, say, posts };
}

/**
 * The first row of a freshly mounted screen. It waits on the staff context and then the directory
 * queries, and the first test in the file also pays for cold module work, which on a loaded machine
 * outlasts `find*`'s one-second default; nothing about the screen is slow once it has loaded.
 */
const loadedCell = (name: string) => screen.findByRole("cell", { name }, { timeout: 5000 });

describe("staff screens", () => {
  for (const locale of ["en", "ar"] as const) {
    it(`identifies and resets an authorized cashier when the employee directory is refused in ${locale}`, async () => {
      const { user, fetchImpl, say, posts } = mount("cashiers", locale, { directoryDenied: true });
      // The number comes from the cashier row itself; the refused directory could not have named it.
      const cell = await loadedCell("EMP-001");
      expect(await screen.findByRole("alert")).toHaveTextContent(say("staff.loadFailed"));
      expect(screen.getByRole("button", { name: say("staff.createCashier") })).toBeDisabled();
      const list = fetchImpl.mock.calls
        .map(([input]) => new URL(String(input)))
        .find((url) => url.pathname.endsWith("/cashiers"));
      expect(list?.searchParams.get("filter[branchId][eq]")).toBe(BRANCH);
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      await user.type(within(form).getByLabelText(say("staff.pin")), "6789");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(posts()).toHaveLength(1));
      const [url, init] = posts()[0]!;
      expect(String(url)).toBe(
        `https://example.test/v1/companies/${COMPANY}/cashiers/${PRINCIPAL}/pin`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({ pin: "6789" });
      expect(init?.headers).toHaveProperty("idempotency-key");
    });
    it(`directory search, Enter and Escape work in ${locale}`, async () => {
      const { user, say } = mount("employees", locale);
      const cell = await loadedCell("EMP-001");
      expect(screen.getByRole("cell", { name: "ADM-002" })).toBeInTheDocument();
      cell.focus();
      await user.keyboard("/");
      expect(screen.getByLabelText(say("staff.search"))).toHaveFocus();
      await user.type(screen.getByLabelText(say("staff.search")), "EMP");
      expect(screen.queryByRole("cell", { name: "ADM-002" })).not.toBeInTheDocument();
      cell.focus();
      await user.keyboard("{Enter}");
      const details = screen.getByRole("region", { name: say("staff.employeeDetails") });
      expect(within(details).getByRole("heading", { name: "EMP-001" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: say("staff.close") })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(
        screen.queryByRole("region", { name: say("staff.employeeDetails") }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(cell).toHaveFocus());
    });
    it(`creates an employee with the home-branch selector in ${locale}`, async () => {
      const { user, posts, say } = mount("employees", locale);
      await loadedCell("EMP-001");
      const create = screen.getByRole("button", { name: say("staff.createEmployee") });
      create.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.createEmployee") });
      expect(within(form).getByLabelText(say("staff.employeeNumber"))).toHaveFocus();
      await user.type(within(form).getByLabelText(say("staff.employeeNumber")), "EMP-003");
      await user.type(within(form).getByLabelText(say("staff.nameEn")), "New employee");
      await user.selectOptions(within(form).getByLabelText(say("staff.homeBranch")), OTHER_BRANCH);
      fireEvent.change(within(form).getByLabelText(say("staff.hiredOn")), {
        target: { value: "2026-02-01" },
      });
      within(form)
        .getByRole("button", { name: say("staff.save") })
        .focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(posts()).toHaveLength(1));
      const [url, init] = posts()[0]!;
      expect(String(url)).toBe(`https://example.test/v1/companies/${COMPANY}/employees`);
      expect(JSON.parse(String(init?.body))).toEqual({
        employeeNumber: "EMP-003",
        nameEn: "New employee",
        homeBranchId: OTHER_BRANCH,
        hiredOn: "2026-02-01",
      });
      expect(init?.headers).toHaveProperty("idempotency-key");
      await waitFor(() =>
        expect(
          screen.queryByRole("form", { name: say("staff.createEmployee") }),
        ).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(create).toHaveFocus());
    });
    it(`keeps the employee form open and shows the refusal when saving fails in ${locale}`, async () => {
      const { user, posts, say } = mount("employees", locale, {
        refuseWrites: {
          status: 409,
          code: "ERR_CONFLICT_UNIQUE",
          detail: "EMP-001 already exists",
        },
      });
      await loadedCell("EMP-001");
      screen.getByRole("button", { name: say("staff.createEmployee") }).focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.createEmployee") });
      await user.type(within(form).getByLabelText(say("staff.employeeNumber")), "EMP-001");
      await user.type(within(form).getByLabelText(say("staff.nameEn")), "Duplicate");
      fireEvent.change(within(form).getByLabelText(say("staff.hiredOn")), {
        target: { value: "2026-02-01" },
      });
      within(form)
        .getByRole("button", { name: say("staff.save") })
        .focus();
      await user.keyboard("{Enter}");
      const alert = await within(form).findByRole("alert");
      expect(alert).toHaveTextContent("EMP-001 already exists");
      expect(within(form).getByRole("button", { name: say("staff.save") })).toBeEnabled();
      expect(posts()).toHaveLength(1);
    });
    it(`PIN starts empty, refuses copying, clears on blur and submits once in ${locale}`, async () => {
      const write = held();
      const { user, posts, say } = mount("cashiers", locale, { holdWrites: write.promise });
      const cell = await loadedCell("EMP-001");
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      const pin = within(form).getByLabelText(say("staff.pin"));
      expect(pin).toHaveFocus();
      expect(pin).toHaveValue("");
      expect(pin).toHaveAttribute("type", "password");
      await user.type(pin, "1234");
      const copy = createEvent.copy(pin, { cancelable: true });
      fireEvent(pin, copy);
      expect(copy.defaultPrevented).toBe(true);
      await user.tab();
      expect(pin).toHaveValue("");
      await user.click(pin);
      await user.type(pin, "6789");
      // Two submits before React re-renders: the disabled field cannot stop the second, so only the
      // panel's own lock keeps it from sending the PIN again.
      act(() => {
        fireEvent.submit(form);
        fireEvent.submit(form);
      });
      await waitFor(() => expect(posts()).toHaveLength(1));
      const [url, init] = posts()[0]!;
      expect(String(url)).toBe(
        `https://example.test/v1/companies/${COMPANY}/cashiers/${PRINCIPAL}/pin`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({ pin: "6789" });
      // While the reset is in flight the field is already empty and locked.
      await waitFor(() => expect(pin).toHaveValue(""));
      expect(pin).toBeDisabled();
      write.release();
      await waitFor(() => expect(form).not.toBeInTheDocument());
      expect(posts()).toHaveLength(1);
    });
    it(`shows a refused PIN reset without leaving the PIN in the field in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale, {
        refuseWrites: { status: 403, code: "ERR_RBAC_FORBIDDEN", detail: "PIN reset refused" },
      });
      const cell = await loadedCell("EMP-001");
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      const pin = within(form).getByLabelText(say("staff.pin"));
      await user.type(pin, "6789");
      await user.keyboard("{Enter}");
      expect(await within(form).findByRole("alert")).toHaveTextContent("PIN reset refused");
      expect(pin).toHaveValue("");
      expect(posts()).toHaveLength(1);
    });
    it(`creates a till credential for a listed employee in ${locale}`, async () => {
      const write = held();
      const { user, posts, say } = mount("cashiers", locale, { holdWrites: write.promise });
      await loadedCell("EMP-001");
      const create = screen.getByRole("button", { name: say("staff.createCashier") });
      await waitFor(() => expect(create).toBeEnabled());
      create.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.createCashier") });
      await user.selectOptions(within(form).getByLabelText(say("staff.employeeNumber")), "ADM-002");
      await user.type(within(form).getByLabelText(say("staff.email")), "till@example.invalid");
      await user.type(within(form).getByLabelText(say("staff.displayName")), "Till operator");
      const pin = within(form).getByLabelText(say("staff.pin"));
      expect(pin).toHaveValue("");
      await user.type(pin, "2468");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(posts()).toHaveLength(1));
      const [url, init] = posts()[0]!;
      expect(String(url)).toBe(`https://example.test/v1/companies/${COMPANY}/cashiers`);
      expect(JSON.parse(String(init?.body))).toEqual({
        employeeId: OTHER_EMPLOYEE,
        branchId: BRANCH,
        email: "till@example.invalid",
        displayName: "Till operator",
        pin: "2468",
      });
      await waitFor(() => expect(pin).toHaveValue(""));
      write.release();
      await waitFor(() => expect(form).not.toBeInTheDocument());
    });
    it(`offers a till credential only to employees without a login in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale);
      await loadedCell("EMP-001");
      const create = screen.getByRole("button", { name: say("staff.createCashier") });
      await waitFor(() => expect(create).toBeEnabled());
      create.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.createCashier") });
      const choice = within(form).getByLabelText(say("staff.employeeNumber"));
      // EMP-001 already signs in as PRINCIPAL, and `POST /cashiers` refuses such an employee with
      // ERR_CONFLICT_UNIQUE, so neither the list nor its default may name them.
      expect(
        within(choice)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["ADM-002"]);
      expect(choice).toHaveValue(OTHER_EMPLOYEE);
      await user.type(within(form).getByLabelText(say("staff.email")), "till@example.invalid");
      await user.type(within(form).getByLabelText(say("staff.displayName")), "Till operator");
      await user.type(within(form).getByLabelText(say("staff.pin")), "2468");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(JSON.parse(String(posts()[0]![1]?.body))).toMatchObject({
        employeeId: OTHER_EMPLOYEE,
      });
      await waitFor(() => expect(form).not.toBeInTheDocument());
      // The directory is read again after the create, so the employee it just linked is not offered
      // a second credential; with nobody left unlinked there is nothing to create.
      await waitFor(() => expect(create).toBeDisabled());
    });
    it(`revokes a till credential by keyboard in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale);
      const cell = await loadedCell("EMP-001");
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      within(form)
        .getByRole("button", { name: say("staff.revoke") })
        .focus();
      await user.keyboard("{Enter}");
      // UI-19: nothing is sent until the operator confirms, and the question names the cashier.
      expect(posts()).toHaveLength(0);
      expect(within(form).getByRole("alertdialog")).toHaveTextContent("EMP-001");
      within(form)
        .getByRole("button", { name: say("staff.revokeConfirm") })
        .focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(posts()).toHaveLength(1));
      const [url, init] = posts()[0]!;
      expect(String(url)).toBe(
        `https://example.test/v1/companies/${COMPANY}/cashiers/${PRINCIPAL}/revoke`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({});
      expect(init?.headers).toHaveProperty("idempotency-key");
      await waitFor(() => expect(form).not.toBeInTheDocument());
    });
    it(`a refused revoke leaves the next attempt a fresh idempotency key in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale, {
        refuseWrites: { status: 403, code: "ERR_RBAC_FORBIDDEN", detail: "Revoke refused" },
      });
      const cell = await loadedCell("EMP-001");
      // The API replays a recorded refusal for as long as it keeps the key, so a key fixed to the
      // credential would answer this second attempt — after, say, a role grant — with the first 403.
      const revokeRefused = async () => {
        cell.focus();
        await user.keyboard("{Enter}");
        const form = screen.getByRole("form", { name: say("staff.resetPin") });
        within(form)
          .getByRole("button", { name: say("staff.revoke") })
          .focus();
        await user.keyboard("{Enter}");
        within(form)
          .getByRole("button", { name: say("staff.revokeConfirm") })
          .focus();
        await user.keyboard("{Enter}");
        expect(await within(form).findByRole("alert")).toHaveTextContent("Revoke refused");
        within(form)
          .getByRole("button", { name: say("staff.close") })
          .focus();
        await user.keyboard("{Enter}");
        await waitFor(() => expect(form).not.toBeInTheDocument());
      };
      await revokeRefused();
      await revokeRefused();
      const keys = posts().map(
        ([, init]) => ((init?.headers ?? {}) as Record<string, string>)["idempotency-key"],
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });
    it(`cancelling the revoke question sends nothing and keeps the credential in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale);
      const cell = await loadedCell("EMP-001");
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      within(form)
        .getByRole("button", { name: say("staff.revoke") })
        .focus();
      await user.keyboard("{Enter}");
      // The safe answer takes focus, so a second Enter does not revoke.
      expect(within(form).getByRole("button", { name: say("staff.revokeCancel") })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(within(form).queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(within(form).getByRole("button", { name: say("staff.revoke") })).toHaveFocus();
      expect(posts()).toHaveLength(0);
    });
    it(`a definite refusal releases the attempt key within one panel in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale, {
        refuseWrites: { status: 403, code: "ERR_RBAC_FORBIDDEN", detail: "Revoke refused" },
      });
      const cell = await loadedCell("EMP-001");
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      for (const attempt of [1, 2]) {
        await user.type(within(form).getByLabelText(say("staff.pin")), "6789{Enter}");
        await waitFor(() => expect(posts()).toHaveLength(attempt));
        expect(await within(form).findByRole("alert")).toHaveTextContent("Revoke refused");
        await waitFor(() => expect(within(form).getByLabelText(say("staff.pin"))).toBeEnabled());
      }
      const pinKeys = posts().map(
        ([, init]) => ((init?.headers ?? {}) as Record<string, string>)["idempotency-key"],
      );
      expect(pinKeys[0]).not.toBe(pinKeys[1]);
      for (const attempt of [1, 2]) {
        within(form)
          .getByRole("button", { name: say("staff.revoke") })
          .focus();
        await user.keyboard("{Enter}");
        within(form)
          .getByRole("button", { name: say("staff.revokeConfirm") })
          .focus();
        await user.keyboard("{Enter}");
        await waitFor(() => expect(posts()).toHaveLength(attempt + 2));
        expect(await within(form).findByRole("alert")).toHaveTextContent("Revoke refused");
      }
      await waitFor(() => expect(posts()).toHaveLength(4));
      const keys = posts().map(
        ([, init]) => ((init?.headers ?? {}) as Record<string, string>)["idempotency-key"],
      );
      // The server recorded each refusal under its key: a retry with that key is only a replay.
      expect(new Set(keys).size).toBe(4);
    });
    it(`an unanswered attempt keeps its key for the retry in ${locale}`, async () => {
      const { user, posts, say } = mount("cashiers", locale, {
        refuseWrites: { status: 503, code: "ERR_UNAVAILABLE", detail: "Gateway unavailable" },
      });
      const cell = await loadedCell("EMP-001");
      cell.focus();
      await user.keyboard("{Enter}");
      const form = screen.getByRole("form", { name: say("staff.resetPin") });
      for (const attempt of [1, 2]) {
        await user.type(within(form).getByLabelText(say("staff.pin")), "6789{Enter}");
        await waitFor(() => expect(posts()).toHaveLength(attempt));
        await waitFor(() => expect(within(form).getByLabelText(say("staff.pin"))).toBeEnabled());
      }
      const keys = posts().map(
        ([, init]) => ((init?.headers ?? {}) as Record<string, string>)["idempotency-key"],
      );
      expect(keys[0]).toBe(keys[1]);
    });
  }
});
