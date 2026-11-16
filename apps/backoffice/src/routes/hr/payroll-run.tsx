import type { AttachmentList } from "@dulja/contracts/accounting/attachment";
import type { PayrollRunDto } from "@dulja/contracts/hr/payroll-run";
import type { z } from "zod";
import type { GeneratePayslipsResult } from "@dulja/contracts/hr/payslip";
import { formatDate, formatMoney, formatQuantity, formatTimestamp } from "@dulja/i18n";
import { Button, DataGrid, Select, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffCompanyGate, type StaffCompany } from "../../components/staff-context";
import { isForbidden, useSubmit } from "../../features/hr/shared";
import { ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { payrollApi, type PayrollApi } from "../../lib/payroll-api";
import { retryQuery } from "../../lib/problem";
import { saveBlob } from "../../lib/report-api";
import { amountToWire } from "../../lib/staff-decimals";
import { kindKey, statusKey } from "./payroll-runs";

type Line = PayrollRunDto["lines"][number];
type Payslip = z.infer<typeof GeneratePayslipsResult>["items"][number];
type StoredFile = z.infer<typeof AttachmentList>["items"][number];
/** §4.16.1's register code, run over this one run by 7A's report screen (8D T10: reuse, not a second grid). */
const REGISTER_CODE = "hr.payroll_register";
type Share = "employee" | "employer";

/**
 * 8B Task 15 — one payroll run, the approval screen (⚠️ OD-24, the owner-authorized default baseline of
 * 2026-11-07; `docs/ui/od-24-phase-8b.md`). Its only data source is `GET …/payroll-runs/{documentId}` and its
 * actions are the run's own recalculate and override routes and 2B's GENERIC transitions, so R1 (maker ≠ checker)
 * and R2 (authority at the transition) are the database's answers, shown as the server words them.
 *
 * What spec:2081/2087/2174 put on this screen, in reading order: the run's period, kind, status and pinned
 * rate-table versions; every MANUAL OVERRIDE, flagged with its reason and who entered it (spec:2087); everyone who
 * CHANGED COMPENSATION in the period (spec:2174 R3); then every line per employee with its pin. The screen adds no
 * figure of its own — a total computed here would be a second payroll arithmetic (SAH-009).
 */
export function PayrollRunRoute({
  api,
  companyId,
  documentId,
}: {
  api: AdminApiOptions;
  companyId: string | undefined;
  documentId: string;
}) {
  return (
    <StaffCompanyGate api={api} companyId={companyId}>
      {(company) => <PayrollRun api={api} company={company} documentId={documentId} />}
    </StaffCompanyGate>
  );
}

function PayrollRun({
  api,
  company,
  documentId,
}: {
  api: AdminApiOptions;
  company: StaffCompany;
  documentId: string;
}) {
  const { t, locale } = useShell();
  const cache = useQueryClient();
  const client = useMemo(() => payrollApi(api, company.id), [api, company.id]);
  const queryKey = ["payroll-run", company.id, documentId];
  const run = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.run(documentId, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(run.error);
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey });
    await cache.invalidateQueries({ queryKey: ["payroll-runs", company.id] });
  };
  const row = run.data;
  return (
    <section className="flex flex-col gap-6" aria-label={t("payroll.runTitle")}>
      <Link to="/hr/payroll-runs" className="text-start text-accent">
        {t("payroll.back")}
      </Link>
      {run.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {run.error ? (
        isForbidden(run.error) ? (
          <p role="status">{t("payroll.denied")}</p>
        ) : (
          <ProblemAlert error={run.error} />
        )
      ) : null}
      {row ? (
        <div className="flex flex-col gap-6" data-testid="payroll-approval">
          <h1 className="text-start text-xl font-bold">
            {t("payroll.heading", {
              start: formatDate(row.periodStart, { locale }),
              end: formatDate(row.periodEnd, { locale }),
            })}
          </h1>
          <RunHeader run={row} />
          <Actions client={client} run={row} onChanged={refresh} />
          <Overrides run={row} />
          <CompensationChanges run={row} />
          <Lines run={row} />
          {row.status === "posted" || row.status === "reversed" ? (
            <Payslips client={client} run={row} cacheKey={[company.id]} />
          ) : null}
          {row.status === "draft" ? (
            <OverrideForm client={client} run={row} onSaved={refresh} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RunHeader({ run }: { run: PayrollRunDto }) {
  const { t, locale } = useShell();
  const schemeCode = new Map(
    run.lines.filter((l) => l.schemeId !== null).map((l) => [l.schemeId!, l.schemeCode ?? ""]),
  );
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-start">
      <dt>{t("payroll.kind")}</dt>
      <dd>{t(kindKey(run.kind))}</dd>
      <dt>{t("staff.status")}</dt>
      <dd data-testid="payroll-status">{t(statusKey(run.status))}</dd>
      <dt>{t("payroll.number")}</dt>
      <dd>{run.number ? <bdi>{`${run.series}-${run.number}`}</bdi> : t("payroll.unnumbered")}</dd>
      <dt>{t("payroll.payDate")}</dt>
      <dd>
        <bdi>{formatDate(run.payDate, { locale })}</bdi>
      </dd>
      <dt>{t("payroll.pinned")}</dt>
      <dd>
        {run.pinnedTables.length === 0 ? (
          t("payroll.noPins")
        ) : (
          <ul className="flex flex-col">
            {run.pinnedTables.map((pin) => (
              <li key={pin.schemeId}>
                <bdi>
                  {t("payroll.pinnedVersion", {
                    scheme: schemeCode.get(pin.schemeId) ?? "",
                    version: String(pin.version),
                  })}
                </bdi>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </dl>
  );
}

/**
 * The transitions this run's status admits, in the order an operator meets them. Every one is a button in DOM order
 * (Tab reaches it, Enter presses it); returning a run to draft asks for the reason 2B's backward edge requires.
 */
function Actions({
  client,
  run,
  onChanged,
}: {
  client: PayrollApi;
  run: PayrollRunDto;
  onChanged: () => Promise<void>;
}) {
  const { t } = useShell();
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (returning) reasonRef.current?.focus();
  }, [returning]);
  async function act(gesture: string, send: (key: string) => Promise<unknown>) {
    setDone(false);
    const result = await submit.run({ gesture, run: run.documentId, status: run.status }, send);
    if (result !== undefined) {
      setDone(true);
      setReturning(false);
      setReason("");
      await onChanged();
    }
  }
  const transition = (to: "submitted" | "approved" | "posted") =>
    act(to, (idempotencyKey) => client.transition(run.documentId, { to }, { idempotencyKey }));
  const recalculate = () =>
    act("recalculate", (idempotencyKey) => client.recalculate(run.documentId, { idempotencyKey }));
  async function returnToDraft(event: FormEvent) {
    event.preventDefault();
    const text = reason.trim();
    if (text === "") return;
    await act(`draft:${text}`, (idempotencyKey) =>
      client.transition(run.documentId, { to: "draft", reason: text }, { idempotencyKey }),
    );
  }
  const status = run.status;
  return (
    <section className="flex flex-col gap-3" aria-label={t("payroll.actions")}>
      <h2 className="text-start text-lg font-bold">{t("payroll.actions")}</h2>
      {status === "posted" ? (
        <p role="status" className="text-start text-text-muted">
          {t("payroll.postedHint")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {status === "draft" ? (
          <Button
            variant="primary"
            disabled={submit.busy}
            onClick={() => void transition("submitted")}
          >
            {t("payroll.submit")}
          </Button>
        ) : null}
        {status === "submitted" ? (
          <Button
            variant="primary"
            disabled={submit.busy}
            onClick={() => void transition("approved")}
          >
            {t("payroll.approve")}
          </Button>
        ) : null}
        {status === "approved" ? (
          <Button
            variant="primary"
            disabled={submit.busy}
            onClick={() => void transition("posted")}
          >
            {t("payroll.post")}
          </Button>
        ) : null}
        {status === "draft" || status === "submitted" ? (
          <Button disabled={submit.busy} onClick={() => void recalculate()}>
            {t("payroll.recalculate")}
          </Button>
        ) : null}
        {(status === "submitted" || status === "approved") && !returning ? (
          <Button disabled={submit.busy} onClick={() => setReturning(true)}>
            {t("payroll.returnToDraft")}
          </Button>
        ) : null}
      </div>
      {status === "submitted" ? (
        <p className="text-start text-text-muted">{t("payroll.approveHint")}</p>
      ) : null}
      {status === "draft" || status === "submitted" ? (
        <p className="text-start text-text-muted">{t("payroll.recalculateHint")}</p>
      ) : null}
      {returning ? (
        <form
          aria-label={t("payroll.returnToDraft")}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => void returnToDraft(event)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setReturning(false);
            }
          }}
        >
          <TextField
            ref={reasonRef}
            label={t("payroll.returnReason")}
            required
            value={reason}
            disabled={submit.busy}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <Button type="submit" variant="primary" disabled={submit.busy}>
            {t("payroll.returnToDraft")}
          </Button>
          <Button type="button" onClick={() => setReturning(false)}>
            {t("hr.cancel")}
          </Button>
        </form>
      ) : null}
      {done ? (
        <p role="status" className="text-start">
          {t("hr.saved")}
        </p>
      ) : null}
      {submit.failure ? <ProblemAlert error={submit.failure} /> : null}
    </section>
  );
}

function Overrides({ run }: { run: PayrollRunDto }) {
  const { t, locale } = useShell();
  return (
    <section className="flex flex-col gap-2" aria-label={t("payroll.overrides")}>
      <h2 className="text-start text-lg font-bold">{t("payroll.overrides")}</h2>
      {run.overrides.length === 0 ? (
        <p className="text-start text-text-muted">{t("payroll.overridesNone")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {run.overrides.map((o) => (
            <li
              key={o.documentLineId}
              data-testid={`override-${o.documentLineId}`}
              className="flex flex-col gap-1 rounded-sm border border-danger p-3 text-start"
            >
              <strong>
                <bdi>
                  {t("payroll.overrideFlag", {
                    employee: o.employeeNumber,
                    scheme: o.schemeCode,
                    share: t(
                      o.share === "employee" ? "payroll.share.employee" : "payroll.share.employer",
                    ),
                    amount: formatMoney(o.amount, { locale }),
                  })}
                </bdi>
              </strong>
              <span>
                {t("payroll.override.reason")}: <bdi>{o.reason}</bdi>
              </span>
              <span>
                {t("payroll.override.enteredBy")}: <bdi>{o.enteredByName}</bdi> —{" "}
                <bdi>{formatTimestamp(o.enteredAt, { locale })}</bdi>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CompensationChanges({ run }: { run: PayrollRunDto }) {
  const { t, locale } = useShell();
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={t("payroll.changes")}
      data-testid="compensation-changed-by"
    >
      <h2 className="text-start text-lg font-bold">{t("payroll.changes")}</h2>
      <p className="text-start text-text-muted">{t("payroll.changesHint")}</p>
      {run.compensationChangedBy.length === 0 ? (
        <p className="text-start text-text-muted">{t("payroll.changesNone")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {run.compensationChangedBy.map((c) => (
            <li
              key={`${c.principalId}:${c.employeeNumber}:${c.effectiveFrom}`}
              className="text-start"
            >
              <bdi>
                {t("payroll.changeLine", {
                  name: c.displayName,
                  employee: c.employeeNumber,
                  date: formatDate(c.effectiveFrom, { locale }),
                })}
              </bdi>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Lines({ run }: { run: PayrollRunDto }) {
  const { t, locale } = useShell();
  const item = (line: Line): string => {
    if (line.componentCode !== null) return line.componentCode;
    if (line.schemeCode !== null)
      return `${line.schemeCode} — ${t(line.share === "employer" ? "payroll.share.employer" : "payroll.share.employee")}`;
    return t("payroll.netPay");
  };
  const columns: Column<Line>[] = [
    {
      key: "employee",
      header: t("payroll.line.employee"),
      cell: (line) => <bdi>{line.employeeNumber}</bdi>,
    },
    { key: "item", header: t("payroll.line.item"), cell: (line) => <bdi>{item(line)}</bdi> },
    {
      key: "quantity",
      header: t("payroll.line.quantity"),
      align: "end",
      cell: (line) =>
        line.quantity === null ? "" : <bdi>{formatQuantity(line.quantity, { locale })}</bdi>,
    },
    {
      key: "amount",
      header: t("payroll.line.amount"),
      align: "end",
      cell: (line) => <bdi>{formatMoney(line.amount, { locale })}</bdi>,
    },
    {
      key: "version",
      header: t("payroll.line.version"),
      cell: (line) =>
        line.rateTableVersion === null ? (
          ""
        ) : (
          <bdi>{t("payroll.line.versionValue", { version: String(line.rateTableVersion) })}</bdi>
        ),
    },
    {
      key: "override",
      header: t("payroll.line.override"),
      cell: (line) =>
        line.overrideReason === null ? (
          ""
        ) : (
          <strong className="text-danger">{t("payroll.overridden")}</strong>
        ),
    },
  ];
  return (
    <DataGrid
      caption={t("payroll.lines")}
      columns={columns}
      rows={run.lines}
      rowKey={(line) => line.documentLineId}
      emptyLabel={t("payroll.linesNone")}
    />
  );
}

/** The (employee, scheme, share) triples the calculation produced — the only shares an override may replace. */
function overridable(run: PayrollRunDto) {
  const seen = new Map<
    string,
    { employeeId: string; employeeNumber: string; schemes: Map<string, string> }
  >();
  for (const line of run.lines) {
    if (line.schemeId === null || line.share === null) continue;
    const entry = seen.get(line.employeeId) ?? {
      employeeId: line.employeeId,
      employeeNumber: line.employeeNumber,
      schemes: new Map<string, string>(),
    };
    entry.schemes.set(`${line.schemeId}:${line.share}`, `${line.schemeCode ?? ""}:${line.share}`);
    seen.set(line.employeeId, entry);
  }
  return [...seen.values()];
}

function OverrideForm({
  client,
  run,
  onSaved,
}: {
  client: PayrollApi;
  run: PayrollRunDto;
  onSaved: () => Promise<void>;
}) {
  const { t } = useShell();
  const employees = useMemo(() => overridable(run), [run]);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  const [employeeId, setEmployeeId] = useState(employees[0]?.employeeId ?? "");
  const employee = employees.find((e) => e.employeeId === employeeId) ?? employees[0];
  const shareKeys = [...(employee?.schemes.keys() ?? [])];
  const [shareKey, setShareKey] = useState(shareKeys[0] ?? "");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const currency = run.lines[0]?.amount.currency ?? "";
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    queueMicrotask(() => opener.current?.focus());
  };
  if (employees.length === 0)
    return <p className="text-start text-text-muted">{t("payroll.override.none")}</p>;
  async function save(event: FormEvent) {
    event.preventDefault();
    const key = employee?.schemes.has(shareKey) ? shareKey : (shareKeys[0] ?? "");
    const [schemeId = "", share = "employee"] = key.split(":");
    let amount: string;
    try {
      amount = amountToWire(value.trim());
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const body = {
      employeeId: employee!.employeeId,
      schemeId,
      share: share as Share,
      amount: { amount, currency },
      reason: reason.trim(),
    };
    const stored = await submit.run(body, (idempotencyKey) =>
      client.override(run.documentId, body, { idempotencyKey }),
    );
    if (stored) {
      setValue("");
      setReason("");
      await onSaved();
      close();
    }
  }
  if (!open)
    return (
      <span>
        <Button ref={opener} onClick={() => setOpen(true)}>
          {t("payroll.override.new")}
        </Button>
      </span>
    );
  return (
    <form
      aria-label={t("payroll.override.new")}
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <h2 className="text-start text-lg font-bold md:col-span-2">{t("payroll.override.new")}</h2>
      <p className="text-start text-text-muted md:col-span-2">{t("payroll.override.hint")}</p>
      <label className="flex flex-col gap-1 text-start text-text">
        {t("payroll.override.employee")}
        <select
          ref={first}
          className="rounded-sm border border-border bg-surface px-3 py-2 text-start text-text"
          value={employee?.employeeId ?? ""}
          disabled={submit.busy}
          onChange={(event) => {
            const next = employees.find((e) => e.employeeId === event.currentTarget.value);
            setEmployeeId(event.currentTarget.value);
            setShareKey([...(next?.schemes.keys() ?? [])][0] ?? "");
          }}
        >
          {employees.map((e) => (
            <option key={e.employeeId} value={e.employeeId}>
              {e.employeeNumber}
            </option>
          ))}
        </select>
      </label>
      <Select
        label={t("payroll.override.scheme")}
        value={employee?.schemes.has(shareKey) ? shareKey : (shareKeys[0] ?? "")}
        disabled={submit.busy}
        options={[...(employee?.schemes.entries() ?? [])].map(([key, label]) => {
          const [code = "", share = "employee"] = label.split(":");
          return {
            value: key,
            label: `${code} — ${t(share === "employer" ? "payroll.share.employer" : "payroll.share.employee")}`,
          };
        })}
        onChange={(event) => setShareKey(event.currentTarget.value)}
      />
      <TextField
        label={t("payroll.override.amountIn", { currency })}
        inputMode="decimal"
        dir="ltr"
        required
        value={value}
        disabled={submit.busy}
        {...(invalid ? { error: t("payroll.override.invalid") } : {})}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <TextField
        label={t("payroll.override.reason")}
        required
        maxLength={500}
        value={reason}
        disabled={submit.busy}
        onChange={(event) => setReason(event.currentTarget.value)}
      />
      {submit.failure ? (
        <div className="md:col-span-2">
          <ProblemAlert error={submit.failure} />
        </div>
      ) : null}
      <div className="flex gap-2 md:col-span-2">
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("payroll.override.save")}
        </Button>
        <Button type="button" onClick={close}>
          {t("hr.cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * 8D Task 10 — payslips for a POSTED run (spec:2083; 8D T5's `POST …/payroll-runs/{documentId}/payslips`, ADR 0079).
 * The server renders one PDF per employee, stores each as an attachment on the run and answers with its file name and
 * sha256; this panel lists those and downloads each through 2C's attachment content route. Every generation stores NEW
 * files and never replaces an earlier one, so the hash of what an employee was given stands (spec:2049). The run's
 * register (`hr.payroll_register`) opens in 7A's report screen with this run filled in.
 *
 * Phase 8 review: the payslips ALREADY on the run — every earlier generation — are listed too, from 2C's attachment
 * list naming the run (gated on the run's module read code, `hr.payroll.read`), newest first, each downloadable under
 * the hash recorded when it was generated. A generation refreshes the list.
 */
function Payslips({
  client,
  run,
  cacheKey,
}: {
  client: PayrollApi;
  run: PayrollRunDto;
  cacheKey: readonly unknown[];
}) {
  const { t, locale } = useShell();
  const cache = useQueryClient();
  const storedKey = ["payroll-run-payslips", run.documentId, ...cacheKey];
  const stored = useQuery({
    queryKey: storedKey,
    queryFn: ({ signal }) => client.runAttachments(run.documentId, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(stored.error);
  const earlier = useMemo(
    () =>
      (stored.data?.items ?? [])
        .filter(
          (file) => file.fileName.startsWith("payslip-") && file.mimeType === "application/pdf",
        )
        .toSorted((a, b) =>
          a.createdAt === b.createdAt
            ? a.fileName < b.fileName
              ? -1
              : 1
            : a.createdAt < b.createdAt
              ? 1
              : -1,
        ),
    [stored.data],
  );
  const employees = useMemo(() => {
    const seen = new Map<string, string>();
    for (const line of run.lines) seen.set(line.employeeId, line.employeeNumber);
    return [...seen.entries()].toSorted(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
  }, [run]);
  const [lang, setLang] = useState<"en" | "ar">(locale === "ar" ? "ar" : "en");
  const [employeeId, setEmployeeId] = useState("");
  const [payslips, setPayslips] = useState<readonly Payslip[] | null>(null);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const download = useSubmit();
  useRefusalRedirect(download.failure);
  async function generate(event: FormEvent) {
    event.preventDefault();
    const body = { lang, ...(employeeId === "" ? {} : { employeeIds: [employeeId] }) };
    const result = await submit.run({ payslips: run.documentId, ...body }, (idempotencyKey) =>
      client.payslips(run.documentId, body, { idempotencyKey }),
    );
    if (result !== undefined) {
      setPayslips(result.items);
      await cache.invalidateQueries({ queryKey: storedKey });
    }
  }
  async function save(payslip: { attachmentId: string; fileName: string }) {
    // A GET: the "gesture" only serialises clicks, it is never an idempotency key on the wire.
    const blob = await download.run({ download: payslip.attachmentId }, () =>
      client.payslipContent(payslip.attachmentId),
    );
    if (blob !== undefined) saveBlob(blob, payslip.fileName);
  }
  const storedColumns: Column<StoredFile>[] = [
    {
      key: "file",
      header: t("payslip.file"),
      cell: (f) => <bdi dir="ltr">{f.fileName}</bdi>,
    },
    {
      key: "generated",
      header: t("payslip.generatedAt"),
      cell: (f) => <bdi>{formatTimestamp(f.createdAt, { locale })}</bdi>,
    },
    {
      key: "size",
      header: t("payslip.size"),
      align: "end",
      cell: (f) => <bdi>{t("payslip.bytes", { count: String(f.byteSize) })}</bdi>,
    },
    {
      key: "hash",
      header: t("payslip.hash"),
      cell: (f) => (
        <bdi dir="ltr" className="font-mono text-sm break-all">
          {f.sha256}
        </bdi>
      ),
    },
    {
      key: "download",
      header: t("payslip.download"),
      cell: (f) => (
        <span onKeyDown={(event) => event.stopPropagation()}>
          <Button
            disabled={download.busy}
            onClick={() => void save({ attachmentId: f.id, fileName: f.fileName })}
          >
            {t("payslip.downloadOne", { employee: f.fileName })}
          </Button>
        </span>
      ),
    },
  ];
  const columns: Column<Payslip>[] = [
    {
      key: "employee",
      header: t("payroll.line.employee"),
      cell: (p) => <bdi>{p.employeeNumber}</bdi>,
    },
    {
      key: "file",
      header: t("payslip.file"),
      cell: (p) => <bdi dir="ltr">{p.fileName}</bdi>,
    },
    {
      key: "size",
      header: t("payslip.size"),
      align: "end",
      cell: (p) => <bdi>{t("payslip.bytes", { count: String(p.byteSize) })}</bdi>,
    },
    {
      key: "hash",
      header: t("payslip.hash"),
      cell: (p) => (
        <bdi
          dir="ltr"
          className="font-mono text-sm break-all"
          data-testid={`payslip-hash-${p.employeeNumber}`}
        >
          {p.sha256}
        </bdi>
      ),
    },
    {
      key: "download",
      header: t("payslip.download"),
      cell: (p) => (
        <span onKeyDown={(event) => event.stopPropagation()}>
          <Button disabled={download.busy} onClick={() => void save(p)}>
            {t("payslip.downloadOne", { employee: p.employeeNumber })}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <section className="flex flex-col gap-3" aria-label={t("payslip.title")}>
      <h2 className="text-start text-lg font-bold">{t("payslip.title")}</h2>
      <p className="text-start text-text-muted">{t("payslip.hint")}</p>
      <form
        aria-label={t("payslip.generate")}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => void generate(event)}
      >
        <Select
          label={t("payslip.lang")}
          value={lang}
          disabled={submit.busy}
          options={[
            { value: "en", label: t("payslip.lang.en") },
            { value: "ar", label: t("payslip.lang.ar") },
          ]}
          onChange={(event) => setLang(event.currentTarget.value === "ar" ? "ar" : "en")}
        />
        <Select
          label={t("payslip.employees")}
          value={employeeId}
          disabled={submit.busy}
          options={[
            { value: "", label: t("payslip.everyone") },
            ...employees.map(([id, number]) => ({ value: id, label: number })),
          ]}
          onChange={(event) => setEmployeeId(event.currentTarget.value)}
        />
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("payslip.generate")}
        </Button>
      </form>
      {submit.busy ? <p role="status">{t("payslip.generating")}</p> : null}
      {submit.failure ? <ProblemAlert error={submit.failure} /> : null}
      {download.failure ? <ProblemAlert error={download.failure} /> : null}
      {payslips !== null ? (
        <DataGrid
          caption={t("payslip.list")}
          columns={columns}
          rows={payslips}
          rowKey={(p) => p.attachmentId}
          emptyLabel={t("payslip.none")}
          onActivate={(p) => void save(p)}
        />
      ) : null}
      {payslips !== null ? <p className="text-start text-text-muted">{t("payslip.keys")}</p> : null}
      <section className="flex flex-col gap-2" aria-label={t("payslip.earlier")}>
        <h3 className="text-start font-bold">{t("payslip.earlier")}</h3>
        {stored.isPending ? <p role="status">{t("app.loading")}</p> : null}
        {stored.error ? (
          isForbidden(stored.error) ? (
            <p role="status">{t("payslip.earlierDenied")}</p>
          ) : (
            <ProblemAlert error={stored.error} />
          )
        ) : null}
        {stored.data?.complete === false ? (
          <p role="status" className="text-start text-text-muted">
            {t("payslip.incomplete")}
          </p>
        ) : null}
        {stored.data ? (
          <DataGrid
            caption={t("payslip.earlier")}
            columns={storedColumns}
            rows={earlier}
            rowKey={(f) => f.id}
            emptyLabel={t("payslip.earlierNone")}
            onActivate={(f) => void save({ attachmentId: f.id, fileName: f.fileName })}
          />
        ) : null}
      </section>
      <Link
        to="/reports/$code"
        params={{ code: REGISTER_CODE }}
        search={{ parameters: { payrollDocumentId: run.documentId } }}
        className="text-start text-accent"
      >
        {t("payslip.register")}
      </Link>
    </section>
  );
}
