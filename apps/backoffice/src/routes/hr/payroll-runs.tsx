import type { EmployeeDto } from "@dulja/contracts/hr/employee";
import type { PayrollRunDto } from "@dulja/contracts/hr/payroll-run";
import { formatDate } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { isForbidden, useSubmit } from "../../features/hr/shared";
import { Checkbox, ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { payrollApi, type PayrollApi, type PayrollRunStatus } from "../../lib/payroll-api";
import { retryQuery } from "../../lib/problem";
import type { TranslationKey } from "@dulja/i18n";

type RunListItem = Omit<PayrollRunDto, "lines" | "overrides" | "compensationChangedBy">;
type Kind = PayrollRunDto["kind"];

export const RUN_STATUSES: readonly PayrollRunStatus[] = [
  "draft",
  "submitted",
  "approved",
  "posted",
  "issued",
  "void",
  "reversed",
];
const KINDS: readonly Kind[] = ["regular", "supplementary", "final"];

/** `payroll.status.<status>` — one key per document status, so a status never reaches the screen raw. */
export const statusKey = (status: PayrollRunStatus) => `payroll.status.${status}` as TranslationKey;
export const kindKey = (kind: Kind) => `payroll.kind.${kind}` as TranslationKey;

/** The calendar month containing `today`, in UTC: the default period of a new run. */
export function monthOf(today: Date = new Date()): { start: string; end: string } {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const mm = String(month + 1).padStart(2, "0");
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, "0")}` };
}

/**
 * 8B Task 15 — the payroll run register and "new run" (⚠️ OD-24, built on the owner-authorized default baseline of
 * 2026-11-07; `docs/ui/od-24-phase-8b.md`). Every run is a PAYROLL document: calculated here as a DRAFT, then opened
 * in its own screen to be checked, overridden, recalculated, submitted, approved and posted through the shared
 * document transitions. Newest period first; a status filter narrows the register.
 */
export function PayrollRunsRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <PayrollRuns api={api} company={company} />}
    </StaffContextPicker>
  );
}

function PayrollRuns({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const navigate = useNavigate();
  const client = useMemo(() => payrollApi(api, company.id), [api, company.id]);
  const [status, setStatus] = useState<PayrollRunStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  // Every page, as 6C's directory reads them: the register is the whole of the filtered list, newest period first.
  const runs = useInfiniteQuery({
    queryKey: ["payroll-runs", company.id, status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.runs({ status, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.next_cursor,
    retry: retryQuery,
  });
  useEffect(() => {
    if (runs.hasNextPage && !runs.isFetchingNextPage && !runs.isFetchNextPageError)
      void runs.fetchNextPage();
  }, [runs.hasNextPage, runs.isFetchingNextPage, runs.isFetchNextPageError, runs.fetchNextPage]);
  useRefusalRedirect(runs.error);
  const close = () => {
    setCreating(false);
    queueMicrotask(() => opener.current?.focus());
  };
  const open = (documentId: string) =>
    void navigate({
      to: "/hr/payroll-runs/$documentId",
      params: { documentId },
      search: { company: company.id },
    });
  const columns: Column<RunListItem>[] = [
    {
      key: "period",
      header: t("payroll.period"),
      cell: (row) => (
        <bdi>
          {t("payroll.periodRange", {
            start: formatDate(row.periodStart, { locale }),
            end: formatDate(row.periodEnd, { locale }),
          })}
        </bdi>
      ),
    },
    { key: "kind", header: t("payroll.kind"), cell: (row) => t(kindKey(row.kind)) },
    { key: "status", header: t("staff.status"), cell: (row) => t(statusKey(row.status)) },
    {
      key: "number",
      header: t("payroll.number"),
      cell: (row) =>
        row.number ? <bdi>{`${row.series}-${row.number}`}</bdi> : t("payroll.unnumbered"),
    },
    {
      key: "payDate",
      header: t("payroll.payDate"),
      cell: (row) => <bdi>{formatDate(row.payDate, { locale })}</bdi>,
    },
  ];
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("payroll.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && creating) {
          event.preventDefault();
          close();
        }
      }}
    >
      <h1 className="text-start text-xl font-bold">{t("payroll.title")}</h1>
      <p className="text-start text-text-muted">{t("payroll.intro")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t("payroll.filterStatus")}
          value={status ?? ""}
          options={[
            { value: "", label: t("payroll.allStatuses") },
            ...RUN_STATUSES.map((value) => ({ value, label: t(statusKey(value)) })),
          ]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setStatus(value === "" ? null : (value as PayrollRunStatus));
          }}
        />
        {creating ? null : (
          <span>
            <Button ref={opener} variant="primary" onClick={() => setCreating(true)}>
              {t("payroll.new")}
            </Button>
          </span>
        )}
      </div>
      {creating ? (
        <CreateRunForm
          client={client}
          company={company}
          onClose={close}
          onCreated={(run) => open(run.documentId)}
        />
      ) : null}
      {runs.error ? (
        isForbidden(runs.error) ? (
          <p role="status">{t("payroll.denied")}</p>
        ) : (
          <ProblemAlert error={runs.error} />
        )
      ) : null}
      {runs.isPending ? <p role="status">{t("app.loading")}</p> : null}
      <DataGrid
        caption={t("payroll.list")}
        columns={columns}
        rows={runs.data?.pages.flatMap((page) => page.items) ?? []}
        rowKey={(row) => row.documentId}
        emptyLabel={t("payroll.none")}
        onActivate={(row) => open(row.documentId)}
      />
    </section>
  );
}

/** Every employee of the company's branches, every page — the people a supplementary or final run may name. */
async function allEmployees(
  client: PayrollApi,
  company: StaffCompany,
  signal: AbortSignal,
): Promise<EmployeeDto[]> {
  const out: EmployeeDto[] = [];
  for (const branch of company.branches) {
    let cursor: string | null = null;
    do {
      const page = await client.employees(branch.id, cursor, { signal });
      out.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor !== null);
  }
  return out.toSorted((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
}

function CreateRunForm({
  client,
  company,
  onClose,
  onCreated,
}: {
  client: PayrollApi;
  company: StaffCompany;
  onClose: () => void;
  onCreated: (run: PayrollRunDto) => void;
}) {
  const { t } = useShell();
  const month = useMemo(() => monthOf(), []);
  const [kind, setKind] = useState<Kind>("regular");
  const [periodStart, setPeriodStart] = useState(month.start);
  const [periodEnd, setPeriodEnd] = useState(month.end);
  const [payDate, setPayDate] = useState(month.end);
  const [effectiveDate, setEffectiveDate] = useState(month.end);
  const [branchId, setBranchId] = useState(company.branches[0]?.id ?? "");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [noneChosen, setNoneChosen] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);
  const named = kind !== "regular";
  const employees = useQuery({
    queryKey: ["payroll-employees", company.id],
    queryFn: ({ signal }) => allEmployees(client, company, signal),
    retry: retryQuery,
    enabled: named,
  });
  async function calculate(event: FormEvent) {
    event.preventDefault();
    if (named && chosen.size === 0) {
      setNoneChosen(true);
      return;
    }
    setNoneChosen(false);
    const body = {
      kind,
      periodStart,
      periodEnd,
      payDate,
      effectiveDate,
      branchId,
      ...(named ? { employeeIds: [...chosen] } : {}),
    };
    const run = await submit.run(body, (idempotencyKey) => client.create(body, { idempotencyKey }));
    if (run) onCreated(run);
  }
  return (
    <form
      aria-label={t("payroll.new")}
      className="grid grid-cols-1 gap-3 md:grid-cols-3"
      onSubmit={(event) => void calculate(event)}
    >
      <label className="flex flex-col gap-1 text-start text-text">
        {t("payroll.kind")}
        <select
          ref={first}
          className="rounded-sm border border-border bg-surface px-3 py-2 text-start text-text"
          value={kind}
          disabled={submit.busy}
          onChange={(event) => setKind(event.currentTarget.value as Kind)}
        >
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {t(kindKey(value))}
            </option>
          ))}
        </select>
      </label>
      <TextField
        label={t("payroll.periodStart")}
        type="date"
        required
        value={periodStart}
        disabled={submit.busy}
        onChange={(event) => setPeriodStart(event.currentTarget.value)}
      />
      <TextField
        label={t("payroll.periodEnd")}
        type="date"
        required
        value={periodEnd}
        disabled={submit.busy}
        onChange={(event) => setPeriodEnd(event.currentTarget.value)}
      />
      <TextField
        label={t("payroll.payDate")}
        type="date"
        required
        value={payDate}
        disabled={submit.busy}
        onChange={(event) => setPayDate(event.currentTarget.value)}
      />
      <TextField
        label={t("payroll.effectiveDate")}
        type="date"
        required
        value={effectiveDate}
        disabled={submit.busy}
        onChange={(event) => setEffectiveDate(event.currentTarget.value)}
      />
      <Select
        label={t("payroll.branch")}
        value={branchId}
        disabled={submit.busy}
        options={company.branches.map((branch) => ({
          value: branch.id,
          label: branch.code,
        }))}
        onChange={(event) => setBranchId(event.currentTarget.value)}
      />
      <p className="text-start text-text-muted md:col-span-3">{t("payroll.employeesHint")}</p>
      {named ? (
        <fieldset className="flex flex-col gap-2 md:col-span-3">
          <legend className="text-start">{t("payroll.employees")}</legend>
          {isForbidden(employees.error) ? (
            <p role="status">{t("payroll.employeesDenied")}</p>
          ) : employees.error ? (
            <ProblemAlert error={employees.error} />
          ) : null}
          {employees.isPending ? <p role="status">{t("app.loading")}</p> : null}
          {(employees.data ?? []).map((employee) => (
            <Checkbox
              key={employee.id}
              label={employee.employeeNumber}
              checked={chosen.has(employee.id)}
              disabled={submit.busy}
              onChange={(checked) =>
                setChosen((previous) => {
                  const next = new Set(previous);
                  if (checked) next.add(employee.id);
                  else next.delete(employee.id);
                  return next;
                })
              }
            />
          ))}
          {noneChosen ? (
            <p role="alert" className="text-start text-danger">
              {t("payroll.employeesNone")}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {submit.failure ? (
        <div className="md:col-span-3">
          <ProblemAlert error={submit.failure} />
        </div>
      ) : null}
      <div className="flex gap-2 md:col-span-3">
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("payroll.calculate")}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("hr.cancel")}
        </Button>
      </div>
    </form>
  );
}
