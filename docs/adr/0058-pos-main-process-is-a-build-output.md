# ADR 0058 — The POS main process is a build output of `apps/pos`, loaded by path

- Status: **proposed** (spec:95 — a decision touching security is written as a proposal and asked)
- Date: 2026-09-05
- Slice: 6B

## Context

spec:2389, verbatim: *"`api`, `worker`, `pos`, `backoffice` import from packages, never from each other.
`desktop` imports only build outputs."* The POS needs `better-sqlite3` and the Ed25519 device key, both of
which must live in the **Electron main process** — and the code that uses them is `apps/pos`'s.

Three readings are possible and two are wrong. `apps/desktop` importing `@dulja/pos` breaks *"desktop imports
only build outputs"*. `apps/pos` importing `apps/desktop` breaks *"never from each other"*. Moving the SQLite
code into `apps/desktop` puts the till's domain logic in the shell that ships two products and makes
`apps/pos` a renderer bundle with no tests of its own.

## Decision

`apps/pos` builds **two** outputs: `dist/` (the renderer bundle, Vite) and **`dist-main/pos-main.cjs`** (the
main-process bundle, `bun build --target node --format cjs --external better-sqlite3 --external electron`).
`apps/desktop/src/main-pos.ts` `require`s the second **by path** and calls its one export,
`registerPosHandlers(deps)`, passing `ipcMain`, the channel map, the database path, the API base URL, 0E's
`SecureStore` and a `print` callback — **as data**.

- Neither workspace imports the other. `apps/desktop`'s `dependency-rule` row is unchanged; `apps/pos`'s row
  lists six packages and no app.
- The channel *names* live in `apps/desktop/src/bridge-types.ts` beside 0E's `CHANNELS`, because the preload
  script needs them and the preload script is `apps/desktop`'s. They reach `apps/pos` as an argument, so the
  two ends cannot disagree about a name without the map being wrong in one place.
- `better-sqlite3` stays external to the bundle: it is a native module whose JavaScript `require`s a `.node`
  binary relative to its own package, and `asarUnpack` unpacks the package, not the bundle. 0E's
  `native-module.spec.ts` already proves that path works.

## Consequences

- A change to a bridge method is a change in two files — the interface and the channel map, both in
  `bridge-types.ts` — plus the handler in `apps/pos/src/main/register.ts`. `POS_CHANNELS`'s
  `satisfies Record<keyof DuljaPosBridge, string>` makes every `keyof DuljaPosBridge` carry a channel at
  typecheck, and `apps/desktop/test/pos-bridge.test.ts` asserts every channel is `dulja:pos:<kebab-case method>`
  and has a `handle("<method>"` in `register.ts` (and no handler lacks a channel), so a half-made change fails.
- `pos.exe` and `backoffice.exe` share one `apps/desktop`, one preload discipline and one updater, with two
  electron-builder configurations and two `extraResources` blocks (Task 10).
- The renderer never sees a path, a handle or a key. It sees fourteen functions (6B amendment A4 added the
  fourteenth; the count is pinned by `pos-bridge.test.ts`).

## What we are asking

Confirm that loading a workspace's build output by path from the Electron main process is acceptable — it is
the same trust boundary as `extraResources`, both halves are built from this repository in the same CI job,
and the alternative readings of spec:2389 are all worse.

## Proposal preparation

Prepared for owner review on 2026-10-07 from [2026-09-05-dulja-phase-6b-pos-application.md](../superpowers/plans/2026-09-05-dulja-phase-6b-pos-application.md). The source proposal date above is preserved. This record is proposed; no owner acceptance or implementation is recorded here.

## 6B packaging correction (2026-10-09)

The packaged build output is a file inside app.asar under pos-main, loaded through app.getAppPath(). The copied extraResources placement cannot resolve its external better-sqlite3 dependency from app.asar/node_modules. The native addon remains unpacked on disk. Use the existing N-API prebuild without an unnecessary MSVC rebuild; verify a database opened through the actual packaged composition root. This changes placement, not the build-output-only application boundary.

## PR 12 review amendment — error codes across the bridge (2026-10-22, proposed)

Electron's `contextBridge` copies a rejected `Error` into the page with its `message` only, so the `code` the
6B plan's `errorCode(error)` reads from the error object (T9 Step 7, T11 Step 2) never reaches the renderer of
a packaged till. The preload (`apps/desktop/src/preload-pos.ts`) therefore writes the code at the head of the
message as `ERR_…: detail`, and the renderer reads it back with `tillErrorCode`
(`apps/pos/src/renderer/lib/error-code.ts`). The renderer still shows only `t("pos.error.<code>")`, never the
detail, with the plan's catalogue of till codes and `ERR_INTERNAL` for anything else. `ERR_RATE_LIMITED`, the
registry's existing code, is now also raised by the till's PIN lockout (ADR 0060's PR 12 amendment).
`ERR_TERMINAL_ENROLMENT_INVALID`, 6A's refusal of an expired, used or unknown enrolment code, is passed through
from the server as its own code (2026-10-23), so the enrol screen says the code was not accepted, and to check
it before asking for a new one (the server answers alike for a mistyped, expired or used code, SAH-025), instead
of the general fault. Every other failure of the server call (`enrolDevice`), an unreachable server included,
stays `ERR_INTERNAL`; the till's own refusals before it (a code that is not 32 characters of A–Z and 2–7, an
enrolment already running, an open shift or unsent work) are `ERR_VALIDATION_FAILED`, as
`docs/runbooks/till-enrolment.md` says.
