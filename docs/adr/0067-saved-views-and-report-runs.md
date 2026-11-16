# 0067 — Saved views archive; a report run is an immutable artefact record

- Status: **Proposed** — a data-model decision (spec:95). Implemented in migration 0075 ahead of approval,
  as ADRs 0054–0064 were.
- Date: 2026-11-05 (the plan's text is dated 2026-09-05)
- Slice: 7A · Task 2 (decisions 6–7 Task 12, decision 8 Task 13)
- Amends: contracts §4.11.2 (`statusUrl`, already recorded in §4.18 round 3), §3.5.4 and §2.8's 7A card
  (`privileges.test.ts` re-asserts the pinned list rather than being untouched), §3.6.3's R7 boot check
  (decision 6, Task 12 — ⚠️ a widening awaiting the owner)

## Context

spec:1241 wants an end-user report designer with saved views: "an accountant filters a ledger and wants that
exact view back from a bookmark". spec:2049 says master data is archived, never deleted, and admits genuine
deletion only "for drafts and for the GDPR/PDPA erasure workflow". Contracts §3.5.4 pins `app_rw`'s DELETE
grants to five tables and names 2B as the only slice that extends the list. spec:2206 wants bulk endpoints
with "async job semantics and a status resource".

## Decision

1. **`saved_view` is archived with `archived_at`.** `DELETE /v1/companies/{companyId}/saved-views/{id}` sets
   `archived_at` and returns 204. No DELETE grant is added; `packages/db/test/privileges.test.ts` re-asserts
   the unchanged five-row list rather than growing it, and asserts that `report_definition`, `saved_view` and
   `report_run` hold exactly `SELECT`, `INSERT` and `UPDATE`.
2. **`saved_view.owner_principal_id` is not a `*_by` column.** It records whom the view belongs to, which is
   data; it defaults to `app.current_actor()` and carries no stamp trigger, so an administrator editing a
   shared view does not silently become its owner (§3.3).
3. **`report_run` is the status resource.** A run row is created `queued` inside the same transaction that
   enqueues `reporting.render`, so a rolled-back request leaves neither (spec:2321). The job moves it to
   `running`, then to `done` with `object_key` and `sha256`, or to `failed` with `error`. Two CHECK
   constraints make "done with nothing to download" and "failed with no reason" unrepresentable.
   `requested_by` is stamped by `app.stamp_actor` and cannot be rewritten (`ERR_ACTOR_IMMUTABLE`).
4. **The status URL is the run itself.** §4.11.2's literal `statusUrl: "/v1/jobs/<jobId>"` is replaced by
   `"/v1/companies/<companyId>/report-runs/<runId>"`, because **no slice mounts `/v1/jobs/{jobId}`** — §4.2.7
   lists the path in the URL scheme and assigns it to no module, and 6A dropped its own status resource for
   the same reason. Pointing a caller at an unmounted path would be a 404 dressed as a contract. The run
   resource is mounted, gated, probed and carries strictly more information than a pg-boss job id; the 202
   body still carries `jobId` for log correlation.
5. **A run row is never deleted.** It is the audit trail of who exported what. Retention is a later
   operational decision, not a v1 grant.
6. **The export request is gated by the export code, through a marked gate (Task 12, 2026-11-05).**
   ⚠️ _A widening of R7's boot check, proposed for the owner's review as `markWriteFreeGate` was._ The plan
   put both of `POST …/reports/{code}/runs`'s checks inline with no route middleware, reasoning that
   `assertRouteGates` forbids `accounting.report.export` (`mutating: false`, spec:2147) on an unsafe method.
   That was written before the Phase 0 review added the check's **presence** half, which refuses an unsafe
   route carrying no gate mark at all on a module that declares permissions — so the inline-only form does
   not boot. Neither existing escape fits: no mutating code describes "request an export", and the route
   writes (a `report_run` row and its job), so it cannot join `REPLAY_BY_RERUN` or carry `markWriteFreeGate`
   — and a re-run on replay would queue a second render. The tree therefore gains
   `markExportRequestGate` (`apps/api/src/middleware/require-permission.ts`), admitted on the same
   two-declaration evidence as the print route's marker: the route must be an unsafe method, its path must
   be listed in `EXPORT_REQUEST_ROUTES` (one member, this POST), and the read-only check is waived **only**
   for the codes in `EXPORT_REQUEST_CODES` (one member, `accounting.report.export`) — any other
   `mutating: false` code on the same route is still refused at boot. spec:2163 gives the `auditor` export
   authority and R7 forbids it any mutating code, so without this the auditor could never export. The
   route's only writes are the run row (the audit trail of decision 5) and its job; it posts nothing and
   changes no master data. The definition's own read code is still evaluated from data in the handler, after
   the gate, and narrows it.
7. **The run resource is gated by the export code, and every read re-evaluates the definition's code.**
   `GET …/report-runs`, `…/{runId}` and `…/{runId}/content` carry `requirePermission("accounting.report.export",
   path:companyId)` — the download IS the export — and the two run reads also ask the definition's own
   `permission` through `app.actor_has`, so a code revoked after a run was queued closes its status and its
   bytes. A run of another company named under this company's path is 404. The content route refuses
   (`ERR_INTERNAL`, logged) bytes that no longer match the recorded `sha256`, as the attachment download does.
8. **Definitions and saved views are configuration and personal state, gated accordingly (Task 13,
   2026-11-05).** `…/report-definitions` writes (create, clone, PUT, archive) carry
   `requirePermission("admin.company.manage", path:companyId)` — §3.6.2's class for company configuration —
   and its two reads are `membershipOnly()`, the chart of accounts' and §4.2.11's precedent, because §3.6.1
   holds no report-definition read code; the data a definition reads is gated again on every run. A clone takes
   `max(version) + 1` under a transaction advisory lock on `(company, code)`, so it never collides with 7B's
   `version = 2` seed or with a concurrent clone; a **core** row refuses an in-place edit
   (`ERR_VALIDATION_FAILED`, "clone it"), because the seed pack re-applies core rows. `…/saved-views` declares
   `permissions: []` (the `/v1/session` precedent — no code to enforce, so `assertRouteGates`' presence half
   does not apply): the store binds the definition to the path company, and every write compares
   `owner_principal_id` with `app.current_actor()` and refuses anyone else `ERR_RBAC_FORBIDDEN`; a read of
   another principal's private view in the same company is 403, a row of another tenant 404.

## Consequences

- A tenant accumulates `report_run` rows. `report_run_recent_idx` (`company_id, created_at desc`) keeps the
  list read cheap; pruning, if it is ever wanted, is a job in a later slice and an amendment to §3.5.4, not a
  grant here.
- `object_key` is `unique`, so two runs can never claim one object, and a replay that re-inserted a run with
  the same key fails loudly rather than overwriting an artefact.
- None of the three tables carries a branch column, so none receives a `branch_isolation` policy (ADR 0062);
  a branch-restricted principal sees every definition, view and run of its company that RLS admits, and the
  run path's permission gates (Task 12) are what bound what it can render.
- `markExportRequestGate` is the seventh widening of a Phase 0 security control on the owner's review list
  (AGENTS.md "Current State" lists the first six). A later export route — 7C's `POST …/exports` — joins it only
  by adding its path to `EXPORT_REQUEST_ROUTES` and, if it is gated by a different read code, that code to
  `EXPORT_REQUEST_CODES`, both of which are review-visible one-line changes; it never inherits it silently.

## Amendment — Phase 7 review, 2026-11-06 (Proposed)

Two findings of the Phase 7 code review change decision 3 and the run list.

1. **A claim is a lease.** `reporting.render` claimed only a `queued` row, so a worker that died after its
   claim left the run `running` forever: pg-boss redelivered the expired job, and the redelivery found no
   queued row and completed. Migration 0075 is amended in place (it has never been applied outside a test
   database) with `started_at` — when the current claim was taken — and `attempts` — the claims taken. A
   claim now also takes a `running` row whose claim is older than `REPORT_RUN_LEASE_SECONDS` (600 s, ten
   times the PDF engine's 60 s timeout), and increments `attempts`, which `completeReportRun` and
   `failReportRun` take back as a fencing token, so a superseded worker that wakes writes nothing. The claim
   that would be number `REPORT_RUN_MAX_CLAIMS + 1` (3 + 1) fails the run in the same statement instead,
   `ERR_INTERNAL`. The job is enqueued with `REPORT_RUN_JOB_OPTIONS` — `expireInSeconds` equal to the lease,
   `retryLimit` the claims plus two, `retryDelaySeconds` 60 with backoff — so a dead delivery is redelivered
   only after the lease has lapsed, and there is always a delivery left to fail an abandoned run. A delivery
   that finds a LIVE claim (its predecessor threw after claiming because its failure write failed) throws, so
   pg-boss redelivers it later rather than completing the only job that could finish the run. 7C's
   `admin.export.run` follows the same rule over `EXPORT_JOB_LEASE_SECONDS` (3,600 s — an export has no engine
   timeout) with `attempts` added to migration 0078. Residual: a worker that dies inside the single claim
   statement of the final delivery leaves its row as it was; that statement is one UPDATE.
2. **The run list is narrowed by the definition's own read code.** `GET …/report-runs` was gated on
   `accounting.report.export` alone and skipped the per-definition `requireReportRead` the single-run and
   content routes apply. `listReportRuns` now keeps a run only when
   `app.actor_has(<definition's permission>, company, null)` holds for the acting principal, the same call
   with the same NULL branch, in the WHERE, so a page is never short of rows the caller may see. The tenant
   export's `tables/report_run.*` remains gated on `accounting.report.export` alone (ADR 0069 decision 2) and
   is an owner question there.

## Amendment — Phase 7 second review, 2026-11-06 (Proposed)

A second review of the amendment above found four defects in the lease and the list; each is fixed with a
regression test that fails on the tree before it.

1. **A live claim schedules its follow-up; it never spends a retry.** A delivery that found a live claim
   threw so pg-boss would redeliver it — and each throw spent one retry, with backoff. Five retries
   (60 + 120 + 240 + 480 + 960 s) end before an export's 3,600 s lease lapses, and can before a run's 600 s, so
   the row stayed `running` with no job left to reclaim or fail it, breaking "a run that never finishes ends
   `failed`". Such a delivery now reads the claim's remaining lease on the database clock (`leaseState`) and
   enqueues ONE follow-up delivery of the same payload — `startAfter` = the remaining lease + 30 s,
   `singletonKey` `<id>:lease:<attempts>` (one per claim; a refused duplicate, `JobNotInsertedError`, means it
   is already scheduled), the job's full retry budget — and returns (`deferPastLease`,
   `apps/worker/src/jobs/lease.ts`). Every claim therefore has a delivery due after it lapses, and the claim
   after `*_MAX_CLAIMS` fails the row without depending on the retry budget. The retry budget now only absorbs
   a delivery whose own failure write failed, or a worker that died (pg-boss's expiry).
2. **Each claim writes its own artefact.** Fencing guarded the row but not the store: under one object key
   per run, a superseded worker that woke up stored its bytes over its successor's, whose digest the row
   held. `reportObjectKeyFor(tenant, run, ext, attempt)` is now `<tenant>/reports/<run>/<attempt>.<ext>` (the
   export's `<tenant>/exports/<job>/<attempt>.tar.gz`); the row stores the key its completing claim wrote and
   the download reads that stored key. `completeReportRun`/`completeExportJob` return whether the fenced write
   landed, and a superseded worker deletes the object it stored.
3. **The run list resolves the caller's codes once.** `listReportRuns` called `app.actor_has` per candidate
   row. It now asks it once for each distinct permission of the tenant's definitions and compares against the
   bound array (`= any($held)`): the same answer, no function per row, the recent-runs index walked to the
   limit.
4. **One lease helper.** The claim's CASE ladder, the fence, the abandoned message and the job options were
   copied between `run-store.ts` and `export/store.ts`; `packages/db/src/jobs/lease.ts` owns them
   (`claimLeased`, `leaseFence`, `leaseJobOptions`, `leaseState`, `leaseFollowUpOptions` over a `Lease`), and
   `FAILURE_DETAIL_MAX` (2,000) with them — the worker's `failureDetail` imports it from `@dulja/db`.

The tenant export's `tables/report_run.*` is no longer gated on `accounting.report.export` (amendment 2's
open point): ADR 0069's second-review amendment gates it on `admin.audit_log.read`.
