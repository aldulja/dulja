import type { PayComponentDto } from "@dulja/contracts/hr/pay-component";
import { Button, DataGrid, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { isForbidden, useSubmit } from "../../features/hr/shared";
import {
  Checkbox,
  localName,
  ProblemAlert,
  useRefusalRedirect,
} from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { hrApi, type HrApi } from "../../lib/hr-api";
import { retryQuery } from "../../lib/problem";

/** spec:2079's two values. A radio of two, never a free select: a third kind is not addable because it does not
 *  exist (8A Task 13). */
const KINDS = ["earning", "deduction"] as const;
type Kind = (typeof KINDS)[number];

/**
 * 8A Task 13 — the pay-component catalogue (⚠️ OD-24 default baseline, `docs/ui/od-24-phase-8a.md`). Create, rename,
 * add scheme joins (additive — no removal path exists, amendment A14) and archive. `code` and `kind` are fixed at
 * creation: a posted payroll line is read back by its component years later.
 */
export function PayComponentsRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <PayComponents api={api} company={company} />}
    </StaffContextPicker>
  );
}

function PayComponents({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const client = useMemo(() => hrApi(api, company.id), [api, company.id]);
  const cache = useQueryClient();
  const queryKey = ["hr-pay-components-all", company.id];
  const cacheRefresh = () => cache.invalidateQueries({ queryKey });
  const list = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.allPayComponents({ signal }),
    retry: retryQuery,
  });
  // The scheme list is the statutory-table codes' read; a payroll officer without them still runs the catalogue.
  const schemes = useQuery({
    queryKey: ["hr-schemes", company.id],
    queryFn: ({ signal }) => client.schemes({ signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(list.error);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const restore = useRef<HTMLElement | null>(null);
  const rows = list.data?.items ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const schemeCode = new Map((schemes.data?.items ?? []).map((s) => [s.id, s.code]));
  function close() {
    setSelectedId(null);
    setCreating(false);
    queueMicrotask(() => {
      if (restore.current?.isConnected) restore.current.focus();
    });
  }
  const columns: Column<PayComponentDto>[] = [
    { key: "code", header: t("hr.payComponent.code"), cell: (row) => <bdi>{row.code}</bdi> },
    {
      key: "name",
      header: t("hr.payComponent.name"),
      cell: (row) => <bdi>{localName(row, locale)}</bdi>,
    },
    { key: "kind", header: t("hr.payComponent.kind"), cell: (row) => t(`hr.kind.${row.kind}`) },
    {
      key: "quantity",
      header: t("hr.payComponent.quantityBased"),
      cell: (row) => t(row.quantityBased ? "hr.yes" : "hr.no"),
    },
    {
      key: "schemes",
      header: t("hr.payComponent.schemes"),
      cell: (row) => (
        <bdi dir="ltr">{row.schemeIds.map((id) => schemeCode.get(id) ?? "—").join(", ")}</bdi>
      ),
    },
    {
      key: "status",
      header: t("staff.status"),
      cell: (row) => (
        <span className={row.archivedAt ? "text-text-muted" : undefined}>
          {t(row.archivedAt ? "hr.archived" : "staff.active")}
        </span>
      ),
    },
  ];
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={t("hr.payComponent.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (selected || creating)) {
          event.preventDefault();
          close();
        }
      }}
    >
      <h1 className="text-start text-xl font-bold">{t("hr.payComponent.title")}</h1>
      <p className="text-start text-text-muted">{t("hr.payComponent.intro")}</p>
      <span>
        <Button
          onClick={(event) => {
            restore.current = event.currentTarget;
            setSelectedId(null);
            setCreating(true);
          }}
        >
          {t("hr.payComponent.new")}
        </Button>
      </span>
      {list.error ? (
        isForbidden(list.error) ? (
          <p role="status">{t("hr.payComponent.denied")}</p>
        ) : (
          <ProblemAlert error={list.error} />
        )
      ) : null}
      {list.isPending ? <p role="status">{t("app.loading")}</p> : null}
      <DataGrid
        caption={t("hr.payComponent.title")}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        emptyLabel={t("hr.payComponent.none")}
        onActivate={(row) => {
          restore.current = document.activeElement as HTMLElement;
          setCreating(false);
          setSelectedId(row.id);
        }}
      />
      {creating ? (
        <CreateForm
          client={client}
          onClose={close}
          onSaved={async () => {
            await cacheRefresh();
            close();
          }}
        />
      ) : null}
      {selected ? (
        <ComponentDetail
          key={selected.id}
          client={client}
          component={selected}
          schemes={schemes.data?.items ?? null}
          schemesDenied={isForbidden(schemes.error)}
          onChanged={cacheRefresh}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

function KindRadio({
  value,
  disabled,
  onChange,
}: {
  value: Kind;
  disabled: boolean;
  onChange: (kind: Kind) => void;
}) {
  const { t } = useShell();
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1 text-start">
      <legend className="text-text">{t("hr.payComponent.kind")}</legend>
      <div className="flex gap-4">
        {KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-2 text-text">
            <input
              type="radio"
              name={name}
              value={kind}
              checked={value === kind}
              disabled={disabled}
              onChange={() => onChange(kind)}
            />
            <span>{t(`hr.kind.${kind}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CreateForm({
  client,
  onSaved,
  onClose,
}: {
  client: HrApi;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useShell();
  const [code, setCode] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [kind, setKind] = useState<Kind>("earning");
  const [quantityBased, setQuantityBased] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = {
      code: code.trim(),
      nameEn: nameEn.trim(),
      ...(nameAr.trim() === "" ? {} : { nameAr: nameAr.trim() }),
      kind,
      quantityBased,
    };
    const stored = await submit.run(body, (idempotencyKey) =>
      client.createPayComponent(body, { idempotencyKey }),
    );
    if (stored) await onSaved();
  }
  return (
    <form
      aria-label={t("hr.payComponent.new")}
      className="flex flex-col gap-3"
      onSubmit={(event) => void save(event)}
    >
      <TextField
        ref={first}
        label={t("hr.payComponent.code")}
        required
        maxLength={40}
        dir="ltr"
        value={code}
        disabled={submit.busy}
        onChange={(event) => setCode(event.currentTarget.value)}
      />
      <TextField
        label={t("staff.nameEn")}
        required
        maxLength={200}
        value={nameEn}
        disabled={submit.busy}
        onChange={(event) => setNameEn(event.currentTarget.value)}
      />
      <TextField
        label={t("staff.nameAr")}
        maxLength={200}
        value={nameAr}
        disabled={submit.busy}
        onChange={(event) => setNameAr(event.currentTarget.value)}
      />
      <KindRadio value={kind} disabled={submit.busy} onChange={setKind} />
      <Checkbox
        label={t("hr.payComponent.quantityBased")}
        checked={quantityBased}
        disabled={submit.busy}
        onChange={setQuantityBased}
      />
      <p className="text-start text-text-muted">{t("hr.payComponent.fixedHint")}</p>
      {submit.failure ? <ProblemAlert error={submit.failure} /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("staff.save")}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("hr.cancel")}
        </Button>
      </div>
    </form>
  );
}

function ComponentDetail({
  client,
  component,
  schemes,
  schemesDenied,
  onChanged,
  onClose,
}: {
  client: HrApi;
  component: PayComponentDto;
  schemes: { id: string; code: string; nameEn: string; nameAr: string | null }[] | null;
  schemesDenied: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const { t, locale } = useShell();
  const [nameEn, setNameEn] = useState(component.nameEn);
  const [nameAr, setNameAr] = useState(component.nameAr ?? "");
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const rename = useSubmit();
  const join = useSubmit();
  const archive = useSubmit();
  useRefusalRedirect(rename.failure ?? join.failure ?? archive.failure);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const archived = component.archivedAt !== null;
  async function saveName(event: FormEvent) {
    event.preventDefault();
    const body = { nameEn: nameEn.trim(), nameAr: nameAr.trim() === "" ? null : nameAr.trim() };
    const stored = await rename.run({ id: component.id, ...body }, (idempotencyKey) =>
      client.renamePayComponent(component.id, body, { idempotencyKey }),
    );
    if (stored) await onChanged();
  }
  async function addSchemes(event: FormEvent) {
    event.preventDefault();
    const schemeIds = [...adding].toSorted();
    if (schemeIds.length === 0) return;
    const stored = await join.run({ id: component.id, schemeIds }, (idempotencyKey) =>
      client.addComponentSchemes(component.id, { schemeIds }, { idempotencyKey }),
    );
    if (stored) {
      setAdding(new Set());
      await onChanged();
    }
  }
  async function retire() {
    const stored = await archive.run({ archive: component.id }, (idempotencyKey) =>
      client.archivePayComponent(component.id, { idempotencyKey }),
    );
    if (stored) await onChanged();
  }
  return (
    <section className="flex flex-col gap-4" aria-label={t("hr.payComponent.detail")}>
      <h2 className="text-start text-lg font-bold">
        <bdi>{component.code}</bdi> — {t(`hr.kind.${component.kind}`)}
      </h2>
      <form
        aria-label={t("hr.payComponent.rename")}
        className="flex flex-col gap-3"
        onSubmit={(event) => void saveName(event)}
      >
        <TextField
          ref={first}
          label={t("staff.nameEn")}
          required
          maxLength={200}
          value={nameEn}
          disabled={rename.busy}
          onChange={(event) => setNameEn(event.currentTarget.value)}
        />
        <TextField
          label={t("staff.nameAr")}
          maxLength={200}
          value={nameAr}
          disabled={rename.busy}
          onChange={(event) => setNameAr(event.currentTarget.value)}
        />
        {rename.failure ? <ProblemAlert error={rename.failure} /> : null}
        <span>
          <Button type="submit" variant="primary" disabled={rename.busy}>
            {t("hr.payComponent.rename")}
          </Button>
        </span>
      </form>
      <form
        aria-label={t("hr.payComponent.schemes")}
        className="flex flex-col gap-2"
        onSubmit={(event) => void addSchemes(event)}
      >
        <h3 className="text-start font-bold">{t("hr.payComponent.schemes")}</h3>
        <p className="text-start text-text-muted">{t("hr.payComponent.schemesHint")}</p>
        {schemesDenied ? (
          <p role="status">{t("hr.payComponent.schemesDenied")}</p>
        ) : (schemes ?? []).length === 0 ? (
          <p>{t("hr.scheme.none")}</p>
        ) : (
          (schemes ?? []).map((scheme) => {
            const joined = component.schemeIds.includes(scheme.id);
            return (
              <Checkbox
                key={scheme.id}
                label={`${scheme.code} — ${localName(scheme, locale)}`}
                checked={joined || adding.has(scheme.id)}
                disabled={joined || join.busy || archived}
                onChange={(checked) =>
                  setAdding((current) => {
                    const next = new Set(current);
                    if (checked) next.add(scheme.id);
                    else next.delete(scheme.id);
                    return next;
                  })
                }
              />
            );
          })
        )}
        {join.failure ? <ProblemAlert error={join.failure} /> : null}
        <span>
          <Button type="submit" disabled={join.busy || adding.size === 0}>
            {t("hr.payComponent.addSchemes")}
          </Button>
        </span>
      </form>
      {archive.failure ? <ProblemAlert error={archive.failure} /> : null}
      <div className="flex gap-2">
        <Button variant="danger" disabled={archived || archive.busy} onClick={() => void retire()}>
          {t(archived ? "hr.archived" : "hr.payComponent.archive")}
        </Button>
        <Button onClick={onClose}>{t("staff.close")}</Button>
      </div>
    </section>
  );
}
