# 0020 — Three decisions the phase-0 review forced

**Status:** accepted — ratified by the owner on 2026-09-18 with the words "go ahead and do the best": approval to
proceed, and a direction to settle the questions at the end with judgement rather than refer them back. Not a
line-by-line reading of this file, and the evidence behind the three is still local only — the next section says
why. · **Date:** 2026-09-18 · **Slice:** 0E by number only — the decisions come from the 2026-09-18 review of
`main` (PR #3), not from that slice's work
**Spec:** §0.2 "if it touches **money semantics, security, the data model, or the sync protocol**, write the ADR
*as a proposal* and ask before implementing" (spec:95)

## Three decisions under one number, and why that number is irregular

The branch that took them is a remediation of `main`, not a slice: §2 of the plan contracts has no card for it
and §3.4.1 and §3.9 give it no range, so it had nothing of its own to allocate from and took what looked free.
Migrations **0008** (inside 0D's range and labelled *spare*), **0009** and **0010** (the single numbers 0C and 0E
each hold as *reserved*), and ADR **0020** — the last number in 0E's range, 0016–0019 being spent and nothing
below the tail unallocated. Not 0C's unused 0014–0015 either: contracts:226 settles both kinds of number in the
same words — "§3.4.1's rule for migration numbers applies to ADR numbers, so 2B may not borrow it" — and under
that rule this branch was entitled to none of them. It also changed frozen text in six sections of the register —
five blocks of §4.2, one of them decision 3's own §4.2.9, and §3.11's environment list. None of it was amended
into the register first, which §1 of the plan contracts and AGENTS.md:109 each require *before* a frozen name or
number moves. That amendment travels beside this file on the same branch, as round 5 of §4.18: it records the
four numbers, corrects the six sections, and proposes a rule for the next non-slice branch. Which rule is the
owner's to settle there, not this ADR's to assume.

spec:95 asks for the proposal *before* the implementation, and that is not what happened either. All three
decisions were taken while closing a security review of `main` and all three are committed on this branch; this
file was written afterwards. **Nor does CI stand behind them.** The `checks` job runs seven workspaces and
excludes `@dulja/db`, `@dulja/api`, `@dulja/worker` and `@dulja/tests` — a `windows-latest` runner cannot serve
the Linux `postgres` image they need (`.github/workflows/ci.yml`) — and every test named below lives in those
four. The evidence for all three decisions is **local only**. The ask is therefore **ratify or reverse**, not
approve-in-advance. Two of the three are free to take today and expensive to take later, which is the substance
of the questions at the end.

---

## 1 — A currency code is policy, not free text (migration 0008)

### Context

`app.currency` is where `minor_units`, `pos_rounding_increment` and `rounding_mode` live, and `Money` rounds with
them (ADR 0008). Six columns named a currency code without referring to that table — `company.base_currency`,
`exchange_rate.from_currency`/`to_currency`, `document.currency`, `ledger_entry.currency` and `account.currency`,
every one a bare `char(3)`. `'XYZ'` was storable, `app.rate_for` would return a rate against it, and a conversion
would round against policy that does not exist. AGENTS.md:3 puts the financial invariants in the data layer, so
the refusal belongs in the schema and not in a handler.

### Decision

Six composite `(tenant_id, code)` foreign keys —
`packages/db/migrations/0008_add_currency_foreign_keys.sql`. Composite because a key on the code alone would
match another tenant's row, and because `composite_fk` in `packages/db/src/lint-schema.ts` requires that shape.
Referential-integrity checks bypass row-level security by design, so the keys resolve under `app_rw` without
widening any policy; the `tenant_id` inside the key is what keeps them from seeing across the boundary.

**The consequence that makes this a data-model decision rather than a bug fix: a tenant must now hold its base
currency before its first company.** `packages/db/src/seed/owner.ts:29` and `packages/db/test/fixtures.ts:47`
each insert one first. The seed knows only the code OD-21 supplies, so the row takes the column defaults of
`0005_create_currency_exchange_rate.sql:7-9` — `minor_units 2`, `pos_rounding_increment 0.01` (rendered `0.0100`
at `numeric(19,4)`) and `HALF_AWAY_FROM_ZERO`.

**For MYR that increment is very likely wrong**, and the seed's own comment (`owner.ts:24-26`) is where that is
written down: Malaysian cash rounding works in five sen, so a till configured from this bootstrap would round to
the wrong unit. Nothing in the spec settles it — a grep for a rounding increment or for five-sen rounding returns
nothing, and spec:1349 says only that POS payment rounds "per the currency's POS rounding rule", which names this
column's consumer in 6B, not a value for it. OD-21 (spec:2400) asks the owner for the base currency but not for
its rounding policy. So the seed takes the default rather than inventing POS policy behind no gate;
`PATCH /v1/admin/currencies` (`apps/api/src/routes/admin/currencies.ts:137,163`) can correct it, and no code in
this tree rounds anything with the column — outside that route and the Drizzle mirror it is only carried — so a
wrong number here is inert until 6B's till reads it. ADR 0008 is not contradicted: it fixes `Money` and display
rounding and says nothing about the POS increment.

### Alternatives considered

- **A key on `code` alone.** Rejected: it matches another tenant's row, and fails the `composite_fk` lint.
- **`not valid`, validated later.** Rejected in the migration header: `convalidated = false` then stays in the
  catalogue for good, and the column remains a place where an old bad row can hide.
- **Validating the code in the handlers.** Rejected: the invariant then holds only for writers that are handlers,
  and the seed, the jobs and every later service are not.

### Consequences

- `account.currency` is the sixth key although the review's brief listed five. It is free **today and only
  today**: the column is nullable, its one writer in the tree is
  `packages/db/src/seed/chart-of-accounts.ts:75` (`account.currency ?? null`), no pack file sets it and no route
  reaches `app.account`, so every row in every database is null and MATCH SIMPLE lets them all through. Once real
  data exists, the same key needs a repair step in front of it.
- `ledger_entry_currency_fk` also refuses the DELETE of a currency that entries were posted against.
  `forbid_change` guards UPDATE and DELETE *of the ledger*; this guards what the ledger points at. A currency with
  history is archived (`archived_at`), never deleted.
- `add constraint` validates the rows already there. On an empty database that is free; over a database seeded
  before 0008 it fails until every referenced code has a row, so migrating real data forward needs a repair step
  in front of this file. That it is currently free is the only reason this is a one-file change, and no repair
  step exists anywhere in the tree — nothing but this bullet and the migration's own header will remind anyone.

---

## 2 — The audit hash preimage is canonicalised, forward-only (migration 0010)

### Context

`app.audit_chain()` as 0001 wrote it hashed eight fields joined by a bare `|` and escaped none of them. The map
from record to preimage was therefore not injective: `table_name = 'company|x'` with `row_id = 'y'`, and
`table_name = 'company'` with `row_id = 'x|y'`, produce identical bytes and so an identical hash. `row_id` is
where `app.audit_row` puts application text — it is `string_agg` over the key columns, and `document_series` keys
on `series` — so a separator inside a field is something the application writes, not a contrivance. What kept the
collision out of reach was `revoke insert, update, delete on app.audit_log from app_rw`
(`0001_foundations.sql:543`): a grant, not a property of the hash. Two distinguishable histories that hash alike
is the one thing a tamper-evident structure may not permit, whatever the grants happen to say this week.

### Decision

`0010_canonicalise_audit_hash.sql` replaces the preimage with `jsonb_build_array(…)::text` over the same eight
fields in the same order, and `packages/db/src/audit/verify-chain.ts:22-24` recomputes it field for field.
`create or replace` rather than a drop, so the trigger keeps running throughout and the chain has no gap. jsonb is
the instrument because its escaping was already load-bearing — `before` and `after` reached the old preimage
through `::text` — so this adds no new dependency; and because SQL NULL now becomes JSON `null`, which the old
`coalesce(…, '')` could not tell from an empty field.

`occurred_at` stays an epoch string. `to_jsonb(timestamptz)` renders in the session's `TimeZone`, so one instant
reads `+00:00` to one connection and `+08:00` to another, and a verifier that connected with a different setting
would report every row in the tenant as tampered; `extract(epoch …)` has no such setting.
`packages/db/provision/roles.sql:20-21` pins UTC on both roles, but that is a setting someone can change, not an
invariant. **This is the argument for the cast, not a measured property — no test exercises two `TimeZone`
settings.**

One collision survives deliberately: a SQL NULL and a stored jsonb `'null'` both render as `null`. It stays
unreachable for the same reason the old one did — `app.audit_row` writes either NULL or a whole row object, and
only `app_migrator` may insert anything else.

What the tests cover — locally, since `@dulja/db` is one of the four workspaces CI does not run:
`packages/db/test/audit.test.ts:141` runs the shipped verifier over rows the trigger actually wrote (more than
ten rows, zero broken links, zero bad hashes); `:188` inserts the two shifted-separator records under an
identical `prev_hash` and asserts their hashes now differ; `:221` proves the down migration restores 0001's
function body character for character, and that up → down → up returns each body.

### Alternatives considered

- **Length-prefixed framing.** Rejected: a hand-rolled framing whose byte-length-versus-character-length rule
  would live only in a comment, against one PostgreSQL already maintains and already round-trips.
- **Rehashing the rows already written.** Rejected, and this is the decision's sharpest edge. Rehashing needs
  UPDATE on `app.audit_log`; `audit_log_immutable` exists to refuse exactly that; and AGENTS.md:83 has
  "Disable an invariant, constraint, RLS policy, or trigger, even temporarily." Rewriting stored hashes is also
  indistinguishable from the tampering the chain is built to expose.

### Consequences

- **Forward-only.** Rows written before 0010 do not verify under the new function. That costs nothing *only
  because nothing is deployed*: OD-19 and OD-20 are open, and the databases that do exist are Testcontainers
  instances built from `packages/db/migrations` and thrown away each run. The one place a stale row could survive
  is a long-lived developer database migrated across 0010; nothing in the tree needs one.
- **The window shuts the moment a database holds audit rows someone must be able to verify.** After that, the same
  change has to carry its own version instead — a `hash_version` column, or a recorded `seq` cutover — with
  `verify-chain.ts` recomputing each row under the formula that was in force when that row was written. This
  migration does not build that mechanism. It spends the one moment at which the mechanism is not needed.
- The rollback carries the mirror-image cost: rows hashed while 0010 was applied stop verifying the moment the old
  formula is back (`0010.down.sql` says so in its own header).
- The trigger and `verify-chain.ts` must now move together for ever; one field out of step and the nightly walk
  reports every row in the tenant as tampered. `audit.test.ts:141` is what keeps them from drifting silently.

---

## 3 — The handler and the record of its response share one transaction (supersedes part of ADR 0004)

### Context

ADR 0004 (accepted, 0B) decided three transactions: "Unsafe requests first commit a tenant-and-principal-scoped
reservation, then execute the handler, then store its response." The third was itself the defect. The handler's
own transaction committed, and only then did a separate transaction write `response_code`. A crash in between
left a committed mutation under a row that still read `response_code null`, so after `RECLAIM_AFTER_SECONDS`
(120, `idempotency.ts:9`) the key was reclaimed and the mutation ran a second time — the double write this
middleware exists to prevent.

### Decision

Two transactions. The reservation still commits alone, for the reason 0004 gave and `idempotency.ts:51-53`
repeats: folding it into the handler's transaction would hold that key's row lock for the whole request, so a
concurrent duplicate would wait out the first request instead of being told `ERR_IDEMPOTENCY_IN_FLIGHT` in
milliseconds. The handler and the `update … set response_code` now share one transaction
(`idempotency.ts:100-149`), so the mutation and the record of its outcome commit together or not at all.

That required rebinding `context.var.withTenant` for the life of the transaction: `withTenant` refuses a
transaction outright (`ERR_TENANT_CONTEXT_NESTED`, `with-tenant.ts:49-53`) and is right to, since `app.tenant_id`
is already set. Downstream calls therefore join the open transaction as a **savepoint** each, and the binding is
restored in a `finally` — the rebinding must not outlive the transaction whose connection it borrows.

**Precisely which of ADR 0004 is now false:** its title, and the clause "then execute the handler, then store its
response" read as three commits. Everything else it decided stands and still describes the middleware — the
reservation committing alone, the reused / in-flight / replay distinction with its three codes, the 120-second
reclaim, recording failures as well as successes, and replay until purge. ADR 0004 keeps its `accepted` status
and carries a dated note pointing here. **§4.2.9 of the plan contracts said the same thing and was frozen** —
"Three transactions, deliberately" — and round 5 of §4.18 amends it in this PR, along with the reclaim predicate
this branch also changed: the reclaim used to overwrite `request_hash` rather than demand it already match
(`idempotency.ts:55-59`).

### Alternatives considered

- **One savepoint around the whole handler** instead of one per call. Rejected: each call must stay as atomic as
  the separate transaction it replaces, and a failed statement must not poison the outer transaction — the unique
  violation a handler raises has to leave it able to write the response row
  (`tests/regression/legacy-083.test.ts`).
- **Folding the reservation in as well**, one transaction for everything. Rejected for the reason above: it trades
  a millisecond `ERR_IDEMPOTENCY_IN_FLIGHT` for a queue behind the first request.
- **Letting `withTenant` retry the outer transaction**, as it retries any other. Refused by name
  (`idempotency.ts:105-109`): hono's compose will not run `next()` twice, and a handler that has already run would
  mutate twice.

### Consequences

- **Per-call atomicity is unchanged, and so is partial-handler behaviour.** A handler whose second call fails
  still commits its first, exactly as under 0004 — a savepoint rolls back only its own call
  (`idempotency.ts:112-117`). What is new is that such a write is no longer *visible* to other connections until
  the request commits, and that a crash before the commit rolls it back rather than leaving it behind — the
  principal inserted at `apps/api/src/routes/admin/users.ts:78` is precisely the row that used to be orphaned
  under `response_code null`.
- **A database connection and an open transaction are now held across `authAdmin.inviteUser`**
  (`users.ts:75`) — a call to the identity provider that previously sat between two separate transactions. Under
  load this is the cost that bites first: idle-in-transaction time proportional to someone else's service.
- A deadlock or serialization failure on the outer transaction becomes `ERR_INTERNAL` once the handler has run,
  and the response record rolls back with it, so the reservation row stays `response_code null` and the key
  answers `ERR_IDEMPOTENCY_IN_FLIGHT` until the 120-second reclaim. Nothing is lost or written twice — the
  mutation rolled back too — but the caller's key is stalled for two minutes behind a 500.
- The guarantee covers only work that goes through `context.var.withTenant`. In this tree that is all of it:
  outside this middleware's own two calls, the only direct caller of `withTenant` in `apps/api/src` is
  `middleware/auth.ts:39`, which creates the binding. A future handler that reached the pool another way would run
  outside both the savepoint and the commit, and no lint rule states that requirement today.

---

## Questions for the owner, and their resolutions

All four were resolved together, by the same direction that ratified the ADR: proceed, and settle what is open with
judgement rather than refer it back. Each question stands as it was put; the resolution follows it. Two of the
four are **not** closed by their resolution, and say so.

1. **Ratify or reverse each of the three, independently.** They share a number, not a dependency: each is one
   migration or one file, and none of the three needs another.

   **Resolved 2026-09-18 — all three ratified, as implemented.** Nothing above is reversed and nothing is amended:
   the two migrations, the middleware and the tests already on this branch are what was ratified. The independence
   the question offered was not needed.

2. **MYR's `pos_rounding_increment`: is `0.0100` right for the seeded tenant, or should it be `0.0500`?** And a
   second, more durable form of the same question — should **OD-21 gain a rounding-policy input**, so the seed
   refuses to bootstrap a currency whose cash rounding nobody has stated, rather than defaulting quietly? The
   default is inert until 6B, which is why it was left rather than guessed.

   **Resolved 2026-09-18 — `0.0100` stays seeded, and this turns out to be the wrong column to put five sen in.**
   Malaysia settles cash to five sen and that is not in dispute; ADR 0009's seventh decision already writes it
   down (`0009-exchange-rate-lookup.md:33-36`), along with what the column is — a display and cash-collection
   concern, *never applied to a stored amount*. Three findings then settle the value, the second of them stronger
   than the "inert until 6B" this question assumed:

   - **The column is not MYR's.** `bootstrapCompany` inserts whatever code OD-21 names
     (`packages/db/src/seed/owner.ts:29-31`) and takes the column defaults. `0.0500` would be right for one
     currency and wrong for the next tenant bootstrapped; a constant in the seed cannot know which it is holding.
   - **It is not the number a till will apply.** Checked this session against the plan set: 6B's tender path reads
     the *branch's* increment — `const increment = allCash ? input.cashier.limits.roundingIncrement : "0.0000"`
     (plan 6B:5685) — out of `app.branch_pos_policy.rounding_increment`, which 6C creates as
     `numeric(19,4) not null default 0.05` under a `rounding_increment > 0` check
     (`2026-09-05-dulja-phase-6c-staff-cashiers-branch-isolation.md:1440`, `:1452`). 6B's draft
     ADR 0059 says it in as many words: "`branch_pos_policy.rounding_increment` (§4.6.4) is where the increment
     lives — a configuration column with a default" (plan 6B:5251-5252). So five sen already has a home and a
     check one level below this column — behind a hard-coded `0.05` that is right for MYR and exactly as blind
     to the next currency as a seed constant would be. Seeding `0.0500` here would put the right value in a
     column no till reads, where it would read as authoritative and be neither.
   - **Nothing in this tree computes with it.** A grep for both spellings finds carriers only: the admin route
     that inserts, returns and patches it (`apps/api/src/routes/admin/currencies.ts:86`, `:113`, `:163`), the
     Drizzle mirror (`packages/db/src/schema/currency.ts:13`), the request and response schemas
     (`packages/contracts/src/admin/currency.ts:24,35,44`) and `packages/contracts/openapi.json`, plus the two
     tests that assert the seeded and patched values (`packages/db/test/currency.test.ts:60`,
     `apps/api/test/routes/admin/currencies.test.ts:42,54`). `packages/domain` does not name it at all.
     `PATCH /v1/admin/currencies` corrects it the moment it means anything.

   The register already points here for this: the 0D migration-range row records that the bootstrap inserts the
   currency "on the column defaults" and that "ADR 0020 carries the argument and puts the `pos_rounding_increment`
   default to the owner" (contracts:81, repeated at :4126). This resolution is that answer.

   **What 6B may not start without deciding:** what `currency.pos_rounding_increment` is *for* now that
   `branch_pos_policy.rounding_increment` exists — display only, as ADR 0009 has it, or a per-currency policy that
   seeds or constrains the branch column, which is what spec:1349's "rounding per the currency's POS rounding
   rule" reads like — and which is the one thing that would give 6C's hard-coded `0.05` a currency to answer
   to. Until that is settled, two columns in two tables both answer "how does cash round here" and only one of
   them is read. 6B holds half of it already, as hazard **A9**: that row sets the same spec clause against the
   branch column (plan 6B:245) and sends it to `docs/adr/0059-pos-cash-rounding-has-no-ledger-account.md`,
   drafted at its task 7 (plan 6B:78, 6B:5237-5252). But A9 asks where the rounding *lands in the ledger*, and
   neither it nor that draft says what the currency column is for. **That half is written down here and nowhere
   else** — amending 6B's plan to carry it is not on this branch.

   **The OD-21 half of the question is not answered here.** Whether that owner item gains a rounding-policy input,
   so the bootstrap refuses a currency whose cash rounding nobody has stated rather than defaulting quietly,
   remains the owner's and remains open.

3. **Is forward-only audit hashing acceptable?** It is free only while no database holds audit rows anyone must
   verify. If staging is stood up under OD-19/OD-20 and seeded before this is approved, the window shuts and the
   same change then costs the `hash_version`-or-`seq` cutover mechanism described above. So: merge 0010 before
   staging exists, or build the versioning now?

   **Resolved 2026-09-18 — accepted, and the timing argues for merging now rather than later.** Today no database
   holds an audit row anyone must verify: OD-19 and OD-20 are open, nothing is deployed, and every database in
   play is a Testcontainers instance built from `packages/db/migrations` and thrown away. The window is open
   **now** and shuts the moment staging is stood up and seeded, so promptness is not impatience here — it is what
   keeps the cheap path. Waiting buys nothing and risks the `hash_version`-or-`seq` cutover priced in the second
   bullet of this decision's consequences. That mechanism is deliberately not built here.

4. **Is D3's trade acceptable — a connection held across the identity-provider call, against the double write it
   removes?** Note what the alternative is not: the middleware wraps the whole of `next()`, so every line of every
   handler runs inside that transaction and there is nowhere inside `users.ts` to move the call to. The real
   options are to enqueue the invite as a job that runs after the commit, or to restructure the middleware so that
   non-database work does not sit inside the transaction at all. Neither is on this branch, and neither is costed
   here.

   **Resolved 2026-09-18 — accepted as a known cost, not as a closed question.** What D3 removes is a correctness
   defect; what it buys is a load characteristic, today one identity-provider call in one handler
   (`apps/api/src/routes/admin/users.ts:75`). At this size that trade is right, and it is not a fix. The two
   alternatives the question names are still the only two, and neither is on this branch nor costed: enqueueing
   the invite as a job that runs after the commit moves when the caller learns it failed, and keeping non-database
   work out of the transaction is a middleware restructure nobody has drawn. Choosing between them needs a number
   nobody has — how long `inviteUser` actually holds the connection under load. **It stays recorded as a Phase 1
   concern**, against the second bullet of this decision's consequences: the second handler to hold the
   transaction across someone else's service is when it has to be answered rather than noted.

## Phase 6 amendment — one-time enrolment issuance (2026-10-07)

This amendment is Proposed for formal review and implemented under the owner’s renewed whole-phase instruction, preserving the accepted mutation/response-record atomicity. Phase 6’s enrolment design returns a bearer code once and stores only its hash. Ordinary response caching would persist that code in `idempotency_key.response_body`, defeating the design.

Register exactly `POST /v1/admin/terminals/enrolments` in `ONE_SHOT_SECRET_RESPONSES`, matched on Hono’s routed path. The initial successful 201 response contains the code; the same transaction commits the enrolment writes and records a safe 409 `ERR_IDEMPOTENCY_KEY_REUSED` problem for future retries. Failed responses use ordinary replay semantics. Hash matching, in-flight handling, reclaim and principal-scoped keys remain unchanged. The handler is never re-run for a completed key, and this operation remains inside the request-spanning transaction. A retry after management authority is removed reveals no secret.

A lost first response cannot recover the code from the server. Its terminal code stays reserved, and the operator must issue a fresh enrolment with a fresh terminal code. Tests must inspect the cache for secret absence and prove safe same-key, encoded-path and revoked-authority replay behavior. ADR 0055 and Plan Contracts §4.2.9 carry the same rule.

## 2026-11-15 amendment — a live reservation is never reclaimed; the payslip route opens its transaction at its first write

**Status:** Proposed (full review 2026-11-15, findings CON-01 and CON-02). **This changes decision 3's ratified
reclaim rule**, so it waits for the owner like any amendment to a security decision.

### Context

Decision 3 kept ADR 0004's reclaim: a reservation with `response_code null` older than `RECLAIM_AFTER_SECONDS`
(120) is taken over by the next request with the same key and body. Age was standing in for "the request that
holds it has died", and it is not proof of that. A request can outlive 120 seconds and still be running: a payslip
generation renders one Chromium PDF per employee, and any request can queue for one of the API's four pooled
connections. The edge times out, the back office retries with the same key, the retry reclaims the key, and both
handlers run and commit. The 2026-11-15 review reproduced it: two 201s and two rows from one key (CON-01). The
final `update … set response_code` was unconditional, so the superseded request committed too.

The same review found the payslip route held a pooled connection `idle in transaction` through every render and
object PUT (CON-02). It wrote through `c.var.withTenant`, so it ran inside the request-spanning transaction. Its
comment said otherwise. Four concurrent generations pinned the whole pool.

### Decision

1. **Liveness lock.** The request-spanning transaction takes a transaction-scoped advisory lock on the key
   (`pg_advisory_xact_lock(hashtextextended('idempotency:<tenant>/<principal>/<key>', 0))`) before the handler
   runs, and holds it until it commits or rolls back. The reclaim gains a last conjunct,
   `pg_try_advisory_xact_lock(<same key>)`. So a reservation whose request is alive is never reclaimed, however
   long it runs, and the retry gets `ERR_IDEMPOTENCY_IN_FLIGHT`. A request whose process died holds nothing, since
   PostgreSQL releases the lock with the connection, so the 120-second reclaim still unblocks a key after a crash.
2. **Fence.** The reservation returns its `created_at` as a token. A reclaim moves it. Before the handler runs,
   the request checks it still owns its reservation (same `created_at`, `response_code null`). The final update is
   conditioned on the same two facts, and if it matches no row the request throws, so its writes roll back. This
   covers the one window the lock cannot: the reservation has committed but the request has not yet taken the lock
   (for example, waiting for a pooled connection). A request superseded there answers `ERR_IDEMPOTENCY_IN_FLIGHT`
   and writes nothing. The token travels as text and is cast in SQL, because postgres.js serialises a
   `timestamptz` parameter through a JS `Date` and drops the microseconds.
3. **`TRANSACTION_AT_FIRST_WRITE`.** This is a new list in `idempotency.ts`. Today it holds only
   `POST …/payroll-runs/{documentId}/payslips`. For a member, each `c.var.withTenant` call runs in its own short
   transaction under the lock and fence. A call that wrote nothing commits at once. The first call that wrote
   (`txid_current_if_assigned()` is set, which any row write or row lock causes) stays open and becomes the
   request transaction. Later calls join it as savepoints, and the response record commits in it. **Decision 3's
   guarantee is unchanged for these routes**: the handler's writes and the record of its response commit together
   or not at all. What changes is only when that transaction opens. A member may hold no lock in a read that the
   write depends on, and its calls must be sequential. During the slow part no lock shows the request is alive, so
   there only the fence protects the key.
4. **`REPLAY_BY_RERUN` and `SELF_TRANSACTED` keep the age-only reclaim.** They hold no connection across the
   handler (that is why the lists exist, and the PR 11 pool deadlock is why it must stay so), so no lock can show
   they are alive. Their response record is fenced, so a superseded request no longer overwrites its successor's
   record. A print writes nothing. An e-invoice poll or cancel is serialised by its own claim (ADR 0053). So a
   duplicate run there does no harm, and this amendment adds no connection to either.

### Alternatives considered

- **Fence only.** At most one of the two requests commits, but both run in full: two renders, two calls to the
  identity provider, objects staged and orphaned. The lock tells the retry the truth within milliseconds instead.
- **A heartbeat column** (a lease renewed while the request runs). Rejected: it needs a migration and a timer per
  request, and it is still a guess about liveness that the lock gets from PostgreSQL for free.
- **Moving payslips to a job.** This would also fix CON-02, but it changes the route's contract (a 201 with the
  attachments becomes a 202 and a poll) and the screen. That is a larger change than a fix branch should make.

### Consequences

- In the window decision 2 covers, a request that waited more than 120 seconds for a connection now gives up its
  work to the retry that took its key over, rather than running beside it.
- A retry's reclaim attempt takes the try-lock in its own short transaction. A live request that is about to take
  the lock waits for that transaction for milliseconds at most, because the lock is blocking there by design.
- The payslip route's reads before its first insert are now separate READ COMMITTED transactions. At that
  isolation each statement already read its own snapshot, so no read sees anything different.
- Not covered here: `POST …/attachments` (2C's upload, up to 25 MiB with a 30 s object PUT) has the same shape as
  the payslip route and the same `idle in transaction` cost. Its route file was outside this fix's scope. Joining
  `TRANSACTION_AT_FIRST_WRITE` is the one-line change, plus correcting its comment and
  `packages/db/src/attachment/index.ts`'s.
