import type { z } from "zod";
import type { PermitExpiryList } from "@dulja/contracts/hr/permit-expiry";
import { formatDate } from "@dulja/i18n";
import { DataGrid, TextField, type Column } from "@dulja/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { isForbidden } from "../../features/hr/shared";
import { Checkbox, ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { hrApi } from "../../lib/hr-api";
import { retryQuery } from "../../lib/problem";

type Row = z.infer<typeof PermitExpiryList>["items"][number];

/** The route's default window (8D T3's `PermitExpiryQuery`). */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650;

/**
 * 8D Task 10 — the permit half of spec:2091's "contract and permit expiry list" (⚠️ OD-24, the owner-authorized
 * default baseline of 2026-11-07; `docs/ui/od-24-phase-8d.md`), over 8D T3's
 * `GET …/employees/permit-expiry`. The permit date is a sensitive field, decrypted by the server only for a holder
 * of `hr.employee.read_sensitive`; a refusal is a sentence, never an empty list that looks like "no permits lapse".
 * The CONTRACT half is the `hr.contract_expiry` report, reached from the HR reports list.
 */
export function PermitExpiryRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <PermitExpiry api={api} company={company} />}
    </StaffContextPicker>
  );
}

function PermitExpiry({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const client = useMemo(() => hrApi(api, company.id), [api, company.id]);
  const [typed, setTyped] = useState(String(DEFAULT_DAYS));
  const [includeTerminated, setIncludeTerminated] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  // A window the route would refuse is not sent: the list keeps the last valid one and the field says why.
  const valid = /^\d{1,4}$/.test(typed) && Number.parseInt(typed, 10) <= MAX_DAYS;
  const [withinDays, setWithinDays] = useState(DEFAULT_DAYS);
  useEffect(() => {
    if (valid) setWithinDays(Number.parseInt(typed, 10));
  }, [typed, valid]);
  const list = useQuery({
    queryKey: ["permit-expiry", company.id, withinDays, includeTerminated],
    queryFn: ({ signal }) => client.permitExpiry({ withinDays, includeTerminated }, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(list.error);
  const columns: Column<Row>[] = [
    {
      key: "employee",
      header: t("permit.employee"),
      cell: (row) => <bdi>{row.employeeNumber}</bdi>,
    },
    { key: "name", header: t("permit.name"), cell: (row) => <bdi>{row.employeeNameEn}</bdi> },
    { key: "branch", header: t("permit.branch"), cell: (row) => <bdi>{row.branchCode}</bdi> },
    {
      key: "position",
      header: t("permit.position"),
      cell: (row) => (row.position === null ? "" : <bdi>{row.position}</bdi>),
    },
    {
      key: "expiry",
      header: t("permit.expiry"),
      cell: (row) => <bdi>{formatDate(row.workPermitExpiry, { locale })}</bdi>,
    },
    {
      key: "remaining",
      header: t("permit.remaining"),
      align: "end",
      cell: (row) =>
        row.daysRemaining < 0 ? (
          <strong className="text-danger">
            {t("permit.lapsed", { days: String(-row.daysRemaining) })}
          </strong>
        ) : (
          <bdi>{t("permit.days", { days: String(row.daysRemaining) })}</bdi>
        ),
    },
  ];
  return (
    <section className="flex flex-col gap-4" aria-label={t("permit.title")}>
      <h1 className="text-start text-xl font-bold">{t("permit.title")}</h1>
      <p className="text-start text-text-muted">{t("permit.intro")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          ref={first}
          label={t("permit.within")}
          inputMode="numeric"
          dir="ltr"
          value={typed}
          {...(valid ? {} : { error: t("permit.withinInvalid") })}
          onChange={(event) => setTyped(event.currentTarget.value.trim())}
        />
        <Checkbox
          label={t("permit.includeTerminated")}
          checked={includeTerminated}
          onChange={setIncludeTerminated}
        />
      </div>
      {list.error ? (
        isForbidden(list.error) ? (
          <p role="status">{t("permit.denied")}</p>
        ) : (
          <ProblemAlert error={list.error} />
        )
      ) : null}
      {list.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {list.data ? (
        <DataGrid
          caption={t("permit.list")}
          columns={columns}
          rows={list.data.items}
          rowKey={(row) => row.employeeId}
          emptyLabel={t("permit.none", { days: String(withinDays) })}
        />
      ) : null}
    </section>
  );
}
