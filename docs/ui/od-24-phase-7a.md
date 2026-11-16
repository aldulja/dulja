# OD-24 — the Phase 7A report-designer and report-viewer screens (Plan 7A Task 15)

**Status:** built on the **owner-authorized default baseline** (2026-11-06), with **legacy keyboard parity
unproven**. No owner material was supplied: `docs/owner/od-24/7a/` does not exist, and there are no legacy
screenshots, no operator description and no legacy key map. On 2026-11-06 the owner directed: *"make sure phase 7
is implemented entirely; if you have any question choose the best suggestion and complete the phase."* That follows
the Phase 6 precedent (`docs/review/2026-10-07-phase-6-decisions.md`): a renewed instruction to complete the phase
authorizes the plan's default screen baseline, verified in English LTR and Arabic RTL, with legacy parity
explicitly not claimed. This file is Task 15 Step 1's gate record; it says what was built, every default chosen in
place of the owner's material, and what stays unproven.

Earlier slices' records: 1B `od-24-phase-1-screens.md`, 2C `od-24-phase-2-screens.md`, 3A
`od-24-phase-3a-screens.md`, 3C `od-24-phase-3c-screens.md`, 3D `od-24-phase-3d-screens.md`, 4A
`od-24-phase-4a-screens.md`, 4B `od-24-phase-4b-screens.md` (those tasks stay blocked: this authorization names
Phase 7 only), 5A `od-24-phase-5a-screens.md` and 6B `od-24-phase-6b-screens.md` (released by their own
authorizations), 7B `od-24-phase-7b.md` (no screen by design), 7C `od-24-phase-7c.md` (released with this one).

## The four OD-24 items, and the default taken for each

| Item | Owner material | Default used |
|---|---|---|
| 1. Screenshots of the report list and designer | none | The plan's "What this task will be" list: a list, a run screen and a designer |
| 2. Screenshots of a rendered report in each output | none | The three renderers 7A Task 10 already ships (PDF, XLSX, CSV); the screens download them, nothing more |
| 3. A fast operator's keys | none | The key map below, the sibling screens' conventions (`/` filter, Esc back, Ctrl+S save) |
| 4. **Which parts of a report a user may change** | none | **Everything §4.11.1 carries that is presentation** — see below |

**Item 4, decided as the best default.** The designer edits the two titles; each column's English and Arabic
heading, order, visibility, width (8–400), format and alignment; the sort keys and their direction; the groups and
their subtotals; the totals and their function; and the page's orientation, paper, header and footer. It never edits
the dataset, its filters, the parameters, the permission, the module, the code or the tie-out: those decide *what*
a report reads and *who* may read it, and a definition never carries SQL (test 27). Every member the designer does
not own is sent back exactly as it was read (`apps/backoffice/src/features/reports/draft.ts`). A **core** definition
is read-only and editing starts with **Clone**; a tenant copy is edited in place (`PUT`) and can be **archived**
(two steps: Archive, then Confirm). A column hidden in a copy is left out of the saved definition; the designer
offers it again from the copy's source (`clonedFrom`), so hiding is reversible. The API's own validation stays the
authority: its `errors[]` (JSON Pointers) are shown beside the field they name — re-keyed when a hidden column
shifts the indices — and any pointer with no field of its own is listed in the summary with its path.

## What was built

| Screen | Route | File |
|---|---|---|
| Report list | `/reports` | `apps/backoffice/src/routes/reports/index.tsx` |
| Run screen | `/reports/$code?definition=<id>` | `apps/backoffice/src/routes/reports/$code.tsx` |
| Designer | `/reports/$code/design?definition=<id>` | `apps/backoffice/src/routes/reports/$code.design.tsx` |

Shared pieces are in `apps/backoffice/src/features/reports/` (`parameter-form.tsx`, `draft.ts`, `shared.tsx`), the
fetch layer is `apps/backoffice/src/lib/report-api.ts` over the handwritten `createAdminApi` door (which gained
`download()` for binary bodies), and every string is a `report.*` key in both catalogues. The nav gains a
**Reports** link.

- **The list** shows every live definition row — a core row and the company's copies side by side, each with its
  version — because a run and a design are of one row, not of a code.
- **The run screen** generates its form from the definition's `parameters`, by kind: a date is a date field; an
  enum a dropdown of its declared options (a required enum starts on its first option); `period`, `account`,
  `party`, `item`, `warehouse` and `branch` a dropdown read from the list route that serves that master (fiscal
  periods, accounts, parties, items, warehouses; branches from `/v1/staff-context`, the only branch list there is);
  anything else a text field. A list the operator may not read falls back to a typed id with a hint — a refusal
  never hides a parameter. A definition carries no parameter labels, so the catalogue names every parameter the
  shipped definitions use (`report.param.name.*`) and their enum values (`report.param.option.*`); an unknown name
  shows as the name and its kind. Saved views: choose one (its parameters fill the form, and the run records it
  while the form still holds exactly what it saved), save the current parameters as a new view (English name, an
  optional Arabic one, shared or not), archive the selected view. The three format buttons post
  `POST …/reports/{code}/runs` with the screen's language as `lang`; the returned `statusUrl` is polled every second
  until `done` (the download button takes the cursor, the SHA-256 is shown) or `failed` (its `CODE: detail`). The
  recent runs of the definition are listed with a download for each finished one.
- **There is no on-screen grid of report rows.** The API renders runs to PDF, XLSX or CSV only; no route returns a
  definition's rows as JSON, so the plan's "TanStack Table + Virtual for the on-screen grid" has nothing to show.
  The screens use `packages/ui`'s `DataGrid` for the list and the run history, as every earlier screen does.
- **Downloads** go through the API door with the bearer token (`GET …/report-runs/{runId}/content`), so a plain
  link cannot reach them; the bytes are saved from an object URL as `<code>-<runId>.<format>`.

## The key map (the defaults, not the shop's)

| Screen | Key | Action |
|---|---|---|
| List | `/` | Cursor to the filter (not while typing) |
| List | Arrows, Home, End | Move in the grid (direction-aware, `DataGrid`) |
| List | Enter | Run the row the cursor is on |
| List | Shift+Enter | Open the row in the designer |
| Run | — | The cursor starts in the first parameter |
| Run | Alt+1 / Alt+2 / Alt+3 | Run as PDF / XLSX / CSV (read from `event.code`, so the same on an Arabic layout) |
| Run | Enter in a field | Run in the format last used (PDF at first) |
| Run | Ctrl+S | Save the parameters as a view (the cursor goes to the name if it is empty) |
| Run | Enter on a finished history row | Download it |
| Run, Designer | Esc | Back to the list (not from an open dropdown) |
| Designer | — | The cursor starts on Clone (core) or the English title (copy) |
| Designer | Ctrl+S | Save the copy |
| Designer | Alt+Up / Alt+Down | Move the column the cursor is in; the cursor follows it |

## Gating

The back office has no client-side permission projection: no route returns the caller's codes, and no existing
nav link is gated. The screens follow that convention — the **Reports** link is always present, and every refusal
is the API's, rendered with its title, remedy and reference (`problemSegments`): reading definitions is membership
only, a run needs `accounting.report.export` plus the definition's own read code, and clone/edit/archive need
`admin.company.manage`. The company is the one `useCompanyId` resolves, as on the tax-return screen; that lookup
needs `admin.company.manage`, so an operator who holds only the report codes sees "the company could not be
determined" — a recorded limit (no route lists a pure report reader's companies), not a leak.

## Verification

- `apps/backoffice/test/reports.test.tsx` and `report-designer.test.tsx`: the list, the run screen (form by kind,
  the lookup fallback, the run body against `CreateReportRunBody`, polling to `done` and the download, a failed run,
  field errors from `errors[]`, saved views, Esc) and the designer (read-only core, Clone, edit-hide-show-move and
  Ctrl+S against `UpdateReportDefinitionBody`, error re-keying, two-step archive), each direction-sensitive case in
  both `en` and `ar`, with no physical-property class rendered.
- `tests/e2e/reports.spec.ts` re-runs **acceptance test 23** on these screens in English LTR and Arabic RTL through
  `bootLocalStack()`, which now runs the worker's own `reporting.render` and `admin.export.run` handlers on a real
  pg-boss and seeds the shipped report catalogue (`--only reports`): `/` and Enter on the list, the period chosen,
  Alt+3, the CSV downloaded and read (its headings in the run's language, account `1200` present), the column and
  button order mirrored in RTL, then Shift+Enter, Clone, a width the format refuses shown against its field,
  corrected, saved and archived.

## Not proven

- **Legacy keyboard parity** (spec:2254): there is no legacy key map to compare against. The keys above are this
  build's defaults and should be checked line by line against what the shop uses today when OD-24's material
  arrives.
- WCAG 2.2 AA beyond what the tests assert (labels, `aria-invalid`, `aria-keyshortcuts`, focus placement, `<bdi>`
  isolation) has not been audited.
- The packaged `backoffice.exe` download path (Electron's save dialog for a blob download) is not exercised; the e2e
  runs the built renderer under `backoffice.exe`'s own CSP in Chromium only (Windows packaged run, CI's `desktop` job).
- The PDF output in a deployed worker (no Chromium or Arabic-capable font in the image yet; AGENTS.md).
