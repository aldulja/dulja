# ADR 0093 — The till learns its API origin at build time, packaged-only, https-only

- Status: **proposed** (touches the till's sync trust path; spec:95)
- Date: 2026-11-15
- Amends: ADR 0055 (terminal identity and the terminal JWT), ADR 0057 (the till's local model)
- Findings: OPS-05 = PRD-02, OPS-09 (2026-11-15 full review)

## Context

`pos.exe` read the address of the API from `DULJA_API_BASE_URL` in the logged-in user's environment and fell
back to `http://127.0.0.1:3000` (`apps/desktop/src/main-pos.ts`). Nothing set that variable on a shop PC, so
an installed till enrolled against its own loopback and failed. The till has no settings screen, and a shop
operator cannot set an environment variable.

The address is also the trust root of everything a till sends. The enrolment code, every cashier PIN and
every signed ticket go to it. ADR 0055 makes the server trust the terminal key; nothing made the till trust
the server beyond "whatever the environment says". Any process running as the shop user can `setx` that
variable with no admin rights, which is exactly the hole `updater.ts` already refused for the update feed.

## Decision

1. **The origin is baked into the package.** `apps/desktop/scripts/write-pos-config.ts` runs before
   electron-builder in `dist:pos` and `dist:pos:dir`, writes `{ "apiBaseUrl": … }` from the build's
   `DULJA_API_BASE_URL` to `dist-config/pos-config.json`, and `electron-builder.pos.yml` ships it as
   `resources/pos-config.json`.
2. **A packaged till reads only that file.** `resolveApiOrigin(app.isPackaged, env, baked)`
   (`apps/desktop/src/api-origin.ts`) ignores `DULJA_API_BASE_URL` when packaged. A development run honours
   the variable, then the file, then `http://127.0.0.1:3000`.
3. **A packaged till requires `https:`.** A missing, malformed or non-https baked origin refuses startup with
   an error dialog naming the cause. There is no loopback exception.
4. **The release refuses to build without it.** `release.yml`'s fail-fast guard requires the repository
   variable `DULJA_API_BASE_URL` and refuses one that is not `https://`. A `preview` dispatch (never a tag)
   substitutes `https://api.invalid`, which can never resolve.

## Amendments

- **ADR 0055:** the till sends its enrolment request and every signed request only to the origin its
  package was built with, over https. Changing a till's server means installing a build for that server.
- **ADR 0057:** the till's configuration that is not cache (its server origin) lives in the package's
  `resources/`, not in the SQLite file and not in the environment.

## Consequences

- Same residual as the update feed: `nsis.perMachine: false` puts `resources/` under `%LOCALAPPDATA%`, which
  the same user can edit. This closes the persistent, invisible path (`HKCU\Environment`); the signature
  OD-18 owes is what makes the package itself trustworthy.
- One build per API origin. Staging and production tills are different builds.
- The smoke specs rewrite `resources/pos-config.json` to a local https stub for one launch and restore it,
  as `updater.spec.ts` does for `app-update.yml`.

## Owner questions

1. Should the till use the same repository variable as the back office (`VITE_API_BASE_URL`) instead of its
   own `DULJA_API_BASE_URL`? Separate today, so tills can use a different host.
