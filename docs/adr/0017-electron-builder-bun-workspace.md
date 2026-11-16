# 0017 — electron-builder from a Bun workspace, and `better-sqlite3` against Electron's ABI

**Status:** accepted · **Date:** 2026-09-17 · **Slice:** 0E
**Spec:** §5.0 task 0.13 (spec:2323) — "⚠️ Verify here and record an ADR"; D2, D5.

## Context

spec:2323 names two risks and demands they be settled in Phase 0: electron-builder resolving
dependencies from a **Bun** workspace, and `better-sqlite3` rebuilt against **Electron's Node ABI**
(`@electron/rebuild`). "If either fails, `apps/desktop` keeps its own npm lockfile."

## What was verified

Windows 11 (10.0.26200), Bun 1.4.2, Node 24.9.0, Electron 44.4.1, electron-builder 26.15.3,
`better-sqlite3` 13.0.3, `@electron/rebuild` 4.2.0. **No Visual Studio and no MSVC on the machine** —
which turned out to be the interesting variable, and is the condition every finding below was observed
under.

| Risk | Outcome | Evidence |
|---|---|---|
| electron-builder from the Bun workspace | **works** — no npm lockfile | `bun run --cwd apps/desktop dist` produced `dist-installer/Dulja Back Office Setup 0.1.0.exe`, `latest.yml`, `.blockmap` and `win-unpacked/` |
| `better-sqlite3` inside the packaged app | **works** — and needs no rebuild at all | `apps/desktop/test/native-module.spec.ts`, whose second case launches `dist-installer/win-unpacked/Dulja Back Office.exe`, asserts `app.isPackaged`, and opens `:memory:` |
| the same, on a machine with no C++ toolchain | **works** — nothing is compiled anywhere | the whole table was produced on a host with no Visual Studio and no `cl.exe` |

**electron-builder and Bun.** electron-builder detects Bun by itself and does not need a package
manager CLI to walk the tree:

```
• packageManager not detected by file, falling back to environment detection  resolvedPackageManager=bun
• detected workspace root for project using packageManager field  pm=bun config=bun@1.4.2 resolved=<repo root>
• searching for node modules  pm=bun searchDir=<repo>/apps/desktop
• note: bun does not support any CLI for dependency tree extraction, utilizing file traversal collector instead
• using manual traversal of node_modules to build dependency tree
```

The traversal follows Bun's symlinks out of `node_modules/.bun/` correctly: all three runtime
dependencies (`@sentry/electron`, `better-sqlite3`, `electron-updater`) are in the package. **The
spec:2323 fallback is therefore not taken** — `apps/desktop` has no `package-lock.json`, and Bun still
owns every workspace in the monorepo.

**`better-sqlite3` and Electron's ABI.** The premise of the risk no longer holds for this version.
`better-sqlite3@13.0.3` ships **N-API** binaries inside its npm tarball — `prebuilds/win32-x64.node`
among eight — compiled against `NAPI_VERSION=10`, and Electron 44.4.1 reports
`process.versions.napi === "10"`. Node-API is ABI-stable across runtimes by definition, so there is
nothing to rebuild: the binary that ships is already the right one. `lib/binding.js` prefers
`prebuilds/<platform>-<arch>.node` over `build/Release/`, and `binding.gyp` sets both targets to
`type: none` when `lib/binding.js` reports a prebuild for the host — the package is explicitly built so
that a rebuild is a no-op.

**`npmRebuild` is therefore `false`.** Left at `true` the build fails here, because
`@electron/rebuild` reaches node-gyp, and node-gyp's Windows **`configure`** step demands MSVC *before*
anything evaluates `prebuild_exists`:

```
• executing @electron/rebuild  electronVersion=44.4.1 arch=x64 buildFromSource=false
• preparing       moduleName=better-sqlite3 arch=x64
⨯ Error: Could not find any Visual Studio installation to use
⨯ node-gyp failed to rebuild '<repo>/node_modules/.bun/better-sqlite3@13.0.3/node_modules/better-sqlite3'
```

The explicit escape hatch spec:2323 offers (`bunx @electron/rebuild -f -w better-sqlite3 -m apps/desktop`)
would fail for the same reason and, on a machine that *does* have MSVC, would spend minutes compiling
SQLite to produce a binary indistinguishable in behaviour from the shipped one. It is not used.

**A Bun install hazard found on the way, and fixed.** `bun install` runs npm's implicit
`node-gyp rebuild` for any package that has a `binding.gyp` and no `install` script — which
`better-sqlite3` is. On a machine without MSVC that fails, and **Bun then drops the package silently**:
`bun install` prints no error, reports "Checked 777 installs … (no changes)", and leaves
`apps/desktop/node_modules/better-sqlite3` as a **dangling symlink** into a store entry that holds only
the dependency link. Nothing in the repository resolves `better-sqlite3` at that point, and nothing says
so. The fix is an explicit `trustedDependencies` allowlist in the root `package.json`. Naming any list
replaces Bun's default trust list, so the implicit compile no longer runs, the shipped prebuild is
used, and the install is identical on a machine with or without a C++ toolchain. The list is exactly
**Bun's own default trust list intersected with `bun.lock`, minus `better-sqlite3`** — `bun pm
default-trusted` against the lockfile gives `better-sqlite3, cpu-features, electron,
electron-winstaller, esbuild, sharp, ssh2, workerd`, and the seven that remain are what is declared.
Chosen that way so nothing else changes behaviour in either direction: no package that used to run its
lifecycle script stops, and none that was blocked starts.

## Decision

1. `apps/desktop` builds with electron-builder from the Bun workspace, **`npmRebuild: false`**, and
   `asarUnpack` for `better-sqlite3`, so the native binary lives on disk beside `app.asar` rather than
   inside it — where a signing step (OD-18) and endpoint security can reach it. That line is currently
   **redundant and kept deliberately**: a build with the pattern changed to match nothing still placed
   all 66 of the package's files in `app.asar.unpacked`, because electron-builder's own smart-unpack
   detects `.node` files by itself. The arrangement is therefore asserted on the artefact, in
   `native-module.spec.ts`, rather than inferred from either mechanism. (Whether Electron *can* load a
   `.node` from inside an asar was not established — no build this ADR made ever produced one.)
2. The renderer arrives as `extraResources` from `apps/backoffice/dist` — **build output, not a
   dependency** — which is how spec:2389's "`desktop` imports only build outputs" is held mechanically.
   `RENDERER_DIR` in `main.ts` switches on `app.isPackaged` between `process.resourcesPath/renderer`
   and the development tree.
3. **The fallback is not taken.** `apps/desktop` carries no `package-lock.json` and CI runs no `npm ci`.
   If a future dependency does need a real compile, the same table must be re-verified before that
   fallback is adopted — and note that `npm ci` would trigger the identical implicit `node-gyp` step,
   so the lockfile alone would not be the fix.
4. The root `package.json` declares `trustedDependencies` for the reason above. Adding a dependency
   that genuinely needs a lifecycle script means adding it here — Bun's defaults no longer apply once
   the field exists, so a new package's `postinstall` is blocked until it is named. **`bun pm
   untrusted` will not tell you.** It lists packages with *declared* scripts, and reports `0` for this
   repository precisely because `better-sqlite3` declares none — the `node-gyp rebuild` Bun runs for a
   `binding.gyp` package is implicit and invisible to that command. So the next `binding.gyp`-only
   dependency repeats the silent-drop hazard above with nothing to flag it; the symptom to recognise
   is a `require` that fails for a package the lockfile swears is installed.
5. **`DULJA_UPDATE_FEED` is a build-time input and a run-time override, and the two are not the same
   thing.** At build time `publish.url` is `${env.DULJA_UPDATE_FEED}` with no default, deliberately —
   a default there would be a literal domain baked into every build. Unset, the build packages the app
   and then fails at the last step with `cannot expand pattern "${env.DULJA_UPDATE_FEED}": env
   DULJA_UPDATE_FEED is not defined` (observed; exit 1, no installer). Any URL will do locally. At run
   time the same name overrides that baked-in value, and **`configureUpdater` only calls `setFeedURL`
   when it is given a feed**. What it is given comes from `main.ts`'s `UPDATE_FEED`: the variable if
   set, otherwise a loopback placeholder when unpackaged and `undefined` when packaged — a packaged
   app is the only one with a baked-in file to fall back to. That condition is load-bearing, not
   defensive: `setFeedURL` assigns `AppUpdater.clientPromise`, and
   `getUpdateInfoAndProvider` consults `resources/app-update.yml` only while that is null. Called
   unconditionally — as this slice first shipped it — the file electron-builder writes is dead code,
   every install dials whatever default the binary carried, and it keeps doing so after OD-20 lands.
   `updater.spec.ts`'s packaged case launches the installed executable with the variable absent and
   asserts the shipped URL is the one dialled. Because that case *removes* the variable — and the three
   before it each serve their own loopback feed — the OD-20 verification line in the 0E plan
   (`DULJA_UPDATE_FEED=https://<domain>/… test:electron -- updater`) needs somewhere to land, so the
   last spec in the file is that gate: skipped unless the variable names a **non-loopback** host,
   launching the packaged app with it passed through, asserting the feed answers at all rather than
   answering `up-to-date` (a real feed is entitled to be ahead of the build under test).
6. `better-sqlite3` is a dependency of `apps/desktop` from 0E even though the back office does not use
   it: the DoD requires the ABI path to be proven now. 6B is its first real consumer.
7. `@electron/rebuild` stays in `devDependencies` because spec:2323 names it, even though
   electron-builder bundles its own copy and warns that ours is excess. It is not invoked.

## Consequences

- 6B inherits a working native-module build and does not re-solve it. It inherits one obligation: if it
  pins a `better-sqlite3` that stops shipping prebuilds, or an Electron whose `process.versions.napi`
  is below the prebuild's, `npmRebuild` has to go back to `true` and the build machine needs MSVC.
- The renderer can be rebuilt without touching the desktop package, and vice versa.
- A developer with no C++ toolchain can install, build, package and test the desktop app. That was not
  true before decision 4.
- **Not settled here (OWNER GATE OD-18):** the installer this produces is unsigned, so a clean Windows
  VM shows the SmartScreen "unknown publisher" warning. That is Task 13's clause of DoD 0.13, and the
  expected outcome until the certificate arrives.
