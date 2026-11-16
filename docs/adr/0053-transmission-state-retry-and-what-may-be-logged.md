# 0053 — Transmission state, bounded retry, and what may be logged

- Status: **proposed** (spec:95 — this touches the data model and what an incident responder can
  see; do not merge the implementation before this is accepted)
- Date: 2026-10-02
- Slice: 5B

## Context

spec:2225 asks for "document hash, QR code, transmission log, retry, and status reconciliation"
and nothing more; §4.9.3 gives six statuses and `retryLimit 8`. Three questions are left open and
each has a wrong answer that is easy to reach.

## Decision

**1. The legal transitions, and there are exactly these.**

| From | Verb | To |
|---|---|---|
| `pending`, `error`, `rejected` | submit | `submitted`, `accepted`, `rejected`, `error` |
| `submitted` | poll | `submitted`, `accepted`, `rejected`, `error` |
| `accepted` | cancel | `cancelled`, `rejected`, `error` |

`cancelled` is terminal. `rejected` is **not** terminal — an authority's refusal is corrected and
resubmitted, which is a normal operation and not a new document; a rejection that needs a credit
note is a *business* decision the operator makes, and the log must not pre-empt it. `error` is
always resubmittable: it is the state an unmapped remote label, a redacted parse failure or an
exhausted retry lands in.

Anything else is `ERR_EINVOICE_STATUS_ILLEGAL` (409), naming the current status and the legal set.

**2. Transient versus permanent, and who retries.**

A 5xx, a timeout and a connection failure are `TransientTransmissionError`: the handler **throws**,
pg-boss retries with `retryLimit 8` and exponential backoff, and the row keeps its previous status
with `attempts` incremented and `last_error` set. A 4xx is an **outcome**: the row moves to
`rejected` (or `error` for an unmapped label) and the handler returns normally, because retrying a
refusal eight times is how an integration gets rate-limited off an authority's platform.

**3. Two short transactions with the call between them, and a bounded claim.**

`withTenant` opens a real transaction; holding one across a call to an authority would be the
longest transaction in the system and would hold a row lock for its duration (spec:1368 asks for
many short transactions). So: **claim** (short), **call** (no transaction), **record** (short).

The claim stamps `claimed_at = now()` (amended 2026-10-07: `date_trunc('milliseconds', now())`, the
precision of the row's `claimedAt`, so the row the claim returns names the claim exactly) and increments
`attempts`, and admits a re-claim only when
`claimed_at` is null or older than **120 seconds** — the same window §4.2.9 already uses to reclaim
a dead idempotency reservation, reused rather than re-invented. **The record step clears
`claimed_at` and stamps `polled_at = now()`, and so does the fault path** — each only while the row
still holds the claim that call took (amended 2026-10-07, below) — so the claim lasts
exactly as long as the call does. **The fault path covers every refusal raised after the claim, not
only the transport ones**: `ERR_EINVOICE_NOT_ENABLED` from `credentialsFor`,
`ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` from `transmitterFor`, a `loadSnapshot` failure and a
canonicaliser's refusal on an unmappable required field are all inside the same `try`. A refusal that
released nothing would be worse than a transport failure, because the second is retried and the first
would not be — and `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` is exactly the state every `myinvois`
company is in until OD-15 is discharged. Two columns, and the reason is that one cannot carry both
meanings: if the claim instant *were* `polled_at`, then the `poll` that legitimately follows a
`submit` seconds later would be refused, and every pg-boss retry (`retryDelaySeconds: 60`) would
arrive inside the 120-second window and be swallowed by the handler's "already settled" branch —
which would make `retryLimit 8` dead for the one case it exists for.

It bounds, and does not eliminate, a concurrent duplicate: the job path is already single-flighted
by stately singleton keys (the transmission ID for submissions, its `:poll` suffix for polls), the route path by `Idempotency-Key`, and the claim
reads the row `for no key update` before it checks it, so every check and the update act on one state of
the row. _(Amended 2026-10-07. Until then this sentence read: "the claim's `and attempts = <the value just
read>` predicate is optimistic concurrency over the same row". It was not: a record changes `status` and
clears `claimed_at` but never touches `attempts`, so a claim whose unlocked read preceded another call's
record still matched after that record committed, and claimed past a status check made on the old
status.)_ The
window's residual job is the crash case — a process that took a claim and died before recording.
A residual duplicate can produce a second submission. The authority's deduplication behavior must
be verified in ADR 0051 before production integration; the OD-15 checklist includes it.

**4. What may reach `response jsonb`.**

The row is audited, so whatever is stored here is copied into `app.audit_log` for the retention
period. `redactResponse` (Task 4) therefore: redacts any key matching
`/token|password|authorization|card|pin|secret/i` at every depth; truncates a string at 1024;
caps an array at 50; records a non-JSON body as `{ nonJson: true, length }`; and stops at depth 6.
**A request body is never stored** — `request_sha256` is, which is enough to prove what was sent
and cannot leak a buyer's details into the audit log.

## Consequences

- An operator can always answer "what did we send, when, how many times, and what came back", and
  can never answer it with a credential.
- A transmission stuck at `submitted` is visible by `polled_at` alone, with no pg-boss query.
- Reconciliation is the poll phase re-enqueueing itself, so a `JOBS` name is not spent on it.
- A rejected document can be corrected and resubmitted on the same log row, so the
  `unique (tenant_id, document_id)` of migration 0057 stays true.

## Queue integration correction — 2026-10-02

The tax submit queue uses pg-boss's `stately` policy, keyed by transmission ID for submissions and `<transmissionId>:poll` for polls. A worker can enqueue the next poll while its submission/poll is active; queued duplicates collapse into the queued job. The standard 24-hour singleton throttle would suppress this follow-up. This extends the existing queue adapter without changing the job envelope or retry options. Status remains the durable transmission row. Implementation is reviewable under the owner's Phase 5 request; this ADR remains proposed pending the merge decision.


### Verification refinements — 2026-10-02

Remote outcomes carry their own unknown-status diagnostic; the transmitter's shared last-call diagnostic is never a persistence source. Known credential values are redacted even when echoed in ordinary strings or field names, and from fetch error messages. The polling budget counts calls in the durable `attempts` column, including submission and retries; the first automatic poll waits 60 seconds. Submit keys use the transmission ID, and poll keys use its `:poll` suffix. Automatic polling checks the budget before calling, stops at twelve total attempts and records a recoverable operator message. QR generation and accepted-poll snapshot reads stay inside the fault handler so failures release their claims.

## Public-protocol receipt amendment — implementation for review, 2026-10-02

A submission UID and document UUID are different remote identifiers. The authority transport encodes both in the existing opaque external-ID text field; polling decodes the submission identifier and cancellation decodes the document identifier. No process-local cache is required to recover either after restart. QR creation receives the individual response's raw receipt as optional context and extracts the long identifier returned on validity. Existing synthetic QR builders ignore that context.

The transport rejects identifiers containing secrets/tokens before persistence, and redacts both credentials and all acquired token values in stored diagnostics. Token expiry uses the remote lifetime, with single-flight acquisition and one bounded refresh after authentication refusal. Authentication/throttling failures never produce accepted states. Public protocol support alone does not establish company applicability or an accepted mapping/signature policy.

Polling a remotely cancelled document records the cancellation timestamp required by the durable state check. An unconfirmed/refused cancellation retains the previously accepted invoice and QR link, records its diagnostic and releases the claim for recovery. The refusal concerns the cancellation operation, not the validity of the invoice that was already accepted.

## Amendment 2026-10-06 (proposed): a poll never demotes; acknowledged submissions are never resubmittable; operator poll

The review of PR 11 found two ways the table in decision 1 lets reconciliation fail. **A poll could
demote an acknowledged transmission to `error`**: an unmapped remote label, a non-2xx poll answer
(whose success-shaped label the HTTP transmitter forces to `error`) and a receipt that does not match
the recorded submission all landed there. The worker re-enqueues a poll only while the row is
`submitted`, so polling stopped; and `error` is submittable, so the next submit sent the authority a
document it already held under the stored `external_id` — a duplicate e-invoice. A submit answered
2xx with an external id and an unmapped label had the same hole. **And a row the worker stopped
polling at its limit was unreachable**: no route polled, submit is legal only from `pending`, `error`
and `rejected`, cancel only from `accepted`, and nothing reads `einvoice_transmission_open_idx`.

**1. The rows of decision 1's table that change.** The `cancel` row is unchanged.

| From | Verb | To |
|---|---|---|
| `pending`, `error`, `rejected` | submit | `submitted`, `accepted`, `rejected`, `error` — **`error` only when the authority did not acknowledge intake**: a non-2xx answer, or a call that returned no usable external id. Any other outcome (`error`, `pending`, `cancelled`) on a **2xx with an external id** is recorded `submitted`. |
| `submitted` | poll (the job, or the operator route below) | `submitted`, `accepted`, `rejected`, `cancelled`, **and only from a 2xx answer**. **`error` is never reached by a poll.** |

A poll only ever runs on a row the authority already holds, so only its definitive answers —
`accepted`, `rejected`, `cancelled`, and `submitted` itself, each **on a 2xx** — change the status.
Any other outcome (`error` from an unmapped label or a mismatched receipt; `pending`; or **any label
on a non-2xx answer**, `rejected` included) records `status = 'submitted'`, keeps the diagnostic in
`last_error` (the unmapped label, or the redacted response, which carries the HTTP status — so an
authority's 404 is distinguishable from a 200 with a missing field), stores the redacted `response`,
releases the claim and stamps `polled_at`, as every completed call does. The HTTP transmitter forces
only a success-shaped label on a non-2xx to `error` and deliberately lets `rejected` through, because
decision 2 makes a 4xx **submit** a rejection; the poll-side rule is therefore applied by the
transmission log on the call's HTTP status, not by widening that forced list. A profile label mapped
explicitly to `error` on a poll is recorded `submitted` like any other non-definitive answer; how an
operator acts on an authority that declares a failure for a document it holds is the open question
at the end. `accepted_at`, `cancelled_at` and `qr_payload` are written only on their own recorded
states. The worker therefore keeps polling within its budget. Decision 1's sentence "`error` is
always resubmittable: it is the state an unmapped remote label … lands in" now holds only for a
submit the authority did not acknowledge; `error` stays always resubmittable, and it is no longer
reachable from a document the authority holds.

The test of acknowledgement is the HTTP status of **that call**, carried on the outcomes of
`RegisteredTransmitter.submit` and `.poll` (this slice's extension type). §4.9.3's frozen
`EInvoiceTransmitter` is untouched. The transmitter's shared `lastCall` remains diagnostic only (the
verification refinements above), and `response.httpStatus` is the redacted storage envelope of
decision 4, not a control input.

**Two submit paths that threw after the authority answered 2xx are outcomes, not faults.** Both
used to leave the row at its prior submittable status with no external id and rethrow, and pg-boss's
retry POSTed the same document again.

- **An acknowledgement the transmitter cannot read** — a codec that cannot decode the receipt, an
  identifier carrying credential material, a success label with no addressable external id — raises
  `UnreadableAcknowledgementError` (an `EInvoiceError` with `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE`,
  the code those codec refusals already carried, holding the call's HTTP status and redacted body).
  The submit service records it as an **`error` outcome** — the "no usable external id" case above —
  with a `last_error` saying the authority answered 2xx and may already hold the document, and
  returns normally, so the job ends. It is **terminal for automation**: resubmitting is an
  operator's decision, made with that diagnostic in front of them. The same failure on a non-2xx
  keeps its original error, and on a poll or a cancel it stays a fault as before (a poll is
  idempotent to retry; a cancel's refusal reaches the operator in the response).
- **An acceptance whose QR payload cannot be built.** The authority accepted the document under its
  external id; the failed builder is ours. The row is recorded **`submitted`** under that id, with the
  QR failure in `last_error`, and the next poll re-reads the acceptance and builds the QR then.

**Any 2xx submit the log records `error` carries the same warning** (added after the second review
of this amendment). On a 2xx, `error` means the answer named no external id the log can use — with
one, the row would be `submitted`. Besides the unreadable acknowledgement above, that is a label the
profile does not map with no id beside it, and a MyInvois 202 whose `acceptedDocuments` the codec
cannot correlate with the document's `invoiceCodeNumber` (no row, several, or one in both lists):
the authority took that submission in under a `submissionUID`, but polling and cancelling need the
document's uuid too, so the log has nothing to poll. A 2xx the log cannot address is **not** an
unacknowledged one. It stays `error`, because there is nothing to reconcile it against, and the job
ends without resending it. Its `last_error` leads with one fixed sentence, exported from `@dulja/db`
as `UNADDRESSED_ACKNOWLEDGEMENT_PREFIX` — "the authority may already hold this document — confirm
with it before resubmitting: " — followed by "http N, but <reason>; response: <redacted answer>", the
only place the `submissionUID` reaches the wire, because `response` is not on it. A 4xx carries no
such warning: the authority refused it. It is terminal for automation; the operator decides.

**Terminal for automation is enforced, not only stated** (PR 11 integrated review, 2026-10-07). An
`error` row whose `last_error` begins with that prefix is not actionable by automation: the worker's
submit phase logs and returns without calling the authority, as for a settled row, and the submit
service's claim refuses such a row with `ERR_EINVOICE_STATUS_ILLEGAL` in the transaction that takes
the claim, so a job that read the row before the warning landed sends nothing either. Without that,
an operator who pressed Submit while the posting job's first call was in flight (the row reads
`pending` throughout it) queued a second job behind it, and that job resent the document the moment
the first recorded the warning. `POST …/einvoice-transmissions/{transmissionId}/submit` is the
deliberate resubmission: in the transaction that enqueues its job it replaces the prefix with
"resubmission requested by an operator; " and keeps the diagnostic after it (`admitOperatorSubmit`),
an audited update that an enqueue failure rolls back. The same route answers 409
`ERR_EINVOICE_STATUS_ILLEGAL` while `claimed_at` is younger than `CLAIM_WINDOW_SECONDS` (read on the
database clock, as the claim reads it), and `claimedAt` — a nullable timestamp, additive — is on
`EinvoiceTransmissionSchema`, so an operator can see a call in flight. **Unverified until OD-15:** ADR 0051 says accepted
rows carry `invoiceCodeNumber`. If the authority echoes something other than the wrapper's
`codeNumber` (a normalised form, or the UBL document's own `ID`), every MyInvois submission would
land here, and the codec's correlation key must be corrected against the verified protocol.

**2. An operator verb that is not bound by the poll limit.**
`POST /v1/companies/{companyId}/einvoice-transmissions/{transmissionId}/poll`, in the existing route
module (a sub-path, so it inherits the module's isolation probe): gated on `accounting.tax.file`
for the path company, `Idempotency-Key` required, no body. It calls the same poll service with the
pool, so the service's claim and record are two short transactions on their own connections and no
lock on the transmission row is held across the remote call. **It runs outside the idempotency
middleware's request-spanning transaction** (corrected after the second review of this amendment).
Inside it, where every unsafe route but `REPLAY_BY_RERUN`'s runs, the request held one pooled
connection for its whole duration while the service's claim and record each needed **another** from
the same pool. As many concurrent poll or cancel requests as the pool has connections (four,
`createDb`'s default) held them all and waited for a fifth for ever, and every later request queued
behind them — a review probe and this amendment's regression test both hung there. That is not the
cost ADR 0020 accepted for `inviteUser`, which holds one connection and needs no second; the cancel
route had the same shape since 5B. Both routes are now members of a new list, `SELF_TRANSACTED`
(`apps/api/src/middleware/idempotency.ts`): the reservation commits as before, the handler runs with
no transaction of the middleware's open, and its real response is recorded afterwards in one more
short transaction and replayed for a repeated key like any other. The guarantee the request-spanning
transaction buys — the handler's writes and the record of its response commit together — never
covered these handlers, whose writes commit in the service's own transactions either way. A crash
between those commits and the response record leaves the key unrecorded, so after
`RECLAIM_AFTER_SECONDS` a retry with it runs the handler again: another poll, or a cancel the claim
refuses with 409 because the row is already cancelled. A route that writes through
`c.var.withTenant` may never join the list. It widens §4.2.9's one-transaction shape, so Plan
Contracts records it as a ⚠️ proposal. Both `SELF_TRANSACTED` and `REPLAY_BY_RERUN`, and the
idempotency fingerprint, match the path Hono routed on (`c.req.path`: unreserved escapes decoded by
`decodeURI`, reserved `%2F`, `%3F` and `%25` kept as sent), not the URL's own spelling (PR 11
integrated review). `…/%70oll`, `…/cance%6C` and `…/einvoice%2Dtransmissions/…` reach the same
handlers; matched on the encoded spelling they ran inside the request-spanning transaction and
deadlocked the pool exactly as above. Two spellings that reach one handler with one set of
parameters are now one request for a key; a path with no `%` hashes as before. The route answers 200 with the transmission, 404 for a row
that is not the path company's, 409 when the row is not `submitted` or a call is already in
flight, and 422 when e-invoicing is not enabled or the transmitter is unavailable. An authority fault (a 5xx, a 429 or a
timeout) is recorded on the row and releases its claim, and the route answers **500 `ERR_INTERNAL`**
— as cancel does — which the idempotency middleware stores and replays for that key, so a retry
needs a fresh `Idempotency-Key`. That is documented on both routes rather than remapped: §4.2.4's
registry has no 503-class code and 5B's list of codes is closed, so a retryable upstream code is a
contracts amendment of its own. `POLL_LIMIT` bounds **automatic** polling only; the worker's
poll-limit `last_error` and log line name this route, and the poll-limit row stays `submitted` and
is reachable.

Because the route can now claim a `submitted` row while a poll job is due, **a poll job whose claim
is refused on a row it read as `submitted` schedules its successor** instead of treating the
refusal as "settled": the other claimant schedules nothing, so returning would end automatic polling
below the limit with no marker. The successor re-reads the row, so one the other call settled makes
it a no-op, and the singleton key collapses duplicates. The **poll-limit marker leads `last_error`
and keeps the authority's last answer after it** ("…; last answer: …"), because the twelfth poll's
diagnostic is why the row never resolved and `response` is not on the wire; a row already carrying
the marker keeps it unchanged, so repeated deliveries never nest it. For the same reason **a submit
job that reads the row as `submitted` schedules its poll and calls nothing**: the submit commits
`submitted` in its own transaction and the poll is enqueued in another, so a failed enqueue (a
dropped connection, a worker stopped between the two) hands pg-boss a submit job to redeliver whose
claim `submitted` refuses. Read as "settled", that left a `submitted` row with no poll job and no
marker, and automatic reconciliation never began. A **poll job that finds e-invoicing disabled**
(`ERR_EINVOICE_NOT_ENABLED`) schedules nothing; guarded on `status = 'submitted' and claimed_at is
null`, it replaces the fault text with "automatic polling stopped: <detail> — once e-invoicing is
enabled again, reconcile this transmission with POST …/{id}/poll", because re-enabling e-invoicing
resumes nothing by itself (PR 11 integrated review).

**3. Company binding inside the claim.** The submit, poll and cancel services take an optional
`companyId`. When it is given, the claim refuses another company's row with `ERR_NOT_FOUND` in its
own transaction, **before** the status check and with the same detail an id that does not exist gets
(the GET and submit routes now use that detail too), so a sibling company learns neither existence
nor status and nothing is claimed. The cancel and poll routes pass the path company, and the cancel
route's separate pre-read is removed as redundant. The submit route keeps its check in the
transaction that enqueues: it never calls the submit service, and the job payload (contracts
amendment 2) names no company. The worker omits `companyId`.

**Still open — for the owner, and not built:** how an operator abandons a transmission the
authority has **lost**. If the authority never resolves a submission, or answers that it does not
know the id, every poll leaves the row `submitted`. Under this amendment no verb moves it out: a
`submitted` row cannot be resubmitted, cancelled or written off. Two candidates are an audited
`abandon` verb (to `error`, with an operator's reason, which knowingly reopens resubmission and
the duplicate risk this amendment closes) and a business process outside the log (a credit note
and a new document). Either one is a decision about money and the data model, so it needs an ADR
before it is built. No automatic reconciliation sweep is built either, so
`einvoice_transmission_open_idx`, which migration 0057 built for one, still has no reader. An
operator finds rows waiting on the authority through the list route's
`filter[status][eq]=submitted`, and each row's `attempts` and `polledAt` show how often and when it
was last asked.

**Also open, and recorded so they are not lost:**

- **`SELF_TRANSACTED` widens §4.2.9** (decision 2 above). It is proposed with this amendment and
  recorded in Plan Contracts as ⚠️; approving or reversing it is the owner's. Reversed, the cancel and
  poll routes would go back inside the request-spanning transaction and the pool deadlock with them,
  unless the call moves behind a job that runs after the commit — ADR 0020's other alternative — which
  would cost the operator poll its synchronous answer.
- **A transport fault after the authority received a submit still resends it.** This predates the
  amendment and is not changed by it. A timeout while the answer is being read, or a gateway's 504
  after the backend processed the request, is a `TransientTransmissionError` like a refused
  connection: the row keeps its submittable status with no external id, and pg-boss's retry POSTs the
  same document again. The transport cannot tell "aborted before the request was written" from
  "aborted while reading its answer", and a 504 looks the same whether or not the backend processed
  the request. Reconciling before the retry would need a lookup of the document at the authority by
  its own number, which no profile describes. Decision 3 already accepts a residual duplicate and
  defers to the authority's deduplication: ADR 0051 notes MyInvois answers a duplicate inside its
  window with 422 and `Retry-After`, and OD-15's verification should state that window and whether a
  lookup by document number exists. Not built.
- **Automatic polling can stop below `POLL_LIMIT` without the marker.** A poll job whose transient
  faults exhaust pg-boss's eight retries (nine deliveries, each claiming an attempt) fails
  permanently with `attempts` still under the limit, and no successor is scheduled. `JobEnvelope`
  carries no retry count, so the handler cannot tell its last delivery from any other. The row is
  `submitted` and reachable through the operator route and the list filter, and `last_error` names
  the transient fault; what it lacks is the marker that says automatic polling has stopped.
- **An operator poll answered with a clean `submitted` clears the marker.** `last_error` reports the
  last completed call, and that call was clean; `attempts` (on the wire) still shows the budget is
  spent. Keeping the marker would need the transmission log to know the worker's limit.
- ~~**A profile version bump strands rows recorded under the old version.**~~ **Resolved 2026-10-07**
  (amendment below, decision 4): the registry builds every shipped version of a code and the poll and
  cancel services resolve the row's pinned `profile_version`. What remains is operational: a version
  must keep shipping in the image while any `submitted` or `accepted` row is pinned to it — removing
  `<code>.v1.json` makes those rows `ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` naming version 1, by design.
- **A call whose claim was taken over leaves its outcome in a log line only** (amendment below,
  decision 2). Nothing of it reaches the row, so on a submit the authority may hold the document under
  an external id the row never records while the claim that took over sends it again; the stderr line
  (`transmissionId`, `verb`, `outcome` with the status, HTTP status and external id) is the only trace an
  operator can reconcile from. It needs a call that outlived 60 s of timeout plus the rest of a 120 s
  window — a stalled pool or a paused process — and it defers to the authority's deduplication, as
  decision 3 already does (OD-15).

## Amendment 2026-10-07 (proposed): a call ends only its own claim, inside the window, against the profile version it is pinned to

The third pass of PR 11's review found that the claim of decision 3 bounded a duplicate less tightly than
it said, and that the registry stranded a row the day a second profile version shipped. Each decision below
was taken while fixing them and is written up here afterwards, like the rest of this ADR's amendments; all
are **proposed** and the owner's to ratify or reverse. No migration, error code, `JOBS` name or ADR number
was taken.

**1. A call's deadline is at most half the claim window.** `claim()` admits another caller once
`claimed_at` is older than `CLAIM_WINDOW_SECONDS` (120), and one `AbortController` covers a call's token
fetch, its request and its single 401 retry; the profile schema admitted a `timeoutMs` of 120000, so a call
could still be running when the window lapsed. `packages/domain/einvoice-profile.schema.json` now caps
`timeoutMs` at **60000**, `parseProfile` and `loadProfile` refuse 60001, and
`packages/db/test/einvoice/profile.test.ts` pins `maximum <= CLAIM_WINDOW_SECONDS * 1000 / 2`, so the two
constants, which live in two packages, cannot drift apart. Every committed profile and default was already
inside the cap.

**2. A record ends only the claim its call took.** Every write that ends a call — the submit, poll and
cancel records and the fault path — matches `id` **and** `attempts = <claimed> and claimed_at = <claimed>`,
the values `claim()` wrote and returned; `claimed_at` is stamped at millisecond precision so that equality
can hold. Matched on `id` alone, a call that outlived the window wrote its outcome over the second caller's
and its `claimed_at = null` released the second claim mid-call, admitting a third. A record that matches no
row **writes nothing**, writes one JSON `error` line to stderr naming the transmission, the verb and the
outcome it could not record, and raises **`ERR_EINVOICE_STATUS_ILLEGAL` (409)** — the code `claim()`
already gives "another call holds this row" — rather than returning a row that is the other claim's. The
worker reads that code as a no-op on a submit and as "schedule the next poll" on a poll; the operator poll
and cancel routes answer 409 and their descriptions say so.

**3. The claim reads its row locked.** `claim()` takes `select … for no key update` on the row before it
reads it (noted in place in decision 3). A claim that read the row while another call was in flight and ran
its update after that call's record committed used to claim a row its read no longer described: a submit
resent a document the authority already held, and a second operator cancel overwrote the recorded
cancellation's answer. Locked, a record landing in that window waits for the claim's short transaction and
the claim refuses with the call-in-flight detail. It is the lock the claim's own update took anyway, so the
lock order is unchanged, and no lock is held across a call to the authority (spec:1368).

**4. A row is served by the profile version it is pinned to.** `registerDefaultTransmitters` builds
**every** `<code>.v<N>.json` of each code it registers, each version in its own never-throwing attempt, and
reports each version it skips. `transmitterFor(code, version?)` returns the named version, else the code's
**highest shipped** version — not the highest that happened to build — so a broken newest file refuses new
submissions (fail closed, ADR 0052) instead of sending them under an older version the authority may no
longer accept. Submit takes the highest; poll and cancel take the row's `profile_version` (a row never
submitted has none and takes the highest). A pinned version the registry lacks is
`ERR_EINVOICE_TRANSMITTER_UNAVAILABLE` naming it, raised inside the claim's fault path, so nothing is sent
and the claim is released. `RegisteredTransmitter` and §4.9.3's frozen `EInvoiceTransmitter` are unchanged.

**Residuals**, recorded under "Also open": a taken-over call's outcome survives only in its log line; and a
version must keep shipping while rows are pinned to it.
