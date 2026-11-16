import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";
import { isMutating, type PermissionCode } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";
import { isReplayByRerunPath } from "./idempotency";

export type ScopeSource =
  | {
      company: "path:companyId";
      branch?: "body:branchId" | "query:branchId" | "document";
    }
  | { company: "body:companyId"; branch?: "body:branchId" }
  | { company: "terminal" }
  | { company: "any" };

const GATE = Symbol.for("dulja.permissionGate");
const MEMBERSHIP = Symbol.for("dulja.membershipOnlyRead");
const WRITE_FREE = Symbol.for("dulja.writeFreeGate");
const EXPORT_REQUEST = Symbol.for("dulja.exportRequestGate");
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function bodyField(context: Context<AppEnv>, name: string): Promise<string | null> {
  try {
    const body = (await context.req.json()) as Record<string, unknown> | null;
    return typeof body?.[name] === "string" ? (body[name] as string) : null;
  } catch {
    return null;
  }
}

async function resolveScope(
  context: Context<AppEnv>,
  scope: ScopeSource,
): Promise<{ companyId: string | null; branchId: string | null }> {
  if (scope.company === "any") return { companyId: null, branchId: null };
  if (scope.company === "terminal") {
    const terminal = context.get("terminal");
    if (!terminal)
      throw new AppError("ERR_INTERNAL", "terminal scope needs terminal authentication");
    return { companyId: terminal.companyId, branchId: terminal.branchId };
  }
  const companyId =
    scope.company === "path:companyId"
      ? context.req.param("companyId")
      : await bodyField(context, "companyId");
  if (!companyId) throw new AppError("ERR_VALIDATION_FAILED", "the request names no company");
  let branchId: string | null = null;
  if (scope.branch === "body:branchId") branchId = await bodyField(context, "branchId");
  else if (scope.branch === "query:branchId")
    branchId = new URL(context.req.url).searchParams.get("branchId");
  else if (scope.branch === "document") {
    const documentId = context.req.param("documentId");
    const [row] = await context.var.withTenant(
      (tx) => tx<{ branch_id: string }[]>`
        select branch_id from app.document where id = ${documentId ?? null}`,
    );
    branchId = row?.branch_id ?? null;
  }
  return { companyId, branchId };
}

/**
 * Code review 2, S3 — the COMPANY-FIRST question every gate that resolves a row from the request asks before
 * it reads that row. `requireDocumentPermission`, `requireDocumentModuleRead`, `requireAttachmentRead`, the
 * attachment upload gate and the override gate all look up a document, a type or an attachment to learn
 * WHICH code to ask; asked in that order, a real id answered 403 naming the code, the type or the branch and
 * a random id answered 404, so a principal with no role in the path company learnt what exists in it. RLS
 * bounds the tenant only (AGENTS.md); the company is the authority boundary.
 *
 * So: does the acting principal hold a live (`expires_at` null or future) role assignment in the path
 * company, or is it the tenant's system principal (which `app.actor_has` admits)? If not, one refusal whose
 * words name no id, type or branch. Nothing changes for a member of the company: a member lacking the code
 * still gets 403 naming it, and an id that is not in the company still 404s. A branch-restricted member can
 * still tell other branches' documents apart; Phase 6's `branch_isolation` RLS is what hides those rows.
 *
 * Runs on the caller's `tx`, inside the caller's `withTenant`, before any read of the resource.
 */
export async function assertRoleInCompany(
  tx: Sql,
  actorId: string,
  companyId: string,
): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`
    select exists (
             select 1 from app.principal p join app.membership m on m.principal_id = p.id
              where p.id = app.current_actor() and p.kind = 'system'
                and m.tenant_id = app.current_tenant())
        or exists (
             select 1 from app.role_assignment ra
              where ra.principal_id = app.current_actor() and ra.company_id = ${companyId}
                and (ra.expires_at is null or ra.expires_at > now())) as ok`;
  if (row?.ok !== true) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `principal ${actorId} holds no role in company ${companyId}`,
    );
  }
}

/**
 * Marks a middleware as a permission gate for `assertRouteGates`, naming the codes it may evaluate. For a gate
 * whose code is resolved from DATA rather than from a literal — 2A's `requireDocumentPermission`, which reads
 * the effective posting policy — the mark carries the union of codes the policy may name, so the boot check
 * judges each one exactly as it judges a `requirePermission` gate and the route never reads as ungated.
 */
export function markPermissionGate<H extends MiddlewareHandler<AppEnv>>(
  handler: H,
  // `readonly string[]`, not `readonly PermissionCode[]` (2B): a gate resolved from DATA may evaluate a code a
  // later slice seeds — the three `OverrideCode` members at 2B (3A, 4A, 6A's rows). `isMutating` treats an
  // unknown code as mutating, so the unsafe-method half of `assertRouteGates` stays as strict as before, and
  // the `permission-catalogue` lint is untouched because a bare string is not a `PERMISSION[…]` reference.
  codes: readonly string[],
): H {
  return Object.assign(handler, { [GATE]: [...codes] });
}

/**
 * A gate over READ codes on an UNSAFE method, said out loud (2C).
 *
 * `POST …/documents/{documentId}/print` is frozen as a POST (contracts §4.5.9: it carries a body) and is
 * gated by the type's module READ code (§4.5.4's rule for a document read). `assertRouteGates` would
 * refuse that pairing, and it is right to: an unsafe method gated by a `mutating: false` code is the
 * defect it exists to catch. What makes printing different is not its method but that its handler
 * writes nothing — the same fact the idempotency layer relies on to re-run it (`REPLAY_BY_RERUN`).
 * So this marker is admitted on exactly that evidence and nothing weaker: the route must be an unsafe
 * method, must carry at least one code, and must be listed in `REPLAY_BY_RERUN`. A route that writes
 * cannot join `REPLAY_BY_RERUN` (§4.2.9), so it cannot carry this marker either; two declarations of
 * "write-free" are checked against each other at boot rather than trusted separately.
 */
export function markWriteFreeGate<H extends MiddlewareHandler<AppEnv>>(
  handler: H,
  codes: readonly string[],
): H {
  return Object.assign(handler, { [GATE]: [...codes], [WRITE_FREE]: true });
}

/**
 * The READ codes that may gate an unsafe method because what the method requests IS that code's authority
 * (7A Task 12, ADR 0067 decision 6; 7C Task 9, ADR 0070 — ⚠️ a widening of R7's boot check, awaiting the
 * owner's review).
 *
 * spec:2163 gives the `auditor` "Read everything financial … and export", spec:2147 makes
 * `accounting.report.export` `mutating: false`, and R7 (spec:2178) forbids the auditor any mutating code. A
 * report is rendered by `POST …/reports/{code}/runs` — a POST because it queues work and records the request
 * (contracts §4.11.2) — so the export code must gate an unsafe method or the auditor can never export. The
 * route's writes are the `report_run` status row (the audit trail of who exported what) and its job; it
 * writes no business row, posts nothing and changes no master data. `POST …/exports` (spec:2186, 7C A12) is
 * the same shape for the tenant data export: it writes the `export_job` status row and its job, under
 * `admin.data.export` (also `mutating: false`).
 *
 * **Each listed route admits exactly ONE code** — the export code of what that route requests — so the report
 * run's POST cannot be gated by `admin.data.export`, nor the data export's by `accounting.report.export`.
 */
export const EXPORT_REQUEST_ROUTES: readonly { method: string; path: RegExp; code: string }[] = [
  {
    method: "POST",
    path: /^\/v1\/companies\/[^/]+\/reports\/[^/]+\/runs$/,
    code: "accounting.report.export",
  },
  { method: "POST", path: /^\/v1\/companies\/[^/]+\/exports\/?$/, code: "admin.data.export" },
];

/** Every code some listed export request admits — derived, so a route and its code are declared once. */
export const EXPORT_REQUEST_CODES: readonly string[] = [
  ...new Set(EXPORT_REQUEST_ROUTES.map((route) => route.code)),
];

/** The one code `EXPORT_REQUEST_ROUTES` admits on this concrete method and path, or null if none is listed. */
function exportRequestCode(method: string, path: string): string | null {
  return EXPORT_REQUEST_ROUTES.find((r) => r.method === method && r.path.test(path))?.code ?? null;
}

/**
 * Marks a gate that evaluates `code` — the export code — on an export REQUEST. `assertRouteGates` admits it
 * only on an unsafe method whose path `EXPORT_REQUEST_ROUTES` lists FOR THAT CODE, and it exempts from the
 * read-only check only that code: any other `mutating: false` code on the same route — another export code
 * included — is still refused, so the marker cannot carry a general read code onto a write.
 */
export function markExportRequestGate<H extends MiddlewareHandler<AppEnv>>(
  handler: H,
  code: string,
): H {
  return Object.assign(handler, { [GATE]: [code], [EXPORT_REQUEST]: true });
}

export function requirePermission(
  code: PermissionCode,
  scope: ScopeSource,
): MiddlewareHandler<AppEnv> {
  const handler: MiddlewareHandler<AppEnv> = async (context, next) => {
    const { companyId, branchId } = await resolveScope(context, scope);
    const allowed = await context.var.withTenant(async (tx) => {
      if (companyId === null) {
        const [row] = await tx<{ ok: boolean }[]>`
          select exists (select 1 from app.company c where app.actor_has(${code}, c.id)) as ok`;
        return row?.ok ?? false;
      }
      const [row] = await tx<{ ok: boolean }[]>`
        select app.actor_has(${code}, ${companyId}, ${branchId}) as ok`;
      return row?.ok ?? false;
    });
    if (!allowed)
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `principal ${context.var.ctx.actorId} does not hold ${code}${companyId ? ` in company ${companyId}` : " in any company of this tenant"}`,
      );
    await next();
  };
  return Object.assign(handler, { [GATE]: code });
}

/**
 * A read that any ONE of several codes admits, scoped like `requirePermission`. Needed where a resource
 * is legitimately read by more than one role and the catalogue has no umbrella read code for it: a
 * document with its amounts is read by whoever drafts journals, whoever posts them and whoever reads the
 * ledger — and by nobody else in the tenant. Every code is recorded on the gate mark, so
 * `assertRouteGates` judges each one exactly as it would a single-code gate.
 */
export function requireAnyPermission(
  codes: readonly [PermissionCode, ...PermissionCode[]],
  scope: ScopeSource,
): MiddlewareHandler<AppEnv> {
  const list = [...codes];
  const handler: MiddlewareHandler<AppEnv> = async (context, next) => {
    const { companyId, branchId } = await resolveScope(context, scope);
    const allowed = await context.var.withTenant(async (tx) => {
      if (companyId === null) {
        const [row] = await tx<{ ok: boolean }[]>`
          select exists (select 1 from app.company c, unnest(${list}::text[]) as x(code)
                          where app.actor_has(x.code, c.id)) as ok`;
        return row?.ok ?? false;
      }
      const [row] = await tx<{ ok: boolean }[]>`
        select coalesce(bool_or(app.actor_has(x.code, ${companyId}, ${branchId})), false) as ok
          from unnest(${list}::text[]) as x(code)`;
      return row?.ok ?? false;
    });
    if (!allowed)
      throw new AppError(
        "ERR_RBAC_FORBIDDEN",
        `principal ${context.var.ctx.actorId} holds none of ${list.join(", ")}${companyId ? ` in company ${companyId}` : " in any company of this tenant"}`,
      );
    await next();
  };
  return Object.assign(handler, { [GATE]: list });
}

/**
 * A read whose only gate is membership, said out loud.
 *
 * Some reads have no permission code to be gated by, and inventing one is not open: §3.6.1 closes the
 * vocabulary. The chart of accounts is the case — the catalogue holds one accounts code and it is
 * mutating, while spec:2158 gives the clerk read access — and 0D set the same precedent for dimension
 * reads. Nor may such a read take `{ company: "path:companyId" }` on some other code: a 403 on an id the
 * caller may not see confirms the id exists, which is exactly the leak 0B removed from
 * `GET /v1/companies/{companyId}` when it regated that read to `{ company: "any" }`. On these paths the
 * control is row-level security: the handler runs inside the caller's tenant, a company of another tenant
 * matches no row, and the honest answer is an empty page with a 200.
 *
 * Simply omitting `middleware:` would express the same thing and be indistinguishable from forgetting it,
 * which is the defect `assertRouteGates`'s presence half exists to catch. This marker is the declaration:
 * the route says membership is the gate, the boot check accepts it for a SAFE method, and refuses it on an
 * unsafe one — so it can never become a way to un-gate a write.
 */
const membershipOnlyHandler = Object.assign(
  (async (_context, next) => {
    await next();
  }) as MiddlewareHandler<AppEnv>,
  { [MEMBERSHIP]: true },
);

export function membershipOnly(): MiddlewareHandler<AppEnv> {
  return membershipOnlyHandler;
}

/**
 * What `assertRouteGates` needs of a mounted module — structurally, so that `RouteModule` itself is
 * not named here: `routes/index.ts` imports every route file and every route file imports this one,
 * and an import back the other way is a cycle nobody should have to reason about at boot.
 */
export interface GatedModule {
  readonly path: string;
  readonly permissions: readonly PermissionCode[];
  readonly auth: "human" | "terminal" | "public";
}

/**
 * The module a mounted route belongs to. Hono records `basePath` as `mergePath(<mount path>, <the
 * router's own base>)`, so a module's directly registered routes carry its declared path verbatim
 * and a router nested one level deeper carries that path plus a suffix. Hence the segment-boundary
 * test rather than equality: on equality alone a single nested `app.route()` inside a module would
 * yield `undefined` here and quietly exempt everything under it from the presence check below —
 * exactly the silence this whole assertion exists to end. This is still matching against declared
 * paths, not guessing at path shape. The longest declaration wins because `/v1/companies` is a legal
 * prefix of `/v1/companies/:companyId/exchange-rates` and those are two separate mounts with two
 * separate declarations; the more specific one is the one that declared the route.
 */
function owningModule(modules: readonly GatedModule[], basePath: string): GatedModule | undefined {
  let owner: GatedModule | undefined;
  for (const candidate of modules)
    if (
      (basePath === candidate.path || basePath.startsWith(`${candidate.path}/`)) &&
      (owner === undefined || candidate.path.length > owner.path.length)
    )
      owner = candidate;
  return owner;
}

/**
 * Two boot-time defects, both fatal (spec:2178 R7).
 *
 * The one this started as: an unsafe method gated by a `mutating: false` code. The one it missed for
 * all of Phase 0: a route with NO gate at all, which passed silently while its module's `permissions`
 * array promised a code nothing enforced. Absence is the dangerous half — a forgotten `middleware:`
 * line leaves RLS as the only bound, and RLS is tenant-wide, not company-wide.
 *
 * Both checks read the group, not the row. `openapi()` hands hono `on(method, path, ...middleware,
 * ...validators, handler)`, so ONE route becomes several `app.routes` entries sharing a method and
 * path; only one of them carries the gate symbol. Exemption is by declaration and never by path
 * shape: a group is matched back to the module that declared it (see `owningModule`), and a module
 * opts out only by saying `auth: "public"` (`/healthz`) or by declaring no permissions
 * (`/v1/session`, which needs a membership and nothing more).
 *
 * The presence half is therefore exactly as strong as the list it is handed: a mount that no entry
 * in `modules` claims — a test's throwaway app, or a real router someone mounted without adding it
 * to `buildRoutes` — is not judged for presence at all, and only the read-only check reaches it.
 * `createApp` closes that by mounting and judging from one `modules` const, so nothing it serves can
 * be absent from what it judges.
 */
export function assertRouteGates(
  app: OpenAPIHono<AppEnv>,
  modules: readonly GatedModule[] = [],
): void {
  const groups = new Map<
    string,
    {
      basePath: string;
      method: string;
      path: string;
      codes: string[];
      membershipOnly: boolean;
      writeFree: boolean;
      exportRequest: boolean;
    }
  >();
  for (const route of app.routes) {
    // A `use()` layer, not a route of its own. So a gate mounted router-wide never counts towards
    // presence and the routes under it read as ungated — deliberately: presence has to be provable
    // for the one method and path, not inferred from a wildcard registered somewhere above it.
    if (route.method === "ALL") continue;
    const key = `${route.basePath}|${route.method} ${route.path}`;
    const group = groups.get(key) ?? {
      basePath: route.basePath,
      method: route.method,
      path: route.path,
      codes: [],
      membershipOnly: false,
      writeFree: false,
      exportRequest: false,
    };
    const marks = route.handler as unknown as Record<symbol, unknown>;
    const code = marks[GATE];
    // One code from requirePermission, several from requireAnyPermission; each is judged alike below.
    if (typeof code === "string") group.codes.push(code);
    else if (Array.isArray(code))
      for (const member of code) if (typeof member === "string") group.codes.push(member);
    if (marks[MEMBERSHIP] === true) group.membershipOnly = true;
    if (marks[WRITE_FREE] === true) group.writeFree = true;
    if (marks[EXPORT_REQUEST] === true) group.exportRequest = true;
    groups.set(key, group);
  }
  const invalid: string[] = [];
  for (const group of groups.values()) {
    if (group.writeFree) {
      // Admitted only where the idempotency layer ALSO declares the route write-free. The pattern's
      // parameters are replaced by a sample segment because REPLAY_BY_RERUN matches concrete paths.
      const sample = group.path.replace(/:[^/]+/g, "x");
      if (!UNSAFE.has(group.method))
        invalid.push(
          `${group.method} ${group.path} is marked markWriteFreeGate(), which is for unsafe methods that write nothing; a safe method takes requirePermission`,
        );
      else if (!isReplayByRerunPath(group.method, sample))
        invalid.push(
          `${group.method} ${group.path} is marked markWriteFreeGate() but REPLAY_BY_RERUN does not list it: a read code gates an unsafe method only on a route the idempotency layer may re-run`,
        );
    } else {
      // An export request (`markExportRequestGate`) is admitted on the same two-declaration evidence: an
      // unsafe method, on a path EXPORT_REQUEST_ROUTES lists, and only for the one export code it lists there.
      const admittedCode = group.exportRequest
        ? exportRequestCode(group.method, group.path.replace(/:[^/]+/g, "x"))
        : null;
      const exportAdmitted = admittedCode !== null && UNSAFE.has(group.method);
      if (group.exportRequest && !UNSAFE.has(group.method))
        invalid.push(
          `${group.method} ${group.path} is marked markExportRequestGate(), which is for the unsafe method that requests an export; a safe method takes requirePermission`,
        );
      else if (group.exportRequest && !exportAdmitted)
        invalid.push(
          `${group.method} ${group.path} is marked markExportRequestGate() but EXPORT_REQUEST_ROUTES does not list it`,
        );
      for (const code of group.codes)
        if (
          UNSAFE.has(group.method) &&
          !isMutating(code as PermissionCode) &&
          !(exportAdmitted && code === admittedCode)
        )
          invalid.push(
            exportAdmitted && EXPORT_REQUEST_CODES.includes(code)
              ? `${group.method} ${group.path} is gated by ${code}, but EXPORT_REQUEST_ROUTES admits only ${admittedCode} on it`
              : `${group.method} ${group.path} is gated by ${code}, which is mutating = false`,
          );
    }
    if (group.membershipOnly && UNSAFE.has(group.method))
      invalid.push(
        `${group.method} ${group.path} is marked membershipOnly(), which is for safe methods only`,
      );
    if (group.codes.length > 0 || group.membershipOnly) continue;
    const module = owningModule(modules, group.basePath);
    if (!module || module.auth === "public" || module.permissions.length === 0) continue;
    invalid.push(
      `${group.method} ${group.path} carries no permission gate, but its module declares ${module.permissions.join(", ")}`,
    );
  }
  if (invalid.length) throw new AppError("ERR_ROUTE_GATE_READONLY", invalid.join("; "));
}
