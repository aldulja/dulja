# ADR 0065 — The report-definition format is validated JSON with a closed dataset registry

- **Status:** Proposed — implemented ahead of approval, as ADRs 0054–0064 were. The shape itself is contracts
  §4.11.1's, frozen there; this record states how it is enforced.
- **Date:** 2026-11-05 (the plan's text is dated 2026-09-05)
- **Slice:** 7A · Task 4
- **Supersedes / superseded by:** —
- **Amends:** contracts §4.11.1 (the generated type's `string` members; recorded beside that section)

## Context

spec:1240 wants "an end-user report designer — text-defined, diffable, version-controlled". spec:1246 puts
"Delphi-serialised report files" on the explicit do-NOT-carry-over list. SAH-077 is the defect they produce:
because report definitions lived as `MEMO` blobs inside customer databases, no static analysis could ever
determine whether a stored procedure was live, so near-duplicates accumulated instead of being consolidated.
SAH-069 is the other half: every report query was rebuilt, re-parsed and re-planned per call, concatenated
into a fixed-size buffer, with ~54 sites interpolating `DATE` parameters as text.

## Decision

1. **A definition is JSON validated against `packages/domain/report-definition.schema.json`**
   (`$id urn:dulja:report-definition:1`, `additionalProperties: false` at every level, `"version": {"const": 1}`).
   A schema change is a new `const` and a new `$id`, exactly as §4.4.1 rules for the posting policy. The
   TypeScript type `ReportDefinition` (`packages/domain/src/reports/definition.ts`) is **generated** from the
   schema by `bun run --cwd packages/domain report:types` with the posting policy's generator options, and
   `test/reports/report-type.test.ts` fails on any drift.
2. **A definition never carries SQL.** `dataset.source` names a member of the closed `DatasetId` registry in
   `packages/db/src/reports/datasets.ts`, where every member is a named `withTenant` read query whose column
   references are literal SQL fragments authored in that file. A filter names a **declared parameter**, and the
   value reaches the query as a bound parameter. There is no escape hatch — `additionalProperties: false` is
   what makes that a fact rather than a convention, and test 27 is what proves it in CI.
3. **The two closed sets are validator parameters, not schema keywords.** `DatasetId` lives in `packages/db`
   and `PermissionCode` in `packages/contracts`; `packages/domain` imports nothing internal (§3.1). A schema
   also cannot know which slices have shipped, and hard-coding either set would fail every definition that a
   later slice's dataset serves. `validateReportDefinition(definition, { datasets, permissions })` therefore
   takes both as `ReadonlySet<string>` — 1A's `validatePolicy(definition, catalogue)` pattern.
   `parseReportDefinition` checks the schema and the grammar only, for a definition already stored.
4. **The module is derived, never asserted twice.** §4.16.1's grammar puts the module in the code's first
   segment; the validator refuses a `module` that disagrees. Two segments, so a report code can never be
   mistaken for a three-segment permission code.
5. **Every rejection names a JSON Pointer.** SAH-084's fix ("a human message naming the specific offending
   entity") applied to configuration: `ReportDefinitionValidation.errors[]` entries are `{ path, message }`
   with `path` a JSON Pointer into the rejected document, sorted by path, and §4.2.4 already lets
   `ERR_VALIDATION_FAILED` carry that array to the wire.
6. **The validator compiles on first use, never at import** — the rule every other Ajv validator in
   `@dulja/domain` follows since PR 12, because the desktop renderers run under a CSP without `'unsafe-eval'`
   and reach this barrel through `@dulja/contracts`. `test/lazy-schemas.test.ts` pins it for this validator too.
7. **One filter vocabulary.** `REPORT_FILTER_OPS` spells the same eight tokens as `@dulja/contracts`'
   `FILTER_OPS`; `packages/contracts/test/report-filter-ops.test.ts` pins the two equal, in order.

## Alternatives rejected

- **A TypeScript register of the forty §4.16.1 codes.** The card asks `validateReportDefinition` to enforce the
  code *grammar* and `DatasetId` *membership* — membership for the codes is §4.16.1's own table. A TS mirror
  would be a fourth spelling of a closed register (after §4.16.1, `ReportCodeSchema` and the seed directory
  layout), a merge hotspot 7B, 7C and 8D would each edit, and it would drag the ⚠️ conditionals into a
  compiled constant. `REPORT_CODE_PATTERN` plus the seed loader's file-name check is the whole enforcement the
  format needs.
- **A SQL string in the definition, sandboxed by a parser.** This is SAH-036/037/069 with extra steps, and
  spec:97 forbids it outright.

## Consequences

- `code`, `permission` and `dataset.source` are `string` in the generated type: a JSON Schema cannot express a
  TypeScript brand or a union whose members live in two other packages. The schema carries the pattern,
  `validateReportDefinition` the membership, and `isReportCode` is the type guard for the brand.
- `json-schema-to-typescript` renders `columns` (`minItems: 1`) as the non-empty tuple
  `[Column, ...Column[]]`; that is the generated name and shape every later task uses.
- The generated file is listed in `.prettierignore`, as `src/posting/policy.ts` is, because its no-diff guard
  regenerates it and compares byte for byte.

## Amendment — a sort key need not be a displayed column (Phase 7 remediation, 2026-11-06)

**Proposed**, like the record it amends. 7A's validator refused a `sort` field that was not one of the
definition's `columns`, so a report could order only by something it printed. Two shipped reports needed
otherwise: `accounting.ageing` printed its buckets in text order (`1_30`, `31_60`, `61_90`, `current`,
`over_90`) and the three statements printed their sections alphabetically (asset, equity, liability; expense
before revenue). Each now sorts on a rank it does not print — the `party_ageing` dataset's `bucket_rank` and
the statement rows' `section_rank` (`STATEMENT_SECTION_RANK`). `validateReportDefinition` therefore checks
`groups` and `totals` against `columns` and no longer checks `sort`: whether a sort key exists is a property of
the dataset, which `packages/domain` cannot see, and `assertDefinitionFields` already refuses an unknown key at
save and at seed (with the statement extras unioned for the three statement codes), as `columnOf` does at run
time. Nothing else in the format changes, and no stored definition becomes invalid.

## Amendment — a definition cannot widen data access (Phase 7 review, 2026-11-06)

**Proposed**, like the record it amends. A run executes as the tenant's system principal (ADR 0066), so a
definition's `permission` is the only gate on the rows it reads — and 7A let a clone or an edit set both
`permission` and `dataset.source` to anything in their closed sets. The review's scenario: an
`admin.company.manage` holder cloned `accounting.audit_log`, gated the clone on a weaker code and added the
`before`/`after` row images; the clone, the code's highest version, became everyone's default run. Three rules
close it, each enforced where the definition is written rather than at run time:

1. **Each dataset declares the read codes that may gate it** (`DATASET_READ_CODES`,
   `packages/db/src/reports/datasets.ts`): a closed, minimal set per member — the codes the 32 shipped
   definitions use for it (contracts §4.16.1), `accounting.ledger.read` beside `accounting.report.read` on the
   three ledger reads, and the module's read code for a dataset no shipped definition reads. `audit_log` and
   `document_event` admit only `admin.audit_log.read`; the cost-bearing `cost_layer`, `cost_consumption` and
   `stock_valuation` only `inventory.cost.read`; `tax_transaction` only `accounting.tax.manage`; the POS
   datasets `pos.report.read` (`needs_attention`: `pos.needs_attention.resolve`); the bank datasets
   `accounting.bank.reconcile`. Two members admit two codes because the shipped catalogue does: `document`
   (7B's count register under `inventory.stock.read`) and `item_profitability` (3D's `inventory.sales_by_item`).
   `assertDatasetGate` refuses any other code as `ERR_VALIDATION_FAILED` at `/permission`; it runs inside
   `assertDefinitionFields`, so the store and the seed loader hold a definition to the same rule.
2. **A code's versions share one source, and the writer holds every gate involved.** A create, clone or edit
   whose `dataset.source` differs from the code's existing versions in the company (archived ones included) is
   refused at `/dataset/source` — a different dataset is a different report, which needs a §4.16.1 row. The
   writer must hold, through `app.actor_has(code, company, null)` (the call the run route makes), the new
   `permission` **and** every `permission` the code's existing versions carry, or the write is
   `ERR_RBAC_FORBIDDEN`. `admin.company.manage` stays necessary and is no longer sufficient: nobody authors a
   report over rows they could not read, and a code cannot move from a stronger gate to a weaker sibling
   (`document` from `accounting.report.read` to `inventory.stock.read`) unless its writer holds both.
3. **No dataset serves a column the export registry pins as a secret** (`NEVER_EXPORTED`, ADR 0069).
   `audit_log` loses `before` and `after`: no shipped definition printed them (7B kept them out of the audit
   report), and they carry row images of every table, the gated ones included. `definition-gates.test.ts`
   asserts the rule over every member and the common secret names (`object_key`, `pin_hash`, `auth_subject`,
   `device_public_key`, `payload`).

**Residual, stated so nobody relies on more.** Within one gate a clone may still drop or widen a filter: the
shipped `inventory.count_register` reads `document` under `inventory.stock.read` with a caller-supplied
`countTypes`, so a holder of that code can already list any document type's totals through it, clone or not.
Narrowing that needs a per-(dataset, code) mandatory filter, which is an owner question, not a format change.
*(Superseded by the second-review amendment below: that per-(dataset, code) bound now exists.)*

## Amendment — a gate bounds rows and columns, and is re-checked at run time (Phase 7 second review, 2026-11-06)

**Proposed**, like the record it amends. A second review of the amendment above found three ways a definition
still read more than its gate admits. Each is closed in `packages/db/src/reports/datasets.ts` and the one row
provider, `rowsForDefinition`:

1. **A gate may carry a row bound** (`DATASET_ROW_BOUNDS`, `datasetRowBound`). The residual the amendment
   above recorded was a leak, not a curiosity: a clone of `inventory.count_register` keeps its gate
   (`inventory.stock.read`) and source (`document`), yet overrides the `countTypes` options to
   `SALES_INVOICE` or `PAYMENT`, and every stock reader printed the company's financial documents. A
   (dataset, code) pair may now declare a literal predicate over the dataset's own aliases, which
   `rowsForDefinition` passes to the dataset as `DatasetParams.rowBound` and the dataset appends to its WHERE:
   `document` under `inventory.stock.read` reads only `dt.module = 'inventory'` (STOCK_COUNT, TRANSFER,
   GOODS_RECEIPT and the rest of 3A–3D's types); under `accounting.report.read` it keeps every type. A bound
   never comes from a definition (test 27). `document_line` and `document_event` admit no module code and
   carry none.
2. **A column may require a stronger code than its dataset** (`DatasetColumn.requires`). `document_line` is
   gated on `accounting.report.read`, so a definition over it could print, total, sort or filter `cost`, the
   line's booked cost — a separate read since 3B, and omitted from the tenant export. `assertDatasetGate`
   refuses a definition that names such a column anywhere (columns, groups, totals, sort, filters) unless its
   `permission` is the column's code. `document_line.cost` requires `inventory.cost.read`, which
   `document_line`'s gate set never is, so no definition may name it; the cost datasets' own figures
   (`cost_layer` and `cost_consumption` `unit_cost`/`value`, `stock_valuation.value`) declare it too, so a later
   widening of their gate sets does not open them.
3. **The gate is re-checked when a run is queued and when it renders.** Rules 1 and 2 above and amendment 1's
   gate set were enforced only when a definition was written; the render handler only schema-parsed the stored
   row. `rowsForDefinition` now runs `assertDatasetGate` before it reads any row, so a definition written
   before a rule existed, or by a path that bypassed the store, fails its run with `ERR_VALIDATION_FAILED` and
   the `/permission` reason; and `POST …/reports/{code}/runs` runs the same check after the definition's read
   code and refuses 400 with neither a run nor a job.

**Known limits, recorded rather than changed.** Three cost-derived figures remain readable under
`inventory.stock.read` because shipped definitions print them there by recorded design: `inventory_movement.value`
(7B's movement and transfer registers), `item_profitability.cogs_base`/`margin_base` (3D/4A's
`inventory.sales_by_item`), and `document.base_total` for a stock count (7B's count register, its "Variance
value"). Marking them `requires: inventory.cost.read` would refuse those shipped definitions; whether a stock
reader should see them is the owner's question.
