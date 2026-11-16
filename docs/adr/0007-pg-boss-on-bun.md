# ADR 0007 — pg-boss on Bun: schema, transactional enqueue, and the install step

- **Status:** Accepted; decision 5 amended 2026-09-28 (a remediation during 4B, below)
- **Date:** 2026-09-05
- **Slice:** 0D
- **Spec trigger:** §0.2 "Agent verifies and records an ADR — do not stop: … pg-boss on Bun"; §3.2.2 "Verify it runs clean on Bun during Phase 0".

## Context

Spec §3.2.2 chooses pg-boss because "a job is enqueued in the same transaction as the posting — the guarantee
LEGACY-005 lacked". Three facts had to be verified against the installed version rather than assumed: the option that
makes pg-boss run its INSERT on our transaction, the options that stop it migrating and point it at a schema, and
whether a queue must be declared before a job is sent. Contracts §4.2.6 fixes the wrapper's shape around them.

## Verified facts (from `node -p … pg-boss types` on 12.32.0)

| Fact | Verified name | Notes |
|---|---|---|
| Do not run pg-boss's own migrations at runtime | `migrate: false` (constructor) | `export interface MaintenanceOptions { supervise?: boolean; migrate?: boolean; createSchema?: boolean; }`; `ConstructorOptions extends … MaintenanceOptions` |
| Schema | `schema: "pgboss"` (constructor) | `export interface DatabaseOptions { … schema?: string; … }`; `ConstructorOptions extends DatabaseOptions` |
| Run the INSERT on my transaction | `send(name, data, { db: { executeSql(text, values) } })` | `ConnectionOptions` declares `db?: IDatabase`; `SendOptions = JobOptions & QueueOptions & ConnectionOptions`; `IDatabase` declares `executeSql(text: string, values?: unknown[]): Promise<{ rows: any[]; }>` |
| Queue must exist before send | `createQueue(name)` — required | `createQueue(name: string, options?: Omit<types.Queue, 'name'>): Promise<void>`; the installed manager rejects an absent queue with `Queue ${name} does not exist` |
| `singletonKey` collision window | `singletonSeconds` — required | pg-boss 12 does not deduplicate on `singletonKey` alone; the adapter uses the same 24-hour horizon as idempotency-key retention. **True of a `standard` queue only — see the amendment: on a `stately` queue the key alone deduplicates, and the slot is the defect** |
| Job table read by tests | `pgboss.job` | The installed construction plan declares `CREATE TABLE ${schema}.job (`; `schema` is `pgboss` |
| Version | 12.32.0 | the lockfile owns it; no version literal in any source file (spec §0.2) |

The relevant installed declaration lines, recorded verbatim for upgrade review, are:

```ts
export interface IDatabase {
    executeSql(text: string, values?: unknown[]): Promise<{
        rows: any[];
    }>;
}
schema?: string;
migrate?: boolean;
export interface ConnectionOptions {
    db?: IDatabase;
}
export type SendOptions = JobOptions & QueueOptions & ConnectionOptions;

send(name: string, data?: object | null, options?: types.SendOptions): Promise<string | null>;
createQueue(name: string, options?: Omit<types.Queue, 'name'>): Promise<void>;
```

The installed `StopOptions` contains `close?`, `graceful?`, and `timeout?`; it does not contain the older `wait?`
sample option. `stopBoss` therefore awaits `boss.stop({ graceful: false })` directly.

## Decision

1. Migration `0004_create_pgboss_schema.sql` creates schema `pgboss`, grants `usage` (never `create`) to `app_rw`,
   and sets default privileges so every table pg-boss later creates as `app_migrator` is DML-accessible to `app_rw`.
2. pg-boss's own DDL runs **once per environment** in the deploy step `bun run --cwd apps/worker jobs:install`,
   connected as `app_migrator` on `DATABASE_URL_MIGRATOR`. Application code never issues DDL (spec §0.2, LEGACY-053).
3. At runtime pg-boss is constructed with `{ schema: "pgboss", migrate: false }` on `DATABASE_URL` (`app_rw`).
4. `packages/db/src/jobs/enqueue.ts` is the **only** application file that calls `sql.unsafe` outside the migration
   runner (§0.2 "never build SQL by string concatenation" — this forwards pg-boss's own parameterised statement text
   with bound values and interpolates nothing). It is one of exactly three sanctioned homes for `unsafe`.
5. `enqueue` **throws** when pg-boss returns `null` (a `singletonKey` collision). A silently un-inserted job is
   exactly the LEGACY-005 failure mode — a job that never runs — so the wrapper fails loudly instead. **Amended
   2026-09-28:** for the two `stately` jobs a refused insert is a collapse into a job that has not started,
   which `enqueue` resolves with that job's id; it still throws (`JobNotInsertedError`) for every other
   non-insert.

## Consequences

- A single upgrade of pg-boss can invalidate rows 1–4 of the table above. The `jobs.test.ts` rollback test is the
  canary: it fails the moment the transactional-send option stops working.
- pg-boss is run under Bun in production (`apps/worker`) and under Node 24 in tests (Vitest, D5); both paths are
  exercised in CI.

## Amendment — 2026-09-28: two queues are `stately`, and a keyed job on them carries no throttle slot

**Found by 4B Task 4** (commit `9615460`): pairing every `singletonKey` with `singletonSeconds = 86400` does
not mean "at most one pending job per key". In pg-boss 12 (12.33.2 at this amendment,
`node_modules/.bun/pg-boss@12.33.2/node_modules/pg-boss/dist/plans.js`) `singletonSeconds` fills
`singleton_on` with the start of the current 24-hour slot (`insertJobs`, the `CASE WHEN "singletonSeconds"`
arm), and the throttle index is

```sql
CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, ''))
  WHERE state <> 'cancelled' AND singleton_on IS NOT NULL
```

so a job in **any** state but `cancelled` — `completed` included — holds its key's slot until the slot ends.
`send` is `INSERT … ON CONFLICT DO NOTHING` and returns `null`, and decision 5 turned that into a throw. The
consequences: 3B's `inventory.cost.replay` (enqueued by `postDocument` for every back-dated document, keyed
by company) failed the **second back-dated post of a company in a UTC day**, fail-closed but blocking
ordinary work; and 4B's step-14 `accounting.projection.rebuild`, which caught the throw as a collapse, ran at
most once a day per company, so `item_profitability` lagged the ledger until the 03:00 rebuild (ADR 0046).

**What the two jobs need** (contracts §4.2.6, ADR 0038): at most one *pending* job per `(name, company)`; a
request while one is queued and not started collapses into it, because the queued job reads committed state
when it runs; a request while one is **active** produces a new queued job, because the running job may have
read the state before this request changed it. pg-boss's `stately` policy is exactly that:

```sql
CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, ''))
  WHERE state <= 'active' AND policy = 'stately'
```

— one job per key in each of `created`, `retry` and `active` (the `job_state` enum orders
`created < retry < active < completed < cancelled < failed`). The claim (`fetchNextJob`) moves a `created` job
to `active` with an `UPDATE`, which `job_i3` refuses while the key already has an active job; `manager.fetch`
treats that 23505 as an empty fetch, and skips keys it already knows are active (`singletons_active`, refreshed
by the monitor), so a key never has two active jobs. A failed attempt is deleted and re-inserted as `retry`,
which `job_i3` also admits beside a queued job.

**Decided.**

1. `STATELY_JOBS = ["inventory.cost.replay", "accounting.projection.rebuild"]` and `queuePolicy(name)` live
   in `packages/db/src/jobs/enqueue.ts`. The deploy step creates every queue with
   `createQueue(name, { policy: queuePolicy(name) })` and **exits non-zero if an existing queue's policy
   differs**: `create_queue` is `INSERT … ON CONFLICT DO NOTHING` and `updateQueue` throws
   `queue policy cannot be changed after creation`, so a stale queue would otherwise stay `standard`
   silently. No environment has pg-boss installed yet (staging was never seeded, OD-19/OD-20), so no queue
   needs recreating; one that ever does must be drained and `deleteQueue`d first.
2. For those two jobs `enqueue` sends `singletonKey` **without** `singletonSeconds`, and requires the key —
   keyless, every tenant's job would share the `''` slot, and tenant B's request could collapse into tenant
   A's job.
3. When `stately` refuses the insert, `enqueue` **locks the key's `created` row `FOR SHARE` on the caller's
   transaction** and resolves with its id. The lock is what makes the collapse safe: without it a worker
   could claim the queued job before the caller commits, read state without the caller's writes, and
   nothing would come back for them — the LEGACY-005 failure again, one step removed. pg-boss claims with
   `FOR UPDATE OF j SKIP LOCKED`, so the locked job is skipped, never waited on, and concurrent posting
   transactions share the lock. Finding no `created` row (a worker claimed it in between) frees the slot, so
   the insert is retried, three times at most, and then `JobNotInsertedError` is thrown.
4. Every other keyed job keeps the 24-hour slot and the throw — 0D's behaviour, pinned by LEGACY-005's
   `accounting.period.month_end` case. No production caller sends one.

**Cost, recorded.** While a key's job is active, the claim of that key's queued job fails until the
monitor's `singletons_active` names the key (about one `monitorIntervalSeconds` plus one
`queueCacheIntervalSeconds`, 60 s each by default); a fetch that picks it in that window returns empty, so
other companies' jobs on the same queue can wait up to that long. Both jobs are background catch-up work.

**Proved by** `packages/db/test/jobs.test.ts` (the stately block: collapse while queued, a new job after
completion and while active, the lock held to commit and released on rollback, the keyless refusal, the
standard slot kept), `packages/db/test/costing/replay-queue.test.ts` (two back-dated posts in one day both
post and one replay recosts both; a post after it completed and one while it is active each get their own
replay) and `packages/db/test/ar-ap/item-profitability.test.ts` (step 14's rebuild), all against a real
pg-boss on PostgreSQL 18.


### Proposed Phase 5 extension — 2026-10-02

`accounting.tax.submit` also uses the stately policy described in decision 5. The submit and poll envelopes retain their existing shape. Polls deduplicate under `<transmissionId>:poll`; an active poll can queue its successor and duplicate queued polls collapse. Standard queue singleton windows suppress successors, so they cannot serve bounded polling. A real pg-boss regression proves active/queued behavior in `packages/db/test/jobs.test.ts`. This extension is implemented for review under the Phase 5 request and remains proposed pending acceptance; the earlier accepted decisions retain their status.
