// apps/api/test/routes/sync/catalogue.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantCodes, seedItem, seedTenantV2, seedUnit, type Seed } from "@dulja/db/test";
// FIVE levels: apps/api/test/routes/sync/ → four would resolve to `apps/`. Same as terminal-auth.test.ts.
import {
  enrolTerminal,
  syncRequest,
  type EnrolledTerminal,
} from "../../../../../tests/invariants/support/pos";
import { startApi, type StartedApi } from "../../support/app";
import type { Problem } from "@dulja/contracts";
import type { CataloguePage } from "@dulja/sync";

describe("GET /v1/sync/catalogue — the branch-scoped down-sync over the wire", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  let t: EnrolledTerminal;
  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    await grantCodes(api.db, a, { codes: ["admin.terminal.manage"] });
    // The SAME item code in both tenants, so a leak would be invisible to a code comparison and visible only
    // as a count — which is the assertion the last case makes.
    const ua = await seedUnit(api.db, a);
    const ub = await seedUnit(api.db, b);
    await seedItem(api.db, a, { code: "SKU-SHARED", baseUnitId: ua });
    await seedItem(api.db, b, { code: "SKU-SHARED", baseUnitId: ub });
    t = await enrolTerminal(api, a, { as: a.human, code: "KL20" });
  }, 240_000);
  afterAll(async () => {
    await api.stop();
  });

  it("a signed pull returns a page, a cursor and a terminal token", async () => {
    const res = await syncRequest(api, t, { method: "GET", path: "/v1/sync/catalogue?limit=1000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Terminal-Token")).toBeTruthy();
    const page = (await res.json()) as CataloguePage;
    expect(page.changes.length).toBeGreaterThan(0);
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page.has_more).toBe(false);
    // A revision crosses the wire as a STRING (T1): read as a JSON number it would round past 2^53.
    expect(typeof (page.changes[0] as unknown as { revision: unknown }).revision).toBe("string");
  });

  it("a second pull from next_cursor returns has_more false and zero changes", async () => {
    const first = (await (
      await syncRequest(api, t, { method: "GET", path: "/v1/sync/catalogue?limit=1000" })
    ).json()) as CataloguePage;
    const res = await syncRequest(api, t, {
      method: "GET",
      path: `/v1/sync/catalogue?limit=1000&since=${encodeURIComponent(first.next_cursor)}`,
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as CataloguePage;
    expect(page.changes).toEqual([]);
    expect(page.has_more).toBe(false);
    // The cursor does not go BACKWARDS on an empty page: readCatalogue returns `since` unchanged, so a till
    // that polls a quiet catalogue never re-pulls what it already has.
    expect(page.next_cursor).toBe(first.next_cursor);
  });

  it("a `since` that is not a cursor this server issued is 400 ERR_SYNC_CURSOR_INVALID", async () => {
    for (const bad of ["!!!", "eyJrIjpbXX0"]) {
      const res = await syncRequest(api, t, {
        method: "GET",
        path: `/v1/sync/catalogue?since=${encodeURIComponent(bad)}`,
      });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as Problem).code, bad).toBe("ERR_SYNC_CURSOR_INVALID");
    }
  });

  it("a terminal in tenant A sees ZERO rows of tenant B's catalogue (the probe cannot make this one)", async () => {
    const page = (await (
      await syncRequest(api, t, { method: "GET", path: "/v1/sync/catalogue?limit=1000" })
    ).json()) as CataloguePage;
    const items = page.changes.filter((c) => c.stream === "item");
    // Both tenants hold an item coded SKU-SHARED, so comparing codes would prove nothing. Compare IDS against
    // the database: every id delivered must belong to tenant A, and the count of B's items must be non-zero
    // (or the case is vacuous because B has nothing to leak).
    const ids = items.map((c) => c.id);
    const [n] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.item where tenant_id = ${b.tenant} and id = any(${ids})`;
    expect(n!.n).toBe(0);
    const [bTotal] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.item where tenant_id = ${b.tenant}`;
    expect(bTotal!.n, "tenant B must actually have items, or this asserts nothing").toBeGreaterThan(
      0,
    );
  });
});
