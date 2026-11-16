import { formatMoney, formatTimestamp, type MoneyJson, type TranslationKey } from "@dulja/i18n";
import { Button, DataGrid } from "@dulja/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useShell } from "../../components/app-shell";
import { StaffFailure } from "../../components/staff-failure";
import type { AdminApiOptions } from "../../lib/admin-api";
import { overShortTone, SHIFT_TIME_ZONE, shiftApi } from "../../lib/shift-api";
import { retryQuery } from "../../lib/problem";
/**
 * The cash-control section's document types: every non-sale document that moves `1110` on a shift — the
 * over/short and OD-10's three till cash documents (ADR 0064). A banking from the safe never touches
 * `1110`, so it is not in this section. A type with no label here prints its code rather than nothing.
 */
const CASH_CONTROL_LABEL: Readonly<Partial<Record<string, TranslationKey>>> = {
  TILL_OVER_SHORT: "documentType.TILL_OVER_SHORT",
  TILL_PAID_OUT: "documentType.TILL_PAID_OUT",
  TILL_SAFE_DROP: "documentType.TILL_SAFE_DROP",
  TILL_BANKING: "documentType.TILL_BANKING",
};
/** The Z-report's per-kind till-event counts arrive as plain strings (`ZReportSchema.tillEvents`). */
const TILL_EVENT_LABEL: Readonly<Partial<Record<string, TranslationKey>>> = {
  no_sale: "shift.no_sale",
  drawer_open: "shift.drawer_open",
  void: "shift.void",
};
/**
 * The over/short figure, and the only coloured element on either shift screen: red for short, green
 * for over (6D Task 12's default layout). `data-tone` is what the component tests assert, so the
 * palette can change without breaking them. The register and the report both render through this one
 * component, so the two cannot disagree about which drawer is short.
 */
export function OverShortAmount({ value }: { value: MoneyJson | null }) {
  const { locale } = useShell();
  const tone = overShortTone(value);
  return (
    <span
      data-tone={tone}
      className={tone === "short" ? "text-danger" : tone === "over" ? "text-success" : undefined}
    >
      {value === null ? "—" : formatMoney(value, { locale })}
    </span>
  );
}
/**
 * The Z-report, print-first: a single 80 mm column that reads the same on a receipt printer and in a
 * browser, because the operator's job with a Z-report is to sign it and file it. Everything a signed
 * paper report needs — the over/short's document, the till-event counts — sits outside
 * `data-print="hide"`.
 *
 * Money goes through `formatMoney` and times through `formatTimestamp` (spec:2041, spec:2039): the
 * currency's display rounding and the company's time zone, not the viewer's browser.
 */
export function ZReportRoute({
  api,
  companyId,
  shiftId,
}: {
  api: AdminApiOptions;
  companyId: string;
  shiftId: string;
}) {
  const { t, locale } = useShell();
  const client = useMemo(() => shiftApi(api, companyId), [api, companyId]);
  const [cursor, setCursor] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ["z-report", companyId, shiftId],
    queryFn: ({ signal }) => client.zReport(shiftId, { signal }),
    retry: retryQuery,
  });
  const events = useQuery({
    queryKey: ["till-events", companyId, shiftId, cursor],
    queryFn: ({ signal }) => client.events(shiftId, cursor, { signal }),
    retry: retryQuery,
  });
  if (report.isPending) return <p>{t("app.loading")}</p>;
  if (report.error) return <StaffFailure cause={report.error} />;
  const z = report.data?.items[0];
  if (!z) return <p>{t("app.empty")}</p>;
  const money = (m: MoneyJson | null) => (m === null ? "—" : formatMoney(m, { locale }));
  const time = (value: string) => formatTimestamp(value, { locale, timeZone: SHIFT_TIME_ZONE });
  const label = (labels: typeof CASH_CONTROL_LABEL, code: string) => {
    const key = labels[code];
    return key === undefined ? code : t(key);
  };
  return (
    <article
      aria-label={t("shift.zReport")}
      data-z-report=""
      className="mx-auto flex w-[80mm] max-w-full flex-col gap-4 print:w-full"
    >
      <header>
        <h2>{t("shift.zReport")}</h2>
        {/* Each part isolated, or a right-to-left paragraph reorders the code and the two times. */}
        <p>
          <bdi>{z.terminalCode}</bdi> · <bdi>{time(z.openedAt)}</bdi> ·{" "}
          <bdi>{z.closedAt ? time(z.closedAt) : t("shift.open")}</bdi>
        </p>
        <p>
          {t("shift.cashier")}: <bdi>{z.openedPrincipalId}</bdi>
        </p>
      </header>
      <Button data-print="hide" onClick={() => window.print()}>
        {t("shift.print")}
      </Button>
      <DataGrid
        caption={t("shift.tenders")}
        emptyLabel={t("app.empty")}
        rows={z.tenders}
        rowKey={(r) => r.method}
        columns={[
          { key: "method", header: t("shift.method"), cell: (r) => t(`pos.${r.method}`) },
          { key: "account", header: t("shift.account"), cell: (r) => r.accountCode },
          { key: "amount", header: t("shift.amount"), align: "end", cell: (r) => money(r.amount) },
        ]}
      />
      {/* Empty, not absent, when nothing moved: a section that vanishes reads as a bug on paper. */}
      <DataGrid
        caption={t("shift.control")}
        emptyLabel={t("app.empty")}
        rows={z.cashControl}
        rowKey={(r) => r.documentTypeCode}
        columns={[
          {
            key: "type",
            header: t("shift.document"),
            cell: (r) => label(CASH_CONTROL_LABEL, r.documentTypeCode),
          },
          { key: "amount", header: t("shift.amount"), align: "end", cell: (r) => money(r.amount) },
        ]}
      />
      <dl>
        {(
          [
            ["shift.opening", z.openingFloat],
            ["shift.expected", z.expectedCash],
            ["shift.counted", z.countedCash],
          ] as const
        ).map(([key, value]) => (
          <div key={key}>
            <dt>{t(key)}</dt>
            <dd className="text-end">{money(value)}</dd>
          </div>
        ))}
        <div>
          <dt>{t("shift.difference")}</dt>
          <dd className="text-end">
            <OverShortAmount value={z.overShort} />
            {/* The traceability line: a signed paper Z-report names the TILL_OVER_SHORT document a
                reader can look up. `<bdi>` keeps the id's own order inside right-to-left Arabic. */}
            {z.overShortDocumentId !== null && (
              <span>
                {" · "}
                {t("shift.overShortDocument")} <bdi>{z.overShortDocumentId}</bdi>
              </span>
            )}
          </dd>
        </div>
      </dl>
      <p>
        {t("shift.tickets")}: {z.ticketCount} · {t("shift.returns")}: {z.returnCount}
      </p>
      {/* Printed: the per-kind counts are the drawer-control figures a Z-report exists to expose. The
          individual events below stay on screen only. */}
      <ul aria-label={t("shift.eventCounts")}>
        {z.tillEvents.length === 0 ? (
          <li>{t("app.empty")}</li>
        ) : (
          z.tillEvents.map((e) => (
            <li key={e.kind}>
              {label(TILL_EVENT_LABEL, e.kind)}: {e.count}
            </li>
          ))
        )}
      </ul>
      {events.error ? (
        <StaffFailure cause={events.error} />
      ) : events.isPending ? (
        <p>{t("app.loading")}</p>
      ) : (
        <div data-print="hide">
          <DataGrid
            caption={t("shift.events")}
            emptyLabel={t("app.empty")}
            rows={events.data?.items ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "kind", header: t("shift.event"), cell: (r) => t(`shift.${r.kind}`) },
              { key: "at", header: t("shift.occurred"), cell: (r) => time(r.occurredAt) },
              { key: "reason", header: t("pos.reason"), cell: (r) => r.reason ?? "—" },
            ]}
          />
          {events.data?.next_cursor && (
            <Button onClick={() => setCursor(events.data!.next_cursor)}>{t("shift.next")}</Button>
          )}
        </div>
      )}
    </article>
  );
}
