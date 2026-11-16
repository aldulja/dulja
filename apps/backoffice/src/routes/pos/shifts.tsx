import { formatMoney, formatTimestamp, type MoneyJson } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField } from "@dulja/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { StaffFailure } from "../../components/staff-failure";
import type { AdminApiOptions } from "../../lib/admin-api";
import { SHIFT_TIME_ZONE, shiftApi, todayIn } from "../../lib/shift-api";
import { retryQuery } from "../../lib/problem";
import { OverShortAmount, ZReportRoute } from "./z-report";
export function ShiftsRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <ShiftRegister key={company.id} api={api} company={company} />}
    </StaffContextPicker>
  );
}
function ShiftRegister({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const client = useMemo(() => shiftApi(api, company.id), [api, company.id]);
  const [branch, setBranch] = useState("");
  // "Today" is the company's date, the one the API filters `opened_at` by — not the browser's UTC day.
  const [from, setFrom] = useState(() => todayIn(SHIFT_TIME_ZONE));
  const [to, setTo] = useState(() => todayIn(SHIFT_TIME_ZONE));
  const [closed, setClosed] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [salesCursor, setSalesCursor] = useState<string | null>(null);
  const [view, setView] = useState("shifts");
  const navigate = useNavigate();
  const router = useRouter();
  /*
   * The open Z-report is the route's, not this component's: `/pos/shifts/$shiftId/z-report` (router.tsx)
   * has no component of its own, so this register stays mounted beside the report — the plan's two-pane
   * default — and its filters survive Esc and the browser's back. `company` records whose register
   * opened the report, because the staff-context picker, not the URL, chooses the company: a report is
   * shown only under the company it was opened from (a link without one is taken as this company's).
   */
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const selected =
    params.shiftId !== undefined && (search.company ?? company.id) === company.id
      ? params.shiftId
      : null;
  const filterRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** Where focus goes back to when Esc closes the report: the row or button that opened it. */
  const restore = useRef<HTMLElement | null>(null);
  /** Whether the open report's history entry was pushed over this register's own entry. */
  const pushed = useRef(false);
  const open = (shiftId: string, origin: HTMLElement | null) => {
    restore.current = origin;
    if (shiftId === selected) return;
    // A report opened over another (or over another company's report address) replaces it, so the
    // entry under an open report is always the register's, and closing it is one step back however
    // many drawers the manager went through.
    const atReport = params.shiftId !== undefined;
    if (!atReport) pushed.current = true;
    void navigate({
      to: "/pos/shifts/$shiftId/z-report",
      params: { shiftId },
      search: { company: company.id },
      replace: atReport,
    });
  };
  const close = () => {
    if (selected === null) return;
    // Closing pops the entry opening pushed, so Esc and the browser's back are the same step and an
    // Enter/Esc scan of twenty drawers leaves no history behind — pushing the register again would make
    // back reopen the report just closed. A report reached by a link has no register entry beneath it,
    // so there the register replaces the report rather than back leaving the screen.
    if (pushed.current) {
      pushed.current = false;
      router.history.back();
    } else void navigate({ to: "/pos/shifts", replace: true });
  };
  // The OD-24 default keyboard model, as the sibling staff screens apply it: "/" focuses the filter
  // from anywhere on the screen, Esc closes the open report and returns to the list. There is no
  // Ctrl+S and no Ctrl+N because nothing on this screen writes (amendment A12).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A browser or OS shortcut (Ctrl+/, Cmd+/) belongs to the browser or the OS, not to this screen.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (event.key === "Escape") {
        // Esc on an open dropdown is the browser closing its own list; Esc with focus in the shell's
        // nav belongs to the nav. Nothing open means nothing to close.
        if (selected === null || target instanceof HTMLSelectElement) return;
        if (
          target !== document.body &&
          !(target instanceof Node && sectionRef.current?.contains(target) === true)
        )
          return;
        event.preventDefault();
        close();
        queueMicrotask(() => {
          if (restore.current?.isConnected) restore.current.focus();
        });
        return;
      }
      if (event.key !== "/") return;
      // "/" is a character before it is a shortcut: a date being typed, or a list's type-ahead, keeps it.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      event.preventDefault();
      filterRef.current?.querySelector("select")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const filters = {
    ...(branch ? { "filter[branchId][eq]": branch } : {}),
    ...(from ? { "filter[openedAt][gte]": from } : {}),
    ...(to ? { "filter[openedAt][lte]": to } : {}),
    ...(closed ? { "filter[closedAt][eq]": closed } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const shifts = useQuery({
    queryKey: ["shifts", company.id, filters],
    queryFn: ({ signal }) => client.shifts(filters, { signal }),
    retry: retryQuery,
  });
  const sales = useQuery({
    queryKey: ["cashier-sales", company.id, branch, from, to, salesCursor],
    queryFn: ({ signal }) =>
      client.sales(
        {
          from,
          to,
          ...(branch ? { branchId: branch } : {}),
          ...(salesCursor ? { cursor: salesCursor } : {}),
        },
        { signal },
      ),
    enabled: view === "sales" && !!from && !!to,
    retry: retryQuery,
  });
  const reset = () => {
    setCursor(null);
    setSalesCursor(null);
    close();
  };
  const money = (m: MoneyJson | null) => (m === null ? "—" : formatMoney(m, { locale }));
  // An open shift shows an em dash, never a zero: "not counted yet" and "counted at nothing" are
  // different facts, and a manager scanning the register must be able to tell them apart.
  const time = (v: string | null) =>
    v === null ? "—" : formatTimestamp(v, { locale, timeZone: SHIFT_TIME_ZONE });
  return (
    <section ref={sectionRef} className="flex flex-col gap-4">
      <h1>{t("shift.title")}</h1>
      <div ref={filterRef} data-print="hide" className="flex flex-wrap gap-3">
        <Select
          label={t("staff.branch")}
          value={branch}
          options={[
            { value: "", label: t("shift.all") },
            ...company.branches.map((b) => ({
              value: b.id,
              label: locale === "ar" ? (b.nameAr ?? b.nameEn) : b.nameEn,
            })),
          ]}
          onChange={(e) => {
            setBranch(e.currentTarget.value);
            reset();
          }}
        />
        <TextField
          type="date"
          label={t("shift.from")}
          value={from}
          onChange={(e) => {
            setFrom(e.currentTarget.value);
            reset();
          }}
        />
        <TextField
          type="date"
          label={t("shift.to")}
          value={to}
          onChange={(e) => {
            setTo(e.currentTarget.value);
            reset();
          }}
        />
        <Select
          label={t("shift.state")}
          value={closed}
          options={[
            { value: "", label: t("shift.all") },
            { value: "null", label: t("shift.open") },
            { value: "not_null", label: t("shift.closed") },
          ]}
          onChange={(e) => {
            setClosed(e.currentTarget.value);
            reset();
          }}
        />
        <Select
          label={t("shift.view")}
          value={view}
          options={[
            { value: "shifts", label: t("shift.title") },
            { value: "sales", label: t("shift.sales") },
          ]}
          onChange={(e) => {
            setView(e.currentTarget.value);
            reset();
          }}
        />
      </div>
      {view === "shifts" ? (
        <>
          <div data-print="hide">
            {shifts.isPending ? (
              <p>{t("app.loading")}</p>
            ) : shifts.error ? (
              <StaffFailure cause={shifts.error} />
            ) : (
              <>
                <DataGrid
                  caption={t("shift.title")}
                  emptyLabel={t("app.empty")}
                  rows={shifts.data?.items ?? []}
                  rowKey={(r) => r.shiftId}
                  onActivate={(r) => open(r.shiftId, document.activeElement as HTMLElement)}
                  columns={[
                    {
                      key: "terminal",
                      header: t("shift.terminal"),
                      cell: (r) => (
                        <Button onClick={(event) => open(r.shiftId, event.currentTarget)}>
                          {r.terminalCode}
                        </Button>
                      ),
                    },
                    { key: "opened", header: t("shift.opened"), cell: (r) => time(r.openedAt) },
                    { key: "closed", header: t("shift.closedAt"), cell: (r) => time(r.closedAt) },
                    {
                      key: "cashier",
                      header: t("shift.cashier"),
                      cell: (r) => r.openedPrincipalId,
                    },
                    {
                      key: "counted",
                      header: t("shift.counted"),
                      align: "end",
                      cell: (r) => money(r.countedCash),
                    },
                    {
                      key: "difference",
                      header: t("shift.difference"),
                      align: "end",
                      cell: (r) => <OverShortAmount value={r.overShort} />,
                    },
                  ]}
                />
                {shifts.data?.next_cursor && (
                  <Button
                    onClick={() => {
                      setCursor(shifts.data!.next_cursor);
                      close();
                    }}
                  >
                    {t("shift.next")}
                  </Button>
                )}
              </>
            )}
          </div>
          {selected && (
            <ZReportRoute key={selected} api={api} companyId={company.id} shiftId={selected} />
          )}
        </>
      ) : !from || !to ? (
        <p>{t("shift.chooseDates")}</p>
      ) : sales.error ? (
        <StaffFailure cause={sales.error} />
      ) : sales.isPending ? (
        <p>{t("app.loading")}</p>
      ) : (
        <>
          <DataGrid
            caption={t("shift.sales")}
            emptyLabel={t("app.empty")}
            rows={sales.data?.items ?? []}
            rowKey={(r) => `${r.cashierPrincipalId}:${r.branchId}`}
            columns={[
              { key: "cashier", header: t("shift.cashier"), cell: (r) => r.cashierName },
              {
                key: "branch",
                header: t("staff.branch"),
                cell: (r) =>
                  (locale === "ar"
                    ? (company.branches.find((b) => b.id === r.branchId)?.nameAr ??
                      company.branches.find((b) => b.id === r.branchId)?.nameEn)
                    : company.branches.find((b) => b.id === r.branchId)?.nameEn) ?? r.branchId,
              },
              {
                key: "tickets",
                header: t("shift.tickets"),
                align: "end",
                cell: (r) => r.ticketCount,
              },
              {
                key: "sales",
                header: t("shift.net"),
                align: "end",
                cell: (r) => money(r.netSales),
              },
              {
                key: "discount",
                header: t("pos.discount"),
                align: "end",
                cell: (r) => money(r.discount),
              },
              {
                key: "rounding",
                header: t("pos.rounding"),
                align: "end",
                cell: (r) => money(r.cashRounding),
              },
              {
                key: "short",
                header: t("shift.difference"),
                align: "end",
                cell: (r) => <OverShortAmount value={r.overShort} />,
              },
            ]}
          />
          {sales.data?.next_cursor && (
            <Button onClick={() => setSalesCursor(sales.data!.next_cursor)}>
              {t("shift.next")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
