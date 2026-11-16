# 0019 — The `window.dulja` context-bridge surface (PROPOSAL)

**Status:** proposed — awaiting the owner's approval before merge · **Date:** 2026-09-05 · **Slice:** 0E
**Spec:** §3.7.2 (spec:1284), §0.2 "if it touches money semantics, security, the data model, or the sync protocol, write the ADR as a proposal and ask before implementing" (spec:95)

## Context
The renderer is sandboxed with `contextIsolation: true` and `nodeIntegration: false`. Everything
privileged therefore crosses one boundary. That boundary's shape is a security decision, and §4.10.6
of the plan contracts has already frozen one member of it — `window.dulja.pos.*` for the POS (6B).

## Proposal
One frozen object, `window.dulja`, with exactly three namespaces in 0E and one added by 6B:

| Namespace | Members | Why it must cross the boundary |
|---|---|---|
| `auth` | `get(key)`, `set(key, value)`, `remove(key)` | `safeStorage` lives only in the main process |
| `app` | `version()`, `checkForUpdates()` | `app.getVersion()`, electron-updater |
| `print` | `toPdf({ landscape })` | `webContents.printToPDF` (D18: Windows drivers, no hardware code) |
| `pos` (6B) | per §4.10.6 | `better-sqlite3` |

Rules the implementation holds to:
1. **No generic channel.** `ipcRenderer` is never exposed; each member names one constant channel.
2. **No filesystem, no network, no shell.** A renderer that wants a file asks for a named operation.
3. **The main process validates every argument** and returns plain JSON-serialisable values.
4. **`safeStorage` unavailable → refuse, as a value, not a rejection.** Never a plaintext fallback
   (DoD 0.13). `auth.set` resolves to `{ ok: true } | { ok: false, reason: "encryption-unavailable" }`
   rather than throwing: `ipcMain.handle` serialises any thrown error into a generic `Error` on the way
   back across IPC, so a thrown `EncryptionUnavailableError`'s identity would not survive the crossing
   and a caller could only string-match its message. The caller (Task 6's session storage) **must not**
   fall back to `localStorage`/`sessionStorage` on `ok: false` — that would put the token back in
   plaintext by a different route and defeat this ADR entirely.

## Alternatives considered
- **A single generic `invoke(operation, payload)` with a main-side allowlist.** Rejected: the allowlist
  becomes the real security boundary and lives as data rather than as a type the compiler checks: adding
  an operation is a string, not a new function with its own argument types, and every future author has
  to go read the allowlist to know what's callable at all.
- **An OS credential vault (`keytar`) instead of `safeStorage`.** Rejected: `keytar` is unmaintained
  upstream and needs a native module rebuild step per Electron/Node ABI (the same class of packaging
  problem `better-sqlite3` already carries in this app — see Task 12). `safeStorage` ships inside
  Electron itself, with no extra native dependency.
- **Not persisting a refresh token at all; re-authenticate every launch.** Rejected on product grounds,
  not security ones: this is a back-office and POS app meant to stay signed in across restarts on a
  till or a manager's machine, and forcing a full re-login every launch is the kind of friction this ADR
  is not the place to impose unilaterally — but it is the fallback behaviour if the owner rejects
  `auth` entirely.

## Consequences
- Adding a member is an amendment to this ADR, not a code change alone.
- 6B extends `DuljaBridge` additively and touches no 0E file.
- A renderer compromise reaches only these six functions.

## Question for the owner
Approve this surface, or name an operation it should not carry.
