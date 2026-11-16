import { describe, expect, it, vi } from "vitest";
import { leaveApi } from "../src/lib/leave-api";
import { payrollApi } from "../src/lib/payroll-api";

/**
 * UI-17 / PRD-25: the leave lists and the run's attachment list answer at most one bounded page and no cursor
 * (`next_cursor` is always null by contract). A list must not stop silently at that page: the leave lists read
 * on with the filters their order allows, and a list that still cannot be read whole says so.
 */
const COMPANY = "0192cccc-0001-7000-8000-000000000001";
const ANNUAL = "0192d0d0-0001-7000-8000-000000000001";
const SICK = "0192d0d0-0002-7000-8000-000000000002";
const CASUAL = "0192d0d0-0003-7000-8000-000000000003";
const uuid = (n: number) => `0192e2e2-0000-7000-8000-${String(n).padStart(12, "0")}`;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const day = (n: number) =>
  new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

function client(handler: (url: URL) => unknown) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => json(handler(new URL(String(input)))));
  return {
    fetchImpl,
    leave: leaveApi(
      { baseUrl: "https://example.test", accessToken: () => "t", fetchImpl },
      COMPANY,
    ),
    payroll: payrollApi(
      { baseUrl: "https://example.test", accessToken: () => "t", fetchImpl },
      COMPANY,
    ),
  };
}

describe("UI-17 / PRD-25 — the leave register reads past one page", () => {
  it("holidays: 250 rows in date order, read on from the last date, the newest included", async () => {
    const all = Array.from({ length: 250 }, (_, n) => ({
      id: uuid(n),
      branchId: null,
      holidayOn: day(n),
      nameEn: `Holiday ${n}`,
      nameAr: null,
    }));
    const { leave } = client((url) => {
      const from = url.searchParams.get("filter[holiday_on][gte]");
      const limit = Number(url.searchParams.get("limit"));
      const rows = all.filter((h) => from === null || h.holidayOn >= from);
      return { items: rows.slice(0, limit), next_cursor: null };
    });
    const answer = await leave.holidays();
    expect(answer.items.map((h) => h.id)).toEqual(all.map((h) => h.id));
    expect(answer.complete).toBe(true);
  });

  it("records: 230 rows newest first, read on from the last start date, each once", async () => {
    const all = Array.from({ length: 230 }, (_, n) => ({
      id: uuid(n),
      employeeId: uuid(9000),
      employeeNumber: "E-0001",
      leaveTypeId: ANNUAL,
      leaveTypeCode: "annual",
      startsOn: day(1000 - Math.floor(n / 2)),
      endsOn: day(1000 - Math.floor(n / 2)),
      days: "1.00",
      status: "approved",
      approvedBy: null,
      reason: null,
    }));
    const { leave, fetchImpl } = client((url) => {
      const to = url.searchParams.get("filter[starts_on][lte]");
      const limit = Number(url.searchParams.get("limit"));
      const rows = all.filter((r) => to === null || r.startsOn <= to);
      return { items: rows.slice(0, limit), next_cursor: null };
    });
    const answer = await leave.records({ status: "approved" });
    expect(answer.items.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(answer.complete).toBe(true);
    for (const [input] of fetchImpl.mock.calls)
      expect(new URL(String(input)).searchParams.get("filter[status][eq]")).toBe("approved");
  });

  it("entitlements: 70 employees × 3 types, read per type once the year's page is full", async () => {
    const types = [ANNUAL, SICK, CASUAL];
    const all = Array.from({ length: 70 }, (_, e) =>
      types.map((leaveTypeId, k) => ({
        employeeId: uuid(e),
        employeeNumber: `E-${String(e).padStart(4, "0")}`,
        year: 2026,
        leaveTypeId,
        leaveTypeCode: (["annual", "sick", "unpaid"] as const)[k],
        days: "14.00",
      })),
    ).flat();
    const { leave } = client((url) => {
      if (url.pathname.endsWith("/types"))
        return {
          items: types.map((id, k) => ({
            id,
            code: (["annual", "sick", "unpaid"] as const)[k],
            nameEn: id,
            nameAr: null,
            paid: true,
            archivedAt: null,
          })),
          next_cursor: null,
        };
      const type = url.searchParams.get("filter[leave_type_id][eq]");
      const limit = Number(url.searchParams.get("limit"));
      return {
        items: all.filter((r) => type === null || r.leaveTypeId === type).slice(0, limit),
        next_cursor: null,
      };
    });
    const answer = await leave.entitlements(2026);
    expect(answer.items).toHaveLength(210);
    expect(new Set(answer.items.map((r) => `${r.employeeId}:${r.leaveTypeId}`)).size).toBe(210);
    expect(answer.complete).toBe(true);
  });

  it("says so when a page cannot be read past: more rows share one start date than a page holds", async () => {
    const all = Array.from({ length: 201 }, (_, n) => ({
      id: uuid(n),
      employeeId: uuid(9000),
      employeeNumber: "E-0001",
      leaveTypeId: ANNUAL,
      leaveTypeCode: "annual",
      startsOn: "2026-01-01",
      endsOn: "2026-01-01",
      days: "1.00",
      status: "requested",
      approvedBy: null,
      reason: null,
    }));
    const { leave } = client((url) => ({
      items: all.slice(0, Number(url.searchParams.get("limit"))),
      next_cursor: null,
    }));
    const answer = await leave.records({ status: null });
    expect(answer.items).toHaveLength(200);
    expect(answer.complete).toBe(false);
  });

  it("the run's attachment list says when it is cut at the route's 1,000 rows", async () => {
    const file = (n: number) => ({
      id: uuid(n),
      companyId: COMPANY,
      documentId: uuid(9999),
      lotId: null,
      objectKey: "opaque-store-key",
      fileName: `payslip-${n}.pdf`,
      mimeType: "application/pdf",
      byteSize: 10,
      sha256: "a".repeat(64),
      uploadedBy: uuid(9998),
      createdAt: "2026-11-01T00:00:00Z",
    });
    const full = client(() => ({
      items: Array.from({ length: 1000 }, (_, n) => file(n)),
      next_cursor: null,
    }));
    expect((await full.payroll.runAttachments(uuid(9999))).complete).toBe(false);
    const short = client(() => ({ items: [file(1)], next_cursor: null }));
    expect((await short.payroll.runAttachments(uuid(9999))).complete).toBe(true);
  });
});
