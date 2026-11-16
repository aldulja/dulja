# OD-27 (Part VII #8) — mapping the AR/AP, POS and cross-module legacy templates (Plan 7C Task 12)

- Owner decision: **OD-27** (contracts §2.12), Part VII **#8** — _which of the 255 legacy report templates are
  actually in use_ (spec:2472). The other four items OD-27 carries (#6, #7, #9, #13) are 9A's.
- Covers: **Plan 7C Task 12** only — `docs/legacy/7c-template-mapping.md` and its `sah-077` assertion. 7B's half
  (the accounting and inventory templates) is recorded in `docs/decisions/od-27-7b-template-mapping.md`.
- Asked: not by this slice. 9A's profiler is the plan's evidence source, and 9A has not run.
- Answered: pending.
- Decision: pending. The plan's default (**the task is dropped whole**) stands.
- Recorded by: the 7C Task 12 agent, 2026-11-05.

**Status:** ⚠️ **DROPPED on the plan's default. No mapping is written.** This is a gate note, not an ADR, and it
decides nothing. Plan 7C Task 12 says that until the material is provided "the task is not started,
`docs/legacy/7c-template-mapping.md` is not created, and the sah-077 append of Task 14 carries only the
version-controlled-definitions clause". It adds no code, no definition and no test.

## The gate, and what it checked

Task 12's Verify line is 9A's own command, `bun run legacy templates --dsn "$LEGACY_ODBC_DSN" --out
artefacts/legacy/7c`, exiting 0 and `ls artefacts/legacy/7c/` listing the catalogue — **and** the owner's list of
templates in use. Run on 2026-11-05 against this tree:

```
$ ls artefacts/legacy
ls: cannot access 'artefacts/legacy': No such file or directory
$ ls packages/importer
ls: cannot access 'packages/importer': No such file or directory
$ ls docs/legacy
ls: cannot access 'docs/legacy': No such file or directory
$ ls docs/owner/
od-10
od-15
```

9A has not run (`packages/importer` does not exist, so there is no `legacy templates` command to run), no run
directory has been named, and no owner list exists. `artefacts/` is git-ignored by 9A's own rule, so its absence
on a clone would prove nothing by itself; here nothing was named either. **Step 1 stopped; Steps 2–4 did not
run.** `docs/legacy/7b-template-mapping.md` does not exist either (7B's Task 12 was dropped on the same gate), so
there is no 7B half to de-duplicate against.

## What this costs — nothing in 7C

The ten definitions in `packages/db/seed/my/reports/7c/` derive from §4.16.1's register and the spec's scope
sentences, not from the legacy catalogue. Tasks 1–10 and 14 consume nothing from this task, Phase 7's definition
of done (spec:2293) does not name the mapping, and no later slice reads its output. The `SAH-077 … — 7C` block
that Task 14 appends carries the version-controlled-text and no-SQL clauses only.

## When the material arrives

Plan 7C Task 12 runs as printed, with the two path facts it records: 7C's file is
`docs/legacy/7c-template-mapping.md` (the `7b-template-mapping.md` convention), and 9A's artefacts are read from
`artefacts/legacy/<run>/`, never committed. One row per in-use AR/AP, POS or cross-module template; a template
with no v1 equivalent gets an empty code cell and its reason — a finding, not a gap. **Add no definition:** a new
code is a §4.16.1 amendment first and a seed file with its own tie-out case second (ADR 0068); a _partial_ fit is
a tenant clone through 7A's designer, which needs no release. The Task 12 `it` is appended inside the
`SAH-077 … — 7C` `describe` in `tests/regression/sah-077.test.ts`, whose imports it already has.
