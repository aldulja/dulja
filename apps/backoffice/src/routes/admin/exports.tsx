import type { ExportJobDto } from "@dulja/contracts";
import { formatNumber, formatTimestamp } from "@dulja/i18n";
import { Button, DataGrid, Select, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import {
  Checkbox,
  ProblemAlert,
  useAlive,
  useAttemptKeys,
  useRefusalRedirect,
} from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { createExportApi } from "../../lib/export-api";
import { retryQuery } from "../../lib/problem";
import { saveBlob } from "../../lib/report-api";

/** `ExportFormatSchema`'s three values and nothing else: `CreateExportBody` is strict and has no fourth member. */
const FORMATS = ["both", "csv", "json"] as const;
type ExportFormat = (typeof FORMATS)[number];
const POLL_MS = 1000;
const isActive = (status: ExportJobDto["status"] | undefined) =>
  status === "queued" || status === "running";

/**
 * 7C Task 13 — the tenant data export screen (spec:2186, 2206; ADRs 0069, 0070), built on the owner's authorized
 * default baseline (2026-11-06; `docs/ui/od-24-phase-7c.md`). The request form offers exactly the body's two
 * members; an accepted request is followed through the `statusUrl` its 202 returned; a finished archive is
 * downloaded with its SHA-256 beside it; and every table the requester's gates kept out is listed with its gate,
 * so an incomplete export is visibly incomplete.
 */
export function ExportsRoute(props: { api: AdminApiOptions; companyId: string }) {
  return <Exports key={props.companyId} {...props} />;
}

function Exports({ api, companyId }: { api: AdminApiOptions; companyId: string }) {
  const { t, locale } = useShell();
  const client = useMemo(() => createExportApi(api, companyId), [api, companyId]);
  const cache = useQueryClient();
  const enabled = companyId !== "" && api.accessToken() !== null;
  const scope = [companyId] as const;
  const [format, setFormat] = useState<ExportFormat>("both");
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [selected, setSelected] = useState<{ id: string; statusUrl: string } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const alive = useAlive();
  const attempts = useAttemptKeys();
  const formatField = useRef<HTMLDivElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);

  const list = useQuery({
    queryKey: ["exports", ...scope],
    enabled,
    retry: retryQuery,
    queryFn: ({ signal }) => client.list({ signal }),
  });
  // The status resource the 202 named — `/v1/companies/{companyId}/exports/{exportJobId}`, never a job path —
  // asked again while the archive is queued or being built.
  const status = useQuery({
    queryKey: ["export", ...scope, selected?.id],
    enabled: enabled && selected !== null,
    retry: retryQuery,
    queryFn: ({ signal }) => client.status(selected!.statusUrl, { signal }),
    refetchInterval: (query) =>
      query.state.data === undefined || isActive(query.state.data.status) ? POLL_MS : false,
  });
  const job = status.data;
  useEffect(() => {
    if (job?.status === "done" || job?.status === "failed")
      void cache.invalidateQueries({ queryKey: ["exports", ...scope] });
    if (job?.status === "done") downloadRef.current?.focus();
  }, [job?.status]);

  const error = failure ?? list.error ?? status.error;
  useRefusalRedirect(error);

  const focusForm = () => formatField.current?.querySelector("select")?.focus();
  function newRequest() {
    setSelected(null);
    setFailure(null);
    focusForm();
  }
  async function request() {
    if (!enabled || lock.current) return;
    const body = { format, includeAttachments };
    const gesture = JSON.stringify(body);
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const accepted = await client.request(body, { idempotencyKey: attempts.key(gesture) });
      attempts.settle(gesture);
      if (!alive.current) return;
      setSelected({ id: accepted.exportJobId, statusUrl: accepted.statusUrl });
      void cache.invalidateQueries({ queryKey: ["exports", ...scope] });
    } catch (cause) {
      attempts.settle(gesture, cause);
      if (alive.current) setFailure(cause);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function download(target: ExportJobDto) {
    try {
      const blob = await client.content(target.id);
      saveBlob(blob, `dulja-export-${target.id}.tar.gz`);
    } catch (cause) {
      if (alive.current) setFailure(cause);
    }
  }
  const open = (row: ExportJobDto) => {
    setFailure(null);
    setSelected({ id: row.id, statusUrl: client.statusUrlFor(row.id) });
  };

  // Ctrl+Enter requests an export from anywhere on the screen; Esc closes the open one and returns to the form.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.altKey || event.repeat) return;
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        void request();
      } else if (
        !event.ctrlKey &&
        event.key === "Escape" &&
        selected !== null &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        newRequest();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const columns: Column<ExportJobDto>[] = [
    {
      key: "created",
      header: t("admin.export.created"),
      cell: (row) => <bdi>{formatTimestamp(row.createdAt, { locale })}</bdi>,
    },
    {
      key: "format",
      header: t("admin.export.format"),
      cell: (row) => t(`admin.export.format.${row.format}`),
    },
    {
      key: "status",
      header: t("admin.export.status"),
      cell: (row) => t(`admin.export.status.${row.status}`),
    },
    {
      key: "open",
      header: t("admin.export.open"),
      cell: (row) => (
        <span onKeyDown={(event) => event.stopPropagation()}>
          <Button onClick={() => open(row)}>{t("admin.export.open")}</Button>
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-6" aria-label={t("admin.export.title")}>
      <h1 className="text-start text-xl font-bold">{t("admin.export.title")}</h1>
      <p className="text-start text-text-muted">{t("admin.export.intro")}</p>
      {companyId === "" ? <p role="status">{t("report.companyUnknown")}</p> : null}
      <form
        aria-label={t("admin.export.request")}
        className="flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void request();
        }}
      >
        <div ref={formatField}>
          <Select
            label={t("admin.export.format")}
            value={format}
            disabled={busy}
            options={FORMATS.map((value) => ({ value, label: t(`admin.export.format.${value}`) }))}
            onChange={(event) => setFormat(event.currentTarget.value as ExportFormat)}
          />
        </div>
        <Checkbox
          label={t("admin.export.includeAttachments")}
          checked={includeAttachments}
          disabled={busy}
          onChange={setIncludeAttachments}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!enabled || busy}
          aria-keyshortcuts="Control+Enter"
        >
          {t("admin.export.submit")}
        </Button>
      </form>
      {error ? (
        <ProblemAlert error={error}>
          {failure === null ? (
            <Button onClick={() => void list.refetch()}>{t("app.error.retry")}</Button>
          ) : null}
        </ProblemAlert>
      ) : null}
      {selected !== null ? (
        <section
          className="flex flex-col gap-3"
          aria-label={t("admin.export.detail")}
          aria-busy={isActive(job?.status)}
        >
          <h2 className="text-start text-lg font-bold">{t("admin.export.detail")}</h2>
          <p role="status" className="text-start">
            {t(`admin.export.status.${job?.status ?? "queued"}`)}
          </p>
          {job?.status === "done" ? (
            <>
              <Button
                ref={downloadRef}
                variant="primary"
                className="self-start"
                onClick={() => void download(job)}
              >
                {t("admin.export.download")}
              </Button>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-start">
                <dt>{t("admin.export.sha256")}</dt>
                <dd className="break-all">
                  <bdi dir="ltr" data-testid="export-sha256">
                    {job.sha256}
                  </bdi>
                </dd>
                <dt>{t("admin.export.tables")}</dt>
                <dd>
                  <bdi>
                    {job.tableCount === null
                      ? ""
                      : formatNumber(String(job.tableCount), { locale })}
                  </bdi>
                </dd>
                <dt>{t("admin.export.rows")}</dt>
                <dd>
                  <bdi>{job.rowCount === null ? "" : formatNumber(job.rowCount, { locale })}</bdi>
                </dd>
                <dt>{t("admin.export.attachments")}</dt>
                <dd>
                  {job.includeAttachments
                    ? t("admin.export.attachmentCount", {
                        count: formatNumber(String(job.manifest?.attachments.length ?? 0), {
                          locale,
                        }),
                      })
                    : t("admin.export.attachmentsOff")}
                </dd>
              </dl>
              <section className="flex flex-col gap-2" aria-label={t("admin.export.excluded")}>
                <h3 className="text-start font-bold">{t("admin.export.excluded")}</h3>
                {(job.manifest?.excluded.length ?? 0) === 0 ? (
                  <p className="text-start">{t("admin.export.excludedNone")}</p>
                ) : (
                  <>
                    <p className="text-start text-text-muted">{t("admin.export.excludedHint")}</p>
                    <ul className="list-disc ps-6" data-testid="export-excluded">
                      {job.manifest!.excluded.map((entry) => (
                        <li key={entry.table}>
                          <bdi dir="ltr">{entry.table}</bdi> — {t("admin.export.gate")}{" "}
                          <bdi dir="ltr">{entry.gate}</bdi>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              {(job.manifest?.excludedRows.length ?? 0) > 0 ? (
                <section
                  className="flex flex-col gap-2"
                  aria-label={t("admin.export.excludedRows")}
                >
                  <h3 className="text-start font-bold">{t("admin.export.excludedRows")}</h3>
                  <p className="text-start text-text-muted">{t("admin.export.excludedRowsHint")}</p>
                  <ul className="list-disc ps-6" data-testid="export-excluded-rows">
                    {job.manifest!.excludedRows.map((entry) => (
                      <li key={`${entry.table}:${entry.module}`}>
                        <bdi dir="ltr">{entry.table}</bdi> — {t("admin.export.excludedRowsModule")}{" "}
                        <bdi dir="ltr">{entry.module}</bdi> — {t("admin.export.gate")}{" "}
                        <bdi dir="ltr">{entry.gate}</bdi>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : null}
          {job?.status === "failed" ? (
            <div role="alert" className="flex flex-col gap-2 text-start text-danger">
              <p>{t("admin.export.failed")}</p>
              <p>
                <bdi dir="ltr">{job.error}</bdi>
              </p>
              <span>
                <Button onClick={newRequest}>{t("admin.export.newRequest")}</Button>
              </span>
            </div>
          ) : null}
        </section>
      ) : null}
      {enabled && list.isPending ? <p role="status">{t("app.loading")}</p> : null}
      <DataGrid
        caption={t("admin.export.list")}
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(row) => row.id}
        emptyLabel={t("admin.export.none")}
        onActivate={open}
      />
    </section>
  );
}
