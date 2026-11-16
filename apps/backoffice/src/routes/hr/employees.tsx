import { CreateEmployeeBody, type EmployeeDto } from "@dulja/contracts/hr/employee";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffFailure } from "../../components/staff-failure";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import type { AdminApiOptions } from "../../lib/admin-api";
import { staffApi } from "../../lib/staff-api";
import { retryQuery } from "../../lib/problem";

export function EmployeesRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <EmployeeDirectory api={api} company={company} />}
    </StaffContextPicker>
  );
}
function EmployeeDirectory({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const client = useMemo(() => staffApi(api, company.id), [api, company.id]);
  const [branchId, setBranchId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EmployeeDto | null>(null);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["staff-employees", company.id, branchId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => client.employees(branchId, pageParam, { signal }),
    getNextPageParam: (page) => page.next_cursor,
    retry: retryQuery,
  });
  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError)
      void query.fetchNextPage();
  }, [
    query.hasNextPage,
    query.isFetchingNextPage,
    query.isFetchNextPageError,
    query.fetchNextPage,
  ]);
  const rows = (query.data?.pages.flatMap((page) => page.items) ?? []).filter((employee) =>
    employee.employeeNumber.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)),
  );
  const columns: Column<EmployeeDto>[] = [
    {
      key: "number",
      header: t("staff.employeeNumber"),
      cell: (employee) => employee.employeeNumber,
    },
    {
      key: "branch",
      header: t("staff.branch"),
      cell: (employee) => {
        const branch = company.branches.find((value) => value.id === employee.homeBranchId);
        return branch
          ? locale === "ar"
            ? (branch.nameAr ?? branch.nameEn)
            : branch.nameEn
          : t("staff.unavailableBranch");
      },
    },
    { key: "hired", header: t("staff.hiredOn"), cell: (employee) => employee.hiredOn },
    {
      key: "status",
      header: t("staff.status"),
      cell: (employee) => t(employee.terminatedOn ? "staff.terminated" : "staff.active"),
    },
  ];
  function close() {
    setSelected(null);
    setCreating(false);
    queueMicrotask(() => {
      if (restore.current?.isConnected) restore.current.focus();
    });
  }
  return (
    <section
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (selected || creating)) {
          event.preventDefault();
          close();
        }
        if (
          event.key === "/" &&
          !(event.target instanceof HTMLInputElement) &&
          !(event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }}
    >
      <h1>{t("staff.employees")}</h1>
      <TextField
        ref={searchRef}
        label={t("staff.search")}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      <Select
        label={t("staff.branch")}
        value={branchId}
        options={[
          { value: "", label: t("staff.allBranches") },
          ...company.branches.map((branch) => ({
            value: branch.id,
            label: locale === "ar" ? (branch.nameAr ?? branch.nameEn) : branch.nameEn,
          })),
        ]}
        onChange={(event) => {
          setSelected(null);
          setBranchId(event.currentTarget.value);
        }}
      />
      <Button
        onClick={(event) => {
          restore.current = event.currentTarget;
          setCreating(true);
          setSelected(null);
        }}
      >
        {t("staff.createEmployee")}
      </Button>
      {/*
        UI-13: a refused or failed list is not an empty one. The refusal is shown alone — `StaffFailure` sends
        a dead session to sign-in and an assurance refusal to enrolment — with a retry, and the grid (and its
        "No employees found") only once there is a list to show.
      */}
      {query.error || query.isFetchNextPageError ? (
        <>
          <StaffFailure cause={query.error ?? query.failureReason} />
          <Button
            onClick={() => {
              if (query.isFetchNextPageError) void query.fetchNextPage();
              else void query.refetch();
            }}
          >
            {t("app.error.retry")}
          </Button>
        </>
      ) : query.isPending || query.isFetchingNextPage ? (
        <p>{t("app.loading")}</p>
      ) : null}
      {query.error || query.isFetchNextPageError || query.isPending ? null : (
        <DataGrid
          caption={t("staff.employees")}
          columns={columns}
          rows={rows}
          rowKey={(employee) => employee.id}
          emptyLabel={t("staff.noEmployees")}
          onActivate={(employee) => {
            restore.current = document.activeElement as HTMLElement;
            setSelected(employee);
            setCreating(false);
          }}
        />
      )}
      {selected ? (
        <EmployeeDetails employee={selected} companyId={company.id} onClose={close} />
      ) : null}
      {creating ? (
        <CreateEmployeeForm
          client={client}
          company={company}
          onClose={close}
          onSaved={() => {
            close();
            void query.refetch();
          }}
        />
      ) : null}
    </section>
  );
}
function EmployeeDetails({
  employee,
  companyId,
  onClose,
}: {
  employee: EmployeeDto;
  companyId: string;
  onClose: () => void;
}) {
  const { t } = useShell();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <section aria-label={t("staff.employeeDetails")} className="flex flex-col gap-2">
      <h2>{employee.employeeNumber}</h2>
      <p>
        {t("staff.hiredOn")}: {employee.hiredOn}
      </p>
      <p>{t(employee.terminatedOn ? "staff.terminated" : "staff.active")}</p>
      {/* 8A Task 13: the HR record — identity, statutory profile and compensation — has its own screen. */}
      <Link
        to="/hr/employees/$employeeId"
        params={{ employeeId: employee.id }}
        search={{ company: companyId }}
        className="text-start text-accent"
      >
        {t("hr.record.open")}
      </Link>
      <Button ref={closeRef} onClick={onClose}>
        {t("staff.close")}
      </Button>
    </section>
  );
}
function CreateEmployeeForm({
  client,
  company,
  onSaved,
  onClose,
}: {
  client: ReturnType<typeof staffApi>;
  company: StaffCompany;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useShell();
  const [number, setNumber] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [branch, setBranch] = useState(company.branches[0]?.id ?? "");
  const [hiredOn, setHiredOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const controller = useRef(new AbortController());
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    numberRef.current?.focus();
    return () => active.abort();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    try {
      const body = CreateEmployeeBody.parse({
        employeeNumber: number,
        nameEn,
        ...(nameAr ? { nameAr } : {}),
        homeBranchId: branch,
        hiredOn,
      });
      const fingerprint = JSON.stringify(body);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, key: crypto.randomUUID() };
      setBusy(true);
      await client.createEmployee(body, {
        idempotencyKey: attempt.current.key,
        signal: controller.current.signal,
      });
      if (!controller.current.signal.aborted) onSaved();
    } catch (cause) {
      if (!controller.current.signal.aborted) setFailure(cause);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <form
      aria-label={t("staff.createEmployee")}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-3"
    >
      <TextField
        ref={numberRef}
        label={t("staff.employeeNumber")}
        value={number}
        required
        maxLength={40}
        disabled={busy}
        onChange={(event) => setNumber(event.currentTarget.value)}
      />
      <TextField
        label={t("staff.nameEn")}
        value={nameEn}
        required
        maxLength={200}
        disabled={busy}
        onChange={(event) => setNameEn(event.currentTarget.value)}
      />
      <TextField
        label={t("staff.nameAr")}
        value={nameAr}
        maxLength={200}
        disabled={busy}
        onChange={(event) => setNameAr(event.currentTarget.value)}
      />
      <Select
        label={t("staff.homeBranch")}
        value={branch}
        disabled={busy}
        options={company.branches.map((value) => ({
          value: value.id,
          label: locale === "ar" ? (value.nameAr ?? value.nameEn) : value.nameEn,
        }))}
        onChange={(event) => setBranch(event.currentTarget.value)}
      />
      <TextField
        label={t("staff.hiredOn")}
        type="date"
        value={hiredOn}
        required
        disabled={busy}
        onChange={(event) => setHiredOn(event.currentTarget.value)}
      />
      {failure ? <StaffFailure cause={failure} /> : null}
      <Button type="submit" disabled={busy}>
        {t("staff.save")}
      </Button>
      <Button type="button" onClick={onClose}>
        {t("staff.close")}
      </Button>
    </form>
  );
}
