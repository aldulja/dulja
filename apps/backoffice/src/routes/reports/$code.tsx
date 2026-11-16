import type { ReportDefinitionDto, ReportRunDto, SavedViewDto } from "@dulja/contracts";
import { formatTimestamp } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import {
  filledValues,
  initialValues,
  ParameterForm,
  parametersOf,
} from "../../features/reports/parameter-form";
import {
  Checkbox,
  localName,
  pointerErrors,
  ProblemAlert,
  useAlive,
  useAttemptKeys,
  useRefusalRedirect,
} from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { ApiError, retryQuery } from "../../lib/problem";
import { createReportApi, saveBlob } from "../../lib/report-api";

type Format = "pdf" | "xlsx" | "csv";
const FORMATS: readonly Format[] = ["pdf", "xlsx", "csv"];
/** Alt+1, Alt+2, Alt+3 — read from `event.code`, so the keys are the same on an Arabic keyboard layout. */
const FORMAT_KEYS: Readonly<Record<string, Format>> = {
  Digit1: "pdf",
  Digit2: "xlsx",
  Digit3: "csv",
};
/** How often a queued or running render is asked again. */
const POLL_MS = 1000;

/**
 * A status answer that asking again cannot change (UI-20): a 4xx other than a timeout or a rate limit — a 401,
 * 403 or 404 on the run's URL. Polling stops there; a transport failure or a 5xx keeps polling.
 */
const isSettledRefusal = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.problem.status >= 400 &&
  error.problem.status < 500 &&
  error.problem.status !== 408 &&
  error.problem.status !== 429;
const isActive = (status: ReportRunDto["status"] | undefined) =>
  status === "queued" || status === "running";

/** The definition row a screen works on: the one named, or the code's highest live version. */
export function pickDefinition(
  rows: readonly ReportDefinitionDto[],
  definitionId: string | null,
): ReportDefinitionDto | undefined {
  if (definitionId !== null) return rows.find((row) => row.id === definitionId);
  return rows.filter((row) => row.archivedAt === null).toSorted((a, b) => b.version - a.version)[0];
}

export interface ReportRunProps {
  api: AdminApiOptions;
  companyId: string;
  code: string;
  definitionId: string | null;
  /** 8D T10 — values another screen fills in (`?parameters=`); a name the definition does not declare is dropped. */
  preset?: Readonly<Record<string, string>> | null;
  onBack(): void;
  onDesign(code: string, definitionId: string): void;
  onSelect(code: string, definitionId: string): void;
}

/**
 * 7A Task 15 — the run screen: parameter entry generated from the definition, saved-view selection and saving,
 * and the three format buttons over `POST …/reports/{code}/runs`, then the run's own status resource polled until
 * it is `done` (a download) or `failed` (its error). Built on the owner's authorized default baseline (2026-11-06);
 * the keys are this screen's defaults, not the shop's (`docs/ui/od-24-phase-7a.md`).
 */
export function ReportRunRoute(props: ReportRunProps) {
  return (
    <ReportRun
      key={`${props.companyId}:${props.code}:${props.definitionId ?? ""}:${JSON.stringify(props.preset ?? {})}`}
      {...props}
    />
  );
}

function ReportRun({
  api,
  companyId,
  code,
  definitionId,
  preset,
  onBack,
  onDesign,
  onSelect,
}: ReportRunProps) {
  const { t, locale } = useShell();
  const client = useMemo(() => createReportApi(api, companyId), [api, companyId]);
  const cache = useQueryClient();
  const enabled = companyId !== "" && api.accessToken() !== null;
  const scope = [companyId] as const;
  const versions = useQuery({
    queryKey: ["report-definitions", ...scope, "code", code],
    enabled,
    retry: retryQuery,
    queryFn: ({ signal }) => client.definitions(null, code, { signal }),
  });
  const row = versions.data ? pickDefinition(versions.data.items, definitionId) : undefined;
  const parameters = useMemo(() => (row ? parametersOf(row.definition) : []), [row]);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const current = values ?? {
    ...initialValues(parameters),
    ...Object.fromEntries(
      Object.entries(preset ?? {}).filter(([name]) => parameters.some((p) => p.name === name)),
    ),
  };
  const [viewId, setViewId] = useState("");
  const [lastFormat, setLastFormat] = useState<Format>("pdf");
  const [run, setRun] = useState<{ runId: string; statusUrl: string; format: Format } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [viewName, setViewName] = useState({ en: "", ar: "" });
  const [shared, setShared] = useState(false);
  const lock = useRef(false);
  const alive = useAlive();
  const attempts = useAttemptKeys();
  const formRef = useRef<HTMLFormElement>(null);
  const viewNameRef = useRef<HTMLInputElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);

  const views = useQuery({
    queryKey: ["saved-views", ...scope, row?.id],
    enabled: enabled && row !== undefined,
    retry: retryQuery,
    queryFn: ({ signal }) => client.views(row!.id, { signal }),
  });
  const status = useQuery({
    queryKey: ["report-run", ...scope, run?.runId],
    enabled: enabled && run !== null,
    retry: retryQuery,
    queryFn: ({ signal }) => client.status(run!.statusUrl, { signal }),
    refetchInterval: (query) =>
      isSettledRefusal(query.state.error)
        ? false
        : query.state.data === undefined || isActive(query.state.data.status)
          ? POLL_MS
          : false,
  });
  const history = useQuery({
    queryKey: ["report-runs", ...scope, row?.id],
    enabled: enabled && row !== undefined,
    retry: retryQuery,
    queryFn: ({ signal }) => client.runs(row!.id, { signal }),
  });
  const runStatus = status.data?.status;
  // A finished run refreshes the recent-runs list and hands the cursor to its download.
  useEffect(() => {
    if (runStatus === "done" || runStatus === "failed")
      void cache.invalidateQueries({ queryKey: ["report-runs", ...scope] });
    if (runStatus === "done") downloadRef.current?.focus();
  }, [runStatus]);

  const error = failure ?? versions.error ?? status.error;
  useRefusalRedirect(error ?? views.error ?? history.error);
  const fieldErrors = pointerErrors(failure);
  const selectedView = views.data?.items.find((view) => view.id === viewId);

  function change(name: string, value: string) {
    setValues({ ...current, [name]: value });
  }
  function chooseView(id: string) {
    setViewId(id);
    const view = views.data?.items.find((v) => v.id === id);
    if (!view) return;
    // Only the parameters the definition declares: a view saved before an edit may carry one it no longer does.
    setValues({
      ...initialValues(parameters),
      ...Object.fromEntries(
        Object.entries(view.parameters).filter(([name]) => parameters.some((p) => p.name === name)),
      ),
    });
  }

  async function act(gesture: string, work: () => Promise<void>) {
    if (!enabled || lock.current || row === undefined) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await work();
      attempts.settle(gesture);
    } catch (cause) {
      attempts.settle(gesture, cause);
      if (alive.current) setFailure(cause);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function start(format: Format) {
    if (row === undefined) return;
    setLastFormat(format);
    const parametersSent = filledValues(current);
    // The view is recorded on the run only while the form still holds exactly what it saved.
    const fromView =
      selectedView !== undefined &&
      JSON.stringify(filledValues({ ...initialValues(parameters), ...selectedView.parameters })) ===
        JSON.stringify(parametersSent);
    const body = {
      reportDefinitionId: row.id,
      ...(fromView ? { savedViewId: selectedView.id } : {}),
      parameters: parametersSent,
      format,
      lang: locale,
    };
    const gesture = `run:${JSON.stringify(body)}`;
    void act(gesture, async () => {
      const accepted = await client.run(code, body, { idempotencyKey: attempts.key(gesture) });
      if (alive.current) setRun({ runId: accepted.runId, statusUrl: accepted.statusUrl, format });
    });
  }

  function saveView() {
    if (row === undefined) return;
    if (viewName.en.trim() === "") {
      viewNameRef.current?.focus();
      return;
    }
    const body = {
      reportDefinitionId: row.id,
      nameEn: viewName.en.trim(),
      ...(viewName.ar.trim() === "" ? {} : { nameAr: viewName.ar.trim() }),
      parameters: filledValues(current),
      shared,
    };
    const gesture = `view:${JSON.stringify(body)}`;
    void act(gesture, async () => {
      const saved = await client.saveView(body, { idempotencyKey: attempts.key(gesture) });
      await cache.invalidateQueries({ queryKey: ["saved-views", ...scope] });
      if (!alive.current) return;
      setViewId(saved.id);
      setViewName({ en: "", ar: "" });
      setShared(false);
    });
  }

  function archiveView() {
    if (selectedView === undefined) return;
    const gesture = `archive-view:${selectedView.id}`;
    void act(gesture, async () => {
      await client.archiveView(selectedView.id, { idempotencyKey: attempts.key(gesture) });
      await cache.invalidateQueries({ queryKey: ["saved-views", ...scope] });
      if (alive.current) setViewId("");
    });
  }

  async function download(target: { id: string; format: Format }) {
    try {
      const blob = await client.content(target.id);
      saveBlob(blob, `${code}-${target.id}.${target.format}`);
    } catch (cause) {
      if (alive.current) setFailure(cause);
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.repeat) return;
      if (event.altKey && !event.ctrlKey && FORMAT_KEYS[event.code] !== undefined) {
        event.preventDefault();
        start(FORMAT_KEYS[event.code]!);
      } else if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveView();
      } else if (
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "Escape" &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The cursor starts in the first parameter, so a report is run without touching the mouse.
  useEffect(() => {
    if (row !== undefined) formRef.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, [row?.id]);

  const formatLabel = (format: Format) => t(`report.format.${format}`);
  const historyColumns: Column<ReportRunDto>[] = [
    {
      key: "created",
      header: t("report.run.created"),
      cell: (r) => <bdi>{formatTimestamp(r.createdAt, { locale })}</bdi>,
    },
    { key: "format", header: t("report.run.format"), cell: (r) => formatLabel(r.format) },
    { key: "lang", header: t("report.run.lang"), cell: (r) => t(`app.endonym.${r.lang}`) },
    { key: "status", header: t("report.run.status"), cell: (r) => t(`report.status.${r.status}`) },
    {
      key: "download",
      header: t("report.run.download"),
      cell: (r) =>
        r.status === "done" ? (
          <span onKeyDown={(event) => event.stopPropagation()}>
            <Button onClick={() => void download({ id: r.id, format: r.format })}>
              {t("report.run.download")}
            </Button>
          </span>
        ) : null,
    },
  ];
  const liveVersions =
    versions.data?.items.filter((v) => v.archivedAt === null || v.id === row?.id) ?? [];

  return (
    <section className="flex flex-col gap-6" aria-label={t("report.run.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-start text-xl font-bold">
          {row ? <bdi>{localName(row.definition, locale)}</bdi> : t("report.run.title")}
        </h1>
        <span className="flex gap-2">
          <Button onClick={onBack} aria-keyshortcuts="Escape">
            {t("report.back")}
          </Button>
          {row ? (
            <Button onClick={() => onDesign(code, row.id)}>{t("report.design")}</Button>
          ) : null}
        </span>
      </div>
      <p className="text-start text-text-muted">
        <bdi dir="ltr">{code}</bdi>
      </p>
      {error ? (
        <ProblemAlert error={error} hidePaths={fieldErrors.size > 0}>
          {failure === null ? (
            <Button onClick={() => void versions.refetch()}>{t("app.error.retry")}</Button>
          ) : null}
        </ProblemAlert>
      ) : null}
      {enabled && versions.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {versions.isSuccess && row === undefined ? <p role="alert">{t("report.notFound")}</p> : null}
      {row ? (
        <>
          {liveVersions.length > 1 ? (
            <Select
              label={t("report.versionChoice")}
              value={row.id}
              options={liveVersions.map((v) => ({
                value: v.id,
                label: t(v.isCore ? "report.versionCore" : "report.versionCopy", {
                  version: v.version,
                }),
              }))}
              onChange={(event) => onSelect(code, event.currentTarget.value)}
            />
          ) : null}
          <form
            ref={formRef}
            aria-label={t("report.param.title")}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              start(lastFormat);
            }}
          >
            <h2 className="text-start text-lg font-bold">{t("report.param.title")}</h2>
            <ParameterForm
              client={client}
              code={code}
              scope={scope}
              parameters={parameters}
              values={current}
              onChange={change}
              errors={fieldErrors}
              disabled={busy}
            />
            <div className="flex flex-wrap gap-3" role="group" aria-label={t("report.run.formats")}>
              {FORMATS.map((format, index) => (
                <Button
                  key={format}
                  variant={format === lastFormat ? "primary" : "secondary"}
                  disabled={!enabled || busy}
                  aria-keyshortcuts={`Alt+${index + 1}`}
                  onClick={() => start(format)}
                >
                  {t("report.run.as", { format: formatLabel(format), key: index + 1 })}
                </Button>
              ))}
            </div>
            {/* Enter in a field runs the format last used; the default is PDF. */}
            <button type="submit" hidden tabIndex={-1} />
          </form>
          <section className="flex flex-col gap-3" aria-label={t("report.view.title")}>
            <h2 className="text-start text-lg font-bold">{t("report.view.title")}</h2>
            <div className="flex flex-wrap items-end gap-3">
              <Select
                label={t("report.view.choose")}
                value={viewId}
                disabled={busy || views.isPending}
                options={[
                  { value: "", label: t("report.view.none") },
                  ...(views.data?.items ?? []).map((view: SavedViewDto) => ({
                    value: view.id,
                    label: localName(view, locale),
                  })),
                ]}
                onChange={(event) => chooseView(event.currentTarget.value)}
              />
              {selectedView ? (
                <Button variant="danger" disabled={busy} onClick={archiveView}>
                  {t("report.view.archive")}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <TextField
                ref={viewNameRef}
                label={t("report.view.nameEn")}
                value={viewName.en}
                disabled={busy}
                onChange={(event) => setViewName({ ...viewName, en: event.currentTarget.value })}
              />
              <TextField
                label={t("report.view.nameAr")}
                value={viewName.ar}
                disabled={busy}
                dir="rtl"
                onChange={(event) => setViewName({ ...viewName, ar: event.currentTarget.value })}
              />
              <Checkbox
                label={t("report.view.shared")}
                checked={shared}
                disabled={busy}
                onChange={setShared}
              />
              <Button disabled={busy} onClick={saveView} aria-keyshortcuts="Control+s">
                {t("report.view.save")}
              </Button>
            </div>
          </section>
          {run !== null ? (
            <section
              className="flex flex-col gap-3"
              aria-label={t("report.run.current")}
              aria-busy={isActive(runStatus)}
            >
              <h2 className="text-start text-lg font-bold">{t("report.run.current")}</h2>
              <p role="status" className="text-start">
                {runStatus === undefined
                  ? t("report.status.queued")
                  : t(`report.status.${runStatus}`)}
              </p>
              {status.data?.status === "done" ? (
                <>
                  <Button
                    ref={downloadRef}
                    variant="primary"
                    className="self-start"
                    onClick={() => void download({ id: run.runId, format: run.format })}
                  >
                    {t("report.run.downloadAs", { format: formatLabel(run.format) })}
                  </Button>
                  {status.data.sha256 ? (
                    <p className="break-all text-start text-text-muted">
                      {t("report.run.sha256")}: <bdi dir="ltr">{status.data.sha256}</bdi>
                    </p>
                  ) : null}
                </>
              ) : null}
              {status.data?.status === "failed" ? (
                <p role="alert" className="text-start text-danger">
                  <bdi dir="ltr">{status.data.error}</bdi>
                </p>
              ) : null}
            </section>
          ) : null}
          <DataGrid
            caption={t("report.run.recent")}
            columns={historyColumns}
            rows={history.data?.items ?? []}
            rowKey={(r) => r.id}
            emptyLabel={t("report.run.none")}
            onActivate={(r) => {
              if (r.status === "done") void download({ id: r.id, format: r.format });
            }}
          />
        </>
      ) : null}
    </section>
  );
}
