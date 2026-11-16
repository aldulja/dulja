# 0070 — The export job runs as the system principal behind a request-time gate snapshot

- Status: **Proposed** — it decides who may take which data out of the system (spec:95: security and the
  data model are proposals asked before implementing). Implemented in 7C Tasks 8–9 ahead of approval, as
  ADRs 0054–0069 were.
- Date: 2026-11-05 (the plan's text is dated 2026-09-08)
- Slice: 7C · Task 9 (the handler half landed in Task 8)
- Amends: §3.6.3's R7 boot check through ADR 0067's decision 6 — ⚠️ a second export request admitted, and
  the marker narrowed to one code per route (decision 4). Builds on ADR 0069 (the archive and the registry).

## Context

`admin.export.run` is a pg-boss handler, and every handler runs as the tenant's **system principal**
(spec:2179, §4.2.6, hazard 20) — a principal that passes `app.actor_has` for every code and that RLS bounds
to the tenant and nothing narrower. So the job cannot ask "may this person see this?" about itself and get a
useful answer.

Two of the export's decisions are person-specific: which **tables** the requester may export (ADR 0069's
`EXPORT_TABLES` gates) and which **attachments** they may see (§4.5.8's `MODULE_READ_CODE`, whose one home
is `apps/api` — `packages/db` and `apps/worker` may not import an app, §3.1). A third follows from them:
once an archive exists, it carries what its requester could see, so **who may read it afterwards** is a
gate too.

## Decision

1. **The authorisation decision is made at the request and recorded on the row.** `POST …/exports`
   resolves, for the calling principal, which modules of `MODULE_READ_CODE` they hold at company scope
   (`app.actor_has(code, company, null)`) and whether they hold `inventory.item.read` (§4.5.8's
   lot-attachment rule), and stores both on `export_job` as `readable_modules` and `lot_attachments`
   (`apps/api/src/export/authorise.ts`, `exportGateSnapshot`). There is no `readableModules()` helper in the
   tree (7C A16 item 6), so the snapshot reads the map directly. The row and the `admin.export.run` job are
   written in one transaction, so a rolled-back request leaves neither (spec:2321).
2. **The table gates are resolved by the job, for `export_job.requested_by`** — never for the acting
   principal — through `app.principal_has` with a null branch, the predicate the override guard uses
   (`resolveExportGates`, ADR 0069). `requested_by` is stamped by `app.stamp_actor`; the request body is
   `strict` and has no field that names a principal, so a caller cannot name someone else and inherit their
   authority.
3. **The route's gate is company-scoped and has no branch source.** `admin.data.export` evaluated as
   `app.actor_has(code, company, null)` is false for a branch-narrowed assignment (spec:2158's branch-scoping
   paragraph), so an export is company-wide or refused — never a partial export a branch manager could
   mistake for the whole book. Test 36's export clause is exactly this assertion
   (`apps/api/test/routes/admin/exports-gates.test.ts`).
4. **The POST is an export request under R7's widening, with one code per route.** `admin.data.export` is
   `mutating: false` (an export changes no business record), so it gates `POST …/exports` only through
   `markExportRequestGate`, on a path `EXPORT_REQUEST_ROUTES` lists (ADR 0067's decision 6). 7A's marker
   stamped every code in `EXPORT_REQUEST_CODES` on every marked gate, so adding `admin.data.export` there
   would have let the report run's POST claim it too. Each `EXPORT_REQUEST_ROUTES` entry now names the one
   code it admits, `markExportRequestGate(handler, code)` stamps only that code, `EXPORT_REQUEST_CODES` is
   derived from the routes, and `assertRouteGates` refuses any other export code on a listed route
   (`apps/api/test/middleware/require-permission.test.ts`).
5. **An export is its requester's.** The list, the status resource and the download answer only the caller's
   own jobs (`requested_by = actor`); another principal's job answers `404 ERR_NOT_FOUND` exactly as a
   missing one does. A colleague who also holds `admin.data.export` but not, say, `hr.employee.read` must not
   download an archive that carries the HR tables — that would be test 32's side channel.
6. **The download serves only verified bytes.** `GET …/content` answers 404 for a job that is queued,
   running or failed (never an empty 200 a caller could save as "the export"), recomputes the stored bytes'
   SHA-256 against the row's, refuses with `ERR_INTERNAL` (detail to the log) on a mismatch, and sends the
   digest as `X-Content-Sha256` so the tenant can verify what ADR 0069 made reproducible. The object key
   never reaches the wire (LEGACY-038).

## Alternatives rejected

- **Re-deriving the requester's authority inside the job.** The job would resolve its *own* authority,
  which is everything; and `MODULE_READ_CODE` cannot be imported there.
- **Sharing an export with every holder of `admin.data.export`.** Simpler, and wrong whenever two holders
  differ in a table gate (decision 5). An owner who wants shared exports can have them by re-checking every
  gate the archive's manifest lists against the reader — a later amendment, not a default.
- **A ninth `AppEnv["Variables"]` member for the object store.** `createExportRoutes(objectStore)` is a
  factory, as 2C's and 7A's are (7C A12).

## Consequences

- A permission revoked between the request and the run does **not** shrink the archive: the decision was
  made when the person asked, it is audited under their id (test 13), and the window is one job. A slice that
  wants revocation to win must re-resolve in the handler and will need `MODULE_READ_CODE` in a package both
  tiers may import — an amendment to §4.5.8, not a patch. Revoking `admin.data.export` itself closes the
  list, the status and the download at once, because each route evaluates it on every request.
- The manifest names every table excluded by a gate and every attachment left out with its reason, so an
  incomplete export is visibly incomplete.
- Every export is audited: the request's `insert` under the requester, the claim and the completion (or the
  failure) under the system principal (`apps/worker/test/handlers/export-run.test.ts`,
  `tests/invariants/export-audit.test.ts`).
- The widening joins the review list `AGENTS.md` keeps (`markExportRequestGate` was 7A's; this is its second
  route and its narrowing to one code per route).

## Owner questions

1. Approve the request-time snapshot (decision 1) over re-resolving at run time.
2. Approve that an export is visible to its requester only (decision 5), or say who else may download one.
3. Approve `admin.data.export` on a POST through R7's export widening (decision 4).
