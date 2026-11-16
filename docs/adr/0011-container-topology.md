# ADR 0011: Container topology as built — one image, two entrypoints, a health surface on the worker

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0C · **Supersedes:** none

## Context

spec §3.2.4 fixes the shape: two container classes from one image with different entrypoints; `api` is a singleton
Durable Object id `"api"` with `sleepAfter: "10m"` reached only through the edge Worker's container binding; `worker`
must not sleep while jobs are pending and is kept awake by a Cron Trigger pinging it every minute. Plan 0D built
`apps/worker/src/index.ts` as a pure poller with no listener, so there was nothing for the Cron Trigger to ping and
no way to observe "a scheduled job runs in `worker` while `api` is idle" (§5.0 row 0.5).

## Decision

1. **One `Dockerfile` at `infra/Dockerfile`, built from the repository root**, with a `deps` stage that installs from
   the committed lockfile and a `runtime` stage that copies `packages/`, `apps/api` and `apps/worker`. Bun installs
   workspace dependencies beside each workspace manifest, so the runtime stage copies those per-workspace
   `node_modules` directories from `deps` as well as the root one. No package version is written into the file
   beyond the base image tag (spec:104).
2. **`infra/entrypoint.sh` dispatches on `DULJA_ENTRYPOINT`** (`api` | `worker`; unset means `api`; anything else
   exits 2 naming the value). `exec` makes the process PID 1 so Cloudflare's SIGTERM reaches it.
3. **Both classes listen on 8080.** `api` because `readConfig()` defaults `PORT` to 8080 (Plan 0B); `worker` because
   this ADR adds `apps/worker/src/health.ts`, a `Bun.serve` answering `GET /healthz` with
   `{ status, jobs, startedAt }` and nothing else. It is not an API: it has no `/v1`, no auth and no database access.
4. **The image runs as a non-root user.** It reuses the base image's unprivileged `bun` account rather than
   installing operating-system packages solely to create an equivalent one.

## Consequences

- The Cron Trigger has a real target and `wrangler` can report container health.
- `apps/worker` gains a Bun-only test file, excluded from the Vitest run and executed with `bun test`.
- A third container class in future is one more `case` in the entrypoint and one more class in `wrangler.jsonc`;
  nothing else changes.
- The health response deliberately lists **registered** job names, not the closed `JOBS` registry, so a deploy that
  forgot to register a handler is visible from outside the container.

## Verified facts (from `@cloudflare/containers` 0.3.7, recorded 2026-09-16)

| Question | Answer as installed |
|---|---|
| Base class | `Container<Env>` exported from `@cloudflare/containers` |
| Listening-port field | `defaultPort` |
| Idle-timeout field | `sleepAfter` (a duration string, e.g. `"10m"`) |
| Container-scoped environment | `envVars` |
| Accessor | `getContainer(namespace, name)` |

**Values chosen.** `ApiContainer`: `defaultPort 8080`, `sleepAfter "10m"` (spec:1156), `max_instances 1`.
`WorkerContainer`: `defaultPort 8080`, `sleepAfter "24h"` — spec:1157 says "`sleepAfter` set long" and keeps the
container awake with a one-minute Cron Trigger; a 24-hour idle timeout means the container sleeps only if the
Cron Trigger has been broken for a whole day, which is an alarm rather than a normal state.

**No public ingress.** Neither class appears in `routes`; both are reached only through the `API` / `WORKER`
Durable Object bindings. That is spec:1156's answer to "how does the Worker authenticate to the container": it
does not need to, because nothing else can reach it — and the container still re-verifies every JWT (spec:1150).
