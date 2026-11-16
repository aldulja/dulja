import {
  applyBatch,
  calculatePayrollRun,
  createHrKeyRing,
  createJobClient,
  createLeaveType,
  DEV_HR_KEY,
  requestLeave,
  writeSensitive,
  JOBS,
  transitionDocument,
  type JobClient,
  type JobEnvelope,
} from "@dulja/db";
import { loadReportDefinitions } from "@dulja/db/seed";
import { serve, type ServerType } from "@hono/node-server";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  uuidv7,
  withTenant,
  seedEmployee,
  seedCashier,
  seedTerminal,
  seedAccount,
  seedStatutoryScheme,
  SYNTH_RATE_TABLE_V1,
  installBoss,
  stopBoss,
  type Seed,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../../apps/api/test/support/app";
import { preflightResponse, withCors } from "../../../apps/edge/src/cors";
import { CONTENT_SECURITY_POLICY } from "../../../apps/desktop/src/window-options";
import { registerHandler, resetHandlers, runJob } from "../../../apps/worker/src/handler";
import { exportRun } from "../../../apps/worker/src/jobs/export-run";
import { reportRender } from "../../../apps/worker/src/jobs/report-render";
import { setObjectStore } from "../../../apps/worker/src/object-store";
import { taxFixture, postTaxedDocument } from "../../invariants/support/tax";
import { payrollFixture, postPayrollRun, secondApprover } from "../../invariants/support/payroll";
import { startAuthStub, WEB_ORIGIN, type AuthStub } from "./auth-stub";
import { E2E_EMAIL, E2E_HR_EMPLOYEE, PEOPLE, type Person } from "./people";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const DIST = join(ROOT, "apps", "backoffice", "dist");
const API_PORT = 8787;
const AUTH_PORT = 8788;
const WEB_PORT = 4173;

/**
 * `backoffice.exe`'s own policy, so every back-office spec runs under the script and style rules the shipped
 * window enforces (no `eval`, no inline `<style>`). Only `connect-src` is widened, to the loopback API and auth
 * stub: the packaged app reaches its API over `https:`, and this harness serves both over plain HTTP. Before
 * 2026-10-23 the site sent no policy, and an inline print rule the shipped app refuses passed here.
 */
const SHIPPED_CONNECT = "connect-src 'self' https:";
if (!CONTENT_SECURITY_POLICY.includes(SHIPPED_CONNECT))
  throw new Error(`the desktop policy no longer reads "${SHIPPED_CONNECT}"; update the e2e policy`);
const E2E_POLICY = CONTENT_SECURITY_POLICY.replace(
  SHIPPED_CONNECT,
  `${SHIPPED_CONNECT} http://127.0.0.1:${API_PORT} http://127.0.0.1:${AUTH_PORT}`,
);

/**
 * Playwright runs `globalSetup` and `globalTeardown` in the same process, so the running stack can
 * simply be parked here between them. It is deliberately **not** reachable from a spec: workers are
 * separate processes, and a spec that could reach into the database directly would stop being the
 * black-box browser test acceptance 23 is meant to be.
 */
declare global {
  var duljaStack: LocalStack | undefined;
}

export interface LocalStack {
  api: StartedApi;
  seed: Seed;
  baseURL: string;
  stop(): Promise<void>;
}

type FetchHandler = (request: Request) => Response | Promise<Response>;

const listen = (fetchHandler: FetchHandler, port: number): Promise<ServerType> =>
  new Promise((done, fail) => {
    const server: ServerType = serve({ fetch: fetchHandler, port, hostname: "127.0.0.1" });
    server.on("error", fail);
    server.on("listening", () => done(server));
  });

const close = (server: ServerType): Promise<void> =>
  new Promise((done) => server.close(() => done()));

/**
 * Polls until `accept` says the thing answering on `url` is the thing we started — never merely
 * until *something* answers. 8787 is also wrangler's default dev port, and a health probe that
 * takes any 2xx (or, as this one's ancestor did, any 404) would sail past a stray server and leave
 * the failure to surface later as an unexplained 401 in the browser.
 */
const waitFor = async (
  url: string,
  accept: (response: Response) => Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await accept(await fetch(url))) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((tick) => setTimeout(tick, 250));
  }
};

/** Explicit administration, tax and 6C staff authorities for the local browser operator. */
const ADMIN_CODES = [
  "admin.user.manage",
  "admin.role.manage",
  "admin.role.assign",
  "admin.company.manage",
  "admin.audit_log.read",
  "accounting.tax.manage",
  "hr.employee.read",
  "hr.employee.manage",
  "hr.attendance.record",
  "pos.cashier.manage_pin",
  "pos.report.read",
  "pos.shift.own",
  // 7A T15 and 7C T13: the report screens and the tenant export (the codes spec:2163 gives the auditor).
  "accounting.report.read",
  "accounting.report.export",
  "admin.data.export",
  // 8A T13: the HR screens. The operator holds every 8A code, the verify half included, so the statutory-table
  // screen can show both sides of verify-not-load: a table the SYSTEM loaded verifies, one the operator loaded
  // is refused with the rule named (R6 binds the seeded roles; this is a test role).
  "hr.employee.read_sensitive",
  "hr.compensation.read",
  "hr.compensation.manage",
  "hr.pay_component.manage",
  "hr.statutory_table.manage",
  "hr.statutory_table.verify",
  // 8B T15: the payroll screens. The operator prepares a run of its own (and is refused approving it, R1) and
  // approves and posts runs ANOTHER principal submitted (R6 binds the seeded roles; this is a test role).
  "hr.payroll.read",
  "hr.payroll.prepare",
  "hr.payroll.approve",
  "hr.payroll.post",
  // 8D T10: payslips on a posted run, and the leave register — the operator records and decides leave, and is
  // refused deciding its own (R4).
  "hr.filing.generate",
  "hr.leave.record",
  "hr.leave.approve",
];

/** The two jobs the report and export screens wait on, run in this process by the worker's own handlers. */
const SCREEN_JOBS = ["reporting.render", "admin.export.run"] as const;

/**
 * `seedTenant` (Plan 0A, §4.1) creates identity, a company, periods and accounts — and **no role and
 * no role_assignment**, so its human principal holds nothing and every `requirePermission` route
 * would answer 403. The grant is made as the **system** principal, because `app.forbid_self_grant`
 * (plan0A:1404) refuses a principal granting a role to itself, and it uses a non-`pos_terminal` role
 * code, because `app.assert_assignment_kind` (plan0A:1421) ties that one code to terminal principals.
 *
 * `role` carries `id uuid primary key default uuidv7()`, so its id is pre-generated here per §4.1's
 * "ids are pre-generated with `uuidv7(db.admin)` in tests". `role_permission` (plan0A:1322) and
 * `role_assignment` (plan0A:1331 — "a join table (no id/created_at — linter rule)") have **no `id`
 * column at all**; naming one in those two inserts is an error, not an omission.
 *
 * Exported because contracts §4.17.1 registers it: `bootLocalStack()` and `grantAdminRole(api, seed)`
 * in `tests/e2e/support/boot.ts` are 0E's row, and 1B, 2C, 7A, 8D and every later UI slice re-use them
 * when they re-run test 23 rather than hand-rolling these three inserts.
 */
export async function grantAdminRole(api: StartedApi, seed: Seed): Promise<void> {
  const roleId = await uuidv7(api.db.admin);
  await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
    await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
             values (${roleId}, ${seed.tenant}, 'e2e_admin', 'E2E administrator', false)`;
    await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
             select ${seed.tenant}, ${roleId}, code from app.permission where code = any(${ADMIN_CODES})`;
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
             values (${seed.tenant}, ${seed.human}, ${roleId}, ${seed.company})`;
  });
}

/**
 * Extra members, so the grid has rows whose *content* is worth measuring. Written straight to the
 * database rather than through `POST /v1/admin/users`, because that route invites through the
 * `AuthAdmin` port and the display name it would store is the one the caller sends — the same row,
 * one network hop and one stub further away.
 */
export async function seedPeople(
  api: StartedApi,
  seed: Seed,
  people: readonly Person[] = PEOPLE,
): Promise<void> {
  const rows: { id: string; person: Person }[] = [];
  for (const person of people) rows.push({ id: await uuidv7(api.db.admin), person });
  await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
    for (const { id, person } of rows) {
      await tx`insert into app.principal (id, kind, auth_subject, email, display_name)
               values (${id}, 'human', ${`human:${id}`}, ${person.email}, ${person.displayName})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${seed.tenant}, ${id})`;
    }
  });
}

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * `apps/backoffice/dist`, served with the single-page fallback the router needs — `/admin/users`
 * typed into the address bar is not a file.
 *
 * This is `vite preview`'s job, done in this process rather than in a child. On Windows a child
 * spawned through a shell is a `cmd.exe` whose own child holds the port, so `kill()` returns
 * happily and leaves the real server running; the *next* run then dies on `--strictPort` with a
 * message about the port rather than about the orphan. Serving the same built bundle from here
 * removes the process, and with it the whole failure mode.
 */
function staticSite(): Hono {
  const web = new Hono();
  web.get("*", async (context) => {
    const requested = decodeURIComponent(new URL(context.req.url).pathname);
    const target = normalize(join(DIST, requested));
    const inside = target === DIST || target.startsWith(DIST + sep);
    /*
     * A path that names a file answers as that file or as 404 — never as the document. The
     * single-page fallback is for routes (`/admin/users`), which have no extension; letting a
     * missing hashed chunk fall through to `index.html` served as `text/html` would hand the
     * browser a document where it asked for a module, blank the page, and turn one clear 404 into
     * ten opaque "locator not found" timeouts. It could not cause a false pass — but the cost of
     * that trade is paid entirely in diagnosis, and this harness exists to be diagnosable.
     */
    if (inside && extname(target) !== "") {
      try {
        const body = await readFile(target);
        return context.body(body, 200, {
          "content-type": MIME[extname(target)] ?? "application/octet-stream",
          "content-security-policy": E2E_POLICY,
        });
      } catch {
        return context.text(`no such file in the built back office: ${requested}`, 404);
      }
    }
    return context.body(await readFile(join(DIST, "index.html")), 200, {
      "content-type": MIME[".html"]!,
      "content-security-policy": E2E_POLICY,
    });
  });
  return web;
}

/**
 * The whole stack, locally: Testcontainers Postgres + 0B's API on its test JWKS issuer + the auth
 * stub + the built back office. Everything a browser needs, and no owner account (OD-19/OD-20).
 */
export async function bootLocalStack(): Promise<LocalStack> {
  /*
   * A real pg-boss behind the API's job client, so a report run (7A T15) and a tenant export (7C T13) queued from
   * the browser are rendered by the worker's own handlers, against the API's in-process object store, and the
   * screens poll a status that really moves. Every other job is queued and left alone, as the stub client did.
   */
  const deferred: { real?: JobClient } = {};
  const api = await startApi({
    jobs: {
      enqueue: (tx, name, job, options) => {
        if (!deferred.real) throw new Error("pg-boss is not installed yet");
        return deferred.real.enqueue(tx, name, job, options);
      },
    },
  });
  const boss = await installBoss(api.db, Object.keys(JOBS));
  deferred.real = createJobClient(boss);
  setObjectStore(api.objectStore);
  resetHandlers();
  registerHandler("reporting.render", reportRender);
  registerHandler("admin.export.run", exportRun);
  for (const name of SCREEN_JOBS)
    await boss.work(name, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      await runJob(api.db.rw, name, job!.data as JobEnvelope<never>);
    });
  const fixture = await taxFixture(api.db, "e2e");
  const seed = fixture.s;
  for (const effectiveDate of ["2026-01-15", "2026-04-15"]) {
    await postTaxedDocument(api.db, fixture, {
      typeCode: "SALES_INVOICE",
      effectiveDate,
      lines: [{ lineNo: 1, amount: "1000.0000", taxCode: "SYN-OUT-STD" }],
    });
  }
  await grantAdminRole(api, seed);
  await seedPeople(api, seed);
  // The shipped report catalogue (7B, 7C), as `bun run seed --only reports` applies it.
  await loadReportDefinitions(
    api.db.rw,
    { tenantId: seed.tenant, actorId: seed.system, requestId: "e2e-reports" },
    join(ROOT, "packages", "db", "seed", "my"),
    seed.company,
  );
  await seedAccount(api.db, seed, {
    code: "1110",
    nameEn: "Till cash",
    type: "asset",
    currency: "MYR",
  });
  const employee = await seedEmployee(api.db, seed, {
    employeeNumber: "E2E-TILL",
    homeBranchId: seed.hq,
    principalId: seed.human,
  });
  await seedCashier(api.db, seed, {
    employeeId: employee,
    branchId: seed.hq,
    principalId: seed.human,
  });
  // 8A T13: an employee who is NOT the operator (the operator is E2E-TILL, and R4 refuses a self-write), the
  // synthetic scheme, and two unverified tables the SYSTEM principal loaded — one for each locale's run to verify.
  await seedEmployee(api.db, seed, {
    employeeNumber: E2E_HR_EMPLOYEE,
    homeBranchId: seed.hq,
  });
  const schemeId = await seedStatutoryScheme(api.db, seed, { code: "SYNTH" });
  for (const version of [1, 2])
    await withTenant(
      api.db.rw,
      seed.tenant,
      seed.system,
      (tx) => tx`
      insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, definition, source)
      values (${seed.tenant}, ${schemeId}, ${version}, '2026-01-01',
              ${tx.json({ ...SYNTH_RATE_TABLE_V1, version } as never)}, 'Dulja test fixture / synthetic')`,
    );
  // 8B T15: the payroll corpus (8B's `payrollFixture`: the payroll chart, PAYROLL, EPF on the synthetic table,
  // E-0001 and E-0002 on BASIC 2000.0000) and one SUBMITTED supplementary run per locale — January for en, February
  // for ar — prepared by a principal who is NOT the operator, so the browser can approve and post it. A change of
  // E-0002's compensation effective inside February is what the February run's approver is shown (spec:2174).
  const payroll = await payrollFixture(api.db, seed);
  const preparer = await secondApprover(api.db, seed, [
    "hr.payroll.prepare",
    "hr.payroll.read",
    "hr.compensation.read",
    "hr.compensation.manage",
  ]);
  await withTenant(
    api.db.rw,
    seed.tenant,
    preparer,
    (tx) => tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, effective_to, amount)
      values (${seed.tenant}, ${payroll.employeeBId}, ${payroll.componentAdvanceId}, '2026-02-10', '2026-02-10',
              '1.0000')`,
  );
  for (const [periodStart, periodEnd, payDate] of [
    ["2026-01-01", "2026-01-31", "2026-02-05"],
    ["2026-02-01", "2026-02-28", "2026-03-05"],
  ] as const) {
    const ctx = { tenantId: seed.tenant, actorId: preparer, requestId: "e2e-payroll" };
    await withTenant(api.db.rw, seed.tenant, preparer, async (tx) => {
      const run = await calculatePayrollRun(tx, ctx, {
        companyId: seed.company,
        kind: "supplementary",
        periodStart,
        periodEnd,
        payDate,
        effectiveDate: periodEnd,
        branchId: seed.hq,
        employeeIds: [payroll.employeeAId, payroll.employeeBId],
      });
      await transitionDocument(tx, ctx, { documentId: run.documentId, to: "submitted" });
    });
  }
  // 8D T10: a POSTED supplementary run (June) whose payslips the browser generates and downloads; a work permit
  // that expires a month from today on E-0002 (sealed under the API's dev ring, as the sensitive route would); and
  // the leave register's starting point — one leave type and one REQUESTED leave per locale (E-0001 for en, E-0002
  // for ar), recorded by the system principal so the operator, who is neither employee, may decide it.
  await postPayrollRun(api.db, seed, payroll, {
    kind: "supplementary",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    payDate: "2026-07-05",
    effectiveDate: "2026-06-30",
    employeeIds: [payroll.employeeAId, payroll.employeeBId],
  });
  const permitDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await withTenant(api.db.rw, seed.tenant, seed.system, (tx) =>
    writeSensitive(
      tx,
      createHrKeyRing({ current: DEV_HR_KEY, currentVersion: 1 }),
      payroll.employeeBId,
      { work_permit_expiry: permitDate },
    ),
  );
  await withTenant(api.db.rw, seed.tenant, seed.system, async (tx) => {
    const annual = await createLeaveType(tx, {
      companyId: seed.company,
      code: "annual",
      nameEn: "Annual leave",
      nameAr: "إجازة سنوية",
      paid: true,
    });
    for (const [employeeId, startsOn, endsOn] of [
      [payroll.employeeAId, "2026-03-02", "2026-03-03"],
      [payroll.employeeBId, "2026-03-09", "2026-03-10"],
    ] as const)
      await requestLeave(tx, {
        companyId: seed.company,
        employeeId,
        leaveTypeId: annual,
        startsOn,
        endsOn,
        days: "2.00",
        reason: "family",
      });
  });
  const terminal = await seedTerminal(api.db, seed, { code: "BROWSER-TILL" });
  const shiftId = crypto.randomUUID();
  await withTenant(api.db.rw, seed.tenant, terminal.principalId, async (tx) => {
    const ctx = {
      tenantId: seed.tenant,
      actorId: terminal.principalId,
      requestId: "browser-shift",
    };
    const scope = { ...terminal, companyId: seed.company, branchId: seed.hq };
    const at = new Date().toISOString();
    const result = await applyBatch(tx as never, ctx, scope, {
      terminalId: terminal.terminalId,
      batchId: crypto.randomUUID(),
      tickets: [],
      tillEvents: [
        {
          clientRef: crypto.randomUUID(),
          shiftId,
          kind: "no_sale",
          ticketClientRef: null,
          cashierPrincipalId: seed.human,
          supervisorPrincipalId: null,
          occurredAt: at,
        },
      ],
      shifts: [
        {
          shiftId,
          kind: "open",
          terminalId: terminal.terminalId,
          cashierPrincipalId: seed.human,
          at,
          currency: "MYR",
          openingFloat: { amount: "100.0000", currency: "MYR" },
          countedCash: null,
        },
        {
          shiftId,
          kind: "close",
          terminalId: terminal.terminalId,
          cashierPrincipalId: seed.human,
          at,
          currency: "MYR",
          openingFloat: null,
          countedCash: { amount: "100.0000", currency: "MYR" },
        },
      ],
    });
    if (
      [...result.shiftResults, ...result.tillEventResults].some((row) => row.status !== "accepted")
    )
      throw new Error(
        JSON.stringify({
          shiftResults: result.shiftResults,
          tillEventResults: result.tillEventResults,
        }),
      );
  });

  /*
   * `tokenFor` signs the JWT's `sub` from the principal-id → `auth_subject` map this call fills, and
   * the API resolves the caller through `resolvePrincipal(db, sub)` against `app.principal
   * .auth_subject`. Skip it and every token carries a principal *id* as its subject, which matches
   * no row: every `/v1` call comes back ERR_AUTH_NO_MEMBERSHIP and the screen shows an empty grid
   * beside a refusal. It has to run after the seeding above, not before.
   */
  await api.loadPrincipals();

  /**
   * The API is reached cross-origin here — the page is on `:4173`, the API on `:8787` — and every
   * `/v1` call carries `authorization`, plus `idempotency-key` on unsafe methods, so every one of
   * them is preflighted. It is in production too: `backoffice.exe` serves the renderer from
   * `dulja://app` and calls the API's https host (API-01). §4.2.3's middleware chain has no CORS by
   * design; the EDGE answers the preflight and grants the allowed origin (apps/edge/src/cors.ts,
   * ADR 0092). The harness has no edge, so it runs the edge's own two functions in front of
   * `createApp`'s `fetch` — with its one origin, the loopback page, in place of `dulja://app` — and
   * so exercises the deployed allow-list, methods, allowed headers and exposed `x-request-id`
   * rather than a CORS layer of its own. A header the back office starts sending that the edge does
   * not allow fails these specs, as it would fail the packaged app.
   */
  const allowed = [WEB_ORIGIN];
  const front = {
    fetch: async (request: Request): Promise<Response> =>
      preflightResponse(request, allowed) ??
      withCors(await api.app.fetch(request), request, allowed),
  };

  const httpApi = await listen(front.fetch, API_PORT);
  await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, async (response) => {
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  });

  const auth: AuthStub = await startAuthStub(seed.human, E2E_EMAIL, api.tokenFor, AUTH_PORT);

  const buildEnv = {
    VITE_API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
    VITE_SUPABASE_URL: auth.url,
    VITE_SUPABASE_ANON_KEY: "stub-anon-key",
    VITE_APP_ENV: "dev",
  };

  await new Promise<void>((done, fail) => {
    const build = spawn("bun", ["run", "--cwd", "apps/backoffice", "build"], {
      cwd: ROOT,
      env: { ...process.env, ...buildEnv },
      stdio: "inherit",
      // Windows only, and for reach rather than convenience: `bun` is a real `.exe` on some
      // machines and a `.cmd` shim on others, and only the shell finds the second. Every argument
      // here is a literal in this file, so Node's DEP0190 warning about unescaped arguments has
      // nothing to bite on. The build exits on its own, so unlike a long-lived `vite preview` this
      // child leaves nothing behind for `stop()` to hunt down.
      shell: process.platform === "win32",
    });
    build.on("error", fail);
    build.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`backoffice build exited ${String(code)}`)),
    );
  });

  const httpWeb = await listen(staticSite().fetch, WEB_PORT);
  await waitFor(`${WEB_ORIGIN}/admin/users`, async (response) => {
    if (!response.ok) return false;
    // The single-page fallback, not merely "something answered": a 200 that is not the document
    // would leave Playwright staring at a blank page with no explanation.
    return (await response.text()).includes('<div id="root">');
  });

  return {
    api,
    seed,
    baseURL: WEB_ORIGIN,
    async stop() {
      await close(httpWeb);
      await auth.stop();
      await close(httpApi);
      await stopBoss(boss);
      await api.stop();
    },
  };
}
