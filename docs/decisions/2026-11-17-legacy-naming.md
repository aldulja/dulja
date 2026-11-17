# The legacy system is not named in this repository

**Date:** 2026-11-17 · **Decided by:** the owner · **Status:** applied

## Decision

The repository no longer names the vendor or product of the legacy system Dulja replaces.

| Before                                                 | Now                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| The legacy vendor's product name, in prose             | "the legacy system" (or "a legacy accounting system", "legacy screen", "legacy database", as the sentence needs) |
| A three-letter defect prefix derived from that name (spec Part I, 87 defects) | `LEGACY-###`, with the same numbers                    |
| Regression files named after that prefix               | `tests/regression/legacy-NNN.test.ts`, with the same numbers        |
| Test data derived from that prefix (tenant names, item and warehouse codes, role codes, e-mail addresses) | the same values with `LEGACY`/`legacy` in place of the prefix |
| The importer's field named after that prefix           | `legacyDefect` (one id, `catalogue/questions.ts`) and `legacyDefects` (a list: the aggregate, orphan, null-poison and duplicate-aggregate rules) |
| The dossier's file name                                | `legacy-system-analysis.md` (the file itself is not in this repository) |

The owner first asked for the legacy name to become "Dulja". That was not done literally: Dulja is the new product, so the documents would have said that Dulja replaces Dulja, the importer that Dulja reads the Dulja database, and the 87 defects of the old system would have read as Dulja's own. The owner chose the neutral names above instead.

## What did not change

- **Meaning.** Every defect keeps its number, its text and its regression test. Every reference resolves as before.
- **The legacy database's own table and column names** (`ACCTOTALS`, `MATOPENS`, `VOUITEMS`, …). The importer must read them by those names.
- **The database.** No table, column, constraint or stored value carried the old prefix. Only SQL comments in migrations did, and one `comment on` text in migration `0053`; those were edited in place, as earlier migrations have been while no database outside a test holds them (no staging or production database exists yet — OD-19, OD-20).
- **Git history** is rewritten separately, at the owner's direction, so that no earlier commit carries the old names either (see "History" below).

## Rule from now on

Do not name the legacy vendor or product in this repository. Write "the legacy system", cite its defects as `LEGACY-###`, and name a new regression file `tests/regression/legacy-NNN.test.ts`. `AGENTS.md` ("Change Discipline") carries the rule.

## History

At the owner's direction (2026-11-17) the published history of `main` was rewritten so that no commit, file or commit message carries the old names; the final tree is unchanged by the rewrite. GitHub keeps the commits a pull request pointed at under that pull request's own refs, and forks and existing clones keep their copies; removing those takes a request to GitHub Support and a fresh clone by everyone who had one.
