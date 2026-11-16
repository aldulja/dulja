# ADR 0032 — Print-template source format and the engine value set

**Status:** accepted
**Date:** 2026-09-05
**Deciders:** architect
**Slice:** 2C
**Spec:** §3.5 report designer — "text-defined, diffable, version-controlled" (spec:1240); §4.10 RTL/LTR
parity (spec:2253); §3.2.2 PDF row (spec:1132).
**Consumes:** ADR 0016 (PDF engine, 0E) — **never re-opened** (contracts hazard 30).
**Consumed by:** 7A (`renderReport` adapters), 8D (payslips).
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

`app.print_template` (contracts §4.5.9, migration 0026) has one `source` column and one `engine` column. A
bilingual template needs its label pairs to travel with its body, and a template must be diffable in git
and reviewable in a pull request. Nothing in the spec fixes either the source format or how a template
reaches the engine ADR 0016 chose.

ADR 0016's Decision is explicit about the engine: **the chosen engine is Chromium print-to-PDF, and the
closed value set of `app.print_template.engine` is `{chromium}`**. Typst is recorded there as a near-miss
that a later contracts amendment, migration and 7A adapter could admit; `react-pdf` fails shaping and bidi
and is not competitive. This ADR consumes that set as written and does not widen or narrow it.

## Decision

**1. `source` is front matter plus body.** The first line is the sentinel `---dulja-template-v1`, then one
JSON object (`{ "labels": { "en": {…}, "ar": {…} } }`), then a line of three dashes, then the body
byte-exact to the end. The parser splits on the first three-dash line only, so a body containing `---`
survives. Labels are **data, not i18next keys**: `packages/domain` may import nothing internal
(contracts §3.1), and a template is tenant data that ships without a release. Both catalogues are
required (spec:2061); a source missing `labels.ar` is refused at parse time.

**2. Templates are rendered by a deterministic mustache subset** — `{{ path }}`,
`{{#if path}}…{{else}}…{{/if}}`, `{{#each path}}…{{/each}}` — with **no raw-output form**. Every
substituted value is escaped for the engine, and the triple-brace form is a parse error. A template
therefore cannot emit unescaped model data, and a tenant-authored template is not an injection vector. A
path the model lacks is a render error, never an empty string, so a typo in a template is found by the
first print rather than by a silent blank.

**3. One body serves both directions.** `dir`, `rtl` and `lang` are model members and the body uses
logical CSS properties (`text-align: start`, `margin-block-end`); no template is duplicated per language
(spec:2253). Labels come from the front matter's `en`/`ar` pair, chosen by the request's `lang`. The
document type's name and every account and party label fall back to the English column when the Arabic
one was never entered — a decided fallback, asserted by test, rather than a blank cell.

**4. The `engine` value set is ADR 0016's Decision and nothing else: `{chromium}`.** Migration 0026's
CHECK holds exactly that set, the seed manifest type admits exactly that literal, and `PDF_ENGINES` in
`apps/api/src/print/engines/` holds exactly one adapter. The `PrintEngineCode` type is the same closed
set; the renderer in `packages/domain` stays engine-neutral (it takes an escape function) so that
admitting Typst later, along ADR 0016's Alternatives path, costs an adapter and a migration, not a
renderer.

**5. `engineFor` fails closed and `ERR_PRINT_ENGINE_UNSUPPORTED` (422) is what it says.** `engine` is a
text column read on every print. The CHECK guards writes, but the API does not trust that alone: a row
naming a code with no adapter — `typst` arriving by a widening migration before its adapter lands, or
`react-pdf`, which renders a React component and can never consume template text — is reported to the
operator as a 422 naming the code, never as a 500. This is the slice's only new registry code.

**6. Rendering a single document is synchronous** (contracts §4.5.9): `POST …/documents/{id}/print`
returns `200 application/pdf`. No job name is allocated, so `JOBS` stays closed and 2C needs no worker.
Batch and catalogue rendering is 7A's `reporting.render` job.

**7. The browser is a process singleton.** One headless Chromium per API process, launched on first
print, closed on shutdown; every render is a fresh page that `setContent`s the rendered string and
navigates nowhere, so a template cannot fetch an external resource and make two renders differ.
`CHROMIUM_EXECUTABLE_PATH`, optional like `SENTRY_DSN`, names a host-installed binary when one exists.

## Consequences

- A template is reviewed as a diff. Two identical rows arrive from the seed pack and from the API because
  both compose the same `source` through `composeTemplateSource`.
- Determinism is asserted on the **rendered template text**, not on PDF bytes: Chromium embeds
  `/CreationDate` and `/ModDate` (ADR 0016's own measurement). Tests 26 and 29 pin their fixtures at the
  text layer for the same reason.
- A new label is a new template version, never an edit — `print_template` is never updated in place
  (Global Constraint 8).
- `engine` is read from the row on every print, so switching engines is data, not code — once an adapter
  for the new code exists.
- The plan for this slice pre-dated ADR 0016's verdict and described three codes and two adapters. This
  ADR records what was built against the accepted verdict: one code, one adapter, and the Typst adapter
  not written.
