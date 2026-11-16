import { StaffContextSchema, type StaffContext } from "@dulja/contracts/admin/staff-context";
import { Select } from "@dulja/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { createAdminApi, type AdminApiOptions } from "../lib/admin-api";
import { retryQuery } from "../lib/problem";
import { useI18n } from "../lib/i18n-provider";
import { useStaffRefusal } from "./staff-failure";

export type StaffCompany = StaffContext["companies"][number];
export function StaffContextPicker({
  api,
  children,
}: {
  api: AdminApiOptions;
  children: (company: StaffCompany) => ReactNode;
}) {
  const { t } = useI18n();
  const client = useMemo(() => createAdminApi(api), [api]);
  const [companyId, setCompanyId] = useState("");
  const context = useQuery({
    queryKey: ["staff-context", api.baseUrl],
    queryFn: ({ signal }) => client.get("/v1/staff-context", StaffContextSchema, { signal }),
    enabled: api.accessToken() !== null,
    retry: retryQuery,
  });
  useStaffRefusal(context.error);
  if (context.isPending) return <p>{t("app.loading")}</p>;
  if (context.error) return <p role="alert">{t("staff.loadFailed")}</p>;
  const companies = context.data?.companies ?? [];
  const selected = companies.find((company) => company.id === companyId) ?? companies[0];
  if (!selected) return <p role="alert">{t("staff.noAccess")}</p>;
  return (
    <div className="flex flex-col gap-4">
      <Select
        label={t("staff.company")}
        value={selected.id}
        options={companies.map((company) => ({ value: company.id, label: company.name }))}
        onChange={(event) => setCompanyId(event.currentTarget.value)}
      />
      <div key={selected.id}>{children(selected)}</div>
    </div>
  );
}

/**
 * 8A Task 13 — the same staff-context answer as the picker, for a screen whose company is already chosen (an
 * employee's HR record, opened from the directory's company). An unknown or absent id falls back to the first
 * company the operator may see, as the picker does; one the operator cannot see is "no access", never a guess.
 */
export function StaffCompanyGate({
  api,
  companyId,
  children,
}: {
  api: AdminApiOptions;
  companyId: string | undefined;
  children: (company: StaffCompany) => ReactNode;
}) {
  const { t } = useI18n();
  const client = useMemo(() => createAdminApi(api), [api]);
  const context = useQuery({
    queryKey: ["staff-context", api.baseUrl],
    queryFn: ({ signal }) => client.get("/v1/staff-context", StaffContextSchema, { signal }),
    enabled: api.accessToken() !== null,
    retry: retryQuery,
  });
  useStaffRefusal(context.error);
  if (context.isPending) return <p>{t("app.loading")}</p>;
  if (context.error) return <p role="alert">{t("staff.loadFailed")}</p>;
  const companies = context.data?.companies ?? [];
  const company =
    companyId === undefined ? companies[0] : companies.find((value) => value.id === companyId);
  if (!company) return <p role="alert">{t("staff.noAccess")}</p>;
  return <div key={company.id}>{children(company)}</div>;
}
