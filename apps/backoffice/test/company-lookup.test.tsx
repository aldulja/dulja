import { describe, expect, it, vi } from "vitest";
import { createReportApi } from "../src/lib/report-api";

/**
 * UI-11 (2026-11-15 review; ADR 0089): a report's branch choices come from the caller's own memberships
 * (`GET /v1/me/companies`), not from `/v1/staff-context`, which answers only seven staff codes — so a warehouse or
 * report-only reader got 403 and could pick no branch.
 */
const COMPANY = "01920000-0000-7000-8000-000000000001";
const OTHER = "01920000-0000-7000-8000-000000000002";
const HQ = "01920000-0000-7000-8000-000000000011";
const BR2 = "01920000-0000-7000-8000-000000000012";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the report branch lookup", () => {
  it("lists the branches the caller holds a role in for this company, from /v1/me/companies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/me/companies")
        return json({
          companies: [
            {
              id: COMPANY,
              code: "HQ",
              name: "Acme",
              branches: [
                { id: BR2, code: "BR2", nameEn: "Second", nameAr: null },
                { id: HQ, code: "HQ", nameEn: "Head office", nameAr: "المكتب" },
              ],
            },
            { id: OTHER, code: "OT", name: "Other", branches: [] },
          ],
        });
      // What a warehouse or report-only reader is answered here.
      if (path === "/v1/staff-context")
        return json(
          { type: "urn:dulja:error:ERR_RBAC_FORBIDDEN", status: 403, code: "ERR_RBAC_FORBIDDEN" },
          403,
        );
      throw new Error(`unexpected fetch: ${path}`);
    });
    const api = createReportApi(
      { baseUrl: "https://api.test", accessToken: () => "jwt", fetchImpl },
      COMPANY,
    );
    const result = await api.lookup("branch");
    expect(result.complete).toBe(true);
    expect(result.options.map((o) => o.id)).toEqual([BR2, HQ]);
    expect(result.options[1]).toMatchObject({
      code: "HQ",
      nameEn: "Head office",
      nameAr: "المكتب",
    });
  });
});
