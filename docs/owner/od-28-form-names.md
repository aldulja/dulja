# OD-28 — the form names on the annual statement and the employer return

spec:2083: _"Annual per-employee statement and employer return from `employee_ytd`, using the Phase 7 report engine;
**form names verified against LHDN at build time**."_ §2.12's OD-28 row carries four ⚠️ items; the other three are
`docs/owner/od-28-statutory-profile-fields.md` (8A), `docs/owner/od-28-proration-rule.md` (8B) and
`docs/owner/statutory-layouts/README.md` (8C). This file is the form-name item, 8D Task 6's.

**Decision needed from the owner and the owner's accountant, not from the build team.** On 2026-11-07 the owner
directed "implement phase 8 entirely"; the plan's default below is what was built
(`docs/review/2026-11-07-phase-8-decisions.md`, the OD-28 form-name row) — implementation authorization, not an
answer.

**Owner provides:** the identifier of (a) the annual per-employee statement of remuneration and (b) the annual employer
return, as the tax authority currently publishes them, with the year they apply to, the publication's name, its URL and
the date it was retrieved; and, if a form requires a field the statement does not carry, which field.

**Verify:**

```bash
bun run --cwd packages/db test test/reports/hr-definitions.test.ts -t "annual_statement"
```

prints `hr.annual_statement: formName options = [<the owner's identifiers>]`, and after
`bun run seed --tenant "$TENANT_ID" --only reports`,
`psql "$DATABASE_URL" -c "select code, version from app.report_definition where code = 'hr.annual_statement'"`
returns one row per seeded version.

**Until provided:** the same commands print `formName options = []`; the header renders the statement's own name, the
tax year, and nothing else; every test passes; and the statement is an **internal document**, not a filing
(`docs/runbooks/payroll-parallel-run.md`, "Annual statements and the employer return").

---

## What is built without an answer (8D Task 6, 2026-11-07)

- **One definition, two uses.** `packages/db/seed/my/reports/8d/hr.annual_statement.json` over the `employee_ytd`
  dataset, gated `hr.payroll.read`, `tieOut: projection employee_ytd`. With `employeeId` it is one employee's statement;
  without it, the employer return grouped by employee. Run through 7A's `POST …/reports/hr.annual_statement/runs` and
  the `reporting.render` job (CSV, XLSX or PDF; English or Arabic) — no new route, job or code.
- **Form identifiers are configuration.** `formName` and `formYear` are optional **free-text** parameters interpolated
  into the header (`{title} {formName} {formYear} — {taxYear}`). The plan wrote `formName` as an `enum` with
  `options: []`; 7A's schema requires an `enum` to offer at least one option, so that file would not seed. Free text
  with no options is the same default — nothing enumerated — and the owner's answer turns it into an `enum` whose
  options are the verified identifiers: one seed-file edit, no migration, no code.
- **No authority literal.** No form identifier, deadline, channel or schema version appears in the definition, a test
  or a fixture; `hr-definitions.test.ts` asserts their absence (hazard 2 in spirit, the rule 5B follows for MyInvois).

## (a) The identifier of the annual per-employee statement

> **Answer:** _(owner)_

## (b) The identifier of the annual employer return

> **Answer:** _(owner)_

## (c) Does either form require a field the statement does not carry?

> **Answer:** _(owner)_

**If yes**, it is a new column of the same definition (and, if the value is per employee and not already stored, a raise
against 8A's `employee_statutory_profile.extra` jsonb) — never a second report code. Two values are already known to be
absent: the employer's registration numbers (OD-23; `missingEmployerRegistrations` names the gaps) and the cut-over
opening of a mid-year switch (`app.employee_ytd_opening`, 9B's; the dataset reads the projection only).
