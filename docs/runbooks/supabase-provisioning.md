# Runbook — Supabase provisioning (spec §5.0 task 0.2; OWNER GATE OD-19)

**Region:** Singapore. **Projects:** `dulja-production` and `dulja-staging`, in the same organisation.
Nothing reaches production without passing through staging (spec:2272). Until the owner supplies organisation
access, the identical posture check runs against PostgreSQL 18 Testcontainers
(`packages/db/test/provision-verify.test.ts`).

## 1. Create the project

1. New project, region **Singapore (ap-southeast-1)**, on a plan that includes **Point-in-time recovery**.
2. Record the project ref. The direct connection string is `postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres`.
3. **Do not** copy the "Transaction pooler" string (port 6543) anywhere. §3.2.1 rejects it: `SET` does not survive a
   transaction-mode pool, and RLS, the audit chain and document numbering all depend on session-scoped state.
   `createDb()` throws `ERR_DB_POOLER_URL` if it ever sees `:6543`, and `provision:verify` scans the configs for it.

## 2. Create the three roles

Connect **as `postgres`** (the project's own superuser-equivalent; it is not a real superuser, which is why
`app_auth` is created with no attributes — plan0A Task 3) and run the repository's own script unchanged:

```bash
psql "postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" -f packages/db/provision/roles.sql
psql "postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
  -c "alter role app_migrator password '<migrator-pw>'" \
  -c "alter role app_rw password '<rw-pw>'"
```

Passwords are never in the repository. Store them in the Cloudflare secret store (§3.11) and in the owner's
password manager; nothing else needs them.

## 3. Apply the migrations

```bash
DATABASE_URL_MIGRATOR="postgres://app_migrator:<migrator-pw>@db.<ref>.supabase.co:5432/postgres" \
  bun run --cwd packages/db db:migrate
DATABASE_URL_MIGRATOR="…" bun run --cwd packages/db db:lint      # must print `schema lint: 0 violations`
```

## 4. Verify the posture — the acceptance check for §5.0 row 0.2

```bash
DATABASE_URL="postgres://app_rw:<rw-pw>@db.<ref>.supabase.co:5432/postgres" \
DATABASE_URL_MIGRATOR="postgres://app_migrator:<migrator-pw>@db.<ref>.supabase.co:5432/postgres" \
  bun run --cwd packages/db provision:verify
```

Expected output, exactly:

```
rls-forced: ok
bypassrls-probe: refused
app_auth-login: refused
pooler-url: absent
```

Any other line is a provisioning defect, not a test defect.

The `pooler-url` line scans the configuration files listed in `SCANNED_CONFIGS` **that exist** —
`infra/wrangler.jsonc`, `.github/workflows/deploy-staging.yml` and `.github/workflows/ci.yml`. If none of the three
exists the command exits 1 rather than printing a false pass.

## 5. Point-in-time recovery (LEGACY-081)

Enable **Point-in-time recovery** on the production project (Database → Backups → PITR). It requires billing,
which is the OD-19 half only the owner can supply.

- **RPO** (maximum acceptable data loss): **2 minutes** — the PITR write-ahead-log shipping interval.
- **RTO** (maximum acceptable time to restore): **4 hours** — restore to a fresh project, re-point `DATABASE_URL`
  and `DATABASE_URL_MIGRATOR`, re-run `db:migrate` (a no-op) and `APP_ENV=production bun run seed --tenant <id>` for
  each tenant, redeploy. **A seed run without `APP_ENV=production` is a dev seed and loads `SYNTH-MY-v1`'s invented
  tax codes into the restored companies** (`docs/runbooks/deploy.md`, step 6).

These two numbers are stated so the drill has something to fail against. **The drill itself is slice 1B**
(acceptance test 24) and is written up in `docs/runbooks/restore-drill.md`; this runbook only guarantees the
mechanism exists. Quarterly cadence, per spec:2233.

## 6. Staging

Repeat sections 1–4 for `dulja-staging`. PITR is not required there. Staging is seeded from the same
`APP_ENV=staging bun run seed --tenant <id>`, as its deploy workflow runs it (never from a production dump; an
anonymised snapshot arrives with Phase 9).

## 7. Auth: first passwords and recovery by e-mailed code (ADR 0096; PRD-01, OPS-08)

Nobody in Dulja is ever given a password. The seed creates the owner with none, `/admin/users` invites with
none, and the back office's sign-in screen offers **"First time here, or forgot your password?"**: the person
types their e-mail, Supabase e-mails them a one-time code, they type the code and choose a password, and then
enrol (or pass) two-factor authentication as after any sign-in. No e-mailed link is used: a link opens a browser
at the Site URL, and `backoffice.exe` lives at `dulja://app`, which no link reaches.

These are **go-live items for the owner** (OD-19/OD-21), on both projects, in Authentication → settings:

1. **Email provider on**, and **"Confirm email" on** (Providers → Email). Email OTP is part of this provider; no
   separate switch is needed.
2. **Custom SMTP** (Authentication → Emails → SMTP settings). Supabase's built-in sender is for testing and is
   limited to a few messages an hour; without SMTP the codes stop arriving after the first handful.
3. **Email OTP length and expiry** (Providers → Email): length **6** (the screen accepts 6–10 digits) and expiry
   **900** seconds (15 minutes). Shorter is safer; much shorter frustrates someone waiting for mail.
4. **Rate limits** (Authentication → Rate limits): keep the per-address minimum interval at **60 s** and set the
   e-mails-per-hour limit to what the SMTP account allows. A request over either limit shows "Too many
   requests. Wait a minute, then try again."
5. **The "Reset Password" template** (Authentication → Emails → Templates) must show the code. Replace the body
   with, for example:

   ```html
   <h2>Your Dulja code</h2>
   <p>Type this code into Dulja's sign-in screen, under "First time here, or forgot your password?":</p>
   <p style="font-size:24px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
   <p>It expires in 15 minutes. If you did not ask for it, ignore this e-mail.</p>
   ```

   Remove `{{ .ConfirmationURL }}` — a link in this e-mail leads nowhere useful.
6. **The "Invite user" template** must not ask the person to click a link. Replace the body with a sentence
   telling them to open Dulja and choose "First time here, or forgot your password?" on the sign-in screen.
   (The invite's own token is a different kind from the recovery code and is not used.)
7. **Password policy** (Providers → Email → Password requirements): minimum length **12** is recommended. A
   password the policy refuses shows "That password is too weak."
8. **MFA** (Authentication → Multi-Factor): TOTP enabled, as for the sign-in flow. The screen never lets the
   e-mailed code alone change the password of an account that has a verified factor: it asks for the
   authenticator's six digits first.

Check on staging before production: invite a test address from `/admin/users`, follow the e-mail's instruction,
receive the code, set a password, enrol TOTP, sign out, sign in with the new password and the authenticator.
Then use the same step as a forgotten password on that enrolled account and confirm it asks for the six digits.

Until this section is done the only way in is an engineer setting a password in the Supabase console.
