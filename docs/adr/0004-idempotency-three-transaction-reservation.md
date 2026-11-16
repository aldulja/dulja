# ADR-0004 — Three-transaction idempotency

**Status:** accepted · **Date:** 2026-09-14 · **Slice:** 0B

> **Superseded in part by ADR 0020 — 2026-09-18.** Two things below no longer describe
> `apps/api/src/middleware/idempotency.ts`: this ADR's **title**, and the clause "**then execute the handler, then
> store its response**" read as three separate commits. There are now two transactions. The reservation still
> commits alone; the handler and the record of its response share one, with each downstream
> `context.var.withTenant` call joining it as a savepoint. The third transaction was the defect — a crash after
> the handler's own had committed left a mutation under `response_code null` for the 120-second reclaim to run a
> second time.
>
> **Everything else here stands**, and is still exactly what the middleware does: the reservation committing ahead
> of the handler so a concurrent duplicate is answered rather than queued, the distinction between a reused key,
> an in-flight request and a replay, the 120-second reclaim, and replay until purge. The status stays `accepted`;
> the title and the filename are left as the historical record of what 0B decided — plan 0B cites the filename in
> four places and calls the middleware "the three-transaction reservation" at plan0B:160, and that plan has not
> been amended. **§4.2.9 of the plan contracts had frozen the same three transactions**, and round 5 of its §4.18
> amends it in this PR.
>
> ADR 0020 was **ratified by the owner on 2026-09-18**, so this supersession is settled rather than pending. The
> note was written while 0020 was still a proposal and said the code diverged from the paragraph below whatever
> became of it; that remains true and is now moot. Reversing the decision would mean restoring the third
> transaction — and with it the crash window that motivated 0020 — not merely deleting this note.

Unsafe requests first commit a tenant-and-principal-scoped reservation, then execute the handler, then store its response. Concurrent duplicates can therefore distinguish a reused key, an in-flight request, and a replay. Reservations abandoned for 120 seconds can be reclaimed; completed results remain replayable until purged.
