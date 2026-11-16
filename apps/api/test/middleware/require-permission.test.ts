import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Problem } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { exportRequestGate } from "../../src/export/authorise";
import { reportExportRequestGate } from "../../src/reports/authorise";
import {
  assertRouteGates,
  EXPORT_REQUEST_CODES,
  EXPORT_REQUEST_ROUTES,
  markExportRequestGate,
  markWriteFreeGate,
  requirePermission,
  type GatedModule,
} from "../../src/middleware/require-permission";
import { ROUTES } from "../../src/routes";
import { startApi, type StartedApi } from "../support/app";
import type { AppEnv } from "../../src/context";

/** Mounts one ungated GET under `module` and hands back the check, so a case is a declaration. */
const judgeUngated = (module: GatedModule) => {
  const app = new OpenAPIHono<AppEnv>();
  const mounted = new OpenAPIHono<AppEnv>();
  mounted.get("/", (context) => context.json({}));
  app.route(module.path, mounted);
  return () => assertRouteGates(app, [module]);
};

describe("requirePermission — spec:2173 pre-flight over app.actor_has; acceptance tests 11 and 36", () => {
  let api: StartedApi;
  let a: Seed;
  /** A second human in Alpha, so the last-admin trigger never stands in for the expiry proof below. */
  let deputy: string;

  /** Gives a principal a role holding `code` in `a.company`, granted by the system principal (no self-grant). */
  const grant = async (principalId: string, code: string): Promise<string> => {
    const roleId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${a.tenant}, ${`r-${code}-${roleId}`}, ${code})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${principalId}, ${roleId}, ${a.company})`;
    });
    return roleId;
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    deputy = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${deputy}, 'human', ${`human:deputy:${a.tenant}`}, 'Alpha deputy')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${deputy})`;
    });
    api.app.get(
      "/v1/gate-any",
      requirePermission(PERMISSION["admin.user.manage"], { company: "any" }),
      (context) => context.json({ ok: true }),
    );
    api.app.get(
      "/v1/companies/:companyId/gate-path",
      requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" }),
      (context) => context.json({ ok: true }),
    );
  });
  afterAll(async () => api.stop());

  it("refuses a principal holding nothing, naming the code in the detail", async () => {
    const response = await api.request({ method: "GET", path: "/v1/gate-any", as: a.human });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Problem;
    expect(body.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(body.detail).toContain("admin.user.manage");
  });

  it("admits the principal once an unexpired assignment grants the code in any company of the tenant", async () => {
    await grant(a.human, "admin.user.manage");
    expect((await api.request({ method: "GET", path: "/v1/gate-any", as: a.human })).status).toBe(
      200,
    );
  });

  it("an expired assignment grants nothing (acceptance test 36)", async () => {
    // The plan expired a.human's only assignment directly. As shipped that raises ERR_RBAC_LAST_ADMIN
    // instead: the role granted above holds admin.user.manage, and `keep_last_admin_assignment`
    // (0001_foundations.sql:248) refuses any change that would leave the tenant with no unexpired holder
    // of that code. Giving the deputy the same code first is what the trigger is asking for, and it
    // leaves the clause under test — expiry alone revokes the grant — exactly as the plan wrote it.
    await grant(deputy, "admin.user.manage");
    await withTenant(
      api.db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`update app.role_assignment set expires_at = now() - interval '1 day'
                  where principal_id = ${a.human} and company_id = ${a.company}`,
    );
    const response = await api.request({ method: "GET", path: "/v1/gate-any", as: a.human });
    expect(response.status).toBe(403);
    expect(((await response.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
    // The deputy's identical, unexpired assignment still admits — only the clock revoked a.human's.
    expect((await api.request({ method: "GET", path: "/v1/gate-any", as: deputy })).status).toBe(
      200,
    );
  });

  it("another tenant's company id is 403 under path:companyId, never a leak of its existence", async () => {
    const b = await seedTenant(api.db, "Beta");
    await grant(a.human, "admin.company.manage");
    // Its own company admits, so the refusal below is the company scope failing — not a bare lack of the code.
    expect(
      (
        await api.request({
          method: "GET",
          path: `/v1/companies/${a.company}/gate-path`,
          as: a.human,
        })
      ).status,
    ).toBe(200);
    const response = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}/gate-path`,
      as: a.human,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Problem;
    expect(body.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(body.detail).toContain(b.company);
  });

  it("assertRouteGates passes the shipped route table and sees through a mounted router (spec:2178 R7)", () => {
    // The plan added the bad route to `api.app` itself and re-ran the check. That cannot work as shipped:
    // Hono freezes its matcher on the first request ("Can not add a route since the matcher is already
    // built"), and this suite has already made several. So the positive half runs on the real app — every
    // route `createApp` mounted — and the negative half uses a fresh app. It is not the throwaway app of
    // `middleware.test.ts`, which registers the mis-gated route directly: here the bad gate sits inside a
    // sub-router reached through `app.route()`, which is how every real route is composed, so this also
    // proves the gate symbol survives mounting.
    //
    // Passing ROUTES is what makes the positive half mean something now: every shipped route is an
    // `openapi()` route, so each is SEVERAL `app.routes` entries — validators plus the gate — and
    // the check would report all of them ungated if it read entries instead of method+path groups.
    expect(() => assertRouteGates(api.app, ROUTES)).not.toThrow();
    const app = new OpenAPIHono<AppEnv>();
    const mounted = new OpenAPIHono<AppEnv>();
    mounted.post(
      "/",
      requirePermission(PERMISSION["admin.audit_log.read"], { company: "any" }),
      (context) => context.json({}),
    );
    app.route("/v1/mounted", mounted);
    expect(() => assertRouteGates(app)).toThrow(/ERR_ROUTE_GATE_READONLY.*admin\.audit_log\.read/s);
  });

  it("assertRouteGates refuses a mounted route carrying no gate at all", () => {
    // The clause that was missing until the Phase 0 review: the check only judged gates that were
    // PRESENT, so a route registered without `requirePermission` passed in silence while its module
    // went on declaring a `permissions` array nothing enforced. Opting out is a declaration and
    // never a path shape — an empty `permissions` array (/v1/session) or `auth: "public"`
    // (/healthz) — so all three cases below are the same ungated GET under different declarations.
    expect(
      judgeUngated({ path: "/v1/ungated", permissions: ["admin.company.manage"], auth: "human" }),
    ).toThrow(/ERR_ROUTE_GATE_READONLY.*GET \/v1\/ungated.*admin\.company\.manage/s);
    expect(judgeUngated({ path: "/v1/no-codes", permissions: [], auth: "human" })).not.toThrow();
    expect(judgeUngated({ path: "/open", permissions: [], auth: "public" })).not.toThrow();
  });

  it("assertRouteGates sees an ungated route through a router nested inside a module", () => {
    // Hono records `basePath` as the mount path plus the inner router's own base, so one nested
    // `route()` puts a route's basePath a segment below its module's declared path. Matching the two
    // by equality found no module here and exempted the route in silence — the one composition that
    // could have re-opened the hole this whole assertion closes, and it is legal hono.
    const app = new OpenAPIHono<AppEnv>();
    const outer = new OpenAPIHono<AppEnv>();
    const inner = new OpenAPIHono<AppEnv>();
    inner.get("/", (context) => context.json({}));
    outer.route("/inner", inner);
    app.route("/v1/nested", outer);
    expect(() =>
      assertRouteGates(app, [
        { path: "/v1/nested", permissions: ["admin.company.manage"], auth: "human" },
      ]),
    ).toThrow(/ERR_ROUTE_GATE_READONLY.*GET \/v1\/nested\/inner/s);
  });
});

const readGate = () =>
  markWriteFreeGate(
    (async (_c, next) => {
      await next();
    }) as Parameters<typeof markWriteFreeGate>[0],
    [PERMISSION["accounting.ledger.read"]],
  );
/** Mounts one route under the documents module with `gate` and hands back the check. */
const judge = (method: "get" | "post", path: string, gate = readGate()) => {
  const app = new OpenAPIHono<AppEnv>();
  const mounted = new OpenAPIHono<AppEnv>();
  mounted[method](path, gate, (context) => context.json({}));
  app.route("/v1/companies/:companyId/documents", mounted);
  return () =>
    assertRouteGates(app, [
      {
        path: "/v1/companies/:companyId/documents",
        permissions: ["accounting.journal.post"],
        auth: "human",
      },
    ]);
};

describe("markWriteFreeGate — a read code on an unsafe method, admitted on one kind of evidence (2C)", () => {
  it("admits the print route: a POST, gated by a read code, listed in REPLAY_BY_RERUN", () => {
    expect(judge("post", "/:documentId/print")).not.toThrow();
  });

  it("refuses the same marker on a POST REPLAY_BY_RERUN does not list", () => {
    expect(judge("post", "/:documentId/transitions")).toThrow(
      /ERR_ROUTE_GATE_READONLY.*REPLAY_BY_RERUN does not list it/s,
    );
  });

  it("refuses the marker on a safe method — that is requirePermission's job", () => {
    expect(judge("get", "/:documentId/print")).toThrow(
      /ERR_ROUTE_GATE_READONLY.*for unsafe methods that write nothing/s,
    );
  });

  it("does not un-gate: the marker with no codes is still an ungated route", () => {
    const empty = markWriteFreeGate(
      (async (_c, next) => {
        await next();
      }) as Parameters<typeof markWriteFreeGate>[0],
      [],
    );
    expect(judge("post", "/:documentId/print", empty)).toThrow(
      /ERR_ROUTE_GATE_READONLY.*carries no permission gate/s,
    );
  });

  it("the plain read code on a POST is still refused without the marker", () => {
    const app = new OpenAPIHono<AppEnv>();
    const mounted = new OpenAPIHono<AppEnv>();
    mounted.post(
      "/:documentId/print",
      requirePermission(PERMISSION["accounting.ledger.read"], { company: "path:companyId" }),
      (context) => context.json({}),
    );
    app.route("/v1/companies/:companyId/documents", mounted);
    expect(() => assertRouteGates(app)).toThrow(/ERR_ROUTE_GATE_READONLY.*mutating = false/s);
  });
});

const exportGate = (code: string = "accounting.report.export") =>
  markExportRequestGate(
    (async (_c, next) => {
      await next();
    }) as Parameters<typeof markExportRequestGate>[0],
    code,
  );
/** Mounts one route under the reports module with `gates` and hands back the check. */
const judgeReports = (
  method: "get" | "post",
  path: string,
  ...gates: ReturnType<typeof exportGate>[]
) => {
  const app = new OpenAPIHono<AppEnv>();
  const mounted = new OpenAPIHono<AppEnv>();
  const handlers: MiddlewareHandler<AppEnv>[] = [...gates, async (context) => context.json({})];
  mounted.on(method.toUpperCase(), path, ...(handlers as [MiddlewareHandler<AppEnv>]));
  app.route("/v1/companies/:companyId/reports", mounted);
  return () =>
    assertRouteGates(app, [
      {
        path: "/v1/companies/:companyId/reports",
        permissions: ["accounting.report.read", "accounting.report.export"],
        auth: "human",
      },
    ]);
};

describe("markExportRequestGate — the export code on the export request, and nowhere else (7A, ADR 0067)", () => {
  it("admits POST …/reports/{code}/runs gated by accounting.report.export", () => {
    expect(judgeReports("post", "/:code/runs", exportGate())).not.toThrow();
  });

  it("refuses the marker on a POST EXPORT_REQUEST_ROUTES does not list", () => {
    expect(judgeReports("post", "/:code/archive", exportGate())).toThrow(
      /ERR_ROUTE_GATE_READONLY.*EXPORT_REQUEST_ROUTES does not list it/s,
    );
  });

  it("refuses the marker on a safe method — that is requirePermission's job", () => {
    expect(judgeReports("get", "/:code/runs", exportGate())).toThrow(
      /ERR_ROUTE_GATE_READONLY.*a safe method takes requirePermission/s,
    );
  });

  it("carries no other read code onto the write: a second non-mutating gate is still refused", () => {
    const read = requirePermission(PERMISSION["accounting.report.read"], {
      company: "path:companyId",
    }) as ReturnType<typeof exportGate>;
    expect(judgeReports("post", "/:code/runs", exportGate(), read)).toThrow(
      /ERR_ROUTE_GATE_READONLY.*accounting\.report\.read, which is mutating = false/s,
    );
  });

  it("the export code on the listed POST is still refused without the marker", () => {
    const plain = requirePermission(PERMISSION["accounting.report.export"], {
      company: "path:companyId",
    }) as ReturnType<typeof exportGate>;
    expect(judgeReports("post", "/:code/runs", plain)).toThrow(
      /ERR_ROUTE_GATE_READONLY.*accounting\.report\.export, which is mutating = false/s,
    );
  });

  it("the listed POST with no gate at all is refused by the presence half", () => {
    expect(judgeReports("post", "/:code/runs")).toThrow(
      /ERR_ROUTE_GATE_READONLY.*carries no permission gate/s,
    );
  });
});

/** The codes a gate mark carries — what `assertRouteGates` reads. */
const codesOf = (gate: unknown) =>
  (gate as Record<symbol, unknown>)[Symbol.for("dulja.permissionGate")];

/** Mounts one POST under the exports module with `gates` and hands back the check (7C T9). */
const judgeExports = (...gates: ReturnType<typeof exportGate>[]) => {
  const app = new OpenAPIHono<AppEnv>();
  const mounted = new OpenAPIHono<AppEnv>();
  const handlers: MiddlewareHandler<AppEnv>[] = [...gates, async (context) => context.json({})];
  mounted.on("POST", "/", ...(handlers as [MiddlewareHandler<AppEnv>]));
  app.route("/v1/companies/:companyId/exports", mounted);
  return () =>
    assertRouteGates(app, [
      {
        path: "/v1/companies/:companyId/exports",
        permissions: ["admin.data.export"],
        auth: "human",
      },
    ]);
};

describe("markExportRequestGate — one export code per listed route (7C T9, ADR 0070)", () => {
  it("admits POST …/exports gated by admin.data.export", () => {
    expect(judgeExports(exportGate("admin.data.export"))).not.toThrow();
  });

  it("the report run's POST does not also claim admin.data.export", () => {
    expect(judgeReports("post", "/:code/runs", exportGate("admin.data.export"))).toThrow(
      /ERR_ROUTE_GATE_READONLY.*admin\.data\.export, but EXPORT_REQUEST_ROUTES admits only accounting\.report\.export/s,
    );
  });

  it("POST …/exports does not admit the report export code", () => {
    expect(judgeExports(exportGate("accounting.report.export"))).toThrow(
      /ERR_ROUTE_GATE_READONLY.*accounting\.report\.export, but EXPORT_REQUEST_ROUTES admits only admin\.data\.export/s,
    );
  });

  it("each listed route names exactly one code, and the shipped gates carry only their own", () => {
    for (const route of EXPORT_REQUEST_ROUTES) expect(EXPORT_REQUEST_CODES).toContain(route.code);
    expect(codesOf(reportExportRequestGate)).toEqual(["accounting.report.export"]);
    expect(codesOf(exportRequestGate)).toEqual(["admin.data.export"]);
  });
});
