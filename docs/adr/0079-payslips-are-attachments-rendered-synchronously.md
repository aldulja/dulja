# 0079 — Payslips are attachments on the run, rendered synchronously in the API

- Status: **Proposed** — asked, not decided (spec:95: it touches the data model). Implemented in 8D Task 5 as the
  plan's default, ahead of approval, under the owner's direction to implement Phase 8 entirely (2026-11-07).
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8D · Task 5
- Contracts: round 19, 8D A4, A5, A10, A11; §4.5.8, §4.5.9, §4.11.2

## Context

spec:2083 wants "a payslip PDF per employee per run (stored as an attachment with its hash)". Three facts of the tree
shape how:

- `JOBS` is a closed registry and 8D owns exactly one member of it, `hr.encryption_key.rotate` (§4.2.6).
- 7A's report renderers and their engine adapter live in `apps/worker`, behind `reporting.render`; `apps/api` may not
  import an app (§3.1).
- 2C's `engineFor` (`apps/api/src/print/engines/`) already turns HTML into a PDF synchronously for one document, and
  7A's layout (`renderReport` → `reportToHtmlSource`) is pure and lives in `@dulja/domain`.

A payslip run is the single-document print at a different cardinality: one request, N employees of one posted run.

## Decision

1. **A payslip is rendered synchronously in `apps/api`**: `payslipRows` (`packages/db/src/hr/payslip.ts`, the
   `payroll_line` dataset `hr.payroll_register` reads, posted and reversed documents only) → `renderReport` →
   `reportToHtmlSource` → `engineFor(PAYSLIP_ENGINE)` → 2C's `stageAttachment` / `insertAttachment`. No pg-boss name
   is added and no second engine registry exists. `PAYSLIP_ENGINE` is a named constant (`"chromium"`,
   `apps/api/src/print/payslip.ts`) because a payslip has no `print_template` row to read an engine from and hazard
   30 forbids an environment read.
2. **The layout is the `hr.payslip` report definition** (`packages/db/seed/my/reports/8d/hr.payslip.json`), resolved as
   a report run resolves its code: the highest live version for the company. A tenant's clone of `hr.payslip` is the
   payslip it prints, with no release.
3. **One `app.attachment` row per employee on the PAYROLL document**, its `sha256` computed by the server from the
   stored bytes and its object key derived from the ids alone (LEGACY-038). Because the owner is the run, 2C's download
   gate reads the payslip under the run's module code (`hr` → `hr.payroll.read`).
4. **Every generation writes new rows and never touches an earlier one**, so the hash of what an employee was given
   is never overwritten (spec:2049 — HR records are archived, never deleted). The route is a normal idempotent write
   (A5): a replayed `Idempotency-Key` returns the stored body and writes nothing.
5. **Two gates.** The route's own code, `hr.filing.generate`, is evaluated before any row is read; then the
   definition's own read code (`hr.payroll.read` as shipped) is evaluated from data, as a report run does (ADR 0067).
6. **Determinism is asserted at the rendered-text layer** (`pdfText`, §4.5.9; acceptance test 33): `generatedAt` is a
   parameter the shipped header does not print, so two generations of the same posted run carry the same text.
   Their bytes differ by Chromium's creation date and are never compared.
7. **The payslip's total is the signed `net_contribution`** (A10), so the total row equals the employee's net; the
   net-pay leg's own all-null line is not printed — it is the figure the payslip states. `hr.payslip` declares
   `tieOut: none`: 7B's `ledger_sum` has no dimension filter, and "Σ payslip net = salaries-payable credit" is proved
   in SQL by `packages/db/test/hr/payslip.test.ts`, per employee and in total.
8. **The annual statement stays on `reporting.render`**: a year-end batch over every employee is a queued render.

## Consequences

- A fifty-employee run is one request that renders fifty small A5 PDFs: bounded and observable, but the request is
  long. Rendering and object writes happen outside the row transaction (2C's attachment route's shape); a failure
  part-way removes every object it staged.
- Regenerating accumulates attachment rows on the run. Which payslip an employee received is answered by the
  attachment's id and hash, not by "the latest".
- If a tenant ever needs a thousand-employee run in one request, the same code moves behind a `reporting.render`
  payload without changing the data model.

## Alternatives rejected

- **A new `hr.payslip.generate` job name** — reopens the closed `JOBS` registry for a request-scoped operation.
- **Rendering through `reporting.render`** — the officer who pressed the button needs the attachment ids in the answer,
  and a queued render cannot return them; it would also store a report-run artefact, not an attachment on the run.
- **Overwriting the previous payslip attachment** — loses the hash of what was actually handed to the employee.

## Owner questions

1. Should regenerating a run's payslips archive the previous generation's attachments (they stay readable and their
   hashes still verify), or keep every generation live as now?
2. Is `hr.filing.generate` (the `hr_payroll` role's) the right code to produce payslips, or should producing them be a
   plain `hr.payroll.read` action?
