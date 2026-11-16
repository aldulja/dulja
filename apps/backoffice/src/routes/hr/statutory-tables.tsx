import type { RateTableDto, StatutorySchemeDto } from "@dulja/contracts/hr/statutory-scheme";
import { formatDate, formatTimestamp } from "@dulja/i18n";
import { Button, DataGrid, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { isForbidden, useSubmit } from "../../features/hr/shared";
import { localName, ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { hrApi, type HrApi } from "../../lib/hr-api";
import { retryQuery } from "../../lib/problem";

/**
 * 8A Task 13 — statutory schemes and their versioned rate tables (ADR 0073; ⚠️ OD-24 default baseline). Schemes are
 * seed-pack data, so there is no "new scheme". A table is loaded through the break-glass door as a JSON definition
 * and stays unverified until a DIFFERENT principal verifies it (spec:2080). For the principal who loaded a table the
 * verify button is disabled with the rule named beside it: the trigger refuses that click anyway, and a 409 after
 * an enabled click would teach the operator that the rule is arbitrary.
 */
export function StatutoryTablesRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <StatutoryTables api={api} company={company} />}
    </StaffContextPicker>
  );
}

function StatutoryTables({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const client = useMemo(() => hrApi(api, company.id), [api, company.id]);
  const schemes = useQuery({
    queryKey: ["hr-schemes", company.id],
    queryFn: ({ signal }) => client.schemes({ signal }),
    retry: retryQuery,
  });
  const session = useQuery({
    queryKey: ["session", api.baseUrl],
    queryFn: ({ signal }) => client.session({ signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(schemes.error ?? session.error);
  const [schemeId, setSchemeId] = useState<string | null>(null);
  const scheme = (schemes.data?.items ?? []).find((s) => s.id === schemeId) ?? null;
  const columns: Column<StatutorySchemeDto>[] = [
    { key: "code", header: t("hr.scheme.code"), cell: (row) => <bdi>{row.code}</bdi> },
    {
      key: "name",
      header: t("hr.scheme.name"),
      cell: (row) => <bdi>{localName(row, locale)}</bdi>,
    },
    {
      key: "registration",
      header: t("hr.scheme.registration"),
      cell: (row) =>
        row.employerRegistration ? (
          <bdi dir="ltr">{row.employerRegistration}</bdi>
        ) : (
          <span className="text-text-muted">{t("hr.scheme.unregistered")}</span>
        ),
    },
  ];
  return (
    <section className="flex flex-col gap-4" aria-label={t("hr.scheme.title")}>
      <h1 className="text-start text-xl font-bold">{t("hr.scheme.title")}</h1>
      <p className="text-start text-text-muted">{t("hr.scheme.intro")}</p>
      {schemes.error ? (
        isForbidden(schemes.error) ? (
          <p role="status">{t("hr.scheme.denied")}</p>
        ) : (
          <ProblemAlert error={schemes.error} />
        )
      ) : null}
      {schemes.isPending ? <p role="status">{t("app.loading")}</p> : null}
      <DataGrid
        caption={t("hr.scheme.list")}
        columns={columns}
        rows={schemes.data?.items ?? []}
        rowKey={(row) => row.id}
        emptyLabel={t("hr.scheme.none")}
        onActivate={(row) => setSchemeId(row.id)}
      />
      {scheme ? (
        <SchemeTables
          key={scheme.id}
          client={client}
          companyId={company.id}
          scheme={scheme}
          principalId={session.data?.principalId ?? null}
        />
      ) : null}
    </section>
  );
}

function SchemeTables({
  client,
  companyId,
  scheme,
  principalId,
}: {
  client: HrApi;
  companyId: string;
  scheme: StatutorySchemeDto;
  principalId: string | null;
}) {
  const { t, locale } = useShell();
  const cache = useQueryClient();
  const queryKey = ["hr-rate-tables", companyId, scheme.id];
  const tables = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.rateTables(scheme.id, { signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(tables.error);
  const [version, setVersion] = useState<number | null>(null);
  const selected = (tables.data?.items ?? []).find((row) => row.version === version) ?? null;
  const refresh = () => cache.invalidateQueries({ queryKey });
  const columns: Column<RateTableDto>[] = [
    { key: "version", header: t("hr.rateTable.version"), cell: (row) => <bdi>{row.version}</bdi> },
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
    { key: "source", header: t("hr.rateTable.source"), cell: (row) => <bdi>{row.source}</bdi> },
    {
      key: "status",
      header: t("staff.status"),
      cell: (row) => t(row.verifiedAt ? "hr.rateTable.verified" : "hr.rateTable.unverified"),
    },
  ];
  return (
    <section className="flex flex-col gap-4" aria-label={t("hr.rateTable.title")}>
      <h2 className="text-start text-lg font-bold">
        {t("hr.rateTable.heading", { code: scheme.code })}
      </h2>
      {tables.error ? <ProblemAlert error={tables.error} /> : null}
      <DataGrid
        caption={t("hr.rateTable.title")}
        columns={columns}
        rows={tables.data?.items ?? []}
        rowKey={(row) => row.id}
        emptyLabel={t("hr.rateTable.none")}
        onActivate={(row) => setVersion(row.version)}
      />
      {selected ? (
        <TableDetail
          key={selected.id}
          client={client}
          table={selected}
          principalId={principalId}
          onVerified={refresh}
        />
      ) : null}
      <LoadForm
        client={client}
        scheme={scheme}
        onLoaded={async (loaded) => {
          await refresh();
          setVersion(loaded.version);
        }}
      />
    </section>
  );
}

function TableDetail({
  client,
  table,
  principalId,
  onVerified,
}: {
  client: HrApi;
  table: RateTableDto;
  principalId: string | null;
  onVerified: () => Promise<void>;
}) {
  const { t, locale } = useShell();
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const reasonId = useId();
  const ownLoad = principalId !== null && table.loadedBy === principalId;
  async function verify() {
    const stored = await submit.run({ verify: table.id }, (idempotencyKey) =>
      client.verifyTable(table.schemeId, table.version, { idempotencyKey }),
    );
    if (stored) await onVerified();
  }
  return (
    <section className="flex flex-col gap-3" aria-label={t("hr.rateTable.detail")}>
      <h3 className="text-start font-bold">
        {t("hr.rateTable.detailHeading", { version: String(table.version) })}
      </h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-start">
        <dt>{t("hr.rateTable.loadedBy")}</dt>
        <dd>{t(ownLoad ? "hr.rateTable.you" : "hr.rateTable.another")}</dd>
        <dt>{t("staff.status")}</dt>
        <dd>
          {table.verifiedAt ? (
            <>
              {t("hr.rateTable.verified")} —{" "}
              <bdi>{formatTimestamp(table.verifiedAt, { locale })}</bdi>
            </>
          ) : (
            t("hr.rateTable.unverified")
          )}
        </dd>
      </dl>
      <h4 className="text-start">{t("hr.rateTable.definition")}</h4>
      <pre
        dir="ltr"
        className="max-h-80 overflow-auto rounded-sm border border-border p-3 text-start"
        data-testid="rate-table-definition"
      >
        {JSON.stringify(table.definition, null, 2)}
      </pre>
      {table.verifiedAt === null ? (
        <div className="flex flex-col gap-2">
          <span>
            <Button
              variant="primary"
              disabled={ownLoad || submit.busy || principalId === null}
              aria-describedby={ownLoad ? reasonId : undefined}
              onClick={() => void verify()}
            >
              {t("hr.rateTable.verify")}
            </Button>
          </span>
          {ownLoad ? (
            <p id={reasonId} className="text-start text-text-muted">
              {t("hr.rateTable.ownLoad")}
            </p>
          ) : (
            <p className="text-start text-text-muted">{t("hr.rateTable.verifyHint")}</p>
          )}
        </div>
      ) : null}
      {submit.failure ? <ProblemAlert error={submit.failure} /> : null}
    </section>
  );
}

function LoadForm({
  client,
  scheme,
  onLoaded,
}: {
  client: HrApi;
  scheme: StatutorySchemeDto;
  onLoaded: (table: RateTableDto) => Promise<void>;
}) {
  const { t } = useShell();
  const [text, setText] = useState("");
  const [malformed, setMalformed] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const fieldId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  async function load(event: FormEvent) {
    event.preventDefault();
    let definition: unknown;
    try {
      definition = JSON.parse(text);
    } catch {
      setMalformed(true);
      area.current?.focus();
      return;
    }
    setMalformed(false);
    const stored = await submit.run(definition, (idempotencyKey) =>
      client.loadRateTable(scheme.id, definition, { idempotencyKey }),
    );
    if (stored) {
      setText("");
      await onLoaded(stored);
    }
  }
  return (
    <form
      aria-label={t("hr.rateTable.load")}
      className="flex flex-col gap-2"
      onSubmit={(event) => void load(event)}
      onKeyDown={(event) => {
        // Ctrl+Enter submits from inside the text area, where a bare Enter is a new line.
        if (event.ctrlKey && event.key === "Enter") {
          event.preventDefault();
          void load(event);
        }
      }}
    >
      <h3 className="text-start font-bold">{t("hr.rateTable.load")}</h3>
      <p className="text-start text-text-muted">{t("hr.rateTable.loadHint")}</p>
      <label htmlFor={fieldId} className="text-start text-text">
        {t("hr.rateTable.definitionField")}
      </label>
      <textarea
        id={fieldId}
        ref={area}
        dir="ltr"
        rows={10}
        spellCheck={false}
        required
        className="rounded-sm border border-border bg-surface px-3 py-2 text-start font-mono text-text"
        value={text}
        disabled={submit.busy}
        aria-invalid={malformed ? true : undefined}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {malformed ? (
        <p role="alert" className="text-start text-danger">
          {t("hr.rateTable.malformed")}
        </p>
      ) : null}
      {submit.failure ? <ProblemAlert error={submit.failure} /> : null}
      <span>
        <Button
          type="submit"
          variant="primary"
          disabled={submit.busy}
          aria-keyshortcuts="Control+Enter"
        >
          {t("hr.rateTable.loadSubmit")}
        </Button>
      </span>
    </form>
  );
}
