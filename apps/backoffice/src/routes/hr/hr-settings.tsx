import type { HrSettingDto } from "@dulja/contracts/hr/hr-setting";
import { Button, Select, TextField } from "@dulja/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import { isForbidden, useSubmit } from "../../features/hr/shared";
import { ProblemAlert, useRefusalRedirect } from "../../features/reports/shared";
import type { AdminApiOptions } from "../../lib/admin-api";
import { hrApi } from "../../lib/hr-api";
import { retryQuery } from "../../lib/problem";

const RULES = ["calendar_days", "working_days"] as const;
type Rule = (typeof RULES)[number];

/**
 * 8A Task 13 — the company's HR settings (8A Task 11, ⚠️ OD-23): the proration rule the accountant confirms, the pay
 * day, and each scheme's employer registration number — stored on the scheme row, never in a blob (amendments
 * A3, A4). Until the owner supplies them the registrations are empty and the screen says so.
 */
export function HrSettingsRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <HrSettings api={api} company={company} />}
    </StaffContextPicker>
  );
}

function HrSettings({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t } = useShell();
  const client = useMemo(() => hrApi(api, company.id), [api, company.id]);
  const settings = useQuery({
    queryKey: ["hr-settings", company.id],
    queryFn: ({ signal }) => client.settings({ signal }),
    retry: retryQuery,
  });
  useRefusalRedirect(settings.error);
  return (
    <section className="flex flex-col gap-4" aria-label={t("hr.settings.title")}>
      <h1 className="text-start text-xl font-bold">{t("hr.settings.title")}</h1>
      <p className="text-start text-text-muted">{t("hr.settings.intro")}</p>
      {settings.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {settings.error ? (
        isForbidden(settings.error) ? (
          <p role="status">{t("hr.settings.denied")}</p>
        ) : (
          <ProblemAlert error={settings.error} />
        )
      ) : null}
      {settings.data ? (
        <SettingsForm
          key={company.id}
          client={client}
          companyId={company.id}
          stored={settings.data}
        />
      ) : null}
    </section>
  );
}

function SettingsForm({
  client,
  companyId,
  stored,
}: {
  client: ReturnType<typeof hrApi>;
  companyId: string;
  stored: HrSettingDto;
}) {
  const { t } = useShell();
  const cache = useQueryClient();
  const [rule, setRule] = useState<Rule>(stored.prorationRule);
  const [payDay, setPayDay] = useState(stored.payDay === null ? "" : String(stored.payDay));
  const [registrations, setRegistrations] = useState<Record<string, string>>(() =>
    Object.fromEntries(stored.employerRegistrations.map((r) => [r.schemeId, r.registration ?? ""])),
  );
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const submit = useSubmit();
  useRefusalRedirect(submit.failure);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (payDay !== "" && !(/^\d{1,2}$/.test(payDay) && +payDay >= 1 && +payDay <= 31)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const body = {
      prorationRule: rule,
      payDay: payDay === "" ? null : Number.parseInt(payDay, 10),
      employerRegistrations: stored.employerRegistrations.map((r) => {
        const value = (registrations[r.schemeId] ?? "").trim();
        return { schemeId: r.schemeId, registration: value === "" ? null : value };
      }),
    };
    const result = await submit.run(body, (idempotencyKey) =>
      client.saveSettings(body, { idempotencyKey }),
    );
    if (result) {
      cache.setQueryData(["hr-settings", companyId], result);
      setSaved(true);
    }
  }
  return (
    <form
      aria-label={t("hr.settings.title")}
      className="flex flex-col gap-4"
      onSubmit={(event) => void save(event)}
    >
      <Select
        label={t("hr.settings.prorationRule")}
        value={rule}
        disabled={submit.busy}
        options={RULES.map((value) => ({ value, label: t(`hr.proration.${value}`) }))}
        onChange={(event) => setRule(event.currentTarget.value as Rule)}
      />
      <TextField
        label={t("hr.settings.payDay")}
        hint={t("hr.settings.payDayHint")}
        inputMode="numeric"
        dir="ltr"
        value={payDay}
        disabled={submit.busy}
        {...(invalid ? { error: t("hr.settings.payDayInvalid") } : {})}
        onChange={(event) => setPayDay(event.currentTarget.value)}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="text-start font-bold">{t("hr.settings.registrations")}</legend>
        <p className="text-start text-text-muted">{t("hr.settings.registrationsHint")}</p>
        {stored.employerRegistrations.length === 0 ? (
          <p>{t("hr.scheme.none")}</p>
        ) : (
          stored.employerRegistrations.map((r) => (
            <TextField
              key={r.schemeId}
              label={t("hr.settings.registrationFor", { code: r.schemeCode })}
              dir="ltr"
              maxLength={80}
              value={registrations[r.schemeId] ?? ""}
              disabled={submit.busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setRegistrations((current) => ({ ...current, [r.schemeId]: value }));
              }}
            />
          ))
        )}
      </fieldset>
      {submit.failure ? <ProblemAlert error={submit.failure} /> : null}
      {saved ? <p role="status">{t("hr.saved")}</p> : null}
      <span>
        <Button type="submit" variant="primary" disabled={submit.busy}>
          {t("staff.save")}
        </Button>
      </span>
    </form>
  );
}
