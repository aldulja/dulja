# Runbook — deploy (spec §5.0 row 0.5, §4.11 environments)

Nothing reaches production without passing through staging (spec:2272). Staging is deployed by
`.github/workflows/deploy-staging.yml`, which today runs on **`workflow_dispatch` only**: until OD-19–OD-22
supply its six secrets an automatic run on `main` would not skip but fail, because GitHub renders an unset
secret as the empty string and step 1 below exits 2 on it. The `push: branches: [main]` trigger returns in the
same change that adds the secrets, and the workflow's own header comment says so. Production is the same six
steps run by hand with `--env production` — `bun run --cwd apps/edge deploy --env production` in step 5,
`--env production` on every `wrangler secret put`, and `APP_ENV=production` on every seed command (step 6).

**`infra/wrangler.jsonc`'s top level is staging; production is its `env.production` block**, deployed as the
Worker `dulja-edge-production`. Wrangler does not inherit `containers`, `durable_objects`, `r2_buckets` or
`ratelimits` into an environment, so `env.production` repeats all four — production's own R2 buckets
(`dulja-attachments`, `dulja-update-feed`) and rate-limit namespace, never staging's (`dulja-staging-*`) — and
`infra/test/wrangler.test.ts` fails the build if any environment lacks one (OPS-02/API-04). Before the first
deploy of an environment, create its two buckets (`wrangler r2 bucket create <name>`). A dry run lists every
binding: `bun run --cwd apps/edge deploy --dry-run --env production` must show `env.API`, `env.WORKER`,
`env.UPDATE_FEED`, `env.ATTACHMENTS` and `env.RATE_LIMIT`; it builds the image, so it needs Docker.

## The order, and why it is this order

1. **`bun run --cwd packages/db db:migrate`** as `app_migrator`. Forward-only (spec:2057). Every migration in the
   repository is expand-only where it touches a live table (§3.4.7), so the running old code tolerates the new
   schema and there is no maintenance window (SAH-080, acceptance test 25).
2. **`bun run --cwd packages/db db:lint`** — zero violations, or stop. A schema that fails the linter must not
   reach a running environment.
3. **`bun run --cwd packages/db provision:verify`** — the four posture lines of §5.0 row 0.2.
4. **`bun run --cwd apps/worker jobs:install`** as `app_migrator` — pg-boss's own tables and queues (§4.2.6).
   Idempotent; safe on every deploy.
5. **`bun run --cwd apps/edge deploy`** — the Worker and both container classes from one image.
6. **`APP_ENV=<env> bun run seed --tenant <id>`** — re-applies the seed pack. Idempotent by construction (§3.4.8); a
   phase that added a sub-pack gets it applied here. **In production it is `APP_ENV=production bun run seed --tenant <id>`.**
   The seed is an offline CLI run as `app_migrator`: it never reads the container's `APP_ENV` (`infra/wrangler.jsonc`),
   an unset one is `dev` (the CLI prints a warning saying so), and only `production` keeps the synthetic tax regime
   out of a real company (Phase 5, below). Staging's workflow sets `APP_ENV: staging` on its seed step.

## Runtime image

`infra/Dockerfile` builds the one image both container classes run (`infra/entrypoint.sh` picks `api` or `worker`
from `DULJA_ENTRYPOINT`). Besides the two entrypoints' source and production dependencies it carries, since
2026-11-15, what printing needs (ADR 0016, OD-20):

- **Debian's `chromium`**, named by `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`, set in the image. Both engines read
  that name — `apps/api` for documents and payslips, `apps/worker` for report PDFs — so a deployment need not bind it;
  one that does must point it at a browser present in the image.
- **`fonts-noto-core`**, whose Noto Naskh Arabic, Noto Sans Arabic and Noto Kufi Arabic cover RTL documents, and
  **`fontconfig`**, which builds the font cache at image build time. `fontconfig-config` also brings DejaVu Sans, its
  default font. In the first CI run (2026-11-15: Debian 13 base, Chromium 156) Arabic printed in Noto Kufi Arabic and
Latin in Noto Sans.

The image is not proven by the build container (its proxy blocks the Debian mirror). CI's `image` job proves it on
every pull request: it builds the image, runs `jobs:install` from it, boots both entrypoints against Postgres 18
until each answers `/healthz`, and prints an English and an Arabic PDF through each entrypoint's engine inside the
image (`infra/test/image/render-probe.ts`), then checks the bytes, every label in the extracted text and, for
Arabic, an embedded Arabic-capable face (`infra/test/image/check-pdfs.sh`). A new Debian `chromium` is a new image:
the base image is digest-pinned and Renovate proposes its updates, but the apt layer takes the mirror's current
`chromium` at build time, so rebuild for a Chromium security release.

**The Chromium sandbox is off today, and turning it on is an owner decision.** The image runs as the non-root `bun`
user and adds no sandbox switch of its own. But Playwright passes `--no-sandbox` to every Chromium it launches unless
the launch sets `chromiumSandbox: true`, and neither engine sets it (`apps/api/src/print/engines/chromium.ts`,
`apps/worker/src/reports/engines/chromium.ts` — their comment that the sandbox "stays ON" except as root is wrong).
What contains a render instead is the engines' own posture: scripts off, every network request aborted, one
browser context per render, and a non-root process. Turning the sandbox on needs two things: the engines launching
with `chromiumSandbox: true`, and a container runtime that lets an unprivileged process create user namespaces —
the image carries no setuid helper, so without them Chromium refuses to start ("No usable sandbox!"). The `image`
job's informational last step measures it on every run (run summary); the first run found: no helper, refused under
Docker's default seccomp profile, starts with `--security-opt seccomp=unconfined`. Whether Cloudflare Containers
permit user namespaces is unverified. Debian's optional `chromium-sandbox` package (a setuid helper) is the other
route, at the cost of a setuid-root binary in the image.
The fallback, if the platform cannot allow it, is the posture above with `--no-sandbox` recorded in an ADR.

## Rollback

`wrangler rollback --config infra/wrangler.jsonc` returns the Worker and both containers to the previous version.
**Do not roll back the database.** Production is forward-only; `down` exists for CI and local development only
(§3.4.1). If a migration is wrong, the remedy is a new migration, exactly as the remedy for a wrong ledger entry
is a reversing entry.

## Secrets

The inventory is contracts §3.11. Cloudflare secret bindings for the container
(`wrangler secret put <NAME> --config infra/wrangler.jsonc`); GitHub environment secrets for CI. Never a committed
`.env`, never a value in `infra/wrangler.jsonc` — `infra/test/wrangler.test.ts` fails the build if one appears.
`SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL_MIGRATOR` exist in CI only and are never container bindings.

The container's secrets are set once per environment, not per deploy. The API container's `readConfig()`
exits 2 at boot without `DATABASE_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL` or `TERMINAL_JWT_SIGNING_KEY`,
and outside `dev` without the four `R2_*` names or `HR_FIELD_ENCRYPTION_KEY` — the crash-at-boot a deploy must not discover after the Worker
is live. `apps/api/test/config-and-auth.test.ts` boots `readConfig()` on exactly the names this block binds, and
`apps/edge/test/containers.test.ts` proves the edge forwards each of them, so a name `readConfig()` starts
requiring without a line here fails CI rather than staging:

```bash
for name in DATABASE_URL SUPABASE_URL SUPABASE_JWT_ISSUER SUPABASE_JWKS_URL SENTRY_DSN OTEL_EXPORTER_OTLP_ENDPOINT \
            R2_ACCOUNT_ID R2_ATTACHMENTS_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  wrangler secret put "$name" --config infra/wrangler.jsonc
done
# 6A — the HS256 key the API signs terminal JWTs with (ADR 0055). Generated here, never issued by a provider and
# never written down; readConfig() refuses one shorter than 32 characters. API container only.
openssl rand -base64 48 | tr -d '\n' | wrangler secret put TERMINAL_JWT_SIGNING_KEY --config infra/wrangler.jsonc
# 8A — the HR field-encryption key (ADR 0071): base64 of exactly 32 bytes, which readConfig() checks by name.
# Both containers. Generated here and kept in the deployment's secret store; a lost key is lost HR identity data.
openssl rand -base64 32 | tr -d '\n' | wrangler secret put HR_FIELD_ENCRYPTION_KEY --config infra/wrangler.jsonc
```

`HR_FIELD_ENCRYPTION_KEY` is **never** rotated by re-running its command: every `employee_sensitive` column is
sealed under it, and a replaced key makes them unreadable. Rotation binds the old key as
`HR_FIELD_ENCRYPTION_KEY_PREVIOUS` first, raises `HR_FIELD_ENCRYPTION_KEY_VERSION` (optional, default `1`) by one,
and re-seals through 8D's `hr.encryption_key.rotate` job — `docs/runbooks/hr-key-rotation.md` (ADRs 0071, 0080).

`LEGACY_ODBC_DSN` (9B, contracts §3.11 round 20 C10) is bound only for a cut-over, and only the **worker** container
receives it (`apps/edge/src/container-env.ts`): `wrangler secret put LEGACY_ODBC_DSN --config infra/wrangler.jsonc`
with the read-only connection string to the frozen legacy database, before `POST /v1/companies/{companyId}/imports`;
`wrangler secret delete LEGACY_ODBC_DSN` once the load is signed off. Unbound, an import run fails
`ERR_IMPORT_SOURCE_UNREADABLE` naming the variable. **`LEGACY_IMPORT_TARGET=<tenant_id>:<company_id>` is bound and
deleted with it** (9B review, finding 1; round 20 C19), to the worker alone: the DSN is process-wide and the worker
serves every tenant, so the binding names the one company that source may be loaded into, and every other run — or
every run, while it is unset — fails `ERR_IMPORT_SOURCE_NOT_BOUND` before the source is opened. The runtime image carries neither the built `odbc` binding nor
the Firebird ODBC driver yet (OD-17), so a deployed worker cannot read the source until those are added.

Rotating `TERMINAL_JWT_SIGNING_KEY` is the same `openssl rand -base64 48` command. It ends only the outstanding 15-minute terminal
tokens: a till signs every call with its own device key, so no till re-enrols. `EINVOICE_CLIENT_SECRET` is
bound the same way, and only when an authority transmitter is enabled (Phase 5, below).

The GitHub environment `staging` holds what the workflow needs:

| Name | Kind | Holder | Why here and not in the container |
|---|---|---|---|
| `DATABASE_URL` | secret | api, worker | also used by `provision:verify` |
| `DATABASE_URL_MIGRATOR` | secret | CI only | DDL and the seed; **never** a container binding |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | secret | seed CLI only | the admin invite; never in the image (§3.11) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | secret | CI only | OD-20 |
| `STAGING_TENANT_ID` | variable | CI | the tenant id minted once by the first `APP_ENV=staging bun run seed --tenant <id>` |
| `STAGING_BASE_URL` | variable | CI | the deployed API origin, e.g. `https://api.<domain>`; the smoke check and the exit gate both read it, so they follow the domain instead of being edited after it |

Both variables are checked before the first migration, by the workflow's own first step. Unset, GitHub renders
a variable as the empty string rather than as absent, so neither stops a run early — they fail late. The seed
CLI rejects an empty `--tenant` cleanly (`packages/db/src/seed/config.ts:67`), but at step 6, with everything
above it already applied to staging; an empty `STAGING_BASE_URL` fails the smoke check at step 7, after the
deploy, and it is the one value that could make the exit gate skip every case and pass.

## CORS and request-body ceilings

`backoffice.exe` runs at the origin `dulja://app` and calls the API host cross-origin; the edge answers its CORS
preflight and grants that one origin, exactly, on every response (`apps/edge/src/cors.ts`, ADR 0092). Nothing
in the deployment configures it: a new origin is a code change. Request bodies are capped at the edge (and again
in the API) — 1 MiB by default, 27 MiB for attachment uploads, 16 MiB for bank-statement imports, 8 MiB for the
till's sync surface — and a larger one is refused `413 ERR_PAYLOAD_TOO_LARGE`. A smoke test after deploy:

```bash
curl -s -o /dev/null -w '%{http_code} ' -X OPTIONS "$BASE_URL/v1/staff-context" \
  -H 'Origin: dulja://app' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization'
# expect: 204, with Access-Control-Allow-Origin: dulja://app (add -D - to see the headers)
```

## Renovate

`infra/renovate.json`; the owner points the Renovate GitHub app at that path (Repository settings →
`configFileNames: ["infra/renovate.json"]`). Patch updates automerge; `postgres`, `pg-boss` and `decimal.js`
never do.

## The domain, and the one update-feed URL

`dulja.example` is a placeholder until OD-20. A previous revision of this section said it appears in
`infra/wrangler.jsonc`, in this file, and in 0E's update-feed URL "and nowhere else"; that was false, and one of
the omissions was a test. **Re-derived by `git grep dulja.example` on 2026-09-17, the set is four places, two of
them load-bearing code:**

| Where | What changes at OD-20 |
|---|---|
| `infra/wrangler.jsonc` (2 lines) | `routes[].pattern` and `zone_name`: staging's `api-staging.dulja.example` in the top-level block, production's `api.dulja.example` under `env.production` |
| `infra/test/wrangler.test.ts` (1 line) | asserts production's pattern verbatim (and that every environment's host is distinct), so it fails until it is changed with it |
| this file | the `/updates/` URL below and the `test:staging` example at the end |
| the `DULJA_UPDATE_FEED` repository variable | 0E's update-feed URL — a GitHub variable, not a file; `release.yml` reads it |

**`.github/workflows/deploy-staging.yml` is deliberately not on that list.** It used to hard-code the domain
three times; it now reads `vars.STAGING_BASE_URL`, so a deploy follows the domain rather than having to be
edited after it. The frozen plan `docs/superpowers/plans/2026-09-05-dulja-phase-0c-cloud-seed-observability.md`
carries the same "exactly three places" claim at `:1800` and `:2367`. It is wrong there too and is left alone.

**One hostname per environment, one feed path.** Staging and production each have their own host — both
placeholders until OD-20 — and never share one, so neither Worker can take the other's traffic (OPS-02). Each
Worker is routed on its own host only. The electron-builder feed is a
**path under that host**, not a second hostname, because `apps/edge/src/router.ts` keys the R2 object on the
`/updates/` path prefix (`serveUpdate` strips exactly that prefix). The URL 0E's auto-updater is configured with
is production's host, verbatim and with the trailing slash:

```
https://api.dulja.example/updates/
```

`https://updates.dulja.example/latest.yml` would arrive with pathname `/latest.yml`, match neither `/v1/`,
`/healthz` nor `/updates/`, and return 404 — which is why `infra/test/wrangler.test.ts` asserts that no
`updates.` route exists.

## The Phase 0 exit gate

Phase 0 exits when every §5.0 row is green **and** acceptance tests 11, 12, 13, 14 and 27 pass in CI, plus the
catalogue-integrity, incompatible-pair, auditor-read-only, expired-assignment and one-query assertions of test 36
against the Phase 0 catalogue (contracts §2.1). Where each runs:

| Test | Where it runs on every PR | Where it runs against staging |
|---|---|---|
| 11 no auth bypass | `tests/invariants/auth-bypass.test.ts` (0B) | — |
| 12 tenant isolation | `tests/invariants/tenant-isolation.test.ts` (0B) | `tests/staging/phase-0-exit.test.ts` |
| 13 audit completeness | `packages/db/test/audit.test.ts` (0A), 0B's API paths | `tests/staging/phase-0-exit.test.ts` |
| 14 permission query | `packages/db/test/roles-seed.test.ts` (0D), on 0A's one-query form | `tests/staging/phase-0-exit.test.ts` — "who can manage users in company X" against the seeded tenant, answered by one `principal ⋈ role_assignment ⋈ role_permission` statement |
| 27 no SQL text across the API | `scripts/lint/rules/no-sql-concat.ts` (0B) | — |
| 36 catalogue clauses | 0D Task 15 | the nine seeded roles are asserted in the staging suite |

`bun run test:staging` runs the staging suite from the repository root against any deployed environment; with
`STAGING_BASE_URL`, `DATABASE_URL` or `DATABASE_URL_MIGRATOR` unset every case skips, so the developer loop
never needs the cloud. `STAGING_TENANT_ID` is **not** one of those three: two cases assert it by name and fail
if it is missing, because a fourth variable in the skip condition would let the exit gate pass having asserted
nothing. It is **not** part of `bun run test`: `tests/vitest.config.ts` collects `invariants/`, `regression/`,
`golden/` and `lint/` only.

In CI it is the `staging-gate` job of `.github/workflows/deploy-staging.yml`, which `needs` the `deploy` job, so it
always checks the environment that deploy has just produced. Once OD-19 and OD-20 have landed:

```bash
STAGING_BASE_URL=https://api-staging.dulja.example STAGING_TENANT_ID=<id> \
DATABASE_URL=… DATABASE_URL_MIGRATOR=… bun run test:staging      # expect: 7 passed
```

That output is the evidence for the Phase 0 exit gate; attach it to the PR.


## Phase 5 deployment checks

After migrations, reseed each company in this order: `--only chart-of-accounts`, `--only document-types`, `--only roles`, then `--only tax`. Each command is `APP_ENV=<env> bun run seed --tenant <id> --only <sub-pack>`; in production every one of them is `APP_ENV=production bun run seed --tenant <id> --only <sub-pack>`. Existing documents retain their pinned policy version. The new tax chart must exist before loading its tax codes. The seed reads `APP_ENV` from its own environment, never the container's (unset is `dev`, and the CLI warns that it is; an unknown value exits 2): with `APP_ENV=production`, `--only tax` skips the synthetic `SYNTH-MY-v1` regime, reports it under `skipped` in its printed result and applies 0 tax rows; staging loads it. **A production seed run without `APP_ENV=production` is a dev seed and loads `SYNTH-MY-v1`'s invented codes into the company** — check its output for the warning and for the `skipped` entry before going on.

Run `jobs:install` to install/update the tax submit queue's stately policy. A standard queue would suppress the next poll. Before enabling a verified authority transmitter, resolve OD-15 and accepted ADRs 0049/0051, set `EINVOICE_CLIENT_SECRET` using the Cloudflare secret binding, and run `bun run --cwd packages/db einvoice:verify --transmitter myinvois` in the target container environment. That command currently reports the authority profile as unavailable. Leave company settings disabled until verified integration exists. Synthetic profiles run only in development and staging.

Phase 5 has not been deployed or reseeded on staging during local implementation; OD-19–OD-21 remain outstanding.

## Phase 6 deployment checks

Before the first deploy of an image that carries Phase 6, bind `TERMINAL_JWT_SIGNING_KEY` in that environment
(Secrets, above). Without it the API container stops at boot with `ConfigError` (exit 2) and the smoke check's
`/healthz` fails after the Worker has already deployed. The worker container never receives it. Enrolling a till
afterwards is `docs/runbooks/till-enrolment.md`.

The Worker forwards `/v1/sync/*` without its Supabase token pre-check, because a till carries a device signature
or a terminal token and never a session; it still rate-limits those calls, and the API authenticates each one.
A till whose enrolment or sync answers 401 `ERR_AUTH_TOKEN_INVALID` ("The bearer token is missing.") is talking
to a Worker deployed before that rule (`apps/edge/src/router.ts`); redeploy the Worker.

## Phase 8 deployment checks

8B adds a chart file (`chart-of-accounts/8b-payroll.json`, the §4.15 payroll accounts) and the `PAYROLL`
document type, both applied by the existing sub-packs. After the reseed above (`--only chart-of-accounts`, then
`--only document-types`, then `--only roles`, which now carries the four `hr.payroll.*` grants), wire each company's
pay components and statutory schemes to those accounts — **this step is not optional**, because nothing in the chart
loader sets `pay_component.expense_account_id` or the two `statutory_scheme` account columns, and a `PAYROLL` post
against null accounts fails with `ERR_POLICY_REQUIRES_MISSING`:

```bash
DATABASE_URL=… bun run --cwd packages/db seed:payroll-accounts --tenant <id> --company <id>
```

It runs as the tenant's system principal, never overwrites an account a company already chose, and prints how many
components and schemes it linked. Exit 2 is a missing flag or `DATABASE_URL`; exit 1 names the account code (or the
`scheme:<CODE>` with no §4.15 accounts) it could not resolve — apply the chart first and run it again.
