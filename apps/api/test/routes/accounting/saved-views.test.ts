import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedReportDefinition, seedTenantV2, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const DEF = {
  version: 1,
  code: "accounting.trial_balance",
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: {
    source: "account_balance",
    filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
  },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

interface ViewDto {
  id: string;
  companyId: string;
  ownerPrincipalId: string;
  nameEn: string;
  shared: boolean;
  archivedAt: string | null;
}

describe("/v1/companies/{companyId}/saved-views — 7A Task 13", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let definitionId: string;
  let colleague: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "views-api");
    other = await seedTenantV2(api.db, "views-api-other");
    definitionId = await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
    colleague = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${colleague}, 'human', ${`sub:${colleague}`}, 'Colleague')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${colleague})`;
    });
    // NEITHER principal is granted a permission code: the module declares `permissions: []`, so membership,
    // the company predicate and the owner column are the whole of the authorisation.
    await api.loadPrincipals();
  }, 240_000);
  afterAll(async () => {
    await api.stop();
  });

  const path = (suffix = "", seed?: Seed) =>
    `/v1/companies/${(seed ?? s).company}/saved-views${suffix}`;
  const create = (as: string, body: Record<string, unknown>) =>
    api.request({
      method: "POST",
      path: path(),
      body: { reportDefinitionId: definitionId, ...body },
      as,
    });

  it("creates a view owned by the caller, with no permission code involved", async () => {
    const res = await create(s.human, {
      nameEn: "Q1",
      nameAr: "الربع الأول",
      parameters: { fiscalPeriodId: s.period },
    });
    expect(res.status).toBe(201);
    const view = (await res.json()) as ViewDto;
    expect(view.ownerPrincipalId).toBe(s.human);
    expect(view.companyId).toBe(s.company);
    expect(view.shared).toBe(false);
    expect(view.archivedAt).toBeNull();
  });

  it("an owner in the payload is refused: the owner is the session's principal, never the body's", async () => {
    const res = await create(s.human, { nameEn: "Forged", ownerPrincipalId: colleague });
    expect(res.status).toBe(400);
  });

  it("refuses a parameter the definition does not declare, at SAVE time", async () => {
    const bad = await problemOf(
      await create(s.human, {
        nameEn: "Wrong",
        parameters: { fiscalPeriodId: s.period, branchId: s.hq },
      }),
    );
    expect(bad.code).toBe("ERR_VALIDATION_FAILED");
    expect(bad.detail).toContain("branchId");
  });

  it("a definition of another tenant is a 404 — the view cannot name it", async () => {
    const foreign = await seedReportDefinition(api.db, other, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
    const res = await problemOf(
      await create(s.human, { reportDefinitionId: foreign, nameEn: "X" }),
    );
    expect(res.code).toBe("ERR_NOT_FOUND");
  });

  it("a list shows the caller's own views and every shared one, and never a colleague's private view", async () => {
    const mine = (await (await create(s.human, { nameEn: "Mine" })).json()) as ViewDto;
    const theirPrivate = (await (await create(colleague, { nameEn: "Theirs" })).json()) as ViewDto;
    const theirShared = (await (
      await create(colleague, { nameEn: "Shared", shared: true })
    ).json()) as ViewDto;

    const ids = (
      (await (await api.request({ method: "GET", path: path(), as: s.human })).json()) as {
        items: { id: string }[];
      }
    ).items.map((v) => v.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(theirShared.id);
    expect(ids).not.toContain(theirPrivate.id);

    // A direct GET of the shared one answers; of the private one is a 403, not a 404: the row IS in this
    // caller's tenant and company. Only a cross-tenant read answers 404 (the isolation probe).
    expect(
      (await api.request({ method: "GET", path: path(`/${theirShared.id}`), as: s.human })).status,
    ).toBe(200);
    const denied = await problemOf(
      await api.request({ method: "GET", path: path(`/${theirPrivate.id}`), as: s.human }),
    );
    expect(denied.code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("filters by definition and pages through next_cursor", async () => {
    const all = (
      (await (
        await api.request({
          method: "GET",
          path: path(`?filter[report_definition_id][eq]=${definitionId}`),
          as: s.human,
        })
      ).json()) as { items: { id: string }[] }
    ).items.map((v) => v.id);
    expect(all.length).toBeGreaterThan(2);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api.request({
        method: "GET",
        path: path(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`),
        as: s.human,
      });
      const body = (await res.json()) as { items: { id: string }[]; next_cursor: string | null };
      seen.push(...body.items.map((v) => v.id));
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(all);
  });

  it("the owner may update; a colleague may not, and gets 403 from the STORE", async () => {
    const view = (await (await create(s.human, { nameEn: "Before" })).json()) as ViewDto;

    const ok = await api.request({
      method: "PUT",
      path: path(`/${view.id}`),
      body: { nameEn: "After", shared: true },
      as: s.human,
    });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as ViewDto;
    expect(updated.nameEn).toBe("After");
    expect(updated.shared).toBe(true);

    // Shared makes it READABLE, never WRITABLE.
    const refused = await problemOf(
      await api.request({
        method: "PUT",
        path: path(`/${view.id}`),
        body: { nameEn: "Hijacked" },
        as: colleague,
      }),
    );
    expect(refused.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(refused.detail).toContain("only its owner may change a saved view");
    const archive = await problemOf(
      await api.request({ method: "DELETE", path: path(`/${view.id}`), as: colleague }),
    );
    expect(archive.code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("DELETE archives and answers 204; the row survives and a second DELETE is still 204", async () => {
    const view = (await (await create(s.human, { nameEn: "Doomed" })).json()) as ViewDto;

    expect(
      (await api.request({ method: "DELETE", path: path(`/${view.id}`), as: s.human })).status,
    ).toBe(204);

    // The ROW is still there with archived_at set — spec:2049, and `app_rw` holds no DELETE on the table.
    const [row] = await api.db.admin<{ archived_at: string | null }[]>`
      select archived_at from app.saved_view where id = ${view.id}`;
    expect(row!.archived_at).not.toBeNull();
    expect(
      (await api.request({ method: "GET", path: path(`/${view.id}`), as: s.human })).status,
    ).toBe(404);
    expect(
      (await api.request({ method: "DELETE", path: path(`/${view.id}`), as: s.human })).status,
    ).toBe(204);
    const edit = await problemOf(
      await api.request({
        method: "PUT",
        path: path(`/${view.id}`),
        body: { nameEn: "Back" },
        as: s.human,
      }),
    );
    expect(edit.code).toBe("ERR_VALIDATION_FAILED");
  });

  it("another tenant's view is a 404 on every route, and is left untouched", async () => {
    const view = (await (
      await create(s.human, { nameEn: "Isolated", shared: true })
    ).json()) as ViewDto;
    for (const req of [
      { method: "GET" as const, path: path(`/${view.id}`, other) },
      { method: "PUT" as const, path: path(`/${view.id}`, other), body: { nameEn: "Taken" } },
      { method: "DELETE" as const, path: path(`/${view.id}`, other) },
    ]) {
      const res = await api.request({ ...req, as: other.human });
      expect(res.status, `${req.method} ${req.path}`).toBe(404);
    }
    const [row] = await api.db.admin<{ name_en: string; archived_at: string | null }[]>`
      select name_en, archived_at from app.saved_view where id = ${view.id}`;
    expect(row).toEqual({ name_en: "Isolated", archived_at: null });
  });

  it("every unsafe route requires Idempotency-Key", async () => {
    const view = (await (await create(s.human, { nameEn: "Keys" })).json()) as ViewDto;
    const cases: { method: "POST" | "PUT" | "DELETE"; path: string; body?: unknown }[] = [
      { method: "POST", path: path(), body: { reportDefinitionId: definitionId, nameEn: "K" } },
      { method: "PUT", path: path(`/${view.id}`), body: { nameEn: "K" } },
      { method: "DELETE", path: path(`/${view.id}`) },
    ];
    for (const c of cases) {
      const res = await api.request({ ...c, as: s.human, idempotencyKey: null });
      expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });
});
