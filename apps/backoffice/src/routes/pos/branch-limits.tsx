import {
  UpsertBranchPosPolicyBody,
  type BranchPosPolicyDto,
} from "@dulja/contracts/pos/branch-pos-policy";
import { Button, Select, TextField } from "@dulja/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useShell } from "../../components/app-shell";
import { StaffFailure } from "../../components/staff-failure";
import { StaffContextPicker, type StaffCompany } from "../../components/staff-context";
import type { AdminApiOptions } from "../../lib/admin-api";
import { staffApi } from "../../lib/staff-api";
import { amountToWire, fractionToPercent, percentToFraction } from "../../lib/staff-decimals";
import { retryQuery } from "../../lib/problem";

export function BranchLimitsRoute({ api }: { api: AdminApiOptions }) {
  return (
    <StaffContextPicker api={api}>
      {(company) => <CompanyLimits api={api} company={company} />}
    </StaffContextPicker>
  );
}
function CompanyLimits({ api, company }: { api: AdminApiOptions; company: StaffCompany }) {
  const { t, locale } = useShell();
  const [branchId, setBranchId] = useState(company.branches[0]?.id ?? "");
  return (
    <section className="flex flex-col gap-4">
      <h1>{t("staff.limits")}</h1>
      <Select
        label={t("staff.branch")}
        value={branchId}
        options={company.branches.map((branch) => ({
          value: branch.id,
          label: locale === "ar" ? (branch.nameAr ?? branch.nameEn) : branch.nameEn,
        }))}
        onChange={(event) => setBranchId(event.currentTarget.value)}
      />
      <PolicyEditor key={branchId} api={api} company={company} branchId={branchId} />
    </section>
  );
}
const fields = [
  "maxLineDiscountPct",
  "maxTicketDiscountPct",
  "maxVoidAmount",
  "maxPriceOverridePct",
  "maxBlindReturnAmount",
  "roundingIncrement",
  "maxCashInDrawer",
  "requireCustomerOver",
  "maxPaidOutAmount",
] as const;
type Field = (typeof fields)[number];
const isPercent = (field: Field) => field.endsWith("Pct");
/** Limits the database leaves NULL until set (PRD-21): a blank field, never a pre-filled zero. */
const isOptional = (field: Field) => field === "maxCashInDrawer" || field === "requireCustomerOver";
function policyFields(policy?: BranchPosPolicyDto): Record<Field, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = policy?.[field];
      return [
        field,
        value === null || (value === undefined && isOptional(field))
          ? ""
          : value === undefined
            ? field === "roundingIncrement"
              ? "0.0500"
              : "0.0000"
            : isPercent(field)
              ? fractionToPercent(value)
              : value,
      ];
    }),
  ) as Record<Field, string>;
}
function PolicyEditor({
  api,
  company,
  branchId,
}: {
  api: AdminApiOptions;
  company: StaffCompany;
  branchId: string;
}) {
  const { t } = useShell();
  const client = useMemo(() => staffApi(api, company.id), [api, company.id]);
  const query = useQuery({
    queryKey: ["staff-policy", company.id, branchId],
    queryFn: ({ signal }) => client.policies(branchId, { signal }),
    retry: retryQuery,
  });
  if (query.isPending) return <p>{t("app.loading")}</p>;
  if (query.error) return <p role="alert">{t("staff.loadFailed")}</p>;
  return (
    <PolicyForm
      key={query.data?.items[0]?.revision ?? "new"}
      client={client}
      branchId={branchId}
      currency={company.baseCurrency}
      policy={query.data?.items[0]}
      onSaved={() => {
        void query.refetch();
      }}
    />
  );
}
function PolicyForm({
  client,
  branchId,
  currency,
  policy,
  onSaved,
}: {
  client: ReturnType<typeof staffApi>;
  branchId: string;
  currency: string;
  policy: BranchPosPolicyDto | undefined;
  onSaved: () => void;
}) {
  const { t } = useShell();
  const [values, setValues] = useState(() => policyFields(policy));
  const [blind, setBlind] = useState(policy?.blindReturnAllowed ?? false);
  const [paidOut, setPaidOut] = useState(policy?.paidOutAllowed ?? false);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef(new AbortController());
  const attempts = useRef(new Map<string, string>());
  // A fresh controller per mount: StrictMode's development remount runs this cleanup once, and a
  // controller made only by `useRef` would stay aborted and refuse every later save.
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    return () => active.abort();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    try {
      const decimalValues = Object.fromEntries(
        fields.map((field) => [
          field,
          isOptional(field) && values[field] === ""
            ? null
            : isPercent(field)
              ? percentToFraction(values[field])
              : amountToWire(values[field]),
        ]),
      );
      const body = UpsertBranchPosPolicyBody.parse({
        branchId,
        ...decimalValues,
        blindReturnAllowed: blind,
        paidOutAllowed: paidOut,
      });
      const fingerprint = JSON.stringify(body);
      const idempotencyKey = attempts.current.get(fingerprint) ?? crypto.randomUUID();
      attempts.current.set(fingerprint, idempotencyKey);
      setBusy(true);
      await client.savePolicy(body, { idempotencyKey, signal: controller.current.signal });
      if (!controller.current.signal.aborted) onSaved();
    } catch (cause) {
      if (!controller.current.signal.aborted) setFailure(cause);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  function limitField(field: Field) {
    return (
      <TextField
        key={field}
        label={t(`staff.limit.${field}`)}
        value={values[field]}
        inputMode="decimal"
        disabled={busy}
        hint={isPercent(field) ? t("staff.percentHint") : t("staff.amountHint", { currency })}
        onChange={(event) => {
          // Read now: React clears `currentTarget` once dispatch ends, before a queued updater runs.
          const value = event.currentTarget.value;
          setValues((current) => ({ ...current, [field]: value }));
        }}
      />
    );
  }
  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-3"
    >
      {fields.filter((field) => field !== "maxPaidOutAmount").map(limitField)}
      <label>
        <input
          type="checkbox"
          checked={blind}
          disabled={busy}
          onChange={(event) => setBlind(event.currentTarget.checked)}
        />
        {t("staff.blindAllowed")}
      </label>
      <label>
        <input
          type="checkbox"
          checked={paidOut}
          disabled={busy}
          onChange={(event) => setPaidOut(event.currentTarget.checked)}
        />
        {t("staff.paidOutAllowed")}
      </label>
      {limitField("maxPaidOutAmount")}
      {failure ? <StaffFailure cause={failure} /> : null}
      <Button type="submit" disabled={busy}>
        {t("staff.save")}
      </Button>
    </form>
  );
}
