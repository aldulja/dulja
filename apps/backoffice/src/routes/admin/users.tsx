import { formatNumber, formatTimestamp, type Locale } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import { createAdminApi, type AdminApiOptions } from "../../lib/admin-api";
import {
  RoleAssignmentSchema,
  RoleList,
  UserList,
  type Role,
  type User,
} from "../../lib/admin-schemas";
import {
  ApiError,
  isAalRefusal,
  isSessionRefusal,
  problemSegments,
  retryQuery,
  type ProblemSegment,
} from "../../lib/problem";
// The query key only — no hook, no session: this screen stays renderable without a provider.
import { keepsAttemptKey } from "../../features/reports/shared";
import { COMPANY_QUERY_KEY } from "../../lib/session";
import type { Translate } from "../../lib/translate";

export interface UsersRouteProps {
  /** Injected so the screen is testable without a network; the route supplies the real one. */
  api: AdminApiOptions;
  /**
   * The company every assignment is scoped to, as `useCompanyId` resolves it (that hook names the
   * route it asks). Empty while that request is in flight **and** when it failed or answered no
   * company, so the assignment controls treat "" as "not known yet" rather than posting to
   * `/v1/companies//role-assignments`.
   */
  companyId: string;
}

/**
 * `createAdminApi` contains every failure as an `ApiError` (a dead network and an unparseable 2xx
 * body included), so the second branch is unreachable by construction. It renders the catalogue's
 * generic title rather than `String(cause)`, because an exception's own message is English a
 * catalogue cannot translate (spec:2061) — a class name on screen would be a regression, not a clue.
 */
const messageFor = (cause: unknown, t: Translate): readonly ProblemSegment[] =>
  cause instanceof ApiError
    ? problemSegments(cause.problem, t)
    : [{ key: "title", text: t("app.error.title") }];

/**
 * Role names are 0B's data, not catalogue keys, so the locale picks the column rather than a lookup:
 * `nameAr` is nullable in `RoleSchema` and a role that has none still has to be nameable.
 */
const roleLabel = (role: Role, locale: Locale): string =>
  locale === "ar" ? (role.nameAr ?? role.nameEn) : role.nameEn;

const matches = (user: User, needle: string): boolean =>
  `${user.email ?? ""} ${user.displayName}`.toLowerCase().includes(needle);

/**
 * The one real back-office screen: the people who may use this tenant, and the roles they hold.
 *
 * **OD-24 is open** (contracts §2.12; `docs/ui/od-24-users-and-roles.md`). No screenshot and no
 * operator description exist, so nothing here is invented beyond that document's default keyboard
 * model and 0B's OpenAPI document — spec:108, "do not invent workflows from this document". In
 * particular the invitation flow (`POST /v1/admin/users`) is deliberately **not** built: the default
 * model names an "Invite user" button in its tab order but nothing sources what the form asks for,
 * and `admin.users.invite` stays in the catalogue unrendered until the owner's material arrives.
 */
export function UsersRoute({ api, companyId }: UsersRouteProps) {
  const { t, locale } = useShell();
  const client = useMemo(() => createAdminApi(api), [api]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [roleId, setRoleId] = useState("");
  /** The id, not the row: a refetch replaces every object, and a selection must survive one. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The *cause*, not the sentence it renders as. A string frozen at `catch` time stays in whatever
   * language was on screen when the request failed, so an operator who switches to Arabic keeps
   * reading English (spec:2061). Translated at render instead, from `t`, like every other string
   * here.
   */
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const assignRef = useRef<HTMLButtonElement>(null);
  /**
   * The cell the operator pressed Enter on. Pressing the submit button disables it — on press, not
   * on success — and the browser blurs a disabled element, dropping focus to `<body>`: the operator
   * is then stranded outside the app's structure and must Tab through the whole shell to get back,
   * with the refusal they need to read announced somewhere behind them.
   * `docs/ui/od-24-users-and-roles.md` already sources the destination ("returning focus to the row
   * it opened from"), so focus goes back there on success, on refusal, and when Esc drops the
   * selection.
   */
  const activatedCell = useRef<HTMLElement | null>(null);
  /**
   * The key of the assignment currently being attempted (§4.2.9, spec:2055). A retry of the *same*
   * submit must carry the key its first attempt used, or 0B cannot replay its stored answer and an
   * attempt that reached the server before the connection died is executed a second time. A
   * different principal or role is a different submit and mints a fresh key, because 0B refuses a
   * reused key with a changed body.
   */
  const attempt = useRef<{ principalId: string; roleId: string; key: string } | null>(null);

  /**
   * A request sent before the session provider has applied its first `getSession()` carries no
   * bearer token, is answered 401, and — since a refused token is now answered by signing out — would
   * eject the operator in the middle of a cold boot. The route guard resolving is not the same event
   * as the provider's state landing: they are two independent asynchronous reads of the same client.
   * A disabled query reports `pending`, which is exactly what the screen should be saying anyway.
   */
  const hasToken = api.accessToken() !== null;

  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => client.get("/v1/admin/users", UserList, { signal }),
    retry: retryQuery,
    enabled: hasToken,
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: ({ signal }) => client.get("/v1/admin/roles", RoleList, { signal }),
    retry: retryQuery,
    enabled: hasToken,
  });

  // The route guard checks the assurance level before the screen loads; this is the case it cannot
  // see — a client that believes it has `aal2` and a server that does not. Nothing is signed out
  // here: the session is fine, only its assurance level is not (§4.2.3).
  useEffect(() => {
    // `failure` is deliberately not consulted: the assign catch routes an assurance refusal itself
    // and returns before setting it, so the only thing including it could do here is let a stale
    // assignment refusal hide an assurance 401 arriving from the queries.
    if (isAalRefusal(users.error) || isAalRefusal(roles.error)) void navigate({ to: "/mfa" });
  }, [users.error, roles.error, navigate]);

  /**
   * A refused *token* is not this screen's to answer. It holds no session, so navigating to
   * `/login` from here would leave the operator signed in, looking at a link straight back — and
   * would unmount `useCompanyId` mid-flight, aborting the very request whose answer that one owner
   * acts on. So the refusal is surfaced like any other (the alert below), and the company lookup is
   * asked to run again: it carries the same token, so it will be refused too, and the owner decides
   * once. This is also the only path for a token that dies *after* that lookup already succeeded.
   */
  useEffect(() => {
    // Every candidate, not the first one that happens to be set: `failure ?? …` let a stale 403 or
    // 409 from an earlier submit hide a 401 that arrived later on a refetch — reachable through
    // `refetchOnWindowFocus`, which `main.tsx`'s client leaves on.
    if ([failure, users.error, roles.error].some(isSessionRefusal))
      void queryClient.invalidateQueries({ queryKey: COMPANY_QUERY_KEY });
  }, [failure, users.error, roles.error, queryClient]);

  const focusIsInGrid = (): boolean => gridRef.current?.contains(document.activeElement) ?? false;

  /**
   * Back to the row the operator acted on. Reads only refs, so the `[]` keydown effect below may
   * close over it safely. When that row is gone — filtered away, or no longer in the refetched page
   * — the search box is the one control that is always present, and is where the operator would go
   * next anyway.
   */
  const returnFocus = (): void => {
    const cell = activatedCell.current;
    if (cell !== null && cell.isConnected) cell.focus();
    else searchRef.current?.focus();
  };

  /**
   * The submit's focus restore, in an effect keyed on the end of the request rather than in
   * `assign`'s own `finally`. It has to run *after* the commit that the refetched list produces:
   * called inline, it would read `isConnected` against the DOM as it was before that commit, hand
   * focus to a row React is about to remove, and land the operator on `<body>` — the very thing it
   * exists to prevent.
   */
  const wasBusy = useRef(false);
  useEffect(() => {
    // Only when focus is still where the press left it: on the button, or on `<body>` once the
    // browser blurred it for being disabled. An operator who Tabbed away while the request was in
    // flight — likely, since the disable-blur is exactly what prompts it — keeps where they went.
    // jsdom needs the button disjunct: it does not blur on `disabled`, which is the same gap that
    // made a "not <body>" assertion vacuous.
    const dropped =
      document.activeElement === null ||
      document.activeElement === document.body ||
      document.activeElement === assignRef.current;
    if (wasBusy.current && !busy && dropped) returnFocus();
    wasBusy.current = busy;
  }, [busy]);

  // The OD-24 default keyboard model: "/" focuses search from anywhere on the screen, Esc drops the
  // selection (the model's "close the panel" with no panel to close — this screen assigns inline).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A browser or OS shortcut (Ctrl+/, Cmd+/) belongs to the browser or the OS, not to this screen.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (event.key === "Escape") {
        // Esc inside the role picker is the browser dismissing its own dropdown. Taking the row
        // selection away as well would punish the operator for closing a list they opened.
        if (target instanceof HTMLSelectElement) return;
        // Esc pressed with focus outside this screen — the shell's nav, the skip link — belongs to
        // whatever has focus there. Before this handler existed it moved nothing, and a global
        // listener that jumps focus *into* a screen the operator has left is worse than no
        // shortcut. Nothing selected means nothing to clear, and nowhere to put focus back.
        if (!(target instanceof Node) || sectionRef.current?.contains(target) !== true) return;
        if (selectedId === null) return;
        setSelectedId(null);
        // Focus must not be left on a button that is about to disable itself (see `returnFocus`).
        if (!focusIsInGrid()) returnFocus();
        return;
      }
      if (event.key !== "/") return;
      // "/" is a character before it is a shortcut, so it must reach anything the operator is typing
      // into — the search box itself, where it would otherwise eat every slash they type, and the
      // role picker, where it drives the browser's own type-ahead.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
    // Re-subscribed when the selection changes, so the Esc branch reads the current one rather than
    // the first render's. Adding and removing one document listener is cheaper than a mirror ref.
  }, [selectedId]);

  const needle = search.trim().toLowerCase();
  // UI-07: TanStack keeps `data` when a refetch fails. A list the server has since refused — a 401, a 403, a
  // different operator's session — must not stay on screen beside the refusal.
  const listed = users.error ? [] : (users.data?.items ?? []);
  const rows = listed.filter((user: User) => needle === "" || matches(user, needle));
  /**
   * Derived from the *filtered* rows rather than held as an object: a selection the filter has
   * hidden is not a selection the operator can see, and assigning a role to an invisible row is the
   * one mistake this screen must not let them make.
   */
  const selected = rows.find((user: User) => user.id === selectedId) ?? null;

  // Every cell reads a field 0B's UserSchema actually carries: id, displayName, email (nullable),
  // kind, createdAt, activeAssignments.
  const columns: Column<User>[] = [
    { key: "email", header: t("admin.users.column.email"), cell: (u) => u.email ?? "" },
    { key: "name", header: t("admin.users.column.name"), cell: (u) => u.displayName },
    {
      key: "roles",
      header: t("admin.users.column.roles"),
      // Through the house formatter, never `String(n)`: the numbering system is `Intl`'s to choose.
      cell: (u) => formatNumber(String(u.activeAssignments), { locale }),
      align: "end",
    },
    {
      key: "status",
      header: t("admin.users.column.status"),
      /*
       * What `activeAssignments` is, not a status 0B never defined. The field is a bare
       * `z.number().int()` in `admin/user.ts` with no description in the OpenAPI document, and 0B's
       * own invite handler creates a member with `activeAssignments: 0` — so reading 0 as "expired
       * out of the tenant", as this task's brief did, labels every freshly invited person expired.
       * spec:108 forbids inventing the vocabulary, and OD-24 is where the real one will come from.
       */
      cell: (u) =>
        t(u.activeAssignments === 0 ? "admin.users.status.noRoles" : "admin.users.status.hasRoles"),
    },
    {
      key: "invitedOn",
      header: t("admin.users.column.invitedOn"),
      cell: (u) => formatTimestamp(u.createdAt, { locale }),
      align: "end",
    },
  ];

  const keyFor = (principalId: string, role: string): string => {
    const held = attempt.current;
    if (held !== null && held.principalId === principalId && held.roleId === role) return held.key;
    const key = crypto.randomUUID();
    attempt.current = { principalId, roleId: role, key };
    return key;
  };

  /** Assigns to the row the operator activated with Enter. Never "the first row". */
  const assign = async (principal: User, role: string) => {
    setFailure(null);
    setBusy(true);
    try {
      await client.send(
        "POST",
        `/v1/companies/${companyId}/role-assignments`,
        { principalId: principal.id, roleId: role },
        RoleAssignmentSchema,
        { idempotencyKey: keyFor(principal.id, role) },
      );
      // Applied: the next click is a new submit, and clearing the selection is what tells the
      // operator so — a second click on an unchanged form would otherwise replay the stored answer.
      attempt.current = null;
      setSelectedId(null);
      setRoleId("");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (cause) {
      if (isAalRefusal(cause)) {
        void navigate({ to: "/mfa" });
        return;
      }
      // UI-12: the server recorded this answer under the key for 24 hours, so a retry after the
      // cause is fixed must not replay it; only an unknown outcome or an in-flight attempt keeps it.
      if (!keepsAttemptKey(cause)) attempt.current = null;
      // A dead token discovered here is surfaced and handed to the owner by the effect above,
      // not acted on from a screen that holds no session.
      setFailure(cause);
    } finally {
      // Focus comes back on both paths, from the effect above: on success the selection clears and
      // the button stays disabled, so it would never come back on its own.
      setBusy(false);
    }
  };

  // A refused list is not an empty list: without this the operator would read "Nothing to show yet."
  // where the truth is that the server said no.
  const cause = failure ?? users.error ?? roles.error;
  const message = cause === null ? null : messageFor(cause, t);
  const companyKnown = companyId !== "";
  /**
   * 0B's list is one page (`ListEnvelope`), and `UserQuery` offers no search term — so the filter
   * above is over this page alone. Saying "No users" or "Nothing to show yet" while a cursor points
   * at another page is the same false statement about the tenant that a pending list was making.
   * No pager is offered, because OD-24 sources none; the screen just stops claiming completeness.
   */
  const morePages = !users.error && (users.data?.next_cursor ?? null) !== null;
  /**
   * A refused list is not an empty one either. `isPending` is false and `data` is undefined once the
   * request has failed, so without this the operator reads "No users" and "Nothing to show yet."
   * beside an alert saying the server refused them — the same false statement about the tenant that
   * a pending list and a paged one were each making.
   */
  const listRefused = users.error !== null;

  return (
    // The ref scopes this screen's `Esc`: a document-level shortcut that jumps focus into a screen
    // the operator has tabbed away from is worse than no shortcut at all.
    <section ref={sectionRef} className="flex flex-col gap-4">
      <h1 className="text-start">{t("admin.users.title")}</h1>
      {/* `role="status"` because this number changes as the operator types in the box below it,
          and a change nobody announces is a change a screen-reader operator never learns about
          (WCAG 2.2 AA 4.1.3, spec:2252). */}
      {/* Nothing is counted when the list never arrived: the alert below says what happened. */}
      {listRefused ? null : (
        <p role="status" className="text-start text-text-muted">
          {users.isPending
            ? t("app.loading")
            : morePages
              ? t("admin.users.countOfPage", { count: rows.length })
              : t("admin.users.count", { count: rows.length })}
        </p>
      )}
      {morePages ? (
        <p className="text-start text-text-muted">{t("admin.users.morePages")}</p>
      ) : null}

      {/* Search sits before the grid and the action controls after it, which is the tab order
          `docs/ui/od-24-users-and-roles.md` records: search → grid → the thing you do to a row. */}
      <TextField
        label={t("admin.users.search")}
        ref={searchRef}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />

      {/* The wrapper exists for the ref: `returnFocus` and the Esc handler need to know whether
          focus is already inside the grid, and `DataGrid` exposes no handle of its own. */}
      <div ref={gridRef}>
        <DataGrid
          caption={t("admin.users.title")}
          columns={columns}
          rows={rows}
          rowKey={(u: User) => u.id}
          /*
           * Neither a pending list nor one page of several is an empty tenant, and "Nothing to show
           * yet." says it is. Both are statements this screen cannot support.
           */
          emptyLabel={
            users.isPending
              ? t("app.loading")
              : listRefused
                ? t("admin.users.listUnavailable")
                : morePages
                  ? t("admin.users.emptyPage")
                  : t("app.empty")
          }
          onActivate={(u: User) => {
            // Captured here, while the operator's own Enter is still the reason focus is where it
            // is: this is the cell the submit must hand focus back to.
            activatedCell.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // A refusal of the previous submit must not sit under a freshly chosen row.
            setFailure(null);
            setSelectedId(u.id);
          }}
        />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {/* Pressing Enter on a row has to show that it did something, and to say so rather than
            only show it — otherwise the one feedback this interaction has is visual (WCAG 2.2 AA
            4.1.3). */}
        <p role="status" className="text-start text-text-muted">
          {selected === null
            ? t("admin.users.selectPrompt")
            : t("admin.users.selected", { name: selected.displayName })}
        </p>
        <Select
          label={t("admin.users.assignRole")}
          value={roleId}
          options={[
            // An empty first option, or the browser shows the first role as chosen while the state
            // holds "" — a disabled button under a role that looks picked.
            { value: "", label: t("admin.users.role.none") },
            ...(roles.data?.items ?? []).map((role: Role) => ({
              value: role.id,
              label: roleLabel(role, locale),
            })),
          ]}
          onChange={(event) => {
            // The refusal that is on screen was about the role that was chosen a moment ago.
            setFailure(null);
            setRoleId(event.currentTarget.value);
          }}
        />
        <Button
          ref={assignRef}
          variant="primary"
          disabled={selected === null || roleId === "" || !companyKnown || busy}
          onClick={() => {
            if (selected !== null && roleId !== "" && companyKnown) void assign(selected, roleId);
          }}
        >
          {t("admin.users.assignRole")}
        </Button>
      </div>

      {companyKnown ? null : (
        <p className="text-start text-text-muted">{t("admin.users.companyUnknown")}</p>
      )}
      {message === null ? null : (
        <p role="alert" className="text-start text-danger">
          {/* One `<bdi>` per segment, exactly as `DataGrid` isolates every cell (spec:2253). The
              server's `detail` names entities, paths and ids, and the reference line is a bare UUID:
              Latin and neutral runs inside an Arabic paragraph, which UAX#9 would otherwise reorder
              against the order they are written in — the reference detaching from the word before it
              is the visible form of that. The separating space sits outside the isolates so it stays
              a separator rather than becoming part of either neighbour. */}
          {message.map((segment, index) => (
            <Fragment key={segment.key}>
              {index === 0 ? null : " "}
              <bdi>{segment.text}</bdi>
            </Fragment>
          ))}
        </p>
      )}
    </section>
  );
}
