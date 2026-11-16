# 0082 — The legacy reader composes SQL from catalogue-validated identifiers and bound values

- Status: **Proposed** — the plan wrote _Accepted_; it decides how statement text reaches the owner's production
  database, which is security (spec:95), so it waits on the owner like every other Phase 9 ADR of that kind.
  Implemented in 9A Task 2 as the plan's default, ahead of approval, under the owner's direction to implement
  Phase 9 entirely (2026-11-13; `docs/review/2026-11-13-phase-9-decisions.md`).
- Date: 2026-11-13 (the plan's text is dated 2026-09-05)
- Slice: 9A · Task 2
- Contracts: §4.13.1 (`LegacyReader.read`'s `where` is "a typed structure, never SQL text"), §3.7.5
  (`no-sql-concat`). Supersedes: none.

## Context

spec:100 forbids building SQL by string concatenation (LEGACY-036/037/069), and contracts §4.13.1 requires that
`LegacyReader.read`'s `where` be "a typed structure, never SQL text". But the legacy source is Firebird, where a
table or column name cannot be a bound parameter: some identifier must reach the statement as text, and the tables
the profiler walks are named at run time from the catalogue, not at compile time.

0B's `no-sql-concat` rule has a second half with no allow-list at all: any untagged template literal whose body
contains both an interpolation and a SQL keyword is a violation anywhere under `apps/` or `packages/`. So the
renderer cannot be written in the obvious style even if we wanted to.

## Decision

1. **`LegacyPredicate` is a closed, typed structure** (`packages/importer/src/legacy/predicate.ts`). It has no
   member that can carry SQL, and 9B consumes it without extending it.
2. **Every value is a bound `?` parameter.** No literal a caller supplies ever reaches statement text.
3. **Every identifier passes two gates before it is quoted:** a shape test (`^[A-Z_$][A-Z0-9_$]{0,62}$`, after
   trimming and upper-casing) and a membership test against the columns the catalogue declares for that table plus
   the table's own name. `quoteIdent` raises `ERR_IMPORT_SOURCE_UNREADABLE` on either failure, with a different
   message for each. A predicate's columns and every order-by key pass the same gates as the projection.
4. **Statement text is assembled by joining an array of tokens**, so a keyword and an identifier are never in the
   same expression. `packages/importer/src/drivers/sql.ts` is the only file in the package that renders a
   statement from a caller's request, and its three functions — `renderSelect`, `renderCount`, `renderMinMax` —
   are the only shapes that exist. (The live driver's three fixed catalogue reads over `RDB$` tables, 9A Task 3,
   are literal statements with their one value bound; they take no identifier from a caller.)
5. **Every shape starts with `select`**, and a test asserts it. The reader cannot write.
6. **Every non-text, non-blob column is cast to `varchar` in the projection** (`CAST_WIDTH`) so no monetary value
   arrives as a JavaScript number and no date arrives as a `Date` in the process's local zone (spec:2039,
   spec:2041). `min`/`max` run on the native column and only the result is cast.
7. **An empty `and`/`or` and an empty `in` list are refused**, not rendered: neither has one meaning SQL and the
   fixture would agree on.

## Consequences

- `no-sql-concat`'s `UNSAFE_ALLOW` no longer names `packages/importer/src/reader.ts` (the Phase 0 main-branch review removed a
  pre-granted exemption for a file that did not exist), and this package does not need it: the ODBC driver calls the
  `odbc` package's own parameterised `query(text, params)` and never `.unsafe(`.
- **Ordering follows the column, in both drivers.** The live driver's `order by` and `min`/`max` run on the native
  column; `FixtureLegacyDriver` orders and ranges by the column's declared kind (numeric kinds by value with
  `decimal.js`, NULLs first as Firebird sorts ascending, everything else by code unit), so "10" sorts after "9" on
  both sides. The plan's text said both sides order lexicographically over the text form; the live side never did.
- **The fixture's predicate comparisons are textual** (`evaluatePredicate`): exact for equality and ISO dates, and
  for `lt`…`gte`/`between` only where values are equal-width. The committed corpus keeps that rule; a test that needs
  numeric range semantics needs the live driver.
- A future need for a SQL construct these three shapes cannot express amends this ADR and adds a fourth renderer
  function; it never adds a `text` member to `LegacyPredicate`.

## Owner question

1. The live read uses whatever account the DSN names. Should the owner's DSN be a Firebird user granted `SELECT`
   only, so read-only is enforced by the engine as well as by construction? (Recommended; the code does not depend
   on it.)
