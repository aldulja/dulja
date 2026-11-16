import { ListEnvelope, ProblemSchema, type Problem } from "@dulja/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Locale } from "@dulja/i18n";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppShell } from "../src/components/app-shell";
import { RouterAround } from "./support/router";
import { createAdminApi } from "../src/lib/admin-api";
import { readEnv } from "../src/lib/env";
import { I18nProvider, useI18n, type LocaleStore } from "../src/lib/i18n-provider";
import {
  ApiError,
  internalProblem,
  isAalRefusal,
  isSessionRefusal,
  problemSegments,
  retryQuery,
} from "../src/lib/problem";
import type { Translate } from "../src/lib/translate";
import { createAppRouter } from "../src/router";

/** A `LocaleStore` that starts empty and records what the provider writes. */
function fakeLocaleStore(
  initial: "en" | "ar" | null = null,
): LocaleStore & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value === "en" || this.value === "ar" ? this.value : null;
    },
    write(locale) {
      this.value = locale;
    },
  };
}

/**
 * `AppShell`'s nav link is now a TanStack `<Link>` (Task 6: a plain anchor is a full document
 * navigation, which discards a session the OS keyring refused to persist), and `<Link>` calls
 * `useRouter()`. `RouterAround` supplies the least router that satisfies it — the shell's own
 * behaviour, which is what these tests are about, is unchanged.
 */
const shell = (children: ReactNode, store: LocaleStore = fakeLocaleStore()) => (
  <I18nProvider store={store}>
    <RouterAround>
      <AppShell>{children}</AppShell>
    </RouterAround>
  </I18nProvider>
);

/** An unauthenticated route: translation, no chrome. Task 6's login screen has this shape. */
function BareRoute() {
  const { t } = useI18n();
  return <p>{t("auth.login.title")}</p>;
}

/**
 * Renders every lookup as `[key|vars]`, so an assertion can tell a translated string apart from a
 * pass-through of the server's own wording. Assignable to `Translate` without a cast: accepting a
 * wider key type than `TranslationKey` is exactly what a stand-in should do.
 */
const fakeT: Translate = (key, vars) =>
  `[${key}${vars === undefined ? "" : `|${JSON.stringify(vars)}`}]`;

const api = (fetchImpl: typeof fetch) =>
  createAdminApi({ baseUrl: "https://api.example.test", accessToken: () => "jwt", fetchImpl });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headersOf = (init: RequestInit | undefined) =>
  (init as RequestInit).headers as Record<string, string>;

describe("readEnv", () => {
  it("accepts a complete environment", () => {
    expect(
      readEnv({
        VITE_API_BASE_URL: "https://api.example.test",
        VITE_SUPABASE_URL: "https://project.supabase.co",
        VITE_SUPABASE_ANON_KEY: "anon-key",
        VITE_APP_ENV: "staging",
      }),
    ).toEqual({
      apiBaseUrl: "https://api.example.test",
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon-key",
      appEnv: "staging",
    });
  });

  it("names the missing variable rather than failing at the first fetch", () => {
    expect(() => readEnv({ VITE_API_BASE_URL: "https://api.example.test" })).toThrow(
      /VITE_SUPABASE_URL/,
    );
  });

  /**
   * The three cases the empty-string strip exists for (0E T13 review). `release.yml` passes
   * `VITE_SENTRY_DSN: ${{ secrets.SENTRY_DSN }}`, and with OD-22 open GitHub renders that absent secret
   * as `""`, not as unset — Vite then bakes the empty string into the bundle. Before the strip,
   * `z.string().min(1).optional()` accepted `undefined` and refused `""`, so the renderer threw
   * "Missing or invalid environment variables: VITE_SENTRY_DSN" at boot: a white screen shipped past
   * the very guard that exists to stop one.
   */
  const complete = {
    VITE_API_BASE_URL: "https://api.example.test",
    VITE_SUPABASE_URL: "https://project.supabase.co",
    VITE_SUPABASE_ANON_KEY: "anon-key",
  };

  it("treats an empty optional variable as absent, not as invalid", () => {
    const env = readEnv({ ...complete, VITE_SENTRY_DSN: "" });
    // `toEqual` would pass on `{ sentryDsn: undefined }` too; `exactOptionalPropertyTypes` (see the
    // comment in `env.ts`) means the key must not be there at all, so assert exactly that.
    expect(env).not.toHaveProperty("sentryDsn");
  });

  it("still refuses an empty required variable, and names it", () => {
    expect(() =>
      readEnv({
        VITE_API_BASE_URL: "",
        VITE_SUPABASE_URL: "https://project.supabase.co",
        VITE_SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toThrow(/VITE_API_BASE_URL/);
  });

  it("takes the default for an empty variable that has one", () => {
    expect(readEnv({ ...complete, VITE_APP_ENV: "" }).appEnv).toBe("dev");
  });
});

describe("AppShell", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dir");
    document.documentElement.removeAttribute("lang");
    document.title = "";
  });

  it("renders in English by default with dir=ltr on the document root", async () => {
    render(shell(<p>content</p>));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("dir")).toBe("ltr");
      // `document.title` is written by its own effect in `I18nProvider`, not by the one that writes
      // `dir`, so it is awaited alongside `dir` rather than read after it.
      expect(document.title).toBe("Dulja");
    });
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("Users and roles")).toBeInTheDocument();
  });

  it("switches the whole shell to Arabic and rtl from the locale switcher, by keyboard", async () => {
    const user = userEvent.setup();
    render(shell(<p>content</p>));
    await waitFor(() => expect(screen.getByLabelText("Language")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    await waitFor(() => {
      expect(document.documentElement.getAttribute("dir")).toBe("rtl");
      // The tab's own name is user-facing too (`index.html` ships an English placeholder), and it is
      // written by a different effect from `dir`, so it is awaited rather than read after it.
      expect(document.title).toBe("دُلجة");
    });
    // `lang` is set by the same effect as `dir`, on the very next line of `DirectionProvider`, so
    // awaiting `dir` has already guaranteed it.
    expect(document.documentElement.getAttribute("lang")).toBe("ar");
    expect(screen.getByText("المستخدمون والأدوار")).toBeInTheDocument();
    // Deliberately NOT inside the `waitFor`: a negative assertion there would pass on the first
    // poll, before Arabic had rendered at all.
    expect(screen.queryByText("Users and roles")).not.toBeInTheDocument();
  });

  it("links only to paths the application's route tree mounts", async () => {
    render(shell(<p>content</p>));
    const links = within(await screen.findByRole("navigation")).getAllByRole("link");
    const mounted = Object.keys(createAppRouter({} as SupabaseClient).routesByPath);
    // The path a link mounts; a search string (8D T10's `/reports?module=hr`) selects within the route.
    const targets = links.map(
      (link) => new URL(link.getAttribute("href") ?? "", "https://example.test").pathname,
    );
    expect(targets).toContain("/pos/shifts");
    expect(targets).toContain("/hr/leave");
    expect(targets).toContain("/hr/permit-expiry");
    for (const target of targets) expect(mounted).toContain(target);
  });

  it("offers a skip link as the first focusable element, and activating it focuses main", async () => {
    const user = userEvent.setup();
    render(shell(<p>content</p>));
    await waitFor(() => expect(screen.getByText("Skip to content")).toBeInTheDocument());
    await user.tab();
    expect(document.activeElement).toHaveTextContent("Skip to content");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

describe("I18nProvider", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dir");
    document.documentElement.removeAttribute("lang");
  });

  it("gives an unauthenticated route translation and direction with no shell chrome", async () => {
    // Task 6's login screen renders exactly like this. If `t` and `dir` were still owned by
    // `AppShell`, this tree would either have no translation or would show a signed-out visitor a
    // header and a "Users and roles" link.
    render(
      <I18nProvider initialLocale="ar" store={fakeLocaleStore()}>
        <BareRoute />
      </I18nProvider>,
    );
    // Both facts inside the same `waitFor`. `dir` is set by an effect, so a commit that has already
    // painted the Arabic text has not necessarily run it yet; asserting it outside made this the one
    // test in the file that flaked under load (seen three times during Task 6's mutation runs, never
    // in isolation). The assertions are unchanged — only when they are evaluated.
    await waitFor(() => {
      expect(screen.getByText("تسجيل الدخول")).toBeInTheDocument();
      expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("boots at the stored locale and writes the operator's choice back", async () => {
    const user = userEvent.setup();
    const store = fakeLocaleStore("ar");
    render(shell(<p>content</p>, store));
    // Restored from storage without a frame of English first: `dir` is rtl on the first commit.
    await waitFor(() => {
      expect(screen.getByText("المستخدمون والأدوار")).toBeInTheDocument();
      expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    });
    await user.selectOptions(screen.getByLabelText("اللغة"), "en");
    await waitFor(() => expect(store.value).toBe("en"));
  });

  it("survives a storage that throws on both reads and writes", async () => {
    // A private window, or a profile with site data blocked, throws on the `localStorage` property
    // access itself. Both halves are exercised: `read()` throws during the boot lookup, and
    // `write()` throws when the operator switches — a locale preference is never worth a blank
    // screen, and this is why the guard sits at the seam rather than inside `browserLocaleStore`.
    const user = userEvent.setup();
    const hostile: LocaleStore = {
      read() {
        throw new Error("site data blocked");
      },
      write() {
        throw new Error("site data blocked");
      },
    };
    render(shell(<p>content</p>, hostile));
    await waitFor(() => expect(screen.getByText("Users and roles")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Language"), "ar");
    await waitFor(() => {
      expect(screen.getByText("المستخدمون والأدوار")).toBeInTheDocument();
      expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    });
  });

  it("treats a store that returns a non-Locale as no preference at all", async () => {
    // The likelier foreign-store failure is a bad *return*, not a throw: a value corrupted in
    // storage, a string persisted by an older build, another key namespace. Unchecked it would reach
    // `dirFor`, which answers `undefined` outside {en, ar} — an unpredictable `dir` attribute rather
    // than a clean fallback.
    const garbage: LocaleStore = {
      read: () => "fr-CA" as unknown as Locale,
      write: () => {},
    };
    render(shell(<p>content</p>, garbage));
    await waitFor(() => {
      expect(screen.getByText("Users and roles")).toBeInTheDocument();
      expect(document.documentElement.getAttribute("dir")).toBe("ltr");
      expect(document.documentElement.getAttribute("lang")).toBe("en");
    });
  });
});

describe("problemSegments", () => {
  it("prefers the catalogue's title and remedy for a code it knows", () => {
    // Asserted as the whole ordered list, not with `toContain`: the segment boundaries are the
    // contract now — they are what the caller wraps in `<bdi>` — so a segment silently merging into
    // its neighbour has to fail here.
    expect(
      problemSegments(
        internalProblem({
          instance: "/v1/admin/users",
          diagnostic: "TypeError",
          status: 0,
          requestId: "req-1",
        }),
        fakeT,
      ),
    ).toEqual([
      { key: "title", text: "[problem.ERR_INTERNAL.title]" },
      { key: "detail", text: "/v1/admin/users — TypeError" },
      // The remedy is the catalogue's, interpolated into the frame — not the envelope's English one.
      { key: "remedy", text: '[problem.remedy|{"remedy":"[problem.ERR_INTERNAL.remedy]"}]' },
      { key: "reference", text: '[problem.reference|{"requestId":"req-1"}]' },
    ]);
  });

  it("omits the reference segment when there is no request id to quote", () => {
    // A failure this side of a reply has no server request id. "Reference unknown" would be a line
    // of English prose no catalogue could translate, so the line is dropped instead of filled.
    const segments = problemSegments(
      internalProblem({
        instance: "/v1/admin/users",
        diagnostic: "TypeError",
        status: 0,
        requestId: "",
      }),
      fakeT,
    );
    expect(segments.map((segment) => segment.key)).toEqual(["title", "detail", "remedy"]);
    expect(segments[0]!.text).toBe("[problem.ERR_INTERNAL.title]");
  });

  it("falls back to the generic title and the server's own remedy for a code it does not know", () => {
    expect(
      problemSegments(
        {
          type: "urn:dulja:error:ERR_PERIOD_NOT_OPEN",
          title: "Fiscal period is not open",
          status: 422,
          detail: "period 2026-01 is closed",
          instance: "/v1/journals",
          code: "ERR_PERIOD_NOT_OPEN",
          remedy: "Use an open period.",
          requestId: "req-2",
        },
        fakeT,
      ),
    ).toEqual([
      { key: "title", text: "[app.error.title]" },
      { key: "detail", text: "period 2026-01 is closed" },
      { key: "remedy", text: '[problem.remedy|{"remedy":"Use an open period."}]' },
      { key: "reference", text: '[problem.reference|{"requestId":"req-2"}]' },
    ]);
  });
});

/** An `ApiError` carrying a registered code at a given status, as `/v1` would produce it. */
const refusal = (code: string, status: number) =>
  new ApiError({
    type: `urn:dulja:error:${code}`,
    title: "Refused",
    status,
    detail: "detail",
    instance: "/v1/admin/users",
    code,
    remedy: "remedy",
    requestId: "req-1",
  } as Problem);

describe("refusal predicates", () => {
  it("tells an assurance refusal apart from a dead token, both of which are 401", () => {
    // The two answers are different screens — `/mfa` and `/login` — so the predicates carry the
    // distinction rather than the order of the `if`s at each call site.
    expect(isAalRefusal(refusal("ERR_AUTH_AAL_INSUFFICIENT", 401))).toBe(true);
    expect(isSessionRefusal(refusal("ERR_AUTH_AAL_INSUFFICIENT", 401))).toBe(false);
    expect(isSessionRefusal(refusal("ERR_AUTH_TOKEN_INVALID", 401))).toBe(true);
    expect(isAalRefusal(refusal("ERR_AUTH_TOKEN_INVALID", 401))).toBe(false);
  });

  it("claims neither a 403 nor a failure this side of a reply", () => {
    expect(isAalRefusal(refusal("ERR_RBAC_FORBIDDEN", 403))).toBe(false);
    expect(isSessionRefusal(refusal("ERR_RBAC_FORBIDDEN", 403))).toBe(false);
    expect(isSessionRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAalRefusal(null)).toBe(false);
  });

  it("retries a dropped connection but never a refusal the server has settled", () => {
    // TanStack's default would repeat a 4xx three times at 1s, 2s and 4s, delaying every answer
    // this screen routes on. A `status: 0` envelope is this side of a reply and keeps the retries.
    expect(retryQuery(0, refusal("ERR_RBAC_FORBIDDEN", 403))).toBe(false);
    expect(retryQuery(0, refusal("ERR_AUTH_AAL_INSUFFICIENT", 401))).toBe(false);
    // 429 too: 0B answers it with a RateLimit-Reset window a blind one-second retry ignores.
    expect(retryQuery(0, refusal("ERR_RATE_LIMITED", 429))).toBe(false);
    expect(retryQuery(0, refusal("ERR_INTERNAL", 500))).toBe(true);
    expect(
      retryQuery(
        0,
        new ApiError(
          internalProblem({ instance: "/v1", diagnostic: "TypeError", status: 0, requestId: "" }),
        ),
      ),
    ).toBe(true);
    // And never for ever, whatever the cause.
    expect(retryQuery(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("createAdminApi", () => {
  const problem = {
    type: "urn:dulja:error:ERR_RBAC_FORBIDDEN",
    title: "Forbidden",
    status: 403,
    detail: "principal 0192… may not manage users in company 0192…",
    instance: "/v1/admin/users",
    code: "ERR_RBAC_FORBIDDEN",
    remedy: "Ask an administrator for the admin.user.manage permission.",
    requestId: "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000",
  };

  it("uses a fixture the shipped ProblemSchema actually accepts", () => {
    // Pins the fixture below to 0B's registered envelope. Without this the rest of this block would
    // still pass against a hand-rolled shape that `/v1` never sends, and the parse in `toApiError`
    // would be asserted against nothing.
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it("sends the bearer token and parses the body against the supplied schema", async () => {
    // Typed as `typeof fetch` so `mock.calls[0]` is fetch's own `[input, init?]` tuple — an
    // untyped `vi.fn(async () => …)` records a zero-length tuple and the header assertions below
    // cannot reach index 1 at all.
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ items: [{ id: "1" }], next_cursor: null }),
    );
    // The registered list envelope, not a second spelling of it (contracts hazard 9).
    const schema = ListEnvelope(z.object({ id: z.string() }));
    await expect(api(fetchImpl).get("/v1/admin/users", schema)).resolves.toEqual({
      items: [{ id: "1" }],
      next_cursor: null,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/admin/users");
    expect(headersOf(init)).toMatchObject({ authorization: "Bearer jwt" });
  });

  it("mints an Idempotency-Key on every unsafe method (§4.2.9)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}));
    await api(fetchImpl).send("POST", "/v1/admin/users", { email: "x@example.test" }, z.object({}));
    expect(headersOf(fetchImpl.mock.calls[0]![1])["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("mints a fresh key per submit, but holds the caller's key across a retry (spec:2055)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({}));
    const client = api(fetchImpl);
    // Two independent submits must not share a key, or the second is silently replayed as the first.
    await client.send("POST", "/v1/admin/users", { email: "a@example.test" }, z.object({}));
    await client.send("POST", "/v1/admin/users", { email: "b@example.test" }, z.object({}));
    const [first, second] = fetchImpl.mock.calls.map(
      (call) => headersOf(call[1])["idempotency-key"],
    );
    expect(first).not.toBe(second);

    // A retry of one logical submit must reuse the key, or 0B cannot replay the stored response and
    // a double-clicked "Invite user" executes twice.
    const key = "0192bbbb-cccc-7ddd-8eee-ffff00001111";
    const body = { email: "c@example.test" };
    await client.send("POST", "/v1/admin/users", body, z.object({}), { idempotencyKey: key });
    await client.send("POST", "/v1/admin/users", body, z.object({}), { idempotencyKey: key });
    const retried = fetchImpl.mock.calls
      .slice(2)
      .map((call) => headersOf(call[1])["idempotency-key"]);
    expect(retried).toEqual([key, key]);
  });

  it("throws an ApiError carrying the parsed problem envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(problem), {
          status: 403,
          headers: { "content-type": "application/problem+json" },
        }),
    );
    const client = api(fetchImpl);
    await expect(client.get("/v1/admin/users", z.object({}))).rejects.toBeInstanceOf(ApiError);
    await expect(client.get("/v1/admin/users", z.object({}))).rejects.toMatchObject({
      problem: { code: "ERR_RBAC_FORBIDDEN", requestId: problem.requestId },
    });
  });

  it("turns a non-envelope error body into an ERR_INTERNAL problem, keeping the request id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html", "x-request-id": "req-502" },
        }),
    );
    await expect(api(fetchImpl).get("/v1/admin/users", z.object({}))).rejects.toMatchObject({
      problem: {
        code: "ERR_INTERNAL",
        status: 502,
        requestId: "req-502",
        detail: "/v1/admin/users — HTTP 502",
      },
    });
  });

  it("turns a dead network into an ApiError rather than a raw TypeError", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = await api(fetchImpl)
      .get("/v1/admin/users", z.object({}))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).problem).toMatchObject({
      code: "ERR_INTERNAL",
      detail: "/v1/admin/users — TypeError",
      requestId: "",
    });
  });

  it("turns a 2xx body that does not match its schema into an ApiError, keeping the issues", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ items: "not-an-array" }));
    const error = await api(fetchImpl)
      .get("/v1/admin/users", ListEnvelope(z.object({ id: z.string() })))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).problem.code).toBe("ERR_INTERNAL");
    expect((error as ApiError).problem.detail).toBe("/v1/admin/users — ZodError");
    expect((error as ApiError).problem.errors?.map((issue) => issue.path)).toContain("items");
  });

  it("lets a deliberate abort through untouched, so a cancelled query is not an error state", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return json({});
    });
    controller.abort();
    const error = await api(fetchImpl)
      .get("/v1/admin/users", z.object({}), { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe("AbortError");
    // The signal really did reach fetch, rather than the abort being simulated here.
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("does not call .json() on a 204", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await expect(
      api(fetchImpl).send("DELETE", "/v1/admin/users/1", undefined, z.undefined()),
    ).resolves.toBeUndefined();
  });
});
