# OD-24 — the Phase 7C export screen and report-viewer entries (Plan 7C Task 13)

**Status:** built on the **owner-authorized default baseline** (2026-11-06), with **legacy keyboard parity
unproven**. No owner material was supplied: neither `docs/owner/od-24/7c/` nor the plan's `docs/ui/od-24/7c/`
exists, so there are no screenshots of the legacy export or "send to Excel" dialogs and no operator description. On
2026-11-06 the owner directed: *"make sure phase 7 is implemented entirely; if you have any question choose the best
suggestion and complete the phase."* As for 7A Task 15 (`docs/ui/od-24-phase-7a.md`) and on the Phase 6 precedent
(`docs/review/2026-10-07-phase-6-decisions.md`), that authorizes the plan's default screen baseline — here Task 13
Step 2's checklist — verified in English LTR and Arabic RTL, with legacy parity explicitly not claimed. Tasks 11 and
12 stay dropped on OD-09's and OD-27's defaults (`docs/decisions/od-09-7c-pdc-register.md`,
`docs/decisions/od-27-7c-template-mapping.md`).

## What was built

| Piece | File |
|---|---|
| The screen, at `/admin/exports` | `apps/backoffice/src/routes/admin/exports.tsx` |
| Its test | `apps/backoffice/test/routes/admin/exports.test.tsx` |
| The route entry and the **Data export** nav link | `apps/backoffice/src/router.tsx`, `src/components/app-shell.tsx` |
| The fetch layer over the four Task 9 routes | `apps/backoffice/src/lib/export-api.ts` |
| The `admin.export.*` keys (and `app.nav.exports`) | `packages/i18n/catalogues/{en,ar}.json` |
| Test 23 in a browser | `tests/e2e/exports.spec.ts` |

The plan names `apps/backoffice/src/routes/index.ts` for the route entry; the back office's route tree is
`src/router.tsx`, so the entry is there. There is no generated client (`AGENTS.md`); the screen calls the API
through `createAdminApi`.

## Task 13 Step 2's checklist, row by row

- **Exactly the three formats and the toggle.** The form holds one dropdown (`both`, `csv`, `json`, defaulting to
  `both`) and the **Include attachments** checkbox (on by default) — two controls, because `CreateExportBody` has
  two members and is strict.
- **A queued or running job polls the `statusUrl` the 202 returned** (`/v1/companies/{companyId}/exports/{id}`,
  never a job path), once a second, until it is `done` or `failed`. A row opened from the list is followed through
  the same resource.
- **A done job** shows its SHA-256 (in an LTR isolate), table, row and attachment counts, and a **Download the
  archive** button, which takes the cursor. *Deviation:* the checklist says "a download link to
  `…/exports/{exportJobId}/content`"; that route needs the bearer token, which a plain link cannot carry, so the
  button fetches the bytes through the API door and saves them as `dulja-export-<id>.tar.gz`. The e2e spec checks
  the saved file's SHA-256 against the one on screen.
- **A failed job** shows its `CODE: detail` and a **New request** button, which returns the cursor to the form; the
  failed row is never retried.
- **A 403** renders the problem's title, remedy and reference (`problemSegments`), never a stack trace.
- **`manifest.excluded`** is rendered as a named list, each table beside the permission code it needs, under a line
  saying the export is incomplete without them; an export with none says so.
- **Both directions** — the unit test renders every direction-sensitive case in `en` and `ar` and asserts no
  physical-property class; the e2e spec runs the whole flow in English LTR and Arabic RTL, checking mirrored control
  and column order.

## The key map (the defaults, not the shop's)

| Key | Action |
|---|---|
| Ctrl+Enter | Request an export with the form's choices, from anywhere on the screen |
| Enter on a list row | Open that export |
| Esc | Close the open export and return to the form (not from an open dropdown) |
| Enter on Download | Save the archive (the button has the cursor once the archive is ready) |

## The 7C report-viewer "entries"

The ten 7C definitions are seeded rows like every other: they appear in 7A's report list, run screen and designer
with no screen of their own (`tests/e2e/support/boot.ts` seeds the whole shipped catalogue, 7B and 7C). Their
parameter names and enum values are labelled in both catalogues (`report.param.name.*`, `report.param.option.*`).

## Gating

As on the report screens: the back office has no client-side permission projection and no gated nav link, so
**Data export** is always in the nav and every refusal is the API's (`admin.data.export`, each export answering only
its requester; ADRs 0069, 0070). The company is the one `useCompanyId` resolves, which needs
`admin.company.manage`: a seeded `auditor`, who holds `admin.data.export` but not that code, sees "the company could
not be determined" rather than the form — a recorded limit (no route lists such an operator's companies), not a
leak. A branch-narrowed principal's refusal (test 36) is shown with its remedy.

## Not proven

- **Legacy keyboard parity** and the legacy export workflow (who exports, how often, what they do with the file):
  no owner material exists; the keys above are this build's defaults.
- The packaged `backoffice.exe` save path for a blob download (Windows packaged run, CI's `desktop` job).
- WCAG 2.2 AA beyond what the tests assert.
