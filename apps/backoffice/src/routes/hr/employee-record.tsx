import type { EmployeeSensitiveDto } from "@dulja/contracts/hr/sensitive";
import type { StatutoryProfileDto } from "@dulja/contracts/hr/statutory-profile";
import { formatDate } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffCompanyGate, type StaffCompany } from "../../components/staff-context";
import { firstOfNextMonth, isForbidden, isNotFound, useSubmit } from "../../features/hr/shared";
import { ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { hrApi, type HrApi } from "../../lib/hr-api";
import { retryQuery } from "../../lib/problem";
import { CompensationPanel } from "./compensation";

/**
 * 8A Task 13 — an employee's HR record (⚠️ OD-24, built on the owner-authorized default baseline of 2026-11-07,
 * `docs/ui/od-24-phase-8a.md`). The 6C master (number, branch, hire date), then three panels, each behind its OWN
 * fetch so one refusal never blanks another: identity and bank details (`hr.employee.read_sensitive`), the
 * effective-dated statutory profile and compensation (`hr.compensation.read`). A refused panel says so in a
 * sentence — it never renders empty fields that look like missing data.
 */
export function EmployeeRecordRoute({
  api,
  companyId,
  employeeId,
}: {
  api: AdminApiOptions;
  companyId: string | undefined;
  employeeId: string;
}) {
  return (
    <StaffCompanyGate api={api} companyId={companyId}>
      {(company) => <EmployeeRecord api={api} company={company} employeeId={employeeId} />}
    </StaffCompanyGate>
  );
}

function EmployeeRecord({
  api,
  company,
  employeeId,
}: {
  api: AdminApiOptions;
  company: StaffCompany;
  employeeId: string;
}) {
  const { t, locale } = useShell();
  const client = useMemo(() => hrApi(api, company.id), [api, company.id]);
  const employee = useQuery({
    queryKey: ["hr-employee", company.id, employeeId],
    queryFn: ({ signal }) => client.employee(employeeId, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(employee.error);
  const row = employee.data;
  const branch = row ? company.branches.find((value) => value.id === row.homeBranchId) : undefined;
  return (
    <section className="flex flex-col gap-6" aria-label={t("hr.record.title")}>
      <Link to="/hr/employees" className="text-start text-accent">
        {t("hr.record.back")}
      </Link>
      {employee.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {employee.error ? <ProblemAlert error={employee.error} /> : null}
      {row ? (
        <>
          <h1 className="text-start text-xl font-bold">
            {t("hr.record.heading", { number: row.employeeNumber })}
          </h1>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-start">
            <dt>{t("staff.employeeNumber")}</dt>
            <dd>
              <bdi>{row.employeeNumber}</bdi>
            </dd>
            <dt>{t("hr.record.position")}</dt>
            <dd>{row.position ? <bdi>{row.position}</bdi> : t("hr.record.notRecorded")}</dd>
            <dt>{t("hr.record.employmentType")}</dt>
            <dd>
              {row.employmentType
                ? t(`hr.employmentType.${row.employmentType}`)
                : t("hr.record.notRecorded")}
            </dd>
            <dt>{t("staff.homeBranch")}</dt>
            <dd>
              {branch
                ? locale === "ar"
                  ? (branch.nameAr ?? branch.nameEn)
                  : branch.nameEn
                : t("staff.unavailableBranch")}
            </dd>
            <dt>{t("staff.hiredOn")}</dt>
            <dd>
              <bdi>{formatDate(row.hiredOn, { locale })}</bdi>
            </dd>
            <dt>{t("staff.status")}</dt>
            <dd>{t(row.terminatedOn ? "staff.terminated" : "staff.active")}</dd>
          </dl>
          <SensitivePanel client={client} companyId={company.id} employeeId={employeeId} />
          <StatutoryProfilePanel client={client} companyId={company.id} employeeId={employeeId} />
          <CompensationPanel client={client} company={company} employeeId={employeeId} />
        </>
      ) : null}
    </section>
  );
}

/** The nine fields, in spec:2076's order, with the wire name each one travels under. */
const SENSITIVE_FIELDS = [
  { key: "nationalId", type: "text" },
  { key: "passport", type: "text" },
  { key: "dateOfBirth", type: "date" },
  { key: "residencyCategory", type: "text" },
  { key: "bankAccount", type: "text" },
  { key: "epfNumber", type: "text" },
  { key: "socsoNumber", type: "text" },
  { key: "taxNumber", type: "text" },
  { key: "workPermitExpiry", type: "date" },
] as const;
type SensitiveKey = (typeof SENSITIVE_FIELDS)[number]["key"];
type SensitiveDraft = Record<SensitiveKey, string>;

const draftOf = (row: EmployeeSensitiveDto | undefined): SensitiveDraft =>
  Object.fromEntries(SENSITIVE_FIELDS.map(({ key }) => [key, row?.[key] ?? ""])) as SensitiveDraft;

/**
 * Identity and bank details — a separate panel behind a separate fetch (8A Task 13). The GET is gated by
 * `hr.employee.read_sensitive` and answers 403 to anyone else, which this panel states; a 404 means nothing is
 * recorded yet. Saving sends only the fields that changed (the PUT's body is every-field-optional), an emptied
 * field as an explicit null.
 */
function SensitivePanel({
  client,
  companyId,
  employeeId,
}: {
  client: HrApi;
  companyId: string;
  employeeId: string;
}) {
  const { t } = useShell();
  const cache = useQueryClient();
  const queryKey = ["hr-sensitive", companyId, employeeId];
  const sensitive = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.sensitive(employeeId, { signal }),
    retry: retryQuery,
  });
  const loaded = sensitive.data;
  const [draft, setDraft] = useState<SensitiveDraft>(() => draftOf(undefined));
  useEffect(() => setDraft(draftOf(loaded)), [loaded]);
  const submit = useSubmit();
  const [saved, setSaved] = useState(false);
  useRefusalRedirect(submit.failure ?? sensitive.error);
  const denied = isForbidden(sensitive.error);
  const absent = isNotFound(sensitive.error);

  async function save(event: FormEvent) {
    event.preventDefault();
    const before = draftOf(loaded);
    const body: Record<string, string | null> = {};
    for (const { key } of SENSITIVE_FIELDS)
      if (draft[key] !== before[key]) body[key] = draft[key] === "" ? null : draft[key];
    setSaved(false);
    if (Object.keys(body).length === 0) return;
    const stored = await submit.run(body, (idempotencyKey) =>
      client.saveSensitive(employeeId, body, { idempotencyKey }),
    );
    if (stored) {
      cache.setQueryData(queryKey, stored);
      setSaved(true);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label={t("hr.sensitive.title")}>
      <h2 className="text-start text-lg font-bold">{t("hr.sensitive.title")}</h2>
      {sensitive.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {denied ? (
        <p role="status" className="text-start text-text-muted">
          {t("hr.sensitive.denied")}
        </p>
      ) : sensitive.error && !absent ? (
        <ProblemAlert error={sensitive.error} />
      ) : sensitive.isPending ? null : (
        <form
          aria-label={t("hr.sensitive.title")}
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
          onSubmit={(event) => void save(event)}
        >
          {absent ? (
            <p className="text-start text-text-muted md:col-span-3">{t("hr.sensitive.none")}</p>
          ) : null}
          {SENSITIVE_FIELDS.map(({ key, type }) => (
            <TextField
              key={key}
              label={t(`hr.sensitive.field.${key}`)}
              type={type}
              dir="ltr"
              autoComplete="off"
              maxLength={120}
              value={draft[key]}
              disabled={submit.busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setSaved(false);
                setDraft((current) => ({ ...current, [key]: value }));
              }}
            />
          ))}
          <p className="text-start text-text-muted md:col-span-3">{t("hr.sensitive.hint")}</p>
          {submit.failure ? (
            <div className="md:col-span-3">
              <ProblemAlert error={submit.failure} />
            </div>
          ) : null}
          {saved ? (
            <p role="status" className="text-start md:col-span-3">
              {t("hr.saved")}
            </p>
          ) : null}
          <span>
            <Button type="submit" variant="primary" disabled={submit.busy}>
              {t("hr.sensitive.save")}
            </Button>
          </span>
        </form>
      )}
    </section>
  );
}

/**
 * The effective-dated statutory profile (⚠️ OD-28). Closed rows are kept and shown with their end date; a new
 * profile CLOSES the open one the day before rather than editing it (ADR 0072), which the form says. `extra` —
 * the OD-28 seam — is shown read-only: the verified field list has not arrived, so no screen invents its fields.
 */
function StatutoryProfilePanel({
  client,
  companyId,
  employeeId,
}: {
  client: HrApi;
  companyId: string;
  employeeId: string;
}) {
  const { t, locale } = useShell();
  const profiles = useQuery({
    queryKey: ["hr-profiles", companyId, employeeId],
    queryFn: ({ signal }) => client.profiles(employeeId, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(profiles.error);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    queueMicrotask(() => opener.current?.focus());
  };
  const yesNo = (value: boolean | null) => (value === null ? "" : t(value ? "hr.yes" : "hr.no"));
  const columns: Column<StatutoryProfileDto>[] = [
    {
      key: "from",
      header: t("hr.effectiveFrom"),
      cell: (row) => <bdi>{formatDate(row.effectiveFrom, { locale })}</bdi>,
    },
    {
      key: "to",
      header: t("hr.effectiveTo"),
      cell: (row) =>
        row.effectiveTo ? <bdi>{formatDate(row.effectiveTo, { locale })}</bdi> : t("hr.open"),
    },
    {
      key: "marital",
      header: t("hr.profile.maritalStatus"),
      cell: (row) => <bdi>{row.maritalStatus ?? ""}</bdi>,
    },
    {
      key: "spouse",
      header: t("hr.profile.spouseWorking"),
      cell: (row) => yesNo(row.spouseWorking),
    },
    {
      key: "children",
      header: t("hr.profile.childReliefCount"),
      cell: (row) => <bdi>{row.childReliefCount === null ? "" : String(row.childReliefCount)}</bdi>,
    },
    {
      key: "residency",
      header: t("hr.profile.residencyCategory"),
      cell: (row) => <bdi>{row.residencyCategory ?? ""}</bdi>,
    },
    {
      key: "extra",
      header: t("hr.profile.extra"),
      cell: (row) =>
        Object.keys(row.extra).length === 0 ? (
          ""
        ) : (
          <bdi dir="ltr">
            {Object.entries(row.extra)
              .map(([name, value]) => `${name}: ${String(value)}`)
              .join(", ")}
          </bdi>
        ),
    },
    {
      key: "state",
      header: t("staff.status"),
      cell: (row) => (
        <span className={row.effectiveTo ? "text-text-muted" : undefined}>
          {t(row.effectiveTo ? "hr.closed" : "hr.current")}
        </span>
      ),
    },
  ];
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("hr.profile.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <h2 className="text-start text-lg font-bold">{t("hr.profile.title")}</h2>
      {isForbidden(profiles.error) ? (
        <p role="status" className="text-start text-text-muted">
          {t("hr.profile.denied")}
        </p>
      ) : (
        <>
          {profiles.error ? <ProblemAlert error={profiles.error} /> : null}
          <DataGrid
            caption={t("hr.profile.title")}
            columns={columns}
            rows={profiles.data?.items ?? []}
            rowKey={(row) => row.id}
            emptyLabel={t("hr.profile.none")}
          />
          {open ? (
            <ProfileForm
              client={client}
              companyId={companyId}
              employeeId={employeeId}
              current={(profiles.data?.items ?? [])
                .filter((row) => row.effectiveTo === null)
                .reduce<StatutoryProfileDto | undefined>(
                  (latest, row) =>
                    latest === undefined || row.effectiveFrom > latest.effectiveFrom ? row : latest,
                  undefined,
                )}
              onClose={close}
            />
          ) : (
            <span>
              <Button ref={opener} onClick={() => setOpen(true)}>
                {t("hr.profile.new")}
              </Button>
            </span>
          )}
        </>
      )}
    </section>
  );
}

function ProfileForm({
  client,
  companyId,
  employeeId,
  current,
  onClose,
}: {
  client: HrApi;
  companyId: string;
  employeeId: string;
  /** The open profile, if any. Opening a new one closes it, so the new one starts as its copy (PRD-23). */
  current: StatutoryProfileDto | undefined;
  onClose: () => void;
}) {
  const { t } = useShell();
  const cache = useQueryClient();
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [maritalStatus, setMaritalStatus] = useState(current?.maritalStatus ?? "");
  const [spouseWorking, setSpouseWorking] = useState(
    current?.spouseWorking == null ? "" : current.spouseWorking ? "yes" : "no",
  );
  const [children, setChildren] = useState(
    current?.childReliefCount == null ? "" : String(current.childReliefCount),
  );
  const [residency, setResidency] = useState(current?.residencyCategory ?? "");
  const [invalid, setInvalid] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (children !== "" && !/^\d{1,3}$/.test(children)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const body = {
      effectiveFrom,
      maritalStatus: maritalStatus.trim() === "" ? null : maritalStatus.trim(),
      spouseWorking: spouseWorking === "" ? null : spouseWorking === "yes",
      childReliefCount: children === "" ? null : Number.parseInt(children, 10),
      residencyCategory: residency.trim() === "" ? null : residency.trim(),
      // The OD-28 seam has no fields on screen yet, so it carries over unchanged rather than being cleared.
      extra: current?.extra ?? {},
    };
    const stored = await submit.run(body, (idempotencyKey) =>
      client.openProfile(employeeId, body, { idempotencyKey }),
    );
    if (stored) {
      await cache.invalidateQueries({ queryKey: ["hr-profiles", companyId, employeeId] });
      onClose();
    }
  }
  return (
    <form
      aria-label={t("hr.profile.new")}
      className="grid grid-cols-1 gap-3 md:grid-cols-3"
      onSubmit={(event) => void save(event)}
    >
      <TextField
        ref={first}
        label={t("hr.effectiveFrom")}
        type="date"
        required
        value={effectiveFrom}
        disabled={submit.busy}
        onChange={(event) => setEffectiveFrom(event.currentTarget.value)}
      />
      <TextField
        label={t("hr.profile.maritalStatus")}
        maxLength={40}
        value={maritalStatus}
        disabled={submit.busy}
        onChange={(event) => setMaritalStatus(event.currentTarget.value)}
      />
      <Select
        label={t("hr.profile.spouseWorking")}
        value={spouseWorking}
        disabled={submit.busy}
        options={[
          { value: "", label: t("hr.notStated") },
          { value: "yes", label: t("hr.yes") },
          { value: "no", label: t("hr.no") },
        ]}
        onChange={(event) => setSpouseWorking(event.currentTarget.value)}
      />
      <TextField
        label={t("hr.profile.childReliefCount")}
        inputMode="numeric"
        dir="ltr"
        value={children}
        disabled={submit.busy}
        {...(invalid ? { error: t("hr.profile.childReliefInvalid") } : {})}
        onChange={(event) => setChildren(event.currentTarget.value)}
      />
      <TextField
        label={t("hr.profile.residencyCategory")}
        maxLength={40}
        value={residency}
        disabled={submit.busy}
        onChange={(event) => setResidency(event.currentTarget.value)}
      />
      <p className="text-start text-text-muted md:col-span-3">{t("hr.profile.closesHint")}</p>
      {submit.failure ? (
        <div className="md:col-span-3">
          <ProblemAlert error={submit.failure} />
        </div>
      ) : null}
      <div className="flex gap-2 md:col-span-3">
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("hr.profile.save")}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("hr.cancel")}
        </Button>
      </div>
    </form>
  );
}
