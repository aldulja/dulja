# Runbook — verifying the back-office installer on a clean Windows VM (DoD 0.13)

**This runbook has not been executed.** No clean Windows VM is reachable from the session that wrote it
(0E Task 13) — every fact below that is stated as observed says where and when it was actually
observed, and every step that is only *expected* says so. Running it for real, on a real clean VM, is
still owner or QA work.

A clean VM means: a fresh Windows 11 image, never used for development, no Node, no Bun, no Visual
Studio redistributables beyond the base image, SmartScreen at its default setting.

## OD-18 — the one clause this runbook cannot close today

DoD 0.13 (spec:2323) has four clauses. Three do not need the certificate — §3 below names, for each, the
spec file that checks it and the launch it checks: two against the packaged artefact, and one (the token
clause) against the development tree only, whose packaged counterpart is a manual step in this runbook
that has not been executed. The fourth, "without an unsigned-publisher warning", needs a Windows OV/EV code-signing
certificate the owner has not yet supplied (OD-18; spec:92, 2323, 2401; contracts §3.11). Until it
exists:

- the artefact is unsigned, on purpose — `electron-builder.yml`'s `forceCodeSigning: false` says so
  explicitly, and `.github/workflows/release.yml` passes the owner's two frozen secret names
  (`WINDOWS_CODE_SIGN_CERT`, `WINDOWS_CODE_SIGN_PASSWORD`) straight through as electron-builder's own
  `CSC_LINK`/`CSC_KEY_PASSWORD`; absent, both are the empty string, and electron-builder's own Windows
  signing code treats an empty `CSC_LINK` exactly like a missing certificate — it does not error, it
  signs nothing;
- a SmartScreen "Windows protected your PC" / unknown-publisher dialog on first run is **expected**,
  not a defect, and step 7 says to record it rather than file it;
- two files change when the certificate lands, matching the plan's own framing that only this task's two
  files (this runbook and `electron-builder.yml`) are ever touched for OD-18 — one of them functionally,
  one editorially. `electron-builder.yml` changes functionally: `forceCodeSigning` flips from `false` to
  `true` in the same PR that supplies the two secrets, so a broken or rotated certificate fails the build
  instead of shipping quietly unsigned again — no new signing key needs adding there, since
  electron-builder already reads the certificate from the environment (see the comment above
  `forceCodeSigning` in that file). This runbook changes editorially: its "pending" rows above and in
  §2's table stop describing the current state and should be edited to describe the signed one instead.
  If the owner's certificate turns out to be HSM-bound (common for EV certs issued to a hardware token,
  with no exportable `.pfx`), `CSC_LINK` cannot carry it at all and `electron-builder.yml` would need a
  real addition — `win.signtoolOptions.certificateSubjectName` naming the certificate in the signing
  machine's own store — which is the one way "two files" turns out to be wrong; nothing here assumes
  which kind of certificate arrives.

```bash
gh secret list --repo <owner>/<repo> | grep -E "WINDOWS_CODE_SIGN_(CERT|PASSWORD)"
```

Run against this repository on 2026-09-17: **empty** — neither secret exists yet, confirmed live
(`gh secret list` and `gh variable list` both return nothing for `aldulja/aldulja` today, the same
pending state `docs/ui/od-24-users-and-roles.md` records for OD-24 and AGENTS.md records for OD-19–22).
What this section reproduces does not need those other, unrelated variables: `dist` in isolation,
against the two OD-18 secrets specifically, on a local rebuild — because that is the one step this
task's own workflow change touches, and it is what "absent → unsigned by design" needs to be true about:

```
CSC_LINK="" CSC_KEY_PASSWORD="" DULJA_UPDATE_FEED=<any URL> bun run --cwd apps/desktop dist
# → exit 0; dist-installer\dulja-backoffice-<version>-windows-x64.exe written
Get-AuthenticodeSignature ".\dulja-backoffice-<version>-windows-x64.exe" | Format-List Status
# → Status : NotSigned
```

Reproduced directly on this repository, off a clean rebuild, immediately before this runbook was
written — not on a clean VM (this build host has Bun, Node and a full checkout), but the empty-secret
behaviour it exercises is exactly what `release.yml`'s `dist` step sees when the two OD-18 secrets are
absent.

The build log names a "signing with signtool.exe" step for each `.exe` even in this state, which reads
like a contradiction until the source is read rather than guessed at: `app-builder-lib`'s
`signWindows()` (`codeSign/windowsCodeSign.js`) logs that line **unconditionally**, before it knows
whether a certificate exists at all, then calls into `WindowsSignToolManager.signFile()`
(`codeSign/windowsSignToolManager.js`), which resolves `cscInfo` from `CSC_LINK`/`CSC_KEY_PASSWORD`,
finds it `null` for an empty `CSC_LINK`, and — with no custom `sign` hook configured either — logs a
debug-level "no signing info identified, signing is skipped" and returns `false` **without invoking
`signtool.exe` at all**. So the log line names an intention electron-builder announces for every file
regardless of outcome, not a signature that was applied; `Get-AuthenticodeSignature` is the authority on
the outcome, and it reported `NotSigned` for all three signable files in the package (the app
executable, the uninstaller, and `resources\elevate.exe`).

**A separate gap, found by a reviewer building it rather than reading it, and now closed.** A real
`workflow_dispatch` run of `release.yml` on this repository does **not** fail at the backoffice-build
step the way an earlier draft of this section claimed — it was built and checked: with
`VITE_API_BASE_URL` and friends unset, `bun run --cwd apps/backoffice build` exits **0** and bakes the
empty string into the bundle, because Vite only substitutes `import.meta.env.VITE_*` at build time and
`apps/backoffice/src/lib/env.ts`'s `readEnv()` — the code that would actually reject an empty
`VITE_API_BASE_URL` — runs in the renderer at boot, not during the build. One step later, an empty
`DULJA_UPDATE_FEED` sails past both `app-builder-lib`'s `macroExpander.js` and `PublishManager.js`,
which both test `== null` and treat `""` as a real value, and ships `resources/app-update.yml` with
`url: ''` — an app that can never update itself. Neither is caught by `test:electron`: the posture specs
assert the *absence* of Node and CSP behaviour, never that the renderer actually rendered. So, before
this finding, the first real run of this workflow would have **succeeded** and uploaded a 126 MB
installer that white-screens with "Missing or invalid environment variables" on the very clean VM this
runbook sends someone to, and that could never update — silently, with nothing in CI to catch it.
`release.yml` now has a guard step, first in the job, that fails the run outright when any of
`VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `DULJA_UPDATE_FEED`, `DULJA_POS_UPDATE_FEED` or `DULJA_API_BASE_URL` is unset (the last must also be `https://`) —
so **today**, a real run fails immediately, with that list, rather than either of the two wrong
outcomes above.

Those six repository variables are the whole of what the guard covers. A `preview: true` dispatch (never a tag) replaces each unset one with an `.invalid` placeholder and says so in the run summary, so both installers can be built, installed and smoke-tested before the backend exists. The seventh value the build
bakes in, `VITE_SENTRY_DSN`, is a *secret* (`secrets.SENTRY_DSN`), and while OWNER GATE OD-22 is open
it is absent — deliberately, because a guard that required it would block every release. It reaches
the build as the empty string all the same (that is how GitHub renders an absent secret), and
`apps/backoffice/src/lib/env.ts` used to accept an absent DSN but refuse an empty one — so the same
white screen this section is about could have shipped straight past the guard the day OD-19–21 landed
before OD-22. That is closed at the boundary instead of in the guard (0E T13 review r2): `readEnv()`
now drops empty values before validating, so an unconfigured variable means unconfigured however the
environment spells it. Two tests in `apps/backoffice/test/shell.test.tsx`'s `readEnv` block pin the
strip itself — an empty optional variable is absent, an empty defaulted one takes its default — and
both were mutation-tested by removing the strip. A third asserts that an empty *required* variable is
still refused and named; it passes with or without the strip, and is there to pin that the fix cannot
let one through, not to pin the fix.

**Main-process Sentry is a separate matter, and is inert in any packaged build.**
`apps/desktop/src/main.ts` reads `SENTRY_DSN` and `APP_ENV` from the real process environment at
launch, on the end user's machine; nothing sets either there (an installed app starts from the Start
menu, not from a shell that exported them), and electron-builder bakes no build-time environment into
the app. So the main-process SDK sends nothing, and an event that did reach it would be labelled
`dev`. Do not file this from a clean VM: it is OD-22's to close, together with §5.0 row 0.14, and it
belongs to slice 0C rather than to this task. (The renderer is a separate mechanism and no further
along: `readEnv()` validates `VITE_SENTRY_DSN` into `AppEnvVars`, but `apps/backoffice` has no Sentry
SDK to hand it to yet — also OD-22's.)

## 1. Get the artefact

> **2026-11-15.** `release.yml` now builds both installers — `dulja-backoffice-<version>-windows-x64.exe` and
> `dulja-pos-<version>-windows-x64.exe`, with `.blockmap` and `latest.yml` — installs each silently (`/S`), runs the
> packaged smoke specs against the installed apps, and uploads them as the artefacts `backoffice-installer`
> and `pos-installer` (kept three days). The version is the tag's (`v1.2.3` → `1.2.3`); any other run is
> `<package.json version>-preview.<run number>`. Without the repository variables, dispatch it with
> `preview: true`. The paragraph below describes the state before that change. The POS has the same
> install path (`%LOCALAPPDATA%\Programs`, per-user) and its own runbook, `pos-till.md`.
>
> **2026-11-16.** A `v<semver>` tag (for example `v1.0.0`) also publishes a **GitHub Release** on the
> repository's Releases page, once both installers have been installed and smoke-tested: the two `.exe`
> files above plus `SHA256SUMS.txt`. That page is where a shop downloads Dulja; the workflow artefacts are
> the three-day hand-off. A tag with a prerelease part (`v1.0.0-rc.1`) is marked prerelease. Release:
> `git tag v1.0.0 && git push origin v1.0.0`.

Download `dulja-backoffice-<version>-windows-x64.exe` from the `release` workflow run (or copy the local
`apps/desktop/dist-installer/` build). **Neither exists for this repository today**: nobody has pushed a
`v[0-9]*` tag or run the workflow by hand, and if they did, the guard described above would stop it —
`vars.VITE_API_BASE_URL`, `vars.VITE_SUPABASE_URL`, `vars.VITE_SUPABASE_ANON_KEY` and
`vars.DULJA_UPDATE_FEED` are all unset (the same OD-19–22 gap `deploy-staging.yml` already carries). The
local build referenced above is the only artefact that exists, and it lives on this session's build
host, not a clean VM.

## 2. Check the signature before running anything

```powershell
Get-AuthenticodeSignature ".\dulja-backoffice-<version>-windows-x64.exe" | Format-List Status, SignerCertificate
```

| Result | Meaning |
|---|---|
| `Status : Valid` | OD-18 satisfied. Continue to step 4 and expect **no** publisher warning. |
| `Status : NotSigned` | OD-18 still pending — the state reproduced above. Continue; a SmartScreen "Windows protected your PC / Unknown publisher" dialog **is expected** and is not a defect. Record the screenshot in the PR. |

## 3. The three clauses that do not need the certificate

Proven in CI on every commit that runs the `desktop` job (`.github/workflows/ci.yml`): that job now runs
`electron-builder --win --dir` before `test:electron` (0E T13, after review) — the same unpacked payload
a full installer produces, without the NSIS script, LZMA compression or the 126 MB write, so both
packaged-build clauses below go green on every PR, not only when `.github/workflows/release.yml` does.
`release.yml` re-runs the same specs again after its own full `dist`, against the actual
signed-or-unsigned NSIS package rather than the `--dir` tree — belt-and-braces, not the only source of
this coverage anymore. For those two clauses a clean-VM session can cite the CI run for the same commit
instead of re-deriving anything by hand.

Two things it must not cite CI for:

- **the second row below, "token not readable from disk in plain text", is checked against the
  *development* tree, not the package.** `safe-storage.spec.ts:33` is
  `electron.launch({ args: [ROOT, …] })`, and `electron-fixtures.ts:8` defines `ROOT` as `apps/desktop`
  itself. It writes a real token through the bridge and encrypts it with this host's real DPAPI keyring,
  so it is strong evidence — but the shipped product is this row's whole subject, and the packaged
  counterpart is that row's own `Select-String` step, which is **Not executed** (§3's steps run only on a
  real VM; see §4). `posture.spec.ts`'s packaged case narrows the gap rather than closing it: a packaged
  build shipping no bridge at all would fail there.
- **the shipped-metadata guard runs in no CI job on either workflow.** (Still true: the `tests` workspace
  runs in `ci.yml`'s ubuntu `database` matrix, where `dist-installer/` is absent, not in `checks`.)
  `tests/regression/sah-087.test.ts`'s "— 0E" block — row 0.13's evidence that no build-machine absolute
  path reaches `latest.yml` or the installed `resources/app-update.yml` — is reachable only through
  the `tests` workspace, which runs in `ci.yml`'s ubuntu `database` matrix, and there `dist-installer/` does not exist,
  so both of its cases skip. `release.yml` produces both files and runs no `bun run test`. Running
  `bun run test` locally after a full `dist` is the only thing that executes it today; changing that
  means changing what a release run executes, which is the owner's decision.

| Clause | How it is actually checked | Manual check on the VM, if you want one anyway |
|---|---|---|
| renderer cannot reach Node | `apps/desktop/test/posture.spec.ts` asserts `typeof require/process/module/Buffer/__dirname === "undefined"` inside the renderer itself, plus that `window.dulja` carries neither `ipcRenderer` nor `require` — the negative space around the bridge, not its exact shape (its own comment points at `safe-storage.spec.ts` for the rigorous surface check, below) | Not "press `Ctrl+Shift+I` and see DevTools refuse to open" — an earlier draft of this runbook claimed that, and it was not confirmed here. This build never calls `Menu.setApplicationMenu`, so Electron's default menu is present with its own "Toggle Developer Tools" item bound to that accelerator (confirmed by reading `Menu.getApplicationMenu()` from inside the packaged app, 2026-09-17); whether the physical key combo actually opens it was not established (a synthetic keypress sent through Playwright did not, which shows only that a synthetic CDP keypress is not the same input path as a native menu accelerator, not that the real shortcut is blocked). It does not matter either way for this clause — `contextIsolation`/`nodeIntegration` are what close it, not the absence of a devtools panel — so there is nothing reliable to check by hand here beyond the CI job. |
| token not readable from disk in plain text | `apps/desktop/test/safe-storage.spec.ts` writes a real token through the bridge and asserts no file under the profile contains it as plain text, in utf8, latin1, utf16le or base64 — but from a **development-tree** launch (`args: [ROOT]`, `electron-fixtures.ts:8`), not the packaged artefact, so the manual check on the right is the only thing that says this about the shipped product, and it has not been run | Sign in, then `Select-String -Path "$env:APPDATA\Dulja Back Office\secure\*" -Pattern "<the refresh token>"` → **no matches**. The path is `%APPDATA%\Dulja Back Office\secure`, not a slugified variant — confirmed by launching the packaged `.exe` and reading `app.getPath("userData")` directly (2026-09-17; see the note on `app.setName` in `apps/desktop/src/main.ts` for why that call exists at all — without it this path came back `%APPDATA%\@dulja/desktop`, the raw npm workspace name, which Windows resolves as two nested folders because `/` is a path separator there too). `apps/desktop/test/posture.spec.ts`'s packaged case now also pins `app.getName()` itself, so a silent revert of that rename fails there before it ever reaches this path. Each token is one `<sha256-of-key>.bin` file, not a file named after the key. |
| `better-sqlite3` loads inside the packaged app | `apps/desktop/test/native-module.spec.ts`'s second case launches the installer's own `win-unpacked\Dulja Back Office.exe` and opens a real `:memory:` database from inside it | Nothing beyond CI — there is no user-facing action that exercises this; the app simply fails to start if it is broken. |

## 4. Install

Double-click. Choose a per-user installation (`electron-builder.yml`'s `nsis.perMachine: false`,
`oneClick: false`, `allowToChangeInstallationDirectory: true`). Expected: the installer completes, a
Start-menu entry "Dulja Back Office" exists, and the application window opens. **Not executed** in this
session — no clean VM, and this build host already has Node, Bun and a full checkout, so running the
installer here would prove nothing about a clean machine and is not offered as if it did.

## 5. The icon

The window, the Start-menu entry and the installer all currently show Electron's own default icon —
the build says so on every run ("default Electron icon is used  reason=application icon is not set").
This is **expected, not a defect**: no brand asset exists anywhere in this repository, no OD gate covers
one, and DoD 0.13 does not mention an icon. `apps/desktop/electron-builder.yml` records the decision and
the exact one-file change (`build/icon.ico` plus `directories.buildResources: build`) for whenever the
owner supplies branding. Do not file this as a clean-VM finding; it is already recorded here and there.

## 6. Uninstall

Settings → Apps → Dulja Back Office → Uninstall. Expected: the Start-menu entry disappears and
`%APPDATA%\Dulja Back Office` (the encrypted token store) is the residue — plus
`%LOCALAPPDATA%\dulja-back-office-updater`, electron-updater's own download cache, on any machine
where an update check has actually downloaded something. That second path is the
`updaterCacheDirName` electron-builder bakes into `resources\app-update.yml` at build time; its value
was read out of the packaged file directly (`updaterCacheDirName: dulja-back-office-updater`,
2026-09-17). **That reading is not reproducible on the current tree**: a later `dist:dir` overwrote
`win-unpacked/` without an `app-update.yml`, since `--dir` generates no publish metadata. A full
`bun run --cwd apps/desktop dist` regenerates the file and the check. The "appears once something has
been downloaded" half is electron-updater's documented behaviour and was not observed here — this
session's own `%LOCALAPPDATA%` has no such directory, having never run an update check. Neither path is removed on uninstall — read, not assumed:
app-builder-lib 26.15.3's own `templates/nsis/uninstaller.nsh` deletes app data only when the
uninstaller is passed `--delete-app-data` or was built with `DELETE_APP_DATA_ON_UNINSTALL` (which is
what `nsis.deleteAppDataOnUninstall` defines, and `electron-builder.yml`'s `nsis:` block does not set
it), and even then it removes only `$APPDATA\…` paths. `$LOCALAPPDATA` does not appear in that
template at all — only in `installer.nsh` and `multiUser.nsh` — so the updater cache survives an
uninstall however that option is set. A machine that ran a build from before the app-rename
fix (0E T13) carries a third path: an orphaned `%APPDATA%\@dulja\desktop\secure`, left behind because
the rename changed where new tokens are written without moving what was already there. That one is
harmless (DPAPI keys ciphertext to the Windows user, not to the path it happens to sit in, so the
orphaned blob decrypts to nothing useful and its only real consequence is signing in again) but real. A
clean VM never ran the old build, so it does not apply to the walkthrough above — recorded for whoever
upgrades an existing install instead of starting from a clean one. Not executed, for the same reason as
step 4.

## 7. Record

Attach to the PR: the `Get-AuthenticodeSignature` output, a screenshot of the first-run window in
**both** text directions (spec:2274), and — while OD-18 is pending — the SmartScreen dialog. A run of
this runbook that skips the SmartScreen screenshot has not actually shown the pending state; "it didn't
appear" is itself a finding worth recording, not an assumption to make in its absence.
