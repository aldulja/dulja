import type { ReportDefinitionDto } from "@dulja/contracts";
import { Button, Select, TextField } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useShell } from "../../components/app-shell";
import {
  ALIGNS,
  COLUMN_FORMATS,
  draftErrors,
  fromDraft,
  move,
  ORIENTATIONS,
  PAPERS,
  SORT_DIRS,
  toDraft,
  TOTAL_FNS,
  type Draft,
  type DraftColumn,
} from "../../features/reports/draft";
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
import { retryQuery } from "../../lib/problem";
import { createReportApi } from "../../lib/report-api";
import { pickDefinition } from "./$code";

/** Every error pointer the form shows beside a field; any other is listed in the summary instead. */
const FIELD_PATH =
  /^\/(nameEn|nameAr|layout\/(header|footer)|columns\/\d+(\/(labelEn|labelAr|width|format|align))?|(sort|groups|totals)\/\d+(\/field)?)$/;

export interface ReportDesignProps {
  api: AdminApiOptions;
  companyId: string;
  code: string;
  definitionId: string | null;
  onBack(): void;
  /** Opens the designer on another row — the clone a "Clone to edit" made. */
  onOpen(code: string, definitionId: string): void;
  onRun(code: string, definitionId: string): void;
}

/**
 * 7A Task 15 — the report designer, over the clone, update and archive routes (7A Task 13; spec:2293 "a user
 * clones and edits a report without a release"). A core definition is read-only and editing starts with Clone; a
 * tenant copy is edited in place and can be archived. What may change is `features/reports/draft.ts`'s list — the
 * owner-authorized default for OD-24 item 4 (2026-11-06) — and the API's own validation is the authority: its
 * `errors[]` are shown against the field they name.
 */
export function ReportDesignRoute(props: ReportDesignProps) {
  return (
    <ReportDesign key={`${props.companyId}:${props.code}:${props.definitionId ?? ""}`} {...props} />
  );
}

function ReportDesign({
  api,
  companyId,
  code,
  definitionId,
  onBack,
  onOpen,
  onRun,
}: ReportDesignProps) {
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
  // The source of a copy, for the columns this copy has hidden. It may itself be archived; that is still a read.
  const source = useQuery({
    queryKey: ["report-definition", ...scope, row?.clonedFrom],
    enabled: enabled && row?.clonedFrom != null,
    retry: retryQuery,
    queryFn: ({ signal }) => client.definition(row!.clonedFrom!, { signal }),
  });
  const ready = row !== undefined && (row.clonedFrom === null || !source.isPending);
  const [draft, setDraft] = useState<Draft | null>(null);
  const base = useMemo(
    () => (row && ready ? toDraft(row.definition, source.data?.definition) : null),
    [row, ready, source.data],
  );
  const current = draft ?? base;
  const readOnly = row === undefined || row.isCore || row.archivedAt !== null;
  const [failure, setFailure] = useState<unknown>(null);
  const [columnIndex, setColumnIndex] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const lock = useRef(false);
  const alive = useAlive();
  const attempts = useAttemptKeys();
  const columnsRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const cloneRef = useRef<HTMLButtonElement>(null);

  /**
   * UI-06: the draft lives only in this screen, so leaving it — Esc (from any field), Back, Open, Clone again, or
   * any other route change — asks first while it differs from the stored definition. The safe answer, keep
   * editing, takes the cursor; Esc while the question is open is that answer too.
   */
  const dirty =
    !readOnly && draft !== null && base !== null && JSON.stringify(draft) !== JSON.stringify(base);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const discarding = useRef(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current && !discarding.current,
    enableBeforeUnload: () => dirtyRef.current && !discarding.current,
    withResolver: true,
  });
  const asking = pendingLeave !== null || blocker.status === "blocked";
  function leave(action: () => void) {
    if (!dirty) {
      action();
      return;
    }
    returnFocus.current = document.activeElement as HTMLElement | null;
    setPendingLeave(() => action);
  }
  function keepEditing() {
    setPendingLeave(null);
    if (blocker.status === "blocked") blocker.reset();
    queueMicrotask(() => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    });
  }
  function discard() {
    discarding.current = true;
    const action = pendingLeave;
    setPendingLeave(null);
    if (blocker.status === "blocked") blocker.proceed();
    else action?.();
  }
  useEffect(() => {
    if (!asking) return;
    if (blocker.status === "blocked" && pendingLeave === null)
      returnFocus.current = document.activeElement as HTMLElement | null;
    keepRef.current?.focus();
  }, [asking]);

  const error = failure ?? versions.error ?? source.error;
  useRefusalRedirect(error);
  const errors = draftErrors(pointerErrors(failure), columnIndex);
  const fieldError = (path: string) => errors.get(path);
  const errorAt = (path: string): { error?: string } => {
    const message = fieldError(path);
    return message === undefined ? {} : { error: message };
  };

  function edit(next: (d: Draft) => Draft) {
    if (current === null || readOnly) return;
    // A new edit after a discarded leave that did not leave (a refused clone) is guarded again.
    discarding.current = false;
    setSaved(false);
    setDraft(next(current));
  }
  const setColumn = (index: number, patch: Partial<DraftColumn>) =>
    edit((d) => ({
      ...d,
      columns: d.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  function moveColumn(index: number, delta: number, refocus: string | null) {
    edit((d) => ({ ...d, columns: move(d.columns, index, delta) }));
    if (refocus === null) return;
    const target = Math.min(Math.max(index + delta, 0), (current?.columns.length ?? 1) - 1);
    // After the re-render, the cursor follows the column it was in.
    requestAnimationFrame(() =>
      columnsRef.current
        ?.querySelector<HTMLElement>(`[data-column="${target}"] [data-part="${refocus}"]`)
        ?.focus(),
    );
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
  function clone() {
    if (row === undefined) return;
    const gesture = `clone:${row.id}`;
    void act(gesture, async () => {
      const copy = await client.clone(row.id, { idempotencyKey: attempts.key(gesture) });
      await cache.invalidateQueries({ queryKey: ["report-definitions", ...scope] });
      if (alive.current) onOpen(code, copy.id);
    });
  }
  function save() {
    if (row === undefined || current === null || readOnly) return;
    const built = fromDraft(row.definition, current);
    setColumnIndex(built.columnIndex);
    const gesture = `save:${row.id}:${JSON.stringify(built.definition)}`;
    void act(gesture, async () => {
      const updated = await client.update(row.id, built.definition, {
        idempotencyKey: attempts.key(gesture),
      });
      cache.setQueryData(
        ["report-definitions", ...scope, "code", code],
        (old: { items: ReportDefinitionDto[]; next_cursor: string | null } | undefined) =>
          old && {
            ...old,
            items: old.items.map((item) => (item.id === updated.id ? updated : item)),
          },
      );
      await cache.invalidateQueries({ queryKey: ["report-definitions", ...scope, "list"] });
      if (!alive.current) return;
      setDraft(null);
      setSaved(true);
    });
  }
  function archive() {
    if (row === undefined || row.isCore) return;
    const gesture = `archive:${row.id}`;
    void act(gesture, async () => {
      await client.archive(row.id, { idempotencyKey: attempts.key(gesture) });
      await cache.invalidateQueries({ queryKey: ["report-definitions", ...scope] });
      if (alive.current) onBack();
    });
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.altKey || event.repeat) return;
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      } else if (
        !event.ctrlKey &&
        event.key === "Escape" &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        if (asking) keepEditing();
        else if (confirmArchive) setConfirmArchive(false);
        else leave(onBack);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The cursor starts where the work is: the first title on a copy, the Clone button on a core report.
  useEffect(() => {
    if (current === null) return;
    (readOnly ? cloneRef.current : firstFieldRef.current)?.focus();
  }, [row?.id, base === null]);

  const fields = current?.columns.map((c) => c.field) ?? [];
  const columnName = (field: string) => {
    const c = current?.columns.find((col) => col.field === field);
    return c ? (locale === "ar" ? c.labelAr : c.labelEn) || field : field;
  };
  const fieldChoices = fields.map((field) => ({
    value: field,
    label: `${columnName(field)} (${field})`,
  }));

  const onColumnKey = (index: number) => (event: ReactKeyboardEvent<HTMLFieldSetElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const part =
      event.target instanceof HTMLElement ? (event.target.dataset["part"] ?? null) : null;
    moveColumn(index, event.key === "ArrowUp" ? -1 : 1, part);
  };

  const body = current ? (
    <>
      <fieldset className="flex flex-col gap-3" disabled={readOnly || busy}>
        <legend className="text-start text-lg font-bold">{t("report.designer.titles")}</legend>
        <div className="flex flex-wrap gap-3">
          <TextField
            ref={firstFieldRef}
            label={t("report.designer.nameEn")}
            value={current.nameEn}
            onChange={(e) => {
              const value = e.currentTarget.value;
              edit((d) => ({ ...d, nameEn: value }));
            }}
            {...errorAt("/nameEn")}
          />
          <TextField
            label={t("report.designer.nameAr")}
            dir="rtl"
            value={current.nameAr}
            onChange={(e) => {
              const value = e.currentTarget.value;
              edit((d) => ({ ...d, nameAr: value }));
            }}
            {...errorAt("/nameAr")}
          />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-3" disabled={readOnly || busy}>
        <legend className="text-start text-lg font-bold">{t("report.designer.columns")}</legend>
        <p className="text-start text-text-muted">{t("report.designer.columnsHint")}</p>
        <div ref={columnsRef} className="flex flex-col gap-3">
          {current.columns.map((c, index) => (
            <fieldset
              key={c.field}
              data-column={index}
              className="flex flex-wrap items-end gap-3 border-b border-border pb-3"
              onKeyDown={onColumnKey(index)}
            >
              <legend className="text-start font-bold">
                {t("report.designer.column", { position: index + 1 })} ·{" "}
                <bdi dir="ltr">{c.field}</bdi>
              </legend>
              <Checkbox
                label={t("report.designer.shown")}
                checked={c.shown}
                onChange={(shown) => setColumn(index, { shown })}
              />
              <TextField
                data-part="labelEn"
                label={t("report.designer.labelEn")}
                value={c.labelEn}
                onChange={(e) => setColumn(index, { labelEn: e.currentTarget.value })}
                {...errorAt(`/columns/${index}/labelEn`)}
              />
              <TextField
                data-part="labelAr"
                label={t("report.designer.labelAr")}
                dir="rtl"
                value={c.labelAr}
                onChange={(e) => setColumn(index, { labelAr: e.currentTarget.value })}
                {...errorAt(`/columns/${index}/labelAr`)}
              />
              <Select
                data-part="format"
                label={t("report.designer.format")}
                value={c.format}
                options={COLUMN_FORMATS.map((value) => ({
                  value,
                  label: t(`report.designer.format.${value}`),
                }))}
                onChange={(e) =>
                  setColumn(index, { format: e.currentTarget.value as DraftColumn["format"] })
                }
              />
              <Select
                data-part="align"
                label={t("report.designer.align")}
                value={c.align}
                options={ALIGNS.map((value) => ({
                  value,
                  label: t(`report.designer.align.${value}`),
                }))}
                onChange={(e) =>
                  setColumn(index, { align: e.currentTarget.value as DraftColumn["align"] })
                }
              />
              <TextField
                data-part="width"
                label={t("report.designer.width")}
                inputMode="numeric"
                dir="ltr"
                value={c.width}
                onChange={(e) => setColumn(index, { width: e.currentTarget.value })}
                {...errorAt(`/columns/${index}/width`)}
              />
              <Button
                data-part="up"
                disabled={index === 0}
                aria-keyshortcuts="Alt+ArrowUp"
                onClick={() => moveColumn(index, -1, "up")}
              >
                {t("report.designer.moveUp")}
              </Button>
              <Button
                data-part="down"
                disabled={index === current.columns.length - 1}
                aria-keyshortcuts="Alt+ArrowDown"
                onClick={() => moveColumn(index, 1, "down")}
              >
                {t("report.designer.moveDown")}
              </Button>
              {[`/columns/${index}`, `/columns/${index}/format`, `/columns/${index}/align`].map(
                (path) =>
                  fieldError(path) ? (
                    <p key={path} role="alert" className="text-start text-danger">
                      <bdi>{fieldError(path)}</bdi>
                    </p>
                  ) : null,
              )}
            </fieldset>
          ))}
        </div>
      </fieldset>
      <RuleList
        legend={t("report.designer.sort")}
        disabled={readOnly || busy}
        addLabel={t("report.designer.addSort")}
        canAdd={fields.length > 0}
        onAdd={() => edit((d) => ({ ...d, sort: [...d.sort, { field: fields[0]!, dir: "asc" }] }))}
        items={current.sort.map((rule, index) => ({
          key: `${index}`,
          error: fieldError(`/sort/${index}`) ?? fieldError(`/sort/${index}/field`),
          onRemove: () => edit((d) => ({ ...d, sort: d.sort.filter((_, i) => i !== index) })),
          removeLabel: t("report.designer.remove"),
          controls: (
            <>
              <Select
                label={t("report.designer.field")}
                value={rule.field}
                options={fieldChoices}
                onChange={(e) => {
                  const field = e.currentTarget.value;
                  edit((d) => ({
                    ...d,
                    sort: d.sort.map((r, i) => (i === index ? { ...r, field } : r)),
                  }));
                }}
              />
              <Select
                label={t("report.designer.dir")}
                value={rule.dir}
                options={SORT_DIRS.map((value) => ({
                  value,
                  label: t(`report.designer.dir.${value}`),
                }))}
                onChange={(e) => {
                  const dir = e.currentTarget.value as (typeof SORT_DIRS)[number];
                  edit((d) => ({
                    ...d,
                    sort: d.sort.map((r, i) => (i === index ? { ...r, dir } : r)),
                  }));
                }}
              />
            </>
          ),
        }))}
      />
      <RuleList
        legend={t("report.designer.groups")}
        disabled={readOnly || busy}
        addLabel={t("report.designer.addGroup")}
        canAdd={fields.length > 0}
        onAdd={() =>
          edit((d) => ({ ...d, groups: [...d.groups, { field: fields[0]!, subtotal: true }] }))
        }
        items={current.groups.map((rule, index) => ({
          key: `${index}`,
          error: fieldError(`/groups/${index}`) ?? fieldError(`/groups/${index}/field`),
          onRemove: () => edit((d) => ({ ...d, groups: d.groups.filter((_, i) => i !== index) })),
          removeLabel: t("report.designer.remove"),
          controls: (
            <>
              <Select
                label={t("report.designer.field")}
                value={rule.field}
                options={fieldChoices}
                onChange={(e) => {
                  const field = e.currentTarget.value;
                  edit((d) => ({
                    ...d,
                    groups: d.groups.map((r, i) => (i === index ? { ...r, field } : r)),
                  }));
                }}
              />
              <Checkbox
                label={t("report.designer.subtotal")}
                checked={rule.subtotal}
                onChange={(subtotal) =>
                  edit((d) => ({
                    ...d,
                    groups: d.groups.map((r, i) => (i === index ? { ...r, subtotal } : r)),
                  }))
                }
              />
            </>
          ),
        }))}
      />
      <RuleList
        legend={t("report.designer.totals")}
        disabled={readOnly || busy}
        addLabel={t("report.designer.addTotal")}
        canAdd={fields.length > 0}
        onAdd={() =>
          edit((d) => ({ ...d, totals: [...d.totals, { field: fields[0]!, fn: "sum" }] }))
        }
        items={current.totals.map((rule, index) => ({
          key: `${index}`,
          error: fieldError(`/totals/${index}`) ?? fieldError(`/totals/${index}/field`),
          onRemove: () => edit((d) => ({ ...d, totals: d.totals.filter((_, i) => i !== index) })),
          removeLabel: t("report.designer.remove"),
          controls: (
            <>
              <Select
                label={t("report.designer.field")}
                value={rule.field}
                options={fieldChoices}
                onChange={(e) => {
                  const field = e.currentTarget.value;
                  edit((d) => ({
                    ...d,
                    totals: d.totals.map((r, i) => (i === index ? { ...r, field } : r)),
                  }));
                }}
              />
              <Select
                label={t("report.designer.fn")}
                value={rule.fn}
                options={TOTAL_FNS.map((value) => ({
                  value,
                  label: t(`report.designer.fn.${value}`),
                }))}
                onChange={(e) => {
                  const fn = e.currentTarget.value as (typeof TOTAL_FNS)[number];
                  edit((d) => ({
                    ...d,
                    totals: d.totals.map((r, i) => (i === index ? { ...r, fn } : r)),
                  }));
                }}
              />
            </>
          ),
        }))}
      />
      <fieldset className="flex flex-col gap-3" disabled={readOnly || busy}>
        <legend className="text-start text-lg font-bold">{t("report.designer.page")}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t("report.designer.orientation")}
            value={current.layout.orientation}
            options={ORIENTATIONS.map((value) => ({
              value,
              label: t(`report.designer.orientation.${value}`),
            }))}
            onChange={(e) => {
              const orientation = e.currentTarget.value as Draft["layout"]["orientation"];
              edit((d) => ({ ...d, layout: { ...d.layout, orientation } }));
            }}
          />
          <Select
            label={t("report.designer.paper")}
            value={current.layout.paper}
            options={PAPERS.map((value) => ({ value, label: t(`report.designer.paper.${value}`) }))}
            onChange={(e) => {
              const paper = e.currentTarget.value as Draft["layout"]["paper"];
              edit((d) => ({ ...d, layout: { ...d.layout, paper } }));
            }}
          />
          <TextField
            label={t("report.designer.header")}
            hint={t("report.designer.placeholders")}
            value={current.layout.header}
            onChange={(e) => {
              const header = e.currentTarget.value;
              edit((d) => ({ ...d, layout: { ...d.layout, header } }));
            }}
            {...errorAt("/layout/header")}
          />
          <TextField
            label={t("report.designer.footer")}
            value={current.layout.footer}
            onChange={(e) => {
              const footer = e.currentTarget.value;
              edit((d) => ({ ...d, layout: { ...d.layout, footer } }));
            }}
            {...errorAt("/layout/footer")}
          />
        </div>
      </fieldset>
    </>
  ) : null;
  const unlisted = [...errors].filter(([path]) => !FIELD_PATH.test(path));

  return (
    <section className="flex flex-col gap-6" aria-label={t("report.designer.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-start text-xl font-bold">
          {t("report.designer.title")}
          {row ? (
            <>
              {" · "}
              <bdi>{localName(row.definition, locale)}</bdi>
            </>
          ) : null}
        </h1>
        <span className="flex flex-wrap gap-2">
          <Button onClick={() => leave(onBack)} aria-keyshortcuts="Escape">
            {t("report.back")}
          </Button>
          {row ? (
            <Button onClick={() => leave(() => onRun(code, row.id))}>{t("report.open")}</Button>
          ) : null}
        </span>
      </div>
      {row ? (
        <p className="text-start text-text-muted">
          <bdi dir="ltr">{code}</bdi> ·{" "}
          {t(row.isCore ? "report.versionCore" : "report.versionCopy", { version: row.version })}
          {row.archivedAt !== null ? ` · ${t("report.designer.archived")}` : ""}
        </p>
      ) : null}
      {error ? (
        <ProblemAlert error={error} hidePaths>
          {unlisted.length > 0 ? (
            <ul className="list-disc ps-6">
              {unlisted.map(([path, message]) => (
                <li key={path}>
                  <bdi dir="ltr">{path}</bdi> <bdi>{message}</bdi>
                </li>
              ))}
            </ul>
          ) : null}
          {failure === null ? (
            <Button onClick={() => void versions.refetch()}>{t("app.error.retry")}</Button>
          ) : null}
        </ProblemAlert>
      ) : null}
      {enabled && (versions.isPending || (row !== undefined && !ready)) ? (
        <p role="status">{t("app.loading")}</p>
      ) : null}
      {versions.isSuccess && row === undefined ? <p role="alert">{t("report.notFound")}</p> : null}
      {saved ? <p role="status">{t("report.designer.saved")}</p> : null}
      {asking ? (
        <div
          role="alertdialog"
          aria-labelledby="report-designer-unsaved"
          className="flex flex-wrap items-center gap-3"
        >
          <p id="report-designer-unsaved" className="text-start">
            {t("report.designer.unsavedQuestion")}
          </p>
          <Button variant="danger" onClick={discard}>
            {t("report.designer.discard")}
          </Button>
          <Button ref={keepRef} onClick={keepEditing}>
            {t("report.designer.keepEditing")}
          </Button>
        </div>
      ) : null}
      {row && readOnly ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-start">
            {t(row.isCore ? "report.designer.coreReadOnly" : "report.designer.archivedReadOnly")}
          </p>
          <Button ref={cloneRef} variant="primary" disabled={busy} onClick={clone}>
            {t("report.designer.clone")}
          </Button>
        </div>
      ) : null}
      {row && !readOnly ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={save} aria-keyshortcuts="Control+s">
            {t("report.designer.save")}
          </Button>
          <Button disabled={busy} onClick={() => leave(clone)}>
            {t("report.designer.cloneAgain")}
          </Button>
          {confirmArchive ? (
            <>
              <Button variant="danger" disabled={busy} onClick={archive}>
                {t("report.designer.confirmArchive")}
              </Button>
              <Button disabled={busy} onClick={() => setConfirmArchive(false)}>
                {t("report.designer.cancel")}
              </Button>
            </>
          ) : (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmArchive(true)}>
              {t("report.designer.archive")}
            </Button>
          )}
        </div>
      ) : null}
      {body}
    </section>
  );
}

interface RuleItem {
  key: string;
  error: string | undefined;
  controls: ReactNode;
  onRemove(): void;
  removeLabel: string;
}

/** One of the three rule lists — sort, groups, totals: rows of controls, each removable, and an Add button. */
function RuleList({
  legend,
  items,
  addLabel,
  canAdd,
  onAdd,
  disabled,
}: {
  legend: string;
  items: readonly RuleItem[];
  addLabel: string;
  canAdd: boolean;
  onAdd(): void;
  disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="text-start text-lg font-bold">{legend}</legend>
      {items.map((item) => (
        <div key={item.key} className="flex flex-wrap items-end gap-3">
          {item.controls}
          <Button onClick={item.onRemove}>{item.removeLabel}</Button>
          {item.error ? (
            <p role="alert" className="text-start text-danger">
              <bdi>{item.error}</bdi>
            </p>
          ) : null}
        </div>
      ))}
      <span>
        <Button disabled={!canAdd} onClick={onAdd}>
          {addLabel}
        </Button>
      </span>
    </fieldset>
  );
}
