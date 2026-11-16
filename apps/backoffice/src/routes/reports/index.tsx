import type { ReportDefinitionDto } from "@dulja/contracts";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../components/app-shell";
import {
  isTyping,
  localName,
  ProblemAlert,
  useRefusalRedirect,
} from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { retryQuery } from "../../lib/problem";
import { createReportApi } from "../../lib/report-api";

/** Where the list sends the operator: the run screen or the designer of one definition row. */
export interface ReportNavigation {
  run(code: string, definitionId: string): void;
  design(code: string, definitionId: string): void;
}

/**
 * 7A Task 15 — the report list, over `GET /v1/companies/{companyId}/report-definitions`, built on the owner's
 * authorized default baseline (2026-11-06; `docs/ui/od-24-phase-7a.md`). Every live definition row is listed —
 * a core row and the tenant's own copies of it side by side, each with its version — because a run and a design
 * are of one row, not of a code. A company or session switch remounts it, discarding the filter.
 */
export function ReportsRoute(props: {
  api: AdminApiOptions;
  companyId: string;
  navigation: ReportNavigation;
  /** 8D T10 — the module the list opens on (`?module=hr`, the HR reports entry); null for every module. */
  module?: string | null;
}) {
  return (
    <ReportList
      key={`${props.companyId}:${props.module ?? ""}`}
      {...props}
      module={props.module ?? null}
    />
  );
}

/** §4.11.1's four modules, in the nav's order. */
const MODULES = ["accounting", "inventory", "hr", "pos"] as const;

function ReportList({
  api,
  companyId,
  navigation,
  module: initialModule,
}: {
  api: AdminApiOptions;
  companyId: string;
  navigation: ReportNavigation;
  module: string | null;
}) {
  const { t, locale } = useShell();
  const client = useMemo(() => createReportApi(api, companyId), [api, companyId]);
  const enabled = companyId !== "" && api.accessToken() !== null;
  const [filter, setFilter] = useState("");
  const [module, setModule] = useState<string>(
    MODULES.some((m) => m === initialModule) ? (initialModule ?? "") : "",
  );
  const filterField = useRef<HTMLInputElement>(null);
  const list = useInfiniteQuery({
    queryKey: ["report-definitions", companyId, "list"],
    enabled,
    retry: retryQuery,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.definitions(pageParam, null, { signal }),
    getNextPageParam: (page) => page.next_cursor,
  });
  useRefusalRedirect(list.error);
  // "/" puts the cursor in the filter from anywhere on the screen, the sibling screens' default.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key !== "/") return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      filterField.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needle = filter.trim().toLocaleLowerCase();
  const rows = (list.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (row) =>
      (module === "" || row.definition.module === module) &&
      (needle === "" ||
        row.code.toLocaleLowerCase().includes(needle) ||
        row.definition.nameEn.toLocaleLowerCase().includes(needle) ||
        row.definition.nameAr.includes(filter.trim())),
  );
  const columns: Column<ReportDefinitionDto>[] = [
    {
      key: "name",
      header: t("report.name"),
      cell: (row) => <bdi>{localName(row.definition, locale)}</bdi>,
    },
    { key: "code", header: t("report.code"), cell: (row) => <bdi dir="ltr">{row.code}</bdi> },
    {
      key: "module",
      header: t("report.module"),
      cell: (row) => t(`report.module.${row.definition.module}`),
    },
    { key: "version", header: t("report.version"), align: "end", cell: (row) => row.version },
    {
      key: "kind",
      header: t("report.kind"),
      cell: (row) => t(row.isCore ? "report.kind.core" : "report.kind.copy"),
    },
    {
      key: "actions",
      header: t("report.actions"),
      cell: (row) => (
        // A key on a button is the button's: without stopping it here the grid's own Enter would also run
        // the row, and Enter on "Design" would open both screens.
        <span className="flex gap-2" onKeyDown={(event) => event.stopPropagation()}>
          <Button onClick={() => navigation.run(row.code, row.id)}>{t("report.open")}</Button>
          <Button onClick={() => navigation.design(row.code, row.id)}>{t("report.design")}</Button>
        </span>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-6" aria-label={t("report.title")}>
      <h1 className="text-start text-xl font-bold">{t("report.title")}</h1>
      {companyId === "" ? <p role="status">{t("report.companyUnknown")}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          ref={filterField}
          label={t("report.filter")}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          aria-keyshortcuts="/"
        />
        <Select
          label={t("report.module")}
          value={module}
          options={[
            { value: "", label: t("report.module.all") },
            ...MODULES.map((value) => ({ value, label: t(`report.module.${value}`) })),
          ]}
          onChange={(event) => setModule(event.currentTarget.value)}
        />
      </div>
      {list.error ? (
        <ProblemAlert error={list.error}>
          <Button onClick={() => void list.refetch()}>{t("app.error.retry")}</Button>
        </ProblemAlert>
      ) : null}
      {enabled && list.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {/*
        Enter runs the row the cursor is on (the grid's own activation); Shift+Enter designs it. Taken in the
        capture phase so the grid never also runs it. The grid hands focus to the cell, not to a button inside
        it, so this — not the row's Design button — is the keyboard path to the designer.
      */}
      <div
        onKeyDownCapture={(event) => {
          if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.altKey) return;
          const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
          const row = rows[Number.parseInt(cell?.dataset["cell"]?.split(":")[0] ?? "", 10)];
          if (row === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          navigation.design(row.code, row.id);
        }}
      >
        <DataGrid
          caption={t("report.list")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyLabel={t("report.empty")}
          onActivate={(row) => navigation.run(row.code, row.id)}
        />
      </div>
      <p className="text-start text-text-muted">{t("report.keys")}</p>
      {list.hasNextPage ? (
        <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t("report.more")}
        </Button>
      ) : null}
    </section>
  );
}
