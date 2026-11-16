import { RoleAssignmentSchema, RoleList, UserList } from "@dulja/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { I18nProvider, type LocaleStore } from "../src/lib/i18n-provider";
import { COMPANY_QUERY_KEY } from "../src/lib/session";
import { UsersRoute } from "../src/routes/admin/users";

/**
 * Every id here is a v7 UUID because 0B's `UuidSchema` is `z.string().uuid()` — the brief's "u1"/"r1"
 * placeholders are rejected by the shipped schema, so a fixture using them would prove only that the
 * screen renders shapes `/v1` never sends. The pinning test below holds that honest.
 */
const AISHA = "0192aaaa-0001-7000-8000-000000000001";
const BILAL = "0192aaaa-0002-7000-8000-000000000002";
const ADMIN_ROLE = "0192bbbb-0001-7000-8000-000000000001";
const ACCOUNTANT_ROLE = "0192bbbb-0002-7000-8000-000000000002";
const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const BASE_URL = "https://api.example.test";

/** Exactly 0B's UserSchema: id, displayName, email (nullable), kind, createdAt, activeAssignments. */
const USERS = {
  items: [
    {
      id: AISHA,
      displayName: "Aisha",
      email: "aisha@example.test",
      kind: "human",
      createdAt: "2026-01-15T02:00:00Z",
      activeAssignments: 2,
    },
    {
      id: BILAL,
      displayName: "Bilal",
      email: "bilal@example.test",
      kind: "human",
      createdAt: "2026-02-03T02:00:00Z",
      activeAssignments: 0,
    },
  ],
  next_cursor: null,
};

/** Exactly 0B's RoleSchema — `description`, `permissions` and `createdAt` are required there. */
const ROLES = {
  items: [
    {
      id: ADMIN_ROLE,
      code: "admin",
      nameEn: "Administrator",
      nameAr: "مدير",
      description: null,
      isSystem: true,
      permissions: ["admin.user.manage"],
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: ACCOUNTANT_ROLE,
      code: "accountant",
      nameEn: "Accountant",
      nameAr: "محاسب",
      description: null,
      isSystem: true,
      permissions: ["admin.audit_log.read"],
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
  next_cursor: null,
};

/** 0B answers the POST with a full `RoleAssignmentSchema`, 201 — not a bare `{ id }`. */
const ASSIGNMENT = {
  principalId: AISHA,
  roleId: ACCOUNTANT_ROLE,
  companyId: COMPANY,
  grantedBy: "0192dddd-0001-7000-8000-000000000001",
  grantedAt: "2026-03-01T09:00:00Z",
  expiresAt: null,
  branchIds: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const problem = (code: string, status: number, detail: string, remedy: string) =>
  new Response(
    JSON.stringify({
      type: `urn:dulja:error:${code}`,
      title: "Refused",
      status,
      detail,
      instance: "/v1",
      code,
      remedy,
      requestId: "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

/**
 * Typed `vi.fn<typeof fetch>` rather than `vi.fn(async (url) => …)`: an untyped mock records a
 * zero-length call tuple, so `call[1]` — every header and body assertion below — cannot be reached.
 */
const fetchImpl = (overrides: Record<string, Response> = {}) =>
  vi.fn<typeof fetch>(async (url) => {
    const path = String(url);
    for (const [fragment, response] of Object.entries(overrides)) {
      // Cloned, so one override can answer a retry as well as the first attempt.
      if (path.includes(fragment)) return response.clone();
    }
    if (path.includes("/v1/admin/users")) return json(USERS);
    if (path.includes("/v1/admin/roles")) return json(ROLES);
    if (path.includes("/role-assignments")) return json(ASSIGNMENT, 201);
    throw new Error(`unexpected fetch: ${path}`);
  });

/** A `LocaleStore` that never touches `localStorage`, so one test's locale cannot leak into the next. */
const fakeLocaleStore = (): LocaleStore => ({ read: () => null, write: () => {} });

/** The `/mfa` destination, as a marker: `ERR_AUTH_AAL_INSUFFICIENT` must land the operator here. */
function MfaMarker() {
  return <p>mfa enrolment screen</p>;
}

/** The `/login` destination: a 401 that is *not* about the assurance level belongs here. */
function LoginMarker() {
  return <p>sign-in screen</p>;
}

/**
 * `AppShell` renders a TanStack `<Link>` (Task 6) and calls `useI18n`, so the brief's bare
 * `render(<AppShell>…)` throws on both counts; and `UsersRoute` calls `useQuery` twice and
 * `useQueryClient` once, so it needs a **fresh** client per test with retries off. The router is a
 * real two-route memory one rather than `RouterAround`, because the AAL redirect has somewhere to go
 * only if `/mfa` exists.
 */
const renderScreen = (
  impl = fetchImpl(),
  companyId = COMPANY,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  accessToken: () => string | null = () => "jwt",
) => {
  // Hoisted out of the component so the props object is referentially stable across re-renders,
  // exactly as `UsersScreen`'s `useMemo` makes it in the real router.
  const api = { baseUrl: BASE_URL, accessToken, fetchImpl: impl };
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <AppShell>
        <UsersRoute api={api} companyId={companyId} />
      </AppShell>
    ),
  });
  const mfaRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/mfa",
    component: MfaMarker,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginMarker,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, mfaRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <I18nProvider store={fakeLocaleStore()}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
};

/**
 * ORCH-02: the first paint waits on the router, the list and role queries and cold module work, which on a loaded
 * Windows runner outlasts `waitFor`'s one-second default and failed with the screen still on "Loading…". Each wait
 * for the screen to have loaded is `find*` under this load timeout instead; the assertion is unchanged, and a
 * screen that never loads still fails.
 */
const LOAD = { timeout: 10_000 };

/** The OD-24 model: the operator lands on a row and presses Enter to select it. */
const activateRow = async (user: ReturnType<typeof userEvent.setup>, email: string) => {
  await user.click(screen.getByText(email));
  await user.keyboard("{Enter}");
};

const assignmentCall = (impl: ReturnType<typeof fetchImpl>) =>
  impl.mock.calls.find(([url]) => String(url).includes("/role-assignments"));

/** Every Idempotency-Key that has reached the assignment endpoint, in order. */
const idempotencyKeys = (impl: ReturnType<typeof fetchImpl>) =>
  impl.mock.calls
    .filter(([url]) => String(url).includes("/role-assignments"))
    .map(
      ([, init]) => ((init as RequestInit).headers as Record<string, string>)["idempotency-key"],
    );

const rowFor = (email: string) => screen.getByText(email).closest("tr")!;

/** The cell an operator lands on — re-queried, so it is the node currently rendered. */
const cellFor = (email: string) => screen.getByText(email).closest("td")!;

describe("UsersRoute", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dir");
    document.documentElement.removeAttribute("lang");
  });

  it("uses fixtures the shipped 0B schemas actually accept", () => {
    // Without this the whole file could pass against shapes `/v1` never sends, and every parse in
    // `createAdminApi` would be asserted against nothing.
    expect(UserList.safeParse(USERS).success).toBe(true);
    expect(RoleList.safeParse(ROLES).success).toBe(true);
    expect(RoleAssignmentSchema.safeParse(ASSIGNMENT).success).toBe(true);
  });

  it("lists users with their roles and a translated count", async () => {
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    expect(screen.getByText("2 users")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "E-mail",
      "Name",
      "Roles",
      "Status",
      "Invited on",
    ]);
  });

  it("formats createdAt through the i18n formatter, not toLocaleDateString", async () => {
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    // 02:00Z is 10:00 in Asia/Kuala_Lumpur, the house default zone (spec:2039). `toLocaleDateString`
    // would print "1/15/2026" with no time at all, and a formatter that ignored the zone would print
    // 02:00 — so the hour is the assertion that tells the three apart. The date half is matched
    // loosely because ICU ≥ 72 puts U+202F, not a space, before the meridiem.
    expect(within(rowFor("aisha@example.test")).getByText(/Jan 15, 2026/)).toBeInTheDocument();
    expect(within(rowFor("aisha@example.test")).getByText(/10:00/)).toBeInTheDocument();
  });

  it("says what activeAssignments is, not a status 0B never defined", async () => {
    // `activeAssignments` is a bare `z.number().int()` with no description in 0B's document, and 0B's
    // own invite handler creates a member holding 0 — so reading 0 as "Expired", as this task's brief
    // did, labels every freshly invited person expired. spec:108: the vocabulary is not ours to coin.
    renderScreen();
    expect(await screen.findByText("bilal@example.test", {}, LOAD)).toBeInTheDocument();
    expect(within(rowFor("aisha@example.test")).getByText("Has roles")).toBeInTheDocument();
    expect(within(rowFor("bilal@example.test")).getByText("No roles")).toBeInTheDocument();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("focuses the search box on `/` from anywhere on the screen (OD-24 default model)", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByLabelText("Search users", {}, LOAD)).toBeInTheDocument();
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Search users"));
    // The shortcut key itself must not also be typed into the box it just focused.
    expect(screen.getByLabelText("Search users")).toHaveValue("");
  });

  it("does not steal `/` from the operator already typing in the search box", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByLabelText("Search users", {}, LOAD)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search users"), "a/b");
    expect(screen.getByLabelText("Search users")).toHaveValue("a/b");
  });

  it("filters the grid as the operator types", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("bilal@example.test", {}, LOAD)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search users"), "aisha");
    expect(screen.queryByText("bilal@example.test")).not.toBeInTheDocument();
    expect(screen.getByText("aisha@example.test")).toBeInTheDocument();
    // The count is of what is on screen, not of what the server sent — and it is still a plural the
    // catalogue chose, not "1 users".
    expect(screen.getByText("1 user")).toBeInTheDocument();
  });

  it("cannot assign until a row is selected — the button is disabled", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
    await activateRow(user, "aisha@example.test");
    expect(screen.getByRole("button", { name: "Assign role" })).toBeEnabled();
  });

  it("cannot assign until a role is chosen — the select starts on a placeholder", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    // Without an empty first option the browser shows "Administrator" while the state holds "", and
    // the operator meets a disabled button under a role that looks chosen.
    expect(screen.getByLabelText("Assign role")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Choose a role" })).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    expect(screen.getByRole("button", { name: "Assign role" })).toBeEnabled();
  });

  it("forgets a selection the filter has hidden, rather than assigning to an invisible row", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    expect(screen.getByRole("button", { name: "Assign role" })).toBeEnabled();
    await user.type(screen.getByLabelText("Search users"), "bilal");
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
  });

  it("assigns to the row the operator activated, not the first row", async () => {
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl);
    expect(await screen.findByText("bilal@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "bilal@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => {
      const call = assignmentCall(impl);
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        principalId: BILAL,
        roleId: ACCOUNTANT_ROLE,
      });
    });
  });

  it("assigns a role through the company-scoped endpoint with an Idempotency-Key", async () => {
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => {
      const call = assignmentCall(impl);
      expect(call).toBeDefined();
      expect(String(call![0])).toBe(`${BASE_URL}/v1/companies/${COMPANY}/role-assignments`);
      const headers = (call![1] as RequestInit).headers as Record<string, string>;
      expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });

  it("re-sends the same Idempotency-Key when the operator retries the same assignment", async () => {
    // spec:2055 — 0B replays the stored response only for the *same* key with the same body. A retry
    // that minted a fresh key would assign the role twice where the first attempt reached the server.
    // The failure is a dropped connection: its outcome is unknown, so the key must survive it. (A 500
    // the server answered is a recorded verdict and releases the key — UI-12, the case below.)
    const user = userEvent.setup();
    const base = fetchImpl();
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/role-assignments")) throw new TypeError("Failed to fetch");
      return base(url, init);
    });
    renderScreen(impl as unknown as ReturnType<typeof fetchImpl>);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Assign role" }));

    await waitFor(() => expect(idempotencyKeys(impl)).toHaveLength(2));
    expect(idempotencyKeys(impl)[0]).toBe(idempotencyKeys(impl)[1]);

    // A different role is a different submit, so it must not replay the first one's stored answer.
    await user.selectOptions(screen.getByLabelText("Assign role"), ADMIN_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(idempotencyKeys(impl)).toHaveLength(3));
    expect(idempotencyKeys(impl)[2]).not.toBe(idempotencyKeys(impl)[0]);
  });

  it("mints a fresh key after a refusal the server recorded, so a fixed cause is not replayed (UI-12)", async () => {
    const user = userEvent.setup();
    const impl = fetchImpl({
      "/role-assignments": problem("ERR_INTERNAL", 500, "the database was unreachable", "Retry."),
    });
    renderScreen(impl);
    await waitFor(() => expect(screen.getByText("aisha@example.test")).toBeInTheDocument());
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(idempotencyKeys(impl)).toHaveLength(2));
    expect(idempotencyKeys(impl)[1]).not.toBe(idempotencyKeys(impl)[0]);
  });

  it("mints a fresh key once an assignment has been applied", async () => {
    // The same person and the same role, assigned twice — a grant made again after the first was
    // expired elsewhere. Holding a succeeded submit's key would have 0B replay its stored 201, and
    // the second grant would silently never happen.
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(idempotencyKeys(impl)).toHaveLength(1));

    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(idempotencyKeys(impl)).toHaveLength(2));
    expect(idempotencyKeys(impl)[0]).not.toBe(idempotencyKeys(impl)[1]);
  });

  it("sends one assignment however many times the operator presses the button", async () => {
    // A double-click on a slow link would otherwise be two POSTs with two keys — two assignments,
    // since a fresh key is exactly what tells 0B this is a different submit (§4.2.9).
    const user = userEvent.setup();
    // The POST hangs until this test lets it go, so "in flight" is an observable state rather than
    // a race the assertions have to win.
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fetchImpl();
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/role-assignments")) await inFlight;
      return base(url, init);
    });
    renderScreen(impl);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);

    await user.click(screen.getByRole("button", { name: "Assign role" }));
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    release?.();

    // The selection clears on success, which is the operator's sign that the submit is done with.
    await waitFor(() => expect(screen.queryByText("Selected: Aisha")).not.toBeInTheDocument());
    expect(idempotencyKeys(impl)).toHaveLength(1);
  });

  /** The refusal the tests below drive: a code this screen is the app's only producer of. */
  const selfGrantRefused = () =>
    fetchImpl({
      "/role-assignments": problem(
        "ERR_RBAC_SELF_GRANT",
        409,
        "principal 0192… may not grant a role to itself",
        // 0B's registry English. The catalogue's operator-facing sentence must win over it, which is
        // only observable because the two are deliberately different here.
        "Ask another administrator.",
      ),
    });

  const refuseAnAssignment = async (user: ReturnType<typeof userEvent.setup>) => {
    // A row must be activated first: an earlier test proves the Assign button is `disabled` while
    // nothing is selected, so without this no request is ever sent and no alert is rendered.
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  };

  it("shows the server's detail under the catalogue's own title and remedy", async () => {
    const user = userEvent.setup();
    renderScreen(selfGrantRefused());
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);
    // The detail names the specific entity and is always the server's (spec:2051)…
    expect(screen.getByRole("alert")).toHaveTextContent("may not grant a role to itself");
    // …while the frame around it is the operator's language, not the registry's English.
    expect(screen.getByRole("alert")).toHaveTextContent("You cannot give yourself a role");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ask another administrator to make this assignment.",
    );
  });

  it("re-translates a refusal already on screen when the operator switches language", async () => {
    // Held as the cause and rendered through `t`, not frozen as a string at `catch` time — otherwise
    // an operator who switches to Arabic goes on reading English (spec:2061).
    const user = userEvent.setup();
    renderScreen(selfGrantRefused());
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("لا يمكنك إسناد دور لنفسك"),
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("You cannot give yourself a role");
    // The detail stays the server's English, which `lib/problem.ts` records as a cross-slice gap.
    expect(screen.getByRole("alert")).toHaveTextContent("may not grant a role to itself");
  });

  it("isolates every segment of a refusal, so an Arabic paragraph cannot reorder it (spec:2253)", async () => {
    // This is the app's one error surface, and in `ar` it is a mixed-direction paragraph: an Arabic
    // title and remedy around the server's Latin `detail` and a bare UUID reference. Joined into one
    // string — which is what this rendered before — UAX#9 reorders those Latin runs and the neutral
    // characters between them against the order they were written in, and the reference id can end up
    // detached from the word it follows. `<bdi>` per segment is the same isolation `DataGrid` gives
    // every cell.
    const user = userEvent.setup();
    renderScreen(selfGrantRefused());
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("لا يمكنك إسناد دور لنفسك"),
    );
    const alert = screen.getByRole("alert");
    const isolated = [...alert.querySelectorAll("bdi")].map((node) => node.textContent);
    expect(isolated).toHaveLength(4); // title, the server's detail, the remedy, the reference
    expect(isolated).toContain("principal 0192… may not grant a role to itself");
    expect(isolated.some((text) => text?.includes("0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000"))).toBe(
      true,
    );
    // The load-bearing one: nothing but the separating spaces is left outside an isolate. A segment
    // rendered as a bare text node — the defect this closes — fails here even if the count matches.
    expect(alert.textContent).toBe(isolated.join(" "));
  });

  it("hands focus back to the activated row when the assignment is refused", async () => {
    // Pressing the button disables it — on press, not on success — and a browser blurs a disabled
    // element the instant it is disabled. Left alone the operator reads the refusal from `<body>`,
    // outside the app's structure, and must Tab through the whole shell to reach the row again.
    // The assertion is a **positive destination**: jsdom does not blur on `disabled`, so asserting
    // merely "not <body>" would pass with the fix removed.
    const user = userEvent.setup();
    renderScreen(selfGrantRefused());
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);
    expect(document.activeElement).toBe(cellFor("aisha@example.test"));
  });

  it("falls back to the search box when the activated row is gone from the refetched page", async () => {
    // Someone else removed that person between the assignment and the refetch: the cell focus was
    // heading for no longer exists. `<body>` is not an answer, so the one control that is always
    // there takes it. This is also why the restore waits for the commit the refetch produces.
    const user = userEvent.setup();
    let firstListing = true;
    const base = fetchImpl();
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/v1/admin/users")) {
        const body = firstListing ? USERS : { items: [USERS.items[1]], next_cursor: null };
        firstListing = false;
        return json(body);
      }
      return base(url, init);
    });
    renderScreen(impl);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.queryByText("aisha@example.test")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByLabelText("Search users"));
  });

  it("leaves focus wherever the operator moved it while the submit was in flight", async () => {
    // The mirror image of the drop this restore exists to fix: the disable-blur at press time is
    // exactly what prompts someone to Tab away, and yanking them back is the same discourtesy in
    // the other direction. Focus is reclaimed only from where the press left it.
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fetchImpl();
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/role-assignments")) await inFlight;
      return base(url, init);
    });
    renderScreen(impl);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));

    screen.getByLabelText("Search users").focus();
    release?.();
    await waitFor(() => expect(screen.queryByText("Selected: Aisha")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByLabelText("Search users"));
  });

  it("hands focus back to the activated row when the assignment succeeds", async () => {
    // The success path needs it more than the failure path: the selection and the role both clear,
    // so the button stays disabled and focus would never come back on its own.
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("bilal@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "bilal@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.queryByText("Selected: Bilal")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(cellFor("bilal@example.test"));
  });

  it("shows the problem when the list itself is refused, rather than an empty grid", async () => {
    renderScreen(
      fetchImpl({
        "/v1/admin/users": problem(
          "ERR_RBAC_FORBIDDEN",
          403,
          "principal 0192… may not manage users in company 0192…",
          "Ask an administrator for the admin.user.manage permission.",
        ),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("may not manage users"),
    );
    // A 403 is not an assurance-level problem: the operator stays where they are.
    expect(screen.queryByText("mfa enrolment screen")).not.toBeInTheDocument();
  });

  it("sends the operator to enrolment when /v1 answers ERR_AUTH_AAL_INSUFFICIENT", async () => {
    // The session is fine and the assurance level is not, so signing out or printing the raw error
    // would both be wrong — §4.2.3 admits `aal1` on the enrolment screen and nowhere else.
    renderScreen(
      fetchImpl({
        "/v1/admin/users": problem(
          "ERR_AUTH_AAL_INSUFFICIENT",
          401,
          "this route requires aal2",
          "Enrol MFA.",
        ),
      }),
    );
    expect(await screen.findByText("mfa enrolment screen", {}, LOAD)).toBeInTheDocument();
  });

  it("does not retry a refusal, so the redirect is not seven seconds behind it", async () => {
    // Deliberately a **default** client: TanStack retries three times at 1s, 2s and 4s, so without a
    // policy of its own the screen sits on an empty grid for about seven seconds before `users.error`
    // is set and the effect above fires. `waitFor`'s own one-second timeout is the discriminator.
    const impl = fetchImpl({
      "/v1/admin/users": problem(
        "ERR_AUTH_AAL_INSUFFICIENT",
        401,
        "this route requires aal2",
        "Enrol MFA.",
      ),
    });
    renderScreen(impl, COMPANY, new QueryClient());
    // Left at the default timeout on purpose: here the wait's length is the assertion, not a load.
    await waitFor(() => expect(screen.getByText("mfa enrolment screen")).toBeInTheDocument());
    // The settled answer was asked for exactly once.
    expect(impl.mock.calls.filter(([url]) => String(url).includes("/v1/admin/users"))).toHaveLength(
      1,
    );
  });

  it("says it is loading rather than claiming the tenant is empty", async () => {
    // "No users" and "Nothing to show yet." are statements about the tenant. Over a slow list they
    // are false, and they are the first thing the operator reads.
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fetchImpl();
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/v1/admin/users")) await inFlight;
      return base(url, init);
    });
    renderScreen(impl);
    await waitFor(() => expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0));
    expect(screen.queryByText("No users")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing to show yet.")).not.toBeInTheDocument();

    release?.();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    expect(screen.getByText("2 users")).toBeInTheDocument();
  });

  it("will not post to a company it does not know", async () => {
    // `useCompanyId` answers "" both while `GET /v1/companies` is in flight and when it fails; the
    // assignment must not go out to `/v1/companies//role-assignments` either way.
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl, "");
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
    expect(
      screen.getByText(
        "Assigning a role is unavailable until the company for this account is known.",
      ),
    ).toBeInTheDocument();
    expect(assignmentCall(impl)).toBeUndefined();
  });

  it("shows the empty state rather than a blank grid", async () => {
    renderScreen(fetchImpl({ "/v1/admin/users": json({ items: [], next_cursor: null }) }));
    expect(await screen.findByText("Nothing to show yet.", {}, LOAD)).toBeInTheDocument();
    expect(screen.getByText("No users")).toBeInTheDocument();
  });

  it("renders every column header in Arabic when the shell switches", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    expect(await screen.findByText("البريد الإلكتروني", {}, LOAD)).toBeInTheDocument();
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    // Role names are 0B's own data, so the Arabic operator gets `nameAr` rather than the `code`.
    expect(screen.getByRole("option", { name: "محاسب" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Accountant" })).not.toBeInTheDocument();
  });

  it("is operable by keyboard alone, from the search box to the assignment", async () => {
    // spec:2254 — "no mouse required". Not one `click` in this test: `/` reaches the search box, Tab
    // reaches the grid's single tab stop, the arrows move inside it, Enter selects the row, and Tab
    // walks on to the controls that act on it.
    const user = userEvent.setup();
    const impl = fetchImpl();
    renderScreen(impl);
    expect(await screen.findByText("bilal@example.test", {}, LOAD)).toBeInTheDocument();

    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Search users"));

    await user.tab();
    expect(document.activeElement).toBe(
      within(rowFor("aisha@example.test")).getByText("aisha@example.test").closest("td"),
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(rowFor("bilal@example.test")).getByText("bilal@example.test").closest("td"),
    );
    await user.keyboard("{Enter}");
    expect(screen.getByText("Selected: Bilal")).toBeInTheDocument();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Assign role"));
    // jsdom does not change a <select>'s value on ArrowDown, so the one step a real browser would do
    // with the arrows is driven here through `selectOptions` — on the element the Tab above focused.
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Assign role" }));
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const call = assignmentCall(impl);
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        principalId: BILAL,
        roleId: ACCOUNTANT_ROLE,
      });
    });
    // And the operator can carry straight on: focus is back on the row they acted on, not on the
    // `<body>` a disabled button would have dropped it to.
    await waitFor(() => expect(document.activeElement).toBe(cellFor("bilal@example.test")));
  });

  it("clears the selection on Esc, the OD-24 model's way out", async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    expect(screen.getByRole("button", { name: "Assign role" })).toBeEnabled();
    // From the button, which Esc is about to disable — the same focus drop as a submit.
    screen.getByRole("button", { name: "Assign role" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Selected: Aisha")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign role" })).toBeDisabled();
    expect(document.activeElement).toBe(cellFor("aisha@example.test"));
  });

  it("leaves Esc to the shell when focus is not on this screen", async () => {
    // A document-level shortcut that jumps focus *into* a screen the operator has tabbed away from
    // is worse than no shortcut: before this handler existed, Esc on the skip link moved nothing.
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    const skipLink = screen.getByText("Skip to content");
    skipLink.focus();
    await user.keyboard("{Escape}");
    expect(screen.getByText("Selected: Aisha")).toBeInTheDocument();
    expect(document.activeElement).toBe(skipLink);
  });

  it("does nothing on Esc when no row is selected", async () => {
    // After a successful assignment the selection is gone but the cell it was made from is still
    // remembered, so an unguarded Esc would pull focus into the grid for no reason at all.
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    await user.click(screen.getByRole("button", { name: "Assign role" }));
    await waitFor(() => expect(screen.queryByText("Selected: Aisha")).not.toBeInTheDocument());

    screen.getByLabelText("Search users").focus();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByLabelText("Search users"));
  });

  it("leaves Esc and `/` to the role picker, which owns both while it has focus", async () => {
    // Esc there dismisses the browser's own dropdown, and `/` drives its type-ahead. Taking either
    // away punishes the operator for using the control the way the platform works.
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await activateRow(user, "aisha@example.test");
    await user.selectOptions(screen.getByLabelText("Assign role"), ACCOUNTANT_ROLE);
    screen.getByLabelText("Assign role").focus();

    await user.keyboard("{Escape}");
    expect(screen.getByText("Selected: Aisha")).toBeInTheDocument();
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Assign role"));
  });

  it("drops a refusal that is no longer about what is on the form", async () => {
    // A stale refusal sitting under a freshly reconfigured submit reads as the answer to it.
    const user = userEvent.setup();
    renderScreen(selfGrantRefused());
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);
    await user.selectOptions(screen.getByLabelText("Assign role"), ADMIN_ROLE);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await refuseAnAssignment(user);
    await activateRow(user, "bilal@example.test");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a refused token and hands the answer to the session's owner", async () => {
    // This screen holds no session, so it must not route to `/login` itself: it would leave the
    // operator signed in, looking at a link straight back — and it would unmount `useCompanyId`
    // mid-flight, aborting the very request whose answer that one owner acts on. What it does is
    // show the refusal and ask the owner's lookup to run again; the same token refuses that too.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await queryClient.prefetchQuery({
      queryKey: COMPANY_QUERY_KEY,
      queryFn: () => ({ items: [], next_cursor: null }),
    });
    renderScreen(
      fetchImpl({
        "/v1/admin/users": problem(
          "ERR_AUTH_TOKEN_INVALID",
          401,
          "the access token could not be verified",
          "Sign in again.",
        ),
      }),
      COMPANY,
      queryClient,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("the access token could not be verified"),
    );
    await waitFor(() =>
      expect(queryClient.getQueryState(COMPANY_QUERY_KEY)?.isInvalidated).toBe(true),
    );
    expect(screen.queryByText("sign-in screen")).not.toBeInTheDocument();
    expect(screen.queryByText("mfa enrolment screen")).not.toBeInTheDocument();
  });

  it("asks /v1 for nothing until there is a token to ask with", async () => {
    // The provider's first `getSession()` is asynchronous and separate from the route guard's, so
    // this screen can render while the token is still null. An unauthenticated request is answered
    // 401, and a refused token is answered by signing out — so an ungated query ejects the operator
    // in the middle of a cold boot. A disabled query reports `pending`, which is also what the
    // screen should be saying while it waits.
    const impl = fetchImpl();
    renderScreen(impl, COMPANY, undefined, () => null);
    await waitFor(() => expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0));
    expect(impl).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets a later refusal through rather than reading only the first one it finds", async () => {
    // A stale 409 from an earlier submit used to shadow a 401 arriving on a refetch, because the
    // effect read `failure ?? users.error ?? roles.error` and stopped at the first set value. The
    // real-world trigger is `refetchOnWindowFocus`, which `main.tsx`'s client leaves on; the
    // invalidation below is the same code path, driven deterministically.
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await queryClient.prefetchQuery({
      queryKey: COMPANY_QUERY_KEY,
      queryFn: () => ({ items: [], next_cursor: null }),
    });
    let listRefused = false;
    const base = fetchImpl({
      "/role-assignments": problem(
        "ERR_RBAC_SELF_GRANT",
        409,
        "principal 0192… may not grant a role to itself",
        "Ask another administrator.",
      ),
    });
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/v1/admin/users") && listRefused)
        return problem("ERR_AUTH_TOKEN_INVALID", 401, "the token has expired", "Sign in again.");
      return base(url, init);
    });
    renderScreen(impl, COMPANY, queryClient);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);
    expect(queryClient.getQueryState(COMPANY_QUERY_KEY)?.isInvalidated).toBe(false);

    listRefused = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(COMPANY_QUERY_KEY)?.isInvalidated).toBe(true),
    );
  });

  it("lets an assurance refusal through a refusal that is already on screen", async () => {
    // The other half of the same shadowing: `isAalRefusal(failure ?? users.error)` read the stale
    // 409 from the submit and never saw the `aal2` 401 that arrived after it, so the operator sat
    // on a screen every request was refused on instead of being sent to enrolment.
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let assuranceLost = false;
    const base = fetchImpl({
      "/role-assignments": problem(
        "ERR_RBAC_SELF_GRANT",
        409,
        "principal 0192… may not grant a role to itself",
        "Ask another administrator.",
      ),
    });
    const impl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/v1/admin/users") && assuranceLost)
        return problem("ERR_AUTH_AAL_INSUFFICIENT", 401, "this route requires aal2", "Enrol MFA.");
      return base(url, init);
    });
    renderScreen(impl, COMPANY, queryClient);
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    await refuseAnAssignment(user);

    assuranceLost = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    });
    expect(await screen.findByText("mfa enrolment screen", {}, LOAD)).toBeInTheDocument();
  });

  it("does not report an empty tenant when the list itself was refused", async () => {
    // Once the request has failed `isPending` is false and `data` is undefined, so the count read
    // "No users" and the grid "Nothing to show yet." beside an alert saying the server refused it.
    renderScreen(
      fetchImpl({
        "/v1/admin/users": problem(
          "ERR_RBAC_FORBIDDEN",
          403,
          "principal 0192… may not manage users",
          "Ask an administrator.",
        ),
      }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("The list of users could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No users")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing to show yet.")).not.toBeInTheDocument();
  });

  it("does not claim the tenant is empty when a cursor points at another page", async () => {
    // 0B's list is one page and `UserQuery` has no search term, so the filter is over this page
    // alone. "No users" and "Nothing to show yet." are both statements about the tenant.
    renderScreen(fetchImpl({ "/v1/admin/users": json({ items: [], next_cursor: "cursor-2" }) }));
    expect(await screen.findByText("No users on this page", {}, LOAD)).toBeInTheDocument();
    expect(screen.queryByText("No users")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing to show yet.")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing to show on this page.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "There are more users than this page shows, and search looks only at the ones listed here.",
      ),
    ).toBeInTheDocument();
  });

  it("counts the page, not the tenant, while there is another page", async () => {
    renderScreen(
      fetchImpl({ "/v1/admin/users": json({ items: USERS.items, next_cursor: "cursor-2" }) }),
    );
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    expect(screen.getByText("2 users on this page")).toBeInTheDocument();
    expect(screen.queryByText("2 users")).not.toBeInTheDocument();
  });

  it("announces the count and the selection, not only shows them", async () => {
    // WCAG 2.2 AA 4.1.3 (spec:2252): the count changes as the filter narrows and the indicator is
    // the only feedback that pressing Enter on a row did anything — both silent without a live role.
    const user = userEvent.setup();
    renderScreen();
    expect(await screen.findByText("aisha@example.test", {}, LOAD)).toBeInTheDocument();
    const live = screen.getAllByRole("status").map((node) => node.textContent);
    expect(live).toContain("2 users");
    expect(live).toContain("Press Enter on a row to choose who to assign a role to.");
    await activateRow(user, "aisha@example.test");
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain(
      "Selected: Aisha",
    );
  });
});
