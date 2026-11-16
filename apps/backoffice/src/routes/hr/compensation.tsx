import type { CompensationLineDto } from "@dulja/contracts/hr/compensation";
import type { PayComponentDto } from "@dulja/contracts/hr/pay-component";
import { formatDate, formatMoney, formatQuantity } from "@dulja/i18n";
import { Button, DataGrid, TextField, type Column } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { useShell } from "../../components/app-shell";
import type { StaffCompany } from "../../components/staff-context";
import { firstOfNextMonth, isForbidden, quantityToWire, useSubmit } from "../../features/hr/shared";
import { localName, ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { HrApi } from "../../lib/hr-api";
import { retryQuery } from "../../lib/problem";
import { amountToWire } from "../../lib/staff-decimals";

/** A closed line is history: shown, but greyed. */
const muted = (row: CompensationLineDto) => (row.effectiveTo ? "text-text-muted" : undefined);

/**
 * 8A Task 13 — an employee's compensation (ADR 0072): every line, closed ones greyed with their end date, because
 * the history IS the closed rows. A new line pre-fills the first of next month and says, before it is saved, that
 * saving CLOSES the component's current line rather than editing it. Amounts are in the company's base currency
 * (v1 payroll is single-currency) and travel as exact decimal strings.
 */
export function CompensationPanel({
  client,
  company,
  employeeId,
}: {
  client: HrApi;
  company: StaffCompany;
  employeeId: string;
}) {
  const { t, locale } = useShell();
  const cache = useQueryClient();
  const queryKey = ["hr-compensation", company.id, employeeId];
  const lines = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.compensation(employeeId, { signal }),
    retry: retryQuery,
  });
  const components = useQuery({
    queryKey: ["hr-pay-components-all", company.id],
    queryFn: ({ signal }) => client.allPayComponents({ signal }),
    retry: retryQuery,
    enabled: !isForbidden(lines.error),
  });
  useRefusalRedirect(lines.error ?? components.error);
  const byId = new Map((components.data?.items ?? []).map((c) => [c.id, c]));
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    queueMicrotask(() => opener.current?.focus());
  };
  const columns: Column<CompensationLineDto>[] = [
    {
      key: "component",
      header: t("hr.compensation.component"),
      cell: (row) => {
        const component = byId.get(row.componentId);
        return (
          <span className={muted(row)}>
            <bdi>{component ? `${component.code} — ${localName(component, locale)}` : ""}</bdi>
          </span>
        );
      },
    },
    {
      key: "from",
      header: t("hr.effectiveFrom"),
      cell: (row) => <bdi className={muted(row)}>{formatDate(row.effectiveFrom, { locale })}</bdi>,
    },
    {
      key: "to",
      header: t("hr.effectiveTo"),
      cell: (row) =>
        row.effectiveTo ? (
          <bdi className="text-text-muted">{formatDate(row.effectiveTo, { locale })}</bdi>
        ) : (
          t("hr.open")
        ),
    },
    {
      key: "amount",
      header: t("hr.compensation.amount"),
      align: "end",
      cell: (row) =>
        row.amount ? <bdi className={muted(row)}>{formatMoney(row.amount, { locale })}</bdi> : "",
    },
    {
      key: "quantity",
      header: t("hr.compensation.quantity"),
      align: "end",
      cell: (row) =>
        row.quantity ? (
          <bdi className={muted(row)}>{formatQuantity(row.quantity, { locale })}</bdi>
        ) : (
          ""
        ),
    },
    {
      key: "state",
      header: t("staff.status"),
      cell: (row) => (
        <span className={muted(row)}>{t(row.effectiveTo ? "hr.closed" : "hr.current")}</span>
      ),
    },
  ];
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={t("hr.compensation.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <h2 className="text-start text-lg font-bold">{t("hr.compensation.title")}</h2>
      {isForbidden(lines.error) ? (
        <p role="status" className="text-start text-text-muted">
          {t("hr.compensation.denied")}
        </p>
      ) : (
        <>
          {lines.error ? <ProblemAlert error={lines.error} /> : null}
          <DataGrid
            caption={t("hr.compensation.title")}
            columns={columns}
            rows={lines.data?.items ?? []}
            rowKey={(row) => row.id}
            emptyLabel={t("hr.compensation.none")}
          />
          {open ? (
            <CompensationForm
              client={client}
              currency={company.baseCurrency}
              employeeId={employeeId}
              components={(components.data?.items ?? []).filter((c) => c.archivedAt === null)}
              componentsPending={components.isPending}
              componentsError={components.error}
              onSaved={async () => {
                await cache.invalidateQueries({ queryKey });
                close();
              }}
              onClose={close}
            />
          ) : (
            <span>
              <Button ref={opener} onClick={() => setOpen(true)}>
                {t("hr.compensation.new")}
              </Button>
            </span>
          )}
        </>
      )}
    </section>
  );
}

function CompensationForm({
  client,
  currency,
  employeeId,
  components,
  componentsPending,
  componentsError,
  onSaved,
  onClose,
}: {
  client: HrApi;
  currency: string;
  employeeId: string;
  components: PayComponentDto[];
  componentsPending: boolean;
  componentsError: unknown;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const { t, locale } = useShell();
  const [chosenId, setComponentId] = useState("");
  // UI-18: derived, not seeded once — the form can open before the components arrive, and then the select shows
  // the first one while a seeded state would still hold "" and send it.
  const componentId = components.some((c) => c.id === chosenId)
    ? chosenId
    : (components[0]?.id ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  const first = useRef<HTMLSelectElement>(null);
  const ready = components.length > 0;
  useEffect(() => {
    if (ready) first.current?.focus();
  }, [ready]);
  const selected = components.find((c) => c.id === componentId);
  const quantityBased = selected?.quantityBased ?? false;
  async function save(event: FormEvent) {
    event.preventDefault();
    let body;
    try {
      body = quantityBased
        ? { componentId, effectiveFrom, quantity: quantityToWire(value.trim()) }
        : {
            componentId,
            effectiveFrom,
            amount: { amount: amountToWire(value.trim()), currency },
          };
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const stored = await submit.run(body, (idempotencyKey) =>
      client.openCompensation(employeeId, body, { idempotencyKey }),
    );
    if (stored) await onSaved();
  }
  if (components.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {componentsError ? (
          <ProblemAlert error={componentsError} />
        ) : (
          <p role="status" className="text-start text-text-muted">
            {t(componentsPending ? "app.loading" : "hr.compensation.noComponents")}
          </p>
        )}
        <span>
          <Button onClick={onClose}>{t("hr.cancel")}</Button>
        </span>
      </div>
    );
  return (
    <form
      aria-label={t("hr.compensation.new")}
      className="grid grid-cols-1 gap-3 md:grid-cols-3"
      onSubmit={(event) => void save(event)}
    >
      <ComponentSelect
        selectRef={first}
        label={t("hr.compensation.component")}
        value={componentId}
        disabled={submit.busy}
        options={components.map((c) => ({
          value: c.id,
          label: `${c.code} — ${localName(c, locale)}`,
        }))}
        onChange={setComponentId}
      />
      <TextField
        label={t("hr.effectiveFrom")}
        type="date"
        required
        value={effectiveFrom}
        disabled={submit.busy}
        onChange={(event) => setEffectiveFrom(event.currentTarget.value)}
      />
      <TextField
        label={
          quantityBased
            ? t("hr.compensation.quantity")
            : t("hr.compensation.amountIn", { currency })
        }
        inputMode="decimal"
        dir="ltr"
        required
        value={value}
        disabled={submit.busy}
        {...(invalid ? { error: t("hr.compensation.invalid") } : {})}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <p className="text-start text-text-muted md:col-span-3">{t("hr.compensation.closesHint")}</p>
      {submit.failure ? (
        <div className="md:col-span-3">
          <ProblemAlert error={submit.failure} />
        </div>
      ) : null}
      <div className="flex gap-2 md:col-span-3">
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("hr.compensation.save")}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("hr.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** `Select` takes no ref; the form's first control is focused on open, so this one is the native element. */
function ComponentSelect({
  selectRef,
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  selectRef: RefObject<HTMLSelectElement | null>;
  label: string;
  value: string;
  disabled: boolean;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-start text-text">
        {label}
        <select
          ref={selectRef}
          className="rounded-sm border border-border bg-surface px-3 py-2 text-start text-text"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
