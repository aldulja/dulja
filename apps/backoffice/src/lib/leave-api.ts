import { EmployeeList } from "@dulja/contracts/hr/employee";
import {
  CreateLeaveRecordBody,
  CreateLeaveTypeBody,
  CreatePublicHolidayBody,
  LeaveDecisionBody,
  LeaveEntitlementList,
  LeaveEntitlementSchema,
  LeaveRecordList,
  LeaveRecordSchema,
  LeaveTypeList,
  LeaveTypeSchema,
  PublicHolidayList,
  PublicHolidaySchema,
  SetLeaveEntitlementBody,
  type LeaveStatusSchema,
} from "@dulja/contracts/hr/leave";
import type { z } from "zod";
import {
  createAdminApi,
  type AdminApiOptions,
  type RequestOptions,
  type SendOptions,
} from "./admin-api";

export type LeaveStatus = z.infer<typeof LeaveStatusSchema>;

/** The leave routes' largest page (`limit` max 200 in `packages/contracts/src/hr/leave.ts`). */
const PAGE = 200;
/** A bound on a runaway read: 50 pages is 10,000 rows, far past any register a screen should show whole. */
const MAX_PAGES = 50;

/** A list read as far as it can be: `complete` is false when rows may remain unread (UI-17, PRD-25). */
export interface Whole<T> {
  items: T[];
  complete: boolean;
}

/**
 * UI-17 / PRD-25: every leave list answers one bounded page and `next_cursor: null` by contract, so it is read on
 * by its ORDER's own filter instead — the next page starts at the last row's date (inclusive, so a date split
 * across two pages loses nothing) and a row already held is dropped by id. When a full page adds nothing new (more
 * rows share one date than a page holds) or the page bound is reached, the answer says it is not complete.
 */
async function readOn<T extends { id: string }>(
  page: (from: string | null) => Promise<{ items: T[] }>,
  boundOf: (row: T) => string,
): Promise<Whole<T>> {
  const held = new Map<string, T>();
  let from: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const { items } = await page(from);
    const before = held.size;
    for (const row of items) held.set(row.id, row);
    if (items.length < PAGE) return { items: [...held.values()], complete: true };
    if (held.size === before) break;
    from = boundOf(items[items.length - 1]!);
  }
  return { items: [...held.values()], complete: false };
}

/**
 * 8D Task 10's handwritten fetch layer over 8D Task 8's leave register (⚠️ OD-13, answered build), all under
 * `/v1/companies/{companyId}/leave-records`. Every body is parsed by the route's own strict contract before it leaves,
 * so a screen cannot send a member the server would refuse — a decider above all: R4 (no self-approval) and the
 * decider's stamp are the database's, never this screen's.
 */
export function leaveApi(options: AdminApiOptions, companyId: string) {
  const api = createAdminApi(options);
  const root = `/v1/companies/${encodeURIComponent(companyId)}`;
  const leave = `${root}/leave-records`;
  return {
    /** Newest start first, so each further page is bounded above by the last start date read. */
    records: (filter: { status: LeaveStatus | null }, request?: RequestOptions) =>
      readOn(
        (to) => {
          const query = new URLSearchParams({ limit: String(PAGE) });
          if (filter.status !== null) query.set("filter[status][eq]", filter.status);
          if (to !== null) query.set("filter[starts_on][lte]", to);
          return api.get(`${leave}?${query}`, LeaveRecordList, request);
        },
        (row) => row.startsOn,
      ),
    request: (body: z.input<typeof CreateLeaveRecordBody>, request: SendOptions) =>
      api.send("POST", leave, CreateLeaveRecordBody.parse(body), LeaveRecordSchema, request),
    decide: (id: string, body: z.input<typeof LeaveDecisionBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${leave}/${encodeURIComponent(id)}/decision`,
        LeaveDecisionBody.parse(body),
        LeaveRecordSchema,
        request,
      ),
    types: async (request?: RequestOptions): Promise<Whole<z.infer<typeof LeaveTypeSchema>>> => {
      const { items } = await api.get(
        `${leave}/types?${new URLSearchParams({ includeArchived: "false", limit: String(PAGE) })}`,
        LeaveTypeList,
        request,
      );
      // Ordered by code with no range filter to read on by: a full page is reported, never assumed whole.
      return { items, complete: items.length < PAGE };
    },
    createType: (body: z.input<typeof CreateLeaveTypeBody>, request: SendOptions) =>
      api.send("POST", `${leave}/types`, CreateLeaveTypeBody.parse(body), LeaveTypeSchema, request),
    /**
     * The year's entitlements. Their order (employee number, type code) has no range filter to read on by, so a full
     * page is read again one leave type at a time — 200 employees per type — and a type that fills its own page
     * makes the answer incomplete.
     */
    entitlements: async (
      year: number,
      request?: RequestOptions,
    ): Promise<Whole<z.infer<typeof LeaveEntitlementSchema>>> => {
      const page = (leaveTypeId: string | null) => {
        const query = new URLSearchParams({
          "filter[year][eq]": String(year),
          limit: String(PAGE),
        });
        if (leaveTypeId !== null) query.set("filter[leave_type_id][eq]", leaveTypeId);
        return api.get(`${leave}/entitlements?${query}`, LeaveEntitlementList, request);
      };
      const first = await page(null);
      if (first.items.length < PAGE) return { items: first.items, complete: true };
      const types = await api.get(
        `${leave}/types?${new URLSearchParams({ includeArchived: "true", limit: String(PAGE) })}`,
        LeaveTypeList,
        request,
      );
      const perType = await Promise.all(types.items.map((type) => page(type.id)));
      const items = perType
        .flatMap((answer) => answer.items)
        .toSorted((a, b) =>
          a.employeeNumber === b.employeeNumber
            ? a.leaveTypeCode < b.leaveTypeCode
              ? -1
              : 1
            : a.employeeNumber < b.employeeNumber
              ? -1
              : 1,
        );
      const complete =
        types.items.length < PAGE && perType.every((answer) => answer.items.length < PAGE);
      return { items, complete };
    },
    setEntitlement: (body: z.input<typeof SetLeaveEntitlementBody>, request: SendOptions) =>
      api.send(
        "PUT",
        `${leave}/entitlements`,
        SetLeaveEntitlementBody.parse(body),
        LeaveEntitlementSchema,
        request,
      ),
    /** Oldest first, so each further page starts at the last date read — the newest holidays are never cut off. */
    holidays: (request?: RequestOptions) =>
      readOn(
        (from) => {
          const query = new URLSearchParams({ limit: String(PAGE) });
          if (from !== null) query.set("filter[holiday_on][gte]", from);
          return api.get(`${leave}/holidays?${query}`, PublicHolidayList, request);
        },
        (row) => row.holidayOn,
      ),
    createHoliday: (body: z.input<typeof CreatePublicHolidayBody>, request: SendOptions) =>
      api.send(
        "POST",
        `${leave}/holidays`,
        CreatePublicHolidayBody.parse(body),
        PublicHolidaySchema,
        request,
      ),
    /** One page of a branch's employees (6C) — the register carries numbers, not names, and this is who may be named. */
    employees: (branchId: string, cursor: string | null, request?: RequestOptions) => {
      const query = new URLSearchParams({ limit: "200", "filter[homeBranchId][eq]": branchId });
      if (cursor !== null) query.set("cursor", cursor);
      return api.get(`${root}/employees?${query}`, EmployeeList, request);
    },
  };
}

export type LeaveApi = ReturnType<typeof leaveApi>;
