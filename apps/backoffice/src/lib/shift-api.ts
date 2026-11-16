import { ShiftList, ShiftSchema, TillEventList } from "@dulja/contracts/pos/shift";
import { SalesByCashierList, ZReportList } from "@dulja/contracts/pos/reports";
import { createAdminApi, type AdminApiOptions, type RequestOptions } from "./admin-api";
export function shiftApi(options: AdminApiOptions, companyId: string) {
  const api = createAdminApi(options);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  return {
    shifts: (params: Record<string, string>, request?: RequestOptions) =>
      api.get(
        `${root}/shifts?${new URLSearchParams({ limit: "50", ...params })}`,
        ShiftList,
        request,
      ),
    shift: (id: string, request?: RequestOptions) =>
      api.get(`${root}/shifts/${encodeURIComponent(id)}`, ShiftSchema, request),
    events: (id: string, cursor: string | null, request?: RequestOptions) =>
      api.get(
        `${root}/shifts/${encodeURIComponent(id)}/till-events?${new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) })}`,
        TillEventList,
        request,
      ),
    zReport: (id: string, request?: RequestOptions) =>
      api.get(
        `${root}/reports/pos.z_report?${new URLSearchParams({ shiftId: id, limit: "1" })}`,
        ZReportList,
        request,
      ),
    sales: (params: Record<string, string>, request?: RequestOptions) =>
      api.get(
        `${root}/reports/pos.sales_by_cashier?${new URLSearchParams({ limit: "50", ...params })}`,
        SalesByCashierList,
        request,
      ),
  };
}

/**
 * The zone both shift screens show times in and read "today" in. The API filters a shift by its
 * company-local opening date (`(s.opened_at at time zone co.timezone)::date`,
 * `apps/api/src/routes/pos/shifts.ts`), and no company time zone reaches the client yet, so the screens
 * use the company default (`TimeZoneSchema.default`, `packages/contracts/src/admin/company.ts`), which is
 * also `formatTimestamp`'s. Recorded in `docs/review/2026-10-22-pr12-decisions.md`.
 */
export const SHIFT_TIME_ZONE = "Asia/Kuala_Lumpur";

/**
 * Today's calendar date, `YYYY-MM-DD`, in `timeZone`. Not `toISOString().slice(0, 10)`: that is the UTC
 * day, which for a UTC+8 company is yesterday from midnight to 08:00 local, so the register's default
 * "today" filter would hide every shift opened since midnight.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The over/short's tone — the one coloured figure on either shift screen (6D Task 12's default layout:
 * a manager scanning twenty drawers is looking for exactly one thing). It reads the sign off the wire's
 * decimal STRING, so no `Number` ever holds the amount (spec:2041).
 *
 * An exact count is `"none"`, not `"over"`: plan Step 3 tests only for a leading minus, which would show
 * a drawer that balanced to the cent in the surplus colour. `null` — a shift not yet closed — is `"none"`
 * as well. Recorded in `docs/review/2026-10-22-pr12-decisions.md`.
 */
export type OverShortTone = "none" | "short" | "over";
const ZERO = /^-?0+(\.0+)?$/;
export function overShortTone(value: { readonly amount: string } | null): OverShortTone {
  if (value === null || ZERO.test(value.amount)) return "none";
  return value.amount.startsWith("-") ? "short" : "over";
}
