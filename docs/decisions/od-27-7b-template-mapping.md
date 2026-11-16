# OD-27 (Part VII #8) — mapping the legacy report templates to 7B's codes (Plan 7B Task 12)

- Owner decision: **OD-27** (contracts §2.12), Part VII **#8** — _which of the 255 legacy report templates are
  actually in use_ (spec:2472). The other four items OD-27 carries (#6, #7, #9, #13) are 9A's.
- Covers: **Plan 7B Task 12** only. 7C carries the same gate for its own codes and records it there.
- Asked: not by this slice. 9A's profiler is the plan's evidence source, and 9A has not run.
- Answered: pending.
- Decision: pending. The plan's default (**the task is dropped**) stands.
- Recorded by: the 7B Task 12 agent, 2026-11-05.

**Status:** ⚠️ **DROPPED on the plan's default. No mapping is written.** This is a gate note, not an ADR, and it
decides nothing. Plan 7B Task 12 says that with the gate closed the task "creates and modifies nothing" and that
the outcome goes in the slice-exit commit; this note is written as well, at the caller's direction, because every
other closed owner gate in this tree left a file the next reader can find (`docs/decisions/od-09-…`,
`docs/ui/od-24-phase-7a.md`). It adds no code, no definition and no test.

## The gate, and what it checked

Task 12 Step 1: the owner names the run directory 9A wrote, `$RUN`, and `ls "$RUN"/index.json
"$RUN"/templates.json "$RUN"/scope.json "$RUN"/open-questions.json` lists the four files — **or** the owner
supplies the list of legacy templates in daily use. Run on 2026-11-05 against this tree:

```
$ ls -1 artefacts/legacy/
ls: cannot access 'artefacts/legacy/': No such file or directory
$ ls -1 docs/owner/
od-10
od-15
$ ls packages/importer
ls: cannot access 'packages/importer': No such file or directory
```

9A has not run (`packages/importer` does not exist; 9A floats in the schedule, §6.3), no run directory has been
named, and no owner list exists. `artefacts/` is git-ignored by 9A's own rule, so its absence on a clone would
prove nothing by itself; here nothing was named either. **Step 1 stopped; Steps 2–5 did not run.**

## What this costs — nothing in 7B

The twenty-two definitions in `packages/db/seed/my/reports/7b/` derive from §4.16.1's register and the spec's
scope sentence, not from the legacy catalogue, and Tasks 1–11 and 14 depend on nothing here. Phase 7's
definition of done does not name the mapping. No later slice consumes its output.

## When the material arrives

1. Read `index.json` first (which 9A commands ran), then `templates.json` (the 255 by name, `nearDuplicateOf`
   collapsing families, `empty: true` mapping to nothing), `scope.json` (corroboration: a template over a table
   whose last row is years old is not in daily use) and `open-questions.json`'s `VII-8` row — whose `verdict` is
   `null` until the owner fills it, and a `null` verdict is not an answer this task may supply.
2. Write `docs/legacy/7b-template-mapping.md`: one row per named template — legacy template, in use (source),
   Dulja code, fit (_exact_ / _partial_ / _none_) — and in its header the three counts (named, mapped
   exact-or-partial, none). Quote `index.json`'s `generatedAt`, `source` and `engineVersion`; copy no artefact,
   which is customer data.
3. **Add no definition.** A _none_ row is a finding: a new code is a §4.16.1 amendment first (hazard 32) and a
   definition with its own tie-out case in a slice of its own (ADR 0068). A _partial_ row's remedy is a tenant
   clone through 7A's designer, which needs no release.
