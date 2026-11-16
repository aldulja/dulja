import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
  type RouterHistory,
} from "@tanstack/react-router";
import { Fragment, useMemo } from "react";
import { AppShell } from "./components/app-shell";
import { I18nProvider, useI18n } from "./lib/i18n-provider";
import { useApiOptions, useCompanyId, useSession } from "./lib/session";
import { TaxReturnsRoute } from "./routes/accounting/tax-returns";
import { ReportsRoute } from "./routes/reports/index";
import { ReportRunRoute } from "./routes/reports/$code";
import { ReportDesignRoute } from "./routes/reports/$code.design";
import { ExportsRoute } from "./routes/admin/exports";
import { UsersRoute } from "./routes/admin/users";
import { BranchLimitsRoute } from "./routes/pos/branch-limits";
import { CashiersRoute } from "./routes/pos/cashiers";
import { ShiftsRoute } from "./routes/pos/shifts";
import { EmployeesRoute } from "./routes/hr/employees";
import { EmployeeRecordRoute } from "./routes/hr/employee-record";
import { HrSettingsRoute } from "./routes/hr/hr-settings";
import { PayrollRunRoute } from "./routes/hr/payroll-run";
import { PayrollRunsRoute } from "./routes/hr/payroll-runs";
import { PayComponentsRoute } from "./routes/hr/pay-components";
import { StatutoryTablesRoute } from "./routes/hr/statutory-tables";
import { LeaveRoute } from "./routes/hr/leave";
import { PermitExpiryRoute } from "./routes/hr/permit-expiry";
import { LoginRoute } from "./routes/login";
import { MfaEnrolRoute } from "./routes/mfa-enrol";

/**
 * The guards ask the Supabase client, not React state: `beforeLoad` is asynchronous, so it can wait
 * for the real answer instead of racing the provider's first `getSession()`.
 */
export interface RouterContext {
  supabase: SupabaseClient;
}

/**
 * `I18nProvider` sits outside `AppShell`, not inside it: translation and direction are available to
 * every route, while the chrome is a choice each route makes.
 */
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <I18nProvider>
      <Outlet />
    </I18nProvider>
  ),
});

const hasSession = async (context: RouterContext): Promise<boolean> => {
  try {
    const { data } = await context.supabase.auth.getSession();
    return data.session !== null;
  } catch {
    // Least privilege: a session we could not read is not a session we may assume.
    return false;
  }
};

/**
 * Any assurance level reaches the chrome — **not** `aal2`. `/mfa` lives under this layout and the
 * operator who needs it has exactly `aal1`, which is the level §4.2.3 admits there. Screens that
 * need more say so themselves, below.
 */
const requireSession = async ({ context }: { context: RouterContext }): Promise<void> => {
  if (await hasSession(context)) return;
  throw redirect({ to: "/login" });
};

/**
 * The `aal2` gate, mirrored on the client so the operator is sent somewhere useful rather than
 * meeting `ERR_AUTH_AAL_INSUFFICIENT` on every request the screen makes. The API remains the
 * authority; this only decides which screen to show. The *level* is checked, never mere presence.
 */
const requireEnrolledFactor = async ({ context }: { context: RouterContext }): Promise<void> => {
  try {
    const { data } = await context.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel === "aal2") return;
  } catch {
    // Unknown is not `aal2`.
  }
  throw redirect({ to: "/mfa" });
};

/**
 * The chrome, as a pathless layout route rather than part of the root: `/login` is reached by
 * someone who has not signed in, and `shell.test.tsx`'s "no shell chrome" case pins that they must
 * not be shown a header and a "Users and roles" link. `/mfa` is the other way round — its visitor
 * *has* signed in, at `aal1`, so it keeps the chrome.
 *
 * Keeping the shell and the session guard here rather than inside `UsersRoute`'s own component
 * leaves that component free for Task 8 to replace wholesale.
 */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: requireSession,
  component: () => (
    <AppShell>
      <PrincipalOutlet />
    </AppShell>
  ),
});

/**
 * UI-01/UI-07: every screen is keyed on the signed-in principal, never on the access token. Supabase
 * refreshes the token about hourly; a key on it remounted the open screen, wiping typed input and the
 * idempotency keys of attempts in flight. A different principal does remount, so no form, attempt key or
 * draft built for one user survives into another's session.
 */
function PrincipalOutlet() {
  const { principal } = useSession();
  return (
    <Fragment key={principal ?? ""}>
      <Outlet />
    </Fragment>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});
export const mfaRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/mfa",
  component: MfaEnrolRoute,
});
/**
 * The screen takes its API options as a prop so a test can drive it without a network; this is the
 * one place that fills them from the live session. `useApiOptions` keeps the object referentially
 * stable — across token refreshes too (UI-01) — because `UsersRoute` builds its client from it: a fresh
 * object every render would rebuild the client on every keystroke in the search box.
 */
function UsersScreen() {
  const api = useApiOptions();
  const companyId = useCompanyId();
  return <UsersRoute api={api} companyId={companyId} />;
}

function TaxReturnsScreen() {
  const api = useApiOptions();
  const companyId = useCompanyId();
  return <TaxReturnsRoute api={api} companyId={companyId} />;
}
export const taxReturnsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/accounting/tax-returns",
  beforeLoad: requireEnrolledFactor,
  component: TaxReturnsScreen,
});
/**
 * 7A Task 15 — the report list, run screen and designer. The company is the one `useCompanyId` resolves, as the
 * tax-return screen's is. A run or a design is of one definition ROW, so the row travels in the search string
 * (`?definition=`); without one the screens take the code's highest live version, the row a run defaults to.
 */
const definitionSearch = (search: Record<string, unknown>): { definition?: string } =>
  typeof search["definition"] === "string" ? { definition: search["definition"] } : {};
/**
 * 8D T10 — a run screen opened from another screen may fill parameters in (`?parameters=`, e.g. the payroll run
 * screen's register link). Only string values survive; the run screen keeps only the names its definition declares.
 */
const runSearch = (
  search: Record<string, unknown>,
): { definition?: string; parameters?: Record<string, string> } => {
  const raw = search["parameters"];
  const parameters =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return {
    ...definitionSearch(search),
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  };
};
/** 8D T10 — the list narrowed to one module (`?module=hr`, the HR reports entry). */
const listSearch = (search: Record<string, unknown>): { module?: string } =>
  typeof search["module"] === "string" ? { module: search["module"] } : {};
const useReportApiOptions = useApiOptions;
function useReportNavigation() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      list: () => void navigate({ to: "/reports" }),
      run: (code: string, definition: string) =>
        void navigate({ to: "/reports/$code", params: { code }, search: { definition } }),
      design: (code: string, definition: string) =>
        void navigate({ to: "/reports/$code/design", params: { code }, search: { definition } }),
    }),
    [navigate],
  );
}
function ReportsScreen() {
  const api = useReportApiOptions();
  const companyId = useCompanyId();
  const navigation = useReportNavigation();
  const { module } = reportsRoute.useSearch();
  return (
    <ReportsRoute api={api} companyId={companyId} navigation={navigation} module={module ?? null} />
  );
}
function ReportRunScreen() {
  const api = useReportApiOptions();
  const companyId = useCompanyId();
  const navigation = useReportNavigation();
  const { code } = reportRunRoute.useParams();
  const { definition, parameters } = reportRunRoute.useSearch();
  return (
    <ReportRunRoute
      api={api}
      companyId={companyId}
      code={code}
      definitionId={definition ?? null}
      preset={parameters ?? null}
      onBack={navigation.list}
      onDesign={navigation.design}
      onSelect={navigation.run}
    />
  );
}
function ReportDesignScreen() {
  const api = useReportApiOptions();
  const companyId = useCompanyId();
  const navigation = useReportNavigation();
  const { code } = reportDesignRoute.useParams();
  const { definition } = reportDesignRoute.useSearch();
  return (
    <ReportDesignRoute
      api={api}
      companyId={companyId}
      code={code}
      definitionId={definition ?? null}
      onBack={navigation.list}
      onOpen={navigation.design}
      onRun={navigation.run}
    />
  );
}
export const reportsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/reports",
  beforeLoad: requireEnrolledFactor,
  validateSearch: listSearch,
  component: ReportsScreen,
});
export const reportRunRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/reports/$code",
  beforeLoad: requireEnrolledFactor,
  validateSearch: runSearch,
  component: ReportRunScreen,
});
export const reportDesignRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/reports/$code/design",
  beforeLoad: requireEnrolledFactor,
  validateSearch: definitionSearch,
  component: ReportDesignScreen,
});
/** 7C Task 13 — the tenant data export, against the company `useCompanyId` resolves (as the report screens). */
function ExportsScreen() {
  const api = useReportApiOptions();
  const companyId = useCompanyId();
  return <ExportsRoute api={api} companyId={companyId} />;
}
export const exportsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin/exports",
  beforeLoad: requireEnrolledFactor,
  component: ExportsScreen,
});
export const usersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin/users",
  beforeLoad: requireEnrolledFactor,
  component: UsersScreen,
});
function BranchLimitsScreen() {
  return <BranchLimitsRoute api={useApiOptions()} />;
}
function EmployeesScreen() {
  return <EmployeesRoute api={useApiOptions()} />;
}
function CashiersScreen() {
  return <CashiersRoute api={useApiOptions()} />;
}
function ShiftsScreen() {
  return <ShiftsRoute api={useApiOptions()} />;
}
export const shiftsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/pos/shifts",
  beforeLoad: requireEnrolledFactor,
  component: ShiftsScreen,
});
/**
 * A shift's Z-report has an address (6D Task 12), so it can be linked to and the browser's back closes
 * it. The route has no component: the register above stays mounted and renders the report beside its
 * list, the plan's two-pane default, which keeps the register's filters across Esc and back. `company`
 * names the company whose register opened the report, because the staff-context picker chooses the
 * company and the path does not carry one.
 */
export const shiftZReportRoute = createRoute({
  getParentRoute: () => shiftsRoute,
  path: "$shiftId/z-report",
  validateSearch: (search: Record<string, unknown>): { company?: string } =>
    typeof search["company"] === "string" ? { company: search["company"] } : {},
});
export const employeesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/employees",
  beforeLoad: requireEnrolledFactor,
  component: EmployeesScreen,
});
/**
 * 8A Task 13 — the HR screens (⚠️ OD-24, built on the owner-authorized default baseline of 2026-11-07;
 * `docs/ui/od-24-phase-8a.md`). The employee's HR record has an address; `company` names the company whose
 * directory opened it, because the staff-context picker chooses the company and the path does not carry one.
 */
const useHrApiOptions = useApiOptions;
function EmployeeRecordScreen() {
  const api = useHrApiOptions();
  const { employeeId } = employeeRecordRoute.useParams();
  const { company } = employeeRecordRoute.useSearch();
  return (
    <EmployeeRecordRoute key={employeeId} api={api} companyId={company} employeeId={employeeId} />
  );
}
function PayComponentsScreen() {
  const api = useHrApiOptions();
  return <PayComponentsRoute api={api} />;
}
function StatutoryTablesScreen() {
  const api = useHrApiOptions();
  return <StatutoryTablesRoute api={api} />;
}
function HrSettingsScreen() {
  const api = useHrApiOptions();
  return <HrSettingsRoute api={api} />;
}
/**
 * 8B Task 15 — the payroll run register and one run's approval screen (⚠️ OD-24, the owner-authorized default
 * baseline of 2026-11-07; `docs/ui/od-24-phase-8b.md`). A run has an address; `company` names the company whose
 * register opened it, as the employee record's does.
 */
function PayrollRunsScreen() {
  const api = useHrApiOptions();
  return <PayrollRunsRoute api={api} />;
}
function PayrollRunScreen() {
  const api = useHrApiOptions();
  const { documentId } = payrollRunRoute.useParams();
  const { company } = payrollRunRoute.useSearch();
  return <PayrollRunRoute key={documentId} api={api} companyId={company} documentId={documentId} />;
}
/**
 * 8D Task 10 — the leave register (⚠️ OD-13 and OD-24, both answered build on 2026-11-07) and the permit-expiry
 * list (8D T3's route), on the plans' default baseline; `docs/ui/od-24-phase-8d.md`.
 */
function LeaveScreen() {
  const api = useHrApiOptions();
  return <LeaveRoute api={api} />;
}
function PermitExpiryScreen() {
  const api = useHrApiOptions();
  return <PermitExpiryRoute api={api} />;
}
export const leaveRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/leave",
  beforeLoad: requireEnrolledFactor,
  component: LeaveScreen,
});
export const permitExpiryRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/permit-expiry",
  beforeLoad: requireEnrolledFactor,
  component: PermitExpiryScreen,
});
export const payrollRunsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/payroll-runs",
  beforeLoad: requireEnrolledFactor,
  component: PayrollRunsScreen,
});
export const payrollRunRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/payroll-runs/$documentId",
  beforeLoad: requireEnrolledFactor,
  validateSearch: (search: Record<string, unknown>): { company?: string } =>
    typeof search["company"] === "string" ? { company: search["company"] } : {},
  component: PayrollRunScreen,
});
export const employeeRecordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/employees/$employeeId",
  beforeLoad: requireEnrolledFactor,
  validateSearch: (search: Record<string, unknown>): { company?: string } =>
    typeof search["company"] === "string" ? { company: search["company"] } : {},
  component: EmployeeRecordScreen,
});
export const payComponentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/pay-components",
  beforeLoad: requireEnrolledFactor,
  component: PayComponentsScreen,
});
export const statutoryTablesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/statutory-tables",
  beforeLoad: requireEnrolledFactor,
  component: StatutoryTablesScreen,
});
export const hrSettingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/hr/settings",
  beforeLoad: requireEnrolledFactor,
  component: HrSettingsScreen,
});
export const cashiersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/pos/cashiers",
  beforeLoad: requireEnrolledFactor,
  component: CashiersScreen,
});
export const branchLimitsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/pos/branch-limits",
  beforeLoad: requireEnrolledFactor,
  component: BranchLimitsScreen,
});
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    // Sending everyone to `/admin/users` would bounce an anonymous visitor through the guard and
    // out to `/login`, which works but loads the shell first. Asking once here is the same question
    // one step earlier.
    throw redirect({ to: (await hasSession(context)) ? "/admin/users" : "/login" });
  },
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  shellRoute.addChildren([
    mfaRoute,
    usersRoute,
    taxReturnsRoute,
    reportsRoute,
    reportRunRoute,
    reportDesignRoute,
    exportsRoute,
    branchLimitsRoute,
    employeesRoute,
    employeeRecordRoute,
    payComponentsRoute,
    statutoryTablesRoute,
    hrSettingsRoute,
    payrollRunsRoute,
    payrollRunRoute,
    leaveRoute,
    permitExpiryRoute,
    cashiersRoute,
    shiftsRoute.addChildren([shiftZReportRoute]),
  ]),
]);

/**
 * Every guard is asynchronous, so on a cold boot the root route commits with an empty `Outlet` while
 * `getSession()` is in flight. Without this the operator's first sight of the app is a blank
 * document. It renders inside the root's `I18nProvider`, so it can speak their language.
 */
function RoutePending() {
  const { t } = useI18n();
  return <p className="p-4 text-start text-text-muted">{t("app.loading")}</p>;
}

/**
 * A factory, not a module-level `router`: the guards need the Supabase client, which is built once
 * at the composition root (`main.tsx`). `history` is a test seam — a memory history lets a unit
 * test drive the real tree without a browser URL.
 */
export function createAppRouter(supabase: SupabaseClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { supabase },
    defaultPendingComponent: RoutePending,
    // TanStack waits a full second before showing a pending component, which is most of the blank
    // window this is here to close. 150ms is short enough to cover a real wait and long enough that
    // a guard answering immediately does not flash.
    defaultPendingMs: 150,
    // `exactOptionalPropertyTypes` rejects an explicit `history: undefined`.
    ...(history === undefined ? {} : { history }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
