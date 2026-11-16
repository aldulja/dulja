import { isLocale, LOCALES } from "@dulja/i18n";
import { Button, Select } from "@dulja/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n-provider";
import { TokenPersistenceAlert, useOptionalSession } from "../lib/session";

/**
 * The name Tasks 6 and 8 consume. It is `useI18n`: the shell no longer owns translation, so a route
 * rendered inside `<I18nProvider>` but outside `<AppShell>` — Task 6's unauthenticated login screen —
 * reads the same value from the same hook, without inheriting a header and a nav link.
 */
export const useShell = useI18n;

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <Select
      label={t("app.language")}
      value={locale}
      options={LOCALES.map((code) => ({ value: code, label: t(`app.endonym.${code}`) }))}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (isLocale(next)) setLocale(next);
      }}
    />
  );
}

/**
 * UI-04: the operator's way out. On a shared workstation the refresh token outlives the window, so without
 * this the next person to open the back office works as the last one. It ends this device's session only
 * (`SessionValue.signOut`), clears the query cache, and lands on `/login` whether or not the sign-out call
 * reached Supabase — a stranded screen is never the answer. Rendered only inside a session provider.
 */
function SignOutButton() {
  const session = useOptionalSession();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (session === null) return null;
  return (
    <Button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void session
          .signOut()
          .catch(() => {})
          .finally(() => void navigate({ to: "/login" }));
      }}
    >
      {t("app.signOut")}
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const mainRef = useRef<HTMLElement>(null);
  const session = useOptionalSession();
  const navigate = useNavigate();
  const status = session?.status;
  /*
   * UI-21: when Supabase ends the session locally — a refresh token revoked or expired, a sign-out in another
   * window — every query here is disabled for want of a token and the screen would say "Loading…" for ever.
   * The shell is only for a signed-in operator, so an anonymous one belongs on `/login`.
   */
  useEffect(() => {
    if (status === "anonymous") void navigate({ to: "/login" });
  }, [status, navigate]);

  return (
    <>
      {/*
        `tabIndex={-1}` on <main> is what lets the fragment jump land focus there rather than leaving
        it on the link; the explicit `focus()` is because following a same-page fragment moves focus
        only inconsistently across engines (and not at all in jsdom), and a skip link that moves the
        viewport without moving the caret is worse than none. `preventDefault` is deliberately not
        called, so the hash still changes.
      */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only"
        onClick={() => mainRef.current?.focus()}
      >
        {t("app.skipToContent")}
      </a>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-bold">{t("app.name")}</span>
        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          <SignOutButton />
        </div>
      </header>
      <div className="flex">
        <nav
          aria-label={t("app.nav.users")}
          className="flex flex-col gap-3 border-e border-border p-4"
        >
          {/*
            `Link`, not `<a href>`: an anchor is a full document navigation, which reloads the
            renderer and throws away the JS heap. Where the OS keyring refused to store the refresh
            token, that heap is the only copy of the session there is (Task 6), so a plain anchor
            would sign the operator out on the first click they make.
          */}
          <Link to="/admin/users" className="text-start text-accent">
            {t("app.nav.users")}
          </Link>
          <Link to="/accounting/tax-returns" className="text-start text-accent">
            {t("app.nav.taxReturns")}
          </Link>
          <Link to="/reports" className="text-start text-accent">
            {t("app.nav.reports")}
          </Link>
          <Link to="/admin/exports" className="text-start text-accent">
            {t("app.nav.exports")}
          </Link>
          <Link to="/pos/branch-limits" className="text-start text-accent">
            {t("app.nav.branchLimits")}
          </Link>
          <Link to="/hr/employees" className="text-start text-accent">
            {t("app.nav.staff")}
          </Link>
          <Link to="/hr/pay-components" className="text-start text-accent">
            {t("app.nav.payComponents")}
          </Link>
          <Link to="/hr/statutory-tables" className="text-start text-accent">
            {t("app.nav.statutoryTables")}
          </Link>
          <Link to="/hr/settings" className="text-start text-accent">
            {t("app.nav.hrSettings")}
          </Link>
          <Link to="/hr/payroll-runs" className="text-start text-accent">
            {t("app.nav.payrollRuns")}
          </Link>
          <Link to="/hr/leave" className="text-start text-accent">
            {t("app.nav.leave")}
          </Link>
          <Link to="/hr/permit-expiry" className="text-start text-accent">
            {t("app.nav.permitExpiry")}
          </Link>
          <Link to="/reports" search={{ module: "hr" }} className="text-start text-accent">
            {t("app.nav.hrReports")}
          </Link>
          <Link to="/pos/shifts" className="text-start text-accent">
            {t("shift.title")}
          </Link>
          <Link to="/pos/cashiers" className="text-start text-accent">
            {t("app.nav.cashiers")}
          </Link>
        </nav>
        <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 p-4">
          {/* On screen wherever the operator is, not only on the login screen they have left. */}
          <TokenPersistenceAlert />
          {children}
        </main>
      </div>
    </>
  );
}
