import type { EmployeeDto } from "@dulja/contracts/hr/employee";
import type {
  LeaveEntitlementDto,
  LeaveRecordDto,
  LeaveTypeDto,
  PublicHolidayDto,
} from "@dulja/contracts/hr/leave";
import { formatDate, type TranslationKey } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { isForbidden, useSubmit } from "../../features/hr/shared";
import { Checkbox, ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { leaveApi, type LeaveApi, type LeaveStatus } from "../../lib/leave-api";
import { retryQuery } from "../../lib/problem";

const STATUSES: readonly LeaveStatus[] = ["requested", "approved", "rejected"];
const TYPE_CODES = ["annual", "sick", "unpaid", "other"] as const;
type TypeCode = (typeof TYPE_CODES)[number];

export const leaveStatusKey = (status: LeaveStatus) => `leave.status.${status}` as TranslationKey;
const typeCodeKey = (code: TypeCode) => `leave.code.${code}` as TranslationKey;

/**
 * A typed day count as the wire's `numeric(6,2)` string ("1" → "1.00", "0.5" → "0.50"); exact, never through a float.
 * Null for anything the route would refuse by shape.
 */
export function daysToWire(value: string): string | null {
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

/** The calendar year of `today`, in UTC — the default entitlement year. */
export const yearOf = (today: Date = new Date()): number => today.getUTCFullYear();

/** Every employee of the company's branches, every page — the people a leave request or an entitlement may name. */
async function allEmployees(
  client: LeaveApi,
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
  return out.toSorted((a, b) =>
    a.employeeNumber < b.employeeNumber ? -1 : a.employeeNumber > b.employeeNumber ? 1 : 0,
  );
}

/**
 * 8D Task 10 — the leave register (⚠️ OD-13 answered build, ⚠️ OD-24 the owner-authorized default baseline of
 * 2026-11-07; `docs/ui/od-24-phase-8d.md`) over 8D T8's `/v1/companies/{companyId}/leave-records`: leave records
 * (request; approve or reject by a DIFFERENT person — R4 is the database's answer, shown as the server words it),
 * the yearly entitlements HR enters, the company's leave types and its public holidays. Leave is a record, never a
 * pay input (spec:2085): nothing here reaches a payroll run.
 */
export function LeaveRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <Leave api={api} company={company} />}
    </StaffContextPicker>
  );
}

function Leave({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t } = useShell();
  const client = useMemo(() => leaveApi(api, company.id), [api, company.id]);
  const scope = [company.id] as const;
  const types = useQuery({
    queryKey: ["leave-types", ...scope],
    queryFn: ({ signal }) => client.types({ signal }),
    retry: retryQuery,
  });
  const employees = useQuery({
    queryKey: ["leave-employees", ...scope],
    queryFn: ({ signal }) => allEmployees(client, company, signal),
    retry: retryQuery,
  });
  useRefusalRedirect(types.error ?? employees.error);
  const context: Context = {
    client,
    company,
    scope,
    types: types.data?.items ?? [],
    typesDenied: isForbidden(types.error),
    employees: employees.data ?? [],
  };
  return (
    <section className="flex flex-col gap-8" aria-label={t("leave.title")}>
      <h1 className="text-start text-xl font-bold">{t("leave.title")}</h1>
      <p className="text-start text-text-muted">{t("leave.intro")}</p>
      <Records context={context} />
      <Entitlements context={context} />
      <Types context={context} error={types.error} pending={types.isPending} />
      <Holidays context={context} />
    </section>
  );
}

interface Context {
  client: LeaveApi;
  company: StaffCompany;
  scope: readonly unknown[];
  types: readonly LeaveTypeDto[];
  typesDenied: boolean;
  employees: readonly EmployeeDto[];
}

/** A section's own refusal: a 403 is a sentence naming the code, anything else the server's problem. */
function Refusal({ error, denied }: { error: unknown; denied: TranslationKey }) {
  const { t } = useShell();
  if (!error) return null;
  return isForbidden(error) ? <p role="status">{t(denied)}</p> : <ProblemAlert error={error} />;
}

/** Opens a section's form, focuses its first control, and on Esc or Cancel closes it and returns the cursor. */
function useToggle<T extends HTMLElement>() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef<T>(null);
  const returning = useRef(false);
  // After the render that closed the form — the opener is rendered again only then.
  useEffect(() => {
    if (open) first.current?.focus();
    else if (returning.current) {
      returning.current = false;
      opener.current?.focus();
    }
  }, [open]);
  const close = () => {
    returning.current = true;
    setOpen(false);
  };
  return { open, setOpen, opener, first, close };
}

function FormShell({
  label,
  onSubmit,
  onClose,
  busy,
  failure,
  saveLabel,
  children,
}: {
  label: string;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  busy: boolean;
  failure: unknown;
  saveLabel: string;
  children: ReactNode;
}) {
  const { t } = useShell();
  return (
    <form
      aria-label={label}
      className="grid grid-cols-1 gap-3 md:grid-cols-3"
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {children}
      {failure ? (
        <div className="md:col-span-3">
          <ProblemAlert error={failure} />
        </div>
      ) : null}
      <div className="flex gap-2 md:col-span-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {saveLabel}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("hr.cancel")}
        </Button>
      </div>
    </form>
  );
}

const SELECT =
  "rounded-sm border border-border bg-surface px-3 py-2 text-start text-text disabled:opacity-50";

function EmployeeSelect({
  employees,
  value,
  onChange,
  disabled,
  selectRef,
}: {
  employees: readonly EmployeeDto[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  selectRef?: Ref<HTMLSelectElement>;
}) {
  const { t } = useShell();
  return (
    <label className="flex flex-col gap-1 text-start text-text">
      {t("leave.employee")}
      <select
        ref={selectRef}
        className={SELECT}
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">{t("leave.choose")}</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.employeeNumber}
          </option>
        ))}
      </select>
    </label>
  );
}

function TypeSelect({
  types,
  value,
  onChange,
  disabled,
}: {
  types: readonly LeaveTypeDto[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t, locale } = useShell();
  return (
    <Select
      label={t("leave.type")}
      required
      value={value}
      disabled={disabled}
      options={[
        { value: "", label: t("leave.choose") },
        ...types.map((type) => ({ value: type.id, label: typeName(type, locale) })),
      ]}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

const typeName = (type: LeaveTypeDto, locale: string): string =>
  locale === "ar" && type.nameAr !== null ? type.nameAr : type.nameEn;

// ── Leave records ───────────────────────────────────────────────────────────────────────────────────────────────

function Records({ context }: { context: Context }) {
  const { t, locale } = useShell();
  const { client, scope } = context;
  const cache = useQueryClient();
  const [status, setStatus] = useState<LeaveStatus | null>("requested");
  const records = useQuery({
    queryKey: ["leave-records", ...scope, status],
    queryFn: ({ signal }) => client.records({ status }, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(records.error);
  const decide = useSubmit();
  useRefusalRedirect(decide.failure);
  const [rejecting, setRejecting] = useState<LeaveRecordDto | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const rejectRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rejecting !== null) rejectRef.current?.focus();
  }, [rejecting]);
  const [decided, setDecided] = useState<LeaveRecordDto | null>(null);
  // The keyboard path: the grid keeps focus on its cells (a button inside one is the mouse's), so Enter on a
  // requested row puts that record "in hand" — a decision panel below the grid whose Approve takes the cursor.
  const [inHand, setInHand] = useState<LeaveRecordDto | null>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (inHand !== null) approveRef.current?.focus();
  }, [inHand]);
  const form = useToggle<HTMLSelectElement>();
  const refresh = () => cache.invalidateQueries({ queryKey: ["leave-records", ...scope] });

  async function send(record: LeaveRecordDto, decision: "approved" | "rejected", reason: string) {
    setDecided(null);
    const body = { decision, ...(reason === "" ? {} : { reason }) };
    const result = await decide.run({ record: record.id, ...body }, (idempotencyKey) =>
      client.decide(record.id, body, { idempotencyKey }),
    );
    if (result !== undefined) {
      setDecided(result);
      setRejecting(null);
      setInHand(null);
      setRejectReason("");
      await refresh();
    }
  }
  const typeLabel = (record: LeaveRecordDto): string => {
    const type = context.types.find((x) => x.id === record.leaveTypeId);
    return type ? typeName(type, locale) : t(typeCodeKey(record.leaveTypeCode));
  };
  const columns: Column<LeaveRecordDto>[] = [
    {
      key: "employee",
      header: t("leave.employee"),
      cell: (r) => <bdi>{r.employeeNumber}</bdi>,
    },
    { key: "type", header: t("leave.type"), cell: (r) => <bdi>{typeLabel(r)}</bdi> },
    {
      key: "dates",
      header: t("leave.dates"),
      cell: (r) => (
        <bdi>
          {t("leave.range", {
            start: formatDate(r.startsOn, { locale }),
            end: formatDate(r.endsOn, { locale }),
          })}
        </bdi>
      ),
    },
    { key: "days", header: t("leave.days"), align: "end", cell: (r) => <bdi>{r.days}</bdi> },
    {
      key: "status",
      header: t("leave.status"),
      cell: (r) => <span data-testid={`leave-status-${r.id}`}>{t(leaveStatusKey(r.status))}</span>,
    },
    { key: "reason", header: t("leave.reason"), cell: (r) => <bdi>{r.reason ?? ""}</bdi> },
    {
      key: "actions",
      header: t("leave.actions"),
      cell: (r) =>
        r.status === "requested" ? (
          // A key on a button is the button's: the grid's own Enter must not also act on the row.
          <span className="flex gap-2" onKeyDown={(event) => event.stopPropagation()}>
            <Button
              disabled={decide.busy}
              onClick={() => void send(r, "approved", "")}
              aria-label={t("leave.approveOne", { employee: r.employeeNumber })}
            >
              {t("leave.approve")}
            </Button>
            <Button
              disabled={decide.busy}
              onClick={() => setRejecting(r)}
              aria-label={t("leave.rejectOne", { employee: r.employeeNumber })}
            >
              {t("leave.reject")}
            </Button>
          </span>
        ) : (
          ""
        ),
    },
  ];
  return (
    <section className="flex flex-col gap-3" aria-label={t("leave.records")}>
      <h2 className="text-start text-lg font-bold">{t("leave.records")}</h2>
      <p className="text-start text-text-muted">{t("leave.recordsHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t("leave.filterStatus")}
          value={status ?? ""}
          options={[
            { value: "", label: t("leave.allStatuses") },
            ...STATUSES.map((value) => ({ value, label: t(leaveStatusKey(value)) })),
          ]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setStatus(value === "" ? null : (value as LeaveStatus));
          }}
        />
        {form.open ? null : (
          <span>
            <Button ref={form.opener} variant="primary" onClick={() => form.setOpen(true)}>
              {t("leave.new")}
            </Button>
          </span>
        )}
      </div>
      {form.open ? <RequestForm context={context} toggle={form} onSaved={refresh} /> : null}
      {rejecting !== null ? (
        <form
          aria-label={t("leave.rejectTitle", { employee: rejecting.employeeNumber })}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(rejecting, "rejected", rejectReason.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setRejecting(null);
            }
          }}
        >
          <TextField
            ref={rejectRef}
            label={t("leave.rejectReason")}
            maxLength={500}
            value={rejectReason}
            disabled={decide.busy}
            onChange={(event) => setRejectReason(event.currentTarget.value)}
          />
          <Button type="submit" variant="primary" disabled={decide.busy}>
            {t("leave.reject")}
          </Button>
          <Button type="button" onClick={() => setRejecting(null)}>
            {t("hr.cancel")}
          </Button>
        </form>
      ) : null}
      {inHand !== null && rejecting === null ? (
        <section
          aria-label={t("leave.decideTitle", { employee: inHand.employeeNumber })}
          className="flex flex-wrap items-center gap-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setInHand(null);
            }
          }}
        >
          <p className="text-start">
            <bdi>
              {t("leave.decideTitle", { employee: inHand.employeeNumber })} —{" "}
              {t("leave.range", {
                start: formatDate(inHand.startsOn, { locale }),
                end: formatDate(inHand.endsOn, { locale }),
              })}
            </bdi>
          </p>
          <Button
            ref={approveRef}
            variant="primary"
            disabled={decide.busy}
            onClick={() => void send(inHand, "approved", "")}
          >
            {t("leave.approve")}
          </Button>
          <Button disabled={decide.busy} onClick={() => setRejecting(inHand)}>
            {t("leave.reject")}
          </Button>
          <Button onClick={() => setInHand(null)}>{t("hr.cancel")}</Button>
        </section>
      ) : null}
      {decided !== null ? (
        <p role="status" className="text-start">
          {t("leave.decided", {
            employee: decided.employeeNumber,
            status: t(leaveStatusKey(decided.status)),
          })}
        </p>
      ) : null}
      {decide.failure ? <ProblemAlert error={decide.failure} /> : null}
      <Refusal error={records.error} denied="leave.denied" />
      {records.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {records.data?.complete === false ? (
        <p role="status" className="text-start text-text-muted">
          {t("leave.incomplete")}
        </p>
      ) : null}
      <DataGrid
        caption={t("leave.list")}
        columns={columns}
        rows={records.data?.items ?? []}
        rowKey={(r) => r.id}
        emptyLabel={t("leave.none")}
        onActivate={(r) => {
          if (r.status === "requested") {
            setDecided(null);
            setInHand(r);
          }
        }}
      />
      <p className="text-start text-text-muted">{t("leave.keys")}</p>
    </section>
  );
}

function RequestForm({
  context,
  toggle,
  onSaved,
}: {
  context: Context;
  toggle: ReturnType<typeof useToggle<HTMLSelectElement>>;
  onSaved: () => Promise<void>;
}) {
  const { t } = useShell();
  const [employeeId, setEmployeeId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  async function save(event: FormEvent) {
    event.preventDefault();
    const wire = daysToWire(days);
    if (wire === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const body = {
      employeeId,
      leaveTypeId,
      startsOn,
      endsOn,
      days: wire,
      reason: reason.trim() === "" ? null : reason.trim(),
    };
    // The route's own strict contract checks the span before anything is sent; its answer is the server's words.
    const result = await submit.run(body, (idempotencyKey) =>
      context.client.request(body, { idempotencyKey }),
    );
    if (result !== undefined) {
      await onSaved();
      toggle.close();
    }
  }
  return (
    <FormShell
      label={t("leave.new")}
      onSubmit={(event) => void save(event)}
      onClose={toggle.close}
      busy={submit.busy}
      failure={submit.failure}
      saveLabel={t("leave.save")}
    >
      <EmployeeSelect
        selectRef={toggle.first}
        employees={context.employees}
        value={employeeId}
        onChange={setEmployeeId}
        disabled={submit.busy}
      />
      <TypeSelect
        types={context.types}
        value={leaveTypeId}
        onChange={setLeaveTypeId}
        disabled={submit.busy}
      />
      {context.typesDenied ? (
        <p className="text-start text-text-muted">{t("leave.typesDenied")}</p>
      ) : context.types.length === 0 ? (
        <p className="text-start text-text-muted">{t("leave.typesNone")}</p>
      ) : (
        <span />
      )}
      <TextField
        label={t("leave.startsOn")}
        type="date"
        required
        value={startsOn}
        disabled={submit.busy}
        onChange={(event) => setStartsOn(event.currentTarget.value)}
      />
      <TextField
        label={t("leave.endsOn")}
        type="date"
        required
        value={endsOn}
        disabled={submit.busy}
        onChange={(event) => setEndsOn(event.currentTarget.value)}
      />
      <TextField
        label={t("leave.days")}
        inputMode="decimal"
        dir="ltr"
        required
        value={days}
        disabled={submit.busy}
        hint={t("leave.daysHint")}
        {...(invalid ? { error: t("leave.daysInvalid") } : {})}
        onChange={(event) => setDays(event.currentTarget.value)}
      />
      <div className="md:col-span-3">
        <TextField
          label={t("leave.reason")}
          maxLength={500}
          value={reason}
          disabled={submit.busy}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </div>
    </FormShell>
  );
}

// ── Entitlements ────────────────────────────────────────────────────────────────────────────────────────────────

function Entitlements({ context }: { context: Context }) {
  const { t, locale } = useShell();
  const { client, scope } = context;
  const cache = useQueryClient();
  const [typedYear, setTypedYear] = useState(String(yearOf()));
  const year = /^\d{4}$/.test(typedYear) ? Number.parseInt(typedYear, 10) : null;
  const valid = year !== null && year >= 2000 && year <= 2200;
  const list = useQuery({
    queryKey: ["leave-entitlements", ...scope, year],
    queryFn: ({ signal }) => client.entitlements(year!, { signal }),
    enabled: valid,
    retry: retryQuery,
  });
  useRefusalRedirect(list.error);
  const form = useToggle<HTMLSelectElement>();
  const typeLabel = (row: LeaveEntitlementDto): string => {
    const type = context.types.find((x) => x.id === row.leaveTypeId);
    return type ? typeName(type, locale) : t(typeCodeKey(row.leaveTypeCode));
  };
  const columns: Column<LeaveEntitlementDto>[] = [
    { key: "employee", header: t("leave.employee"), cell: (r) => <bdi>{r.employeeNumber}</bdi> },
    { key: "type", header: t("leave.type"), cell: (r) => <bdi>{typeLabel(r)}</bdi> },
    { key: "year", header: t("leave.year"), align: "end", cell: (r) => <bdi>{r.year}</bdi> },
    { key: "days", header: t("leave.days"), align: "end", cell: (r) => <bdi>{r.days}</bdi> },
  ];
  return (
    <section className="flex flex-col gap-3" aria-label={t("leave.entitlements")}>
      <h2 className="text-start text-lg font-bold">{t("leave.entitlements")}</h2>
      <p className="text-start text-text-muted">{t("leave.entitlementsHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("leave.year")}
          inputMode="numeric"
          dir="ltr"
          value={typedYear}
          {...(valid ? {} : { error: t("leave.yearInvalid") })}
          onChange={(event) => setTypedYear(event.currentTarget.value.trim())}
        />
        {form.open ? null : (
          <span>
            <Button ref={form.opener} onClick={() => form.setOpen(true)}>
              {t("leave.entitlementNew")}
            </Button>
          </span>
        )}
      </div>
      {form.open ? (
        <EntitlementForm
          context={context}
          toggle={form}
          defaultYear={valid ? year : yearOf()}
          onSaved={() => cache.invalidateQueries({ queryKey: ["leave-entitlements", ...scope] })}
        />
      ) : null}
      <Refusal error={list.error} denied="leave.recordDenied" />
      {valid && list.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {list.data?.complete === false ? (
        <p role="status" className="text-start text-text-muted">
          {t("leave.incomplete")}
        </p>
      ) : null}
      <DataGrid
        caption={t("leave.entitlementList")}
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(r) => `${r.employeeId}:${r.leaveTypeId}:${r.year}`}
        emptyLabel={t("leave.entitlementsNone")}
      />
    </section>
  );
}

function EntitlementForm({
  context,
  toggle,
  defaultYear,
  onSaved,
}: {
  context: Context;
  toggle: ReturnType<typeof useToggle<HTMLSelectElement>>;
  defaultYear: number;
  onSaved: () => Promise<void>;
}) {
  const { t } = useShell();
  const [employeeId, setEmployeeId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [year, setYear] = useState(String(defaultYear));
  const [days, setDays] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  async function save(event: FormEvent) {
    event.preventDefault();
    const wire = daysToWire(days);
    const y = /^\d{4}$/.test(year) ? Number.parseInt(year, 10) : NaN;
    if (wire === null || !(y >= 2000 && y <= 2200)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const body = { employeeId, leaveTypeId, year: y, days: wire };
    const result = await submit.run(body, (idempotencyKey) =>
      context.client.setEntitlement(body, { idempotencyKey }),
    );
    if (result !== undefined) {
      await onSaved();
      toggle.close();
    }
  }
  return (
    <FormShell
      label={t("leave.entitlementNew")}
      onSubmit={(event) => void save(event)}
      onClose={toggle.close}
      busy={submit.busy}
      failure={submit.failure}
      saveLabel={t("leave.save")}
    >
      <EmployeeSelect
        selectRef={toggle.first}
        employees={context.employees}
        value={employeeId}
        onChange={setEmployeeId}
        disabled={submit.busy}
      />
      <TypeSelect
        types={context.types}
        value={leaveTypeId}
        onChange={setLeaveTypeId}
        disabled={submit.busy}
      />
      <TextField
        label={t("leave.year")}
        inputMode="numeric"
        dir="ltr"
        required
        value={year}
        disabled={submit.busy}
        onChange={(event) => setYear(event.currentTarget.value.trim())}
      />
      <TextField
        label={t("leave.days")}
        inputMode="decimal"
        dir="ltr"
        required
        value={days}
        disabled={submit.busy}
        hint={t("leave.daysHint")}
        {...(invalid ? { error: t("leave.entitlementInvalid") } : {})}
        onChange={(event) => setDays(event.currentTarget.value)}
      />
    </FormShell>
  );
}

// ── Leave types ─────────────────────────────────────────────────────────────────────────────────────────────────

function Types({
  context,
  error,
  pending,
}: {
  context: Context;
  error: unknown;
  pending: boolean;
}) {
  const { t } = useShell();
  const cache = useQueryClient();
  const form = useToggle<HTMLSelectElement>();
  const columns: Column<LeaveTypeDto>[] = [
    {
      key: "code",
      header: t("leave.typeCode"),
      cell: (r) => t(typeCodeKey(r.code)),
    },
    { key: "nameEn", header: t("leave.nameEn"), cell: (r) => <bdi>{r.nameEn}</bdi> },
    { key: "nameAr", header: t("leave.nameAr"), cell: (r) => <bdi>{r.nameAr ?? ""}</bdi> },
    {
      key: "paid",
      header: t("leave.paid"),
      cell: (r) => t(r.paid ? "leave.paidYes" : "leave.paidNo"),
    },
  ];
  return (
    <section className="flex flex-col gap-3" aria-label={t("leave.types")}>
      <h2 className="text-start text-lg font-bold">{t("leave.types")}</h2>
      {form.open || context.typesDenied ? null : (
        <span>
          <Button ref={form.opener} onClick={() => form.setOpen(true)}>
            {t("leave.typeNew")}
          </Button>
        </span>
      )}
      {form.open ? (
        <TypeForm
          context={context}
          toggle={form}
          onSaved={() => cache.invalidateQueries({ queryKey: ["leave-types", ...context.scope] })}
        />
      ) : null}
      <Refusal error={error} denied="leave.recordDenied" />
      {pending ? <p role="status">{t("app.loading")}</p> : null}
      <DataGrid
        caption={t("leave.typeList")}
        columns={columns}
        rows={context.types}
        rowKey={(r) => r.id}
        emptyLabel={t("leave.typesNone")}
      />
    </section>
  );
}

function TypeForm({
  context,
  toggle,
  onSaved,
}: {
  context: Context;
  toggle: ReturnType<typeof useToggle<HTMLSelectElement>>;
  onSaved: () => Promise<void>;
}) {
  const { t } = useShell();
  const [code, setCode] = useState<TypeCode>("annual");
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [paid, setPaid] = useState(true);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = {
      code,
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim() === "" ? null : nameAr.trim(),
      paid,
    };
    const result = await submit.run(body, (idempotencyKey) =>
      context.client.createType(body, { idempotencyKey }),
    );
    if (result !== undefined) {
      await onSaved();
      toggle.close();
    }
  }
  return (
    <FormShell
      label={t("leave.typeNew")}
      onSubmit={(event) => void save(event)}
      onClose={toggle.close}
      busy={submit.busy}
      failure={submit.failure}
      saveLabel={t("leave.save")}
    >
      <label className="flex flex-col gap-1 text-start text-text">
        {t("leave.typeCode")}
        <select
          ref={toggle.first}
          className={SELECT}
          value={code}
          disabled={submit.busy}
          onChange={(event) => setCode(event.currentTarget.value as TypeCode)}
        >
          {TYPE_CODES.map((value) => (
            <option key={value} value={value}>
              {t(typeCodeKey(value))}
            </option>
          ))}
        </select>
      </label>
      <TextField
        label={t("leave.nameEn")}
        required
        maxLength={120}
        value={nameEn}
        disabled={submit.busy}
        onChange={(event) => setNameEn(event.currentTarget.value)}
      />
      <TextField
        label={t("leave.nameAr")}
        dir="rtl"
        maxLength={120}
        value={nameAr}
        disabled={submit.busy}
        onChange={(event) => setNameAr(event.currentTarget.value)}
      />
      <Checkbox label={t("leave.paid")} checked={paid} onChange={setPaid} disabled={submit.busy} />
    </FormShell>
  );
}

// ── Public holidays ─────────────────────────────────────────────────────────────────────────────────────────────

function Holidays({ context }: { context: Context }) {
  const { t, locale } = useShell();
  const { client, scope, company } = context;
  const cache = useQueryClient();
  const list = useQuery({
    queryKey: ["public-holidays", ...scope],
    queryFn: ({ signal }) => client.holidays({ signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(list.error);
  const form = useToggle<HTMLInputElement>();
  const branchCode = (id: string | null): string =>
    id === null ? t("leave.allBranches") : (company.branches.find((b) => b.id === id)?.code ?? id);
  const columns: Column<PublicHolidayDto>[] = [
    {
      key: "date",
      header: t("leave.holidayOn"),
      cell: (r) => <bdi>{formatDate(r.holidayOn, { locale })}</bdi>,
    },
    {
      key: "name",
      header: t("leave.holidayName"),
      cell: (r) => <bdi>{locale === "ar" && r.nameAr !== null ? r.nameAr : r.nameEn}</bdi>,
    },
    { key: "branch", header: t("leave.branch"), cell: (r) => <bdi>{branchCode(r.branchId)}</bdi> },
  ];
  return (
    <section className="flex flex-col gap-3" aria-label={t("leave.holidays")}>
      <h2 className="text-start text-lg font-bold">{t("leave.holidays")}</h2>
      <p className="text-start text-text-muted">{t("leave.holidaysHint")}</p>
      {form.open || isForbidden(list.error) ? null : (
        <span>
          <Button ref={form.opener} onClick={() => form.setOpen(true)}>
            {t("leave.holidayNew")}
          </Button>
        </span>
      )}
      {form.open ? (
        <HolidayForm
          context={context}
          toggle={form}
          onSaved={() => cache.invalidateQueries({ queryKey: ["public-holidays", ...scope] })}
        />
      ) : null}
      <Refusal error={list.error} denied="leave.recordDenied" />
      {list.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {list.data?.complete === false ? (
        <p role="status" className="text-start text-text-muted">
          {t("leave.incomplete")}
        </p>
      ) : null}
      <DataGrid
        caption={t("leave.holidayList")}
        columns={columns}
        rows={list.data?.items ?? []}
        rowKey={(r) => r.id}
        emptyLabel={t("leave.holidaysNone")}
      />
    </section>
  );
}

function HolidayForm({
  context,
  toggle,
  onSaved,
}: {
  context: Context;
  toggle: ReturnType<typeof useToggle<HTMLInputElement>>;
  onSaved: () => Promise<void>;
}) {
  const { t } = useShell();
  const [holidayOn, setHolidayOn] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [branchId, setBranchId] = useState("");
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = {
      branchId: branchId === "" ? null : branchId,
      holidayOn,
      nameEn: nameEn.trim(),
      nameAr: nameAr.trim() === "" ? null : nameAr.trim(),
    };
    const result = await submit.run(body, (idempotencyKey) =>
      context.client.createHoliday(body, { idempotencyKey }),
    );
    if (result !== undefined) {
      await onSaved();
      toggle.close();
    }
  }
  return (
    <FormShell
      label={t("leave.holidayNew")}
      onSubmit={(event) => void save(event)}
      onClose={toggle.close}
      busy={submit.busy}
      failure={submit.failure}
      saveLabel={t("leave.save")}
    >
      <TextField
        ref={toggle.first}
        label={t("leave.holidayOn")}
        type="date"
        required
        value={holidayOn}
        disabled={submit.busy}
        onChange={(event) => setHolidayOn(event.currentTarget.value)}
      />
      <TextField
        label={t("leave.nameEn")}
        required
        maxLength={120}
        value={nameEn}
        disabled={submit.busy}
        onChange={(event) => setNameEn(event.currentTarget.value)}
      />
      <TextField
        label={t("leave.nameAr")}
        dir="rtl"
        maxLength={120}
        value={nameAr}
        disabled={submit.busy}
        onChange={(event) => setNameAr(event.currentTarget.value)}
      />
      <Select
        label={t("leave.branch")}
        value={branchId}
        disabled={submit.busy}
        options={[
          { value: "", label: t("leave.allBranches") },
          ...context.company.branches.map((b) => ({ value: b.id, label: b.code })),
        ]}
        onChange={(event) => setBranchId(event.currentTarget.value)}
      />
    </FormShell>
  );
}
