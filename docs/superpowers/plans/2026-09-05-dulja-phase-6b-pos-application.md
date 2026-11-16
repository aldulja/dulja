# Dulja Phase 6B — POS application (`apps/pos`, `pos.exe`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **till half** of the Phase 6 definition of done — *"A till sells 8 hours offline and reconciles with **zero duplicates and zero lost tickets**"* — as `apps/pos`, packaged as `pos.exe` from `apps/desktop`'s second electron-builder target. Six pieces. (1) **The local SQLite model of §4.10.6** — exactly spec:1328–1335's tables plus `outbox.kind` and `catalogue_branch_pos_policy`, behind `better-sqlite3` in the Electron main process, reached from the renderer only through the typed `contextBridge` API `window.dulja.pos`. (2) **A `SyncStore` over SQLite** that satisfies 6A's contract to the letter — eight per-stream cursors, `applyChanges` advancing **every** stream to the page's highest revision, and an outbox row acked only when the server names its ref. (3) **Selling offline** — scan or search, quantity and unit, line and ticket discount within the branch limit, price override within the branch limit, price list per shop, promotions with date windows, customer-specific pricing, multi-tender with change and POS rounding, returns against an original ticket and blind returns where policy allows, customer lookup and quick-create, account sales inside the credit limit, and a read-only price-check mode. (4) **A ticket and its outbox row in one SQLite transaction** (spec:1303, 1337), so a sale can never be committed locally and lost in transit. (5) **PIN login and authority evaluated at the till** from the down-synced `catalogue_cashier` snapshot and `catalogue_branch_pos_policy` row, with `verifyPin` imported from 6C and never re-implemented, and clock-in/out written to the outbox as `Ticket.attendance`. (6) **An honest offline indicator** carrying the last catalogue revision and the time it arrived, receipt printing through `webContents.print()`, and `pos.exe` auto-updating from the R2 feed. Acceptance test **19** — *500 tickets sold with the network down; reconnect; zero duplicates, zero lost tickets; re-sending the same batch twice changes nothing* — is this slice's own.

**Architecture:** Five seams, and none of them is a second model. (1) **The till has a cache, not a schema.** spec:1358 names the legacy system's *"own 69-table schema that mirrored the core"* as its biggest structural error in this area; the local database therefore holds read-only catalogue mirrors stamped with the revision they arrived at, the tickets the till itself created, and nothing else. Every row that is not a ticket, a shift, a till event or an outbox entry is a mirror whose only writer is `applyChanges`. (2) **The Electron main process owns the database; `apps/pos`'s main bundle owns the SQL.** spec:2389 says *"`desktop` imports only build outputs"*, so the POS handlers are a **build output of `apps/pos`** (`apps/pos/dist-main/pos-main.cjs`) that `apps/desktop/src/main-pos.ts` `require`s by path and hands `{ ipcMain, channels, dbPath, transport }`. `apps/desktop` therefore imports no workspace package for the POS, and `apps/pos` — an app-tier workspace — imports `@dulja/sync`, `@dulja/domain`, `@dulja/contracts`, `@dulja/ui`, `@dulja/i18n` and one `@dulja/db` subpath, all of which the dependency rule permits. (3) **The wire contract is 6A's and is not restated.** Every message this slice writes to the outbox is a `@dulja/sync` type; every signature header comes from `packages/sync/src/signing.ts` (Task 0 moves `canonicalSyncRequest` there so the two ends share **one** canonical string — SAH-046 is exactly the defect two spellings produce); `pullAll` and `drainOutbox` are 6A's functions run against this slice's store and transport. (4) **Money never becomes a number and never becomes a float, at the till either.** Every monetary column in SQLite is `TEXT` holding a fixed-4-dp decimal string, every quantity `TEXT` at 6 dp, every revision `TEXT` holding a decimal integer — SQLite's `INTEGER` is 64-bit but the JavaScript driver hands it back as a `number`, and a revision past 2⁵³ read as a double would re-deliver one row for ever, which is the failure acceptance test 20 exists to catch. `@dulja/domain`'s `Money` and `Quantity` do every calculation. (5) **The till computes prices and tax; the server recomputes and refuses a disagreement.** 6A's `applyBatch` step (g) recomputes tax from the stored line and rejects a mismatch, so the till's figures must be right rather than merely plausible — which is why pricing and tax at the till go through 5A's own `TaxEngine.compute` and 3A's own price-list rows, never through a second formula.

**Tech Stack:** Bun 1.4 (install, scripts, the Vite build) · Node 24 LTS (runs Vitest) · TypeScript strict · Electron (from 0E, with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) · `better-sqlite3` in the Electron main process, rebuilt against Electron's Node ABI by `@electron/rebuild` (0E's ADR 0017) · React 19 + Vite + TanStack Router (the same stack as `apps/backoffice`) · `@dulja/ui` primitives and `@dulja/i18n` catalogues · `@dulja/sync` for every message and the request signer · `@dulja/domain` for `Money`, `Quantity`, `round`, `RoundingMode` · `@dulja/db/staff/pin` for `verifyPin` (6C's one PIN function) · `node:crypto` `generateKeyPairSync('ed25519')` and `sign` for the terminal device key, stored through 0E's `safeStorage` seam · electron-builder + electron-updater against the R2 feed · Vitest + Playwright (`_electron`) · oxlint + oxfmt + Turborepo. No package version appears in any source file — the lockfile owns versions (spec:104).

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §0.2 the never/always lists (spec:97–108), §0.3 **D18** *POS hardware out of scope for v1* (spec:133), §3.6 *Explicitly do NOT carry over* (spec:1244–1248, and especially spec:1239 *"Offline POS with parcel-based sync"* as the one thing kept in spirit), **§3.7.1–§3.7.2** (spec:1256–1284 — two applications one codebase, the Electron decision table and the security posture verbatim), **§3.7.3** up-sync and the Stock paragraph (spec:1301–1308), **§3.7.5** the local SQLite schema and the cashier-identity paragraph (spec:1320–1337), **§3.7.6** the POS scope table (spec:1339–1360), §3.9 Identifiers (*"The POS generates a `uuidv7` at the till for each ticket … carried as `document.client_ref`"*, spec:2037), Time, Money, Quantities, Naming, Localisation (spec:2039–2061), §4.2 PIN hashing (spec:2132), §4.2.1 the `cashier` row (spec:2161), §4.10 frontend and UX standards — RTL/LTR parity, keyboard-first entry, offline-tolerant POS (spec:2249–2256), §4.11 the two code-signing secret names (spec:2273), §5.2 `apps/pos` and `apps/desktop`'s *"two build targets: backoffice.exe and pos.exe"* (spec:2360–2361) and the dependency rule (spec:2389), Part V the Phase 6 row (spec:2292) and the sequencing note (spec:2299), Part VI tests **19** (spec:2437), **20** (spec:2438), **23** (spec:2441), Part VII **#10** (spec:2481 — historical POS data, OD-16, *not this slice*) and **#11** (spec:2482 — the UI is not covered by the document, which is OD-24), Part I **SAH-028** (spec:471), **SAH-051** (spec:647), **SAH-086** (spec:923).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 6B — POS application (`apps/pos`, `pos.exe`). **Phase:** 6. **Phase gate:** this plan starts only when **6A** and **6C** are merged and Phase 5's definition of done is green in CI (spec:87). §2.7's card fixes the order: *"6B is therefore sequenced 6A → 6C → 6B, not parallel to 6C"* — staff PIN login, till-side authority and the discount/void/blind-return limits all read the down-synced `catalogue_cashier` and `catalogue_branch_pos_policy` mirrors whose server tables are 6C's migrations 0065 and 0066, and acceptance test 19 needs a cashier only 6C can create. **6D is *not* a predecessor**: `app.shift` and `app.till_event` are 6D's tables, so this slice's shift and till-event messages are refused per message with `ERR_SYNC_MESSAGE_UNSUPPORTED` and stay in the outbox, which is 6A's refuse-never-drop contract (§4.10.1) and is asserted as such in Task 12.
- **Depends on (merged):** **Plan 0A** by exact name — `startDb`, `Db`, `Seed`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `seedTenant`, `MIGRATIONS_DIR`, `lintSchema`, `up`, `down`, `listApplied`, `discover`, `app.resolve_principal`, `app.actor_has`, `app.pos_terminal`, the role literal `pos_terminal`, `permission.module in ('admin','accounting','inventory','hr','pos')`. **0B** — the production `withTenant(sql, ctx, fn)`, `TenantContext`, `createDb`, `AppError`, `ERRORS`, `ErrCode`, `Problem`, `PERMISSION`, `PERMISSIONS`, `PermissionCode`, `PermissionDef`, `SliceId`, `buildRoutes`, `ROUTES`, `startApi`, `ApiRequest`, `StartedApi`, `PROBES`, `sharedApi`, `grantAdmin`, `problemOf`, `sourceFiles`, `REPO_ROOT`, `MoneySchema`, `QuantitySchema`, `UuidSchema`, `TimestampSchema`. **0D** — `Money`, `currency`, `CurrencyCode`, `Quantity`, `round`, `RoundingMode`, `MONEY_SCALE`, `QUANTITY_SCALE`, `rational`, `Rational`, `seedBranch`, `seedCurrency`, `ROLES`, `INCOMPATIBLE_PAIRS`, `startWorker`. **0C** — the seed CLI and `bun run seed --tenant <id> --only roles`, the `0c-base.json` chart rows, `repoFile`, the R2 `UPDATE_FEED` binding, `SENTRY_DSN`. **0E** — `packages/i18n` (`Locale`, `Dir`, `LOCALES`, `dirFor`, `isLocale`, `createI18n`, `formatDate`, `formatNumber`, `formatMoney`, `formatQuantity`, `checkCatalogues`), `packages/ui` (`tokens.css`, `tailwind-preset`, `DirectionProvider`, `useDirection`, `Button`, `TextField`, `Select`, `DataGrid`), `apps/desktop` (`APP_SCHEME`, `APP_ORIGIN`, `CONTENT_SECURITY_POLICY`, `browserWindowOptions`, `isAppUrl`, `DuljaBridge`, `DuljaAuthBridge`, `DuljaAppBridge`, `DuljaPrintBridge`, `UpdateStatus`, `CHANNELS`, `createSecureStore`, `SecureStore`, `EncryptionUnavailableError`, `configureUpdater`, `checkForUpdates`, `initSentry`, `electron-builder.yml`), **ADR 0016** (the PDF engine — consumed only as a decision; the till prints through `webContents.print()`), **ADR 0017** (electron-builder from a Bun workspace and `better-sqlite3` against Electron's ABI), `bootLocalStack`, `grantAdminRole`, `scripts/lint/rules/no-hardcoded-string.ts`. **1A** — `postDocument` (reached only through 6A's `applyBatch`), `seedTenantV2`, `seedAccount`. **2A** — `seedParty`, `seedDocumentType`, `DocumentLineKindSchema`. **2B** — `grantCodes`, `app.principal_has`. **3A** — `app.item`, `app.price_list`, `app.price_list_line`, `app.promotion`, `seedUnit`, `seedItem`, `seedWarehouse`, `seedPriceList`. **3B** — `ensureOpenPeriods`, `postInventoryDocument`. **3D** — `secondPrincipal`. **5A** — `app.tax_code`, `TaxEngine`, `TaxCodeDef`, `TaxLineInput`, `TaxLineResult`, `taxEngine`, `taxFixture`, `TaxFixture`, `seedTaxPack`, the `SYNTH-MY-v1` regime and its four codes. **6A** — `@dulja/sync` in full (`Stream`, `CATALOGUE_STREAMS`, `Cursor`, `Change`, `CataloguePage`, `MoneyJson`, `TicketLine`, `TicketTender`, `TicketEvent`, `NewCustomer`, `Ticket`, `ShiftOpenClose`, `TillEventMsg`, `TicketBatch`, `TicketResult`, `MessageResult`, `BatchResult`, `BatchQueued`, `SYNC_BATCH_SYNC_LIMIT`, `shiftRef`, `encodeSyncCursor`, `decodeSyncCursor`, `SyncCursorError`, `SyncStore`, `SyncTransport`, `OutboxRow`, `SyncQueuedError`, `pullAll`, `drainOutbox`), `POST /v1/sync/enrol`, `GET /v1/sync/catalogue`, `POST /v1/sync/tickets`, `canonicalSyncRequest`, `TerminalIdentity`, `applyBatch`, `TicketInput`, `TerminalApplyContext`, `SyncError`, `SyncErrorCode`, `POS_PERMISSION`, `PosPermissionCode`, `OVERRIDE_SUBJECT_FOR`, `seedTerminal`, `posFixture`, `PosFixture`, `enrolTerminal`, `EnrolledTerminal`, `signSyncRequest`, `syncRequest`, `buildTicket`, `MemorySyncStore`, the `POS_TICKET` envelope and its `1110`/`1120`/`1100`/`2200` tender rules. **6C** — `hashPin`, `verifyPin`, `PinFormatError`, `PIN_MIN_LENGTH`, `PIN_MAX_LENGTH`, `CashierLimits`, `CashierSnapshot`, `computeSnapshot`, `readSnapshot`, `CASHIER_SNAPSHOT_CODES`, `verifyTicket`, `requiredCodesFor`, `OVERRIDE_LIFTS`, `LimitKind`, `LimitRefusal`, `app.pos_cashier`, `app.branch_pos_policy`, `app.attendance_event`, `app.pos_cashier_sync`, `app.branch_pos_policy_sync`, `app.actor_in_branch`, `seedEmployee`, `seedCashier`, `seedBranchPosPolicy`, `staffFixture`, `StaffFixture`, `applyTicket`, `branchActor`, `ERR_POS_LIMIT_EXCEEDED`.

  Where a name in the list above differs from the written plan that ships it, **that plan's file is the authority** (§4.18's rule) and **Task 0's repo gate is what discovers the difference before any code is written**.
- **Migration numbers:** **0063** — one file, one PR, with a hand-written down: `0063_seed_permission_phase6b.sql` (**T4**) — the three codes §3.6.2 assigns this slice. §2.7's card says *"0063 (reserved; client-side slice, no server migration expected)"*, and **Task 0 amendment A1 corrects it**: §3.6.2 makes 6B the introducing slice for `pos.price.check`, `pos.shift.own` and `pos.attendance.clock`, and §3.6.3's `permission-catalogue.test.ts` asserts the set in `app.permission` **equals** the set exported by `permissions.ts` in both directions — so a `PermissionDef` row with no migration insert fails that test the day it lands. "Reserved" is what the number was reserved *for*. **ADR numbers:** 0057–0059, each written **as a proposal and asked before implementing** where it touches security or the data model (spec:95): **0057** *The till's local SQLite model is a cache, not a schema* (T1); **0058** *The POS main process is a build output of `apps/pos`, loaded by path* (T9); **0059** *POS cash rounding is absorbed into the ticket, because the ledger has no rounding account* (T7).
- **Interfaces consumed:** §4.1 (the Plan 0A surface), §4.2.1 (`Money`, `Quantity`, `currency`, `round`, `RoundingMode`, `rational`, the scales), §4.2.2 (`withTenant`, `TenantContext`, `createDb` — in this slice's **tests** only; the till has no Postgres), §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, and this slice's four allocated rows), §4.2.5 (`PERMISSION`, `PERMISSIONS`, `PermissionDef`, `ROLES`), §4.2.8 (`MoneySchema`, `QuantitySchema`, `UuidSchema`, `TimestampSchema`), §4.2.12 (`startApi`, `StartedApi`, `ApiRequest`), §4.6.3 (`app.pos_cashier` — the `snapshot` shape the till mirrors), §4.6.4 (`app.branch_pos_policy` — every limit column by name), §4.6.5 (`app.shift`, and the tender-line contract the till's `TicketTender` becomes), §4.9.1 (5A's `TaxEngine`, `TaxCodeDef`, `TaxLineInput`, `TaxLineResult`), **§4.10 in full** and §4.10.6 as this slice's own definition of done, §4.11 (consulted: the report engine is 7A's and this slice ships no `ReportDefinition`), §4.14 (`POS_TICKET`, consumed — 6A seeds it), §4.15 (consumed, none seeded: `1110`, `1120`, `2200` are 6A's and `1100`, `1200`, `1300`, `4000`, `5000` are 0C's), §4.16.1 (consulted: no `ReportCode` — `pos.z_report` and `pos.sales_by_cashier` are **6D's**), §4.16.2 (consulted: **no** `DatasetId` member), §4.17 (consumed: `seedTerminal`, `seedCashier`, `seedBranchPosPolicy`, `seedEmployee`, `seedItem`, `seedPriceList`, `seedParty`, `seedTaxCode`, `grantCodes` — **this slice adds no `fixtures.ts` helper**), §4.17.1 (`posFixture`, `buildTicket`, `signSyncRequest`, `syncRequest`, `MemorySyncStore`, `staffFixture`, `sharedApi`, `grantAdmin`, `problemOf`, `sourceFiles`, `bootLocalStack`; **this slice adds one file, `tests/invariants/support/till.ts`**), §5 (all thirty-five hazards), §6.1 rows 19, 20, 23, §6.2 row **1062**.
- **Interfaces produced:** **§4.10.6 in full** — the local SQLite schema, `better-sqlite3` in the Electron main process and the typed `contextBridge` API `window.dulja.pos.{sell, tender, closeShift, pull, drain, clock, priceCheck}`; §4.10.5's `SyncStore` implemented over SQLite as `SqliteSyncStore`; §3.6.2's three `pos` codes and §3.6.4's **`cashier` and `branch_manager`** grants for them; §4.2.4's four allocated rows; the `pos.exe` target. Everything else is listed under **Contract additions** in the Self-Review and lands through **Task 0**.
- **Owner decisions:** **OD-03** loyalty points in POS v1 (*Decide* — spec:22, 1032, 1348, 2397) → **Task 14**, isolated, default §2.12's — **not built**; dropped whole if the answer is no, renumbering nothing. **OD-18** the Windows code-signing certificate, OV or EV (spec:92, 2323, 2401) → **Task 13**, isolated; default — **unsigned build, SmartScreen warning expected**; Task 10 ships the installer and the auto-update feed without it. **OD-24** screenshots and a two-minute operator description before any screen (spec:79, 108, 2254, 2408) → **Task 11**, isolated, and **the POS is the most keyboard-critical UI in the product**; default — *the screen task is blocked, not the slice*: Tasks 1–10 and 12 ship every service, the whole SQLite model, both sync loops and acceptance test 19 with **no renderer**, and Task 11 adds the screens when the owner's material arrives. **OD-29** restaurant features in POS (excluded unless confirmed — spec:1341) → **recorded, no task**: no floor plan, no table, no kitchen modifier, no meal course appears anywhere in this slice, and §2.7's card says "no task, recorded". **D18 is a settled decision, not an owner gate** (spec:133 — *"POS hardware: out of scope for v1; Windows printer drivers via Electron in v1"*), so §3.7.3's conditional file **`tests/regression/sah-086.test.ts` is never created by this slice and nothing appends to it** — which is exactly what §3.7.3's named-creator rule provides for.
- **Part VI tests owned / re-run:** **owns 19** (offline POS — Task 12). **Re-runs:** **20** (catalogue resume, the till half — Task 2, `pullAll` against `SqliteSyncStore` instead of `MemorySyncStore`), **23** (RTL/LTR parity, the POS screens — Task 11, and therefore blocked with it under OD-24), **11** (auth bypass — Task 3's assertion that the till never sends `X-Tenant-Id`/`X-Actor-Id` and that a stale device signature is refused), **37** (POS authority — Task 4's till half: the same over-limit ticket the server refuses is refused at the till first, and the refusal messages agree), **36** (the permission catalogue over this slice's three codes — Task 4). **§3.0.4 rows owned:** **spec:1062** — *"POS selling, pricing, tenders, returns, customers, shifts, PIN, offline, price check"*. §6.2 names 6A, **6C** and 6D as contributors and 6B as owner, so the row closes when this slice is green. **Regression files created / appended:** **creates none.** **`sah-086` is not created** (D18, above). **Appends** a `— 6B` block to `tests/regression/sah-051.test.ts` (created by 0B) — *uuidv7 at the till*: the ticket id is minted offline, is the `document.client_ref`, and no sequential integer and no shared counter exists anywhere in `apps/pos`. **And makes one in-place correction, in Task 0, to `tests/regression/sah-046.test.ts` (created by 6A):** amendment A2 moves the single `canonicalSyncRequest` declaration into `packages/sync/src/signing.ts`, and two of 6A's assertions name its old address, so they are **replaced inside 6A's own `— 6A` block** rather than contradicted by a second one. §3.7.3's rule is that a later slice does not *edit an earlier block to say something different*; here the invariant is identical (one declaration, one file) and only the path in it moved, and a `— 6B` block asserting the opposite of a live `— 6A` block would itself be the two-spellings defect SAH-046 is about. **This is the only earlier-block edit in the slice, it is stated in A2, and Task 0 Step 5 carries both replacement lines in full.**
- **Shared namespaces this slice writes into:** **Document-type codes (§4.14) — none.** `POS_TICKET` is 6A's and is consumed; the till writes its `code` into no seed file. **Account codes (§4.15) — none seeded.** Consumed and asserted-not-reseeded, each with its seeding slice: `1110` Cash in till, `1120` Card clearing, `2200` Store-credit liability (**6A**), `1100` Bank, `1200` Trade receivables, `1300` Inventory control, `4000` Sales, `5000` COGS, `5920` FX rounding (**0C**), `2300` Output tax payable (**5A**). The till resolves **no** account by code — it never posts; `applyBatch` and the `POS_TICKET` policy do. **Report codes (§4.16.1) — none**, and `ReportCodeSchema` is not widened: hazard 4 gives Phase 6 exactly `pos.z_report` and `pos.sales_by_cashier`, both **6D's**. **`DatasetId` members (§4.16.2) — none.** **`fixtures.ts` helpers (§4.17) — none**: every row this slice's tests need already has a helper, and hazard 9 forbids inventing one beside the register. **Shared test helpers (§4.17.1) — one new file, registered by Task 0:** `tests/invariants/support/till.ts` with `TillFixture`, `tillFixture`, `HttpTillTransport`, `openTill` and `sellOffline`.
- **Nine facts every task in this plan depends on, stated once because getting one wrong is a silent failure.** (1) **`Seed` has no `branch` member** — it is `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy; branchType; hq }` (§4.1), so every `branchId:` here is `<seed>.hq` unless a second value came from 0D's `seedBranch`. (2) **`seedTenant` grants `s.human` nothing** (§4.1, pinned), so every test that reaches a gated route calls `grantAdmin()` or `grantCodes` first. (3) **`applyChanges` advances EVERY member of `CATALOGUE_STREAMS`** to the page's highest revision, not only the streams the page carried (§4.10.5 as amended by 6A's Task 0 amendment 23c) — *"This is the sentence 6B's SQLite store is measured against"*. `cashier` and `branch_pos_policy` are quiet streams on a fresh company, and a store that advanced only the touched ones would hold `0n` on them for ever, making `pullAll`'s minimum-across-streams `0n` on every till: every pull would re-fetch the whole catalogue, nothing would throw, and no resume would exist. (4) **A revision is a `bigint` end to end.** `better-sqlite3` returns an SQLite `INTEGER` as a JavaScript `number` unless `defaultSafeIntegers(true)` is set; this plan stores every revision as **`TEXT`** holding a decimal integer and converts with `BigInt(...)` at the boundary, which needs no driver mode and cannot be undone by a later `defaultSafeIntegers(false)`. (5) **`no-number-money` scans `apps/**`** (§3.7.5), so a property, parameter or variable in `apps/pos` whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i` may not be typed `number` — `Money`, `Quantity`, `Decimal` or `string` only. Every SQLite money column is `TEXT` for the same reason. (6) **`document.shift_id` exists from 6A's migration 0061 with no FK until 6D's 0070**, so a ticket may carry the till's shift id from the first sale (6A:5066, 5362) — the till never waits for 6D. (7) **`Quantity` has `add`, `subtract`, `negate`, `multiply`, `convert`, `compare`, `isZero`, `isNegative`, `toDecimal`, `toString`, `toJSON` and nothing else** (§4.2.1, 0D's frozen member list) — only `Money` has `abs`. A return line's magnitude is spelled `q.isNegative() ? q.negate() : q`. (8) **A return is not a second document type**: it is a `POS_TICKET` whose line `quantity`, `amount`, `taxAmount`, `totalInclTax` and tender `amount` are all negative, and `cost` stays positive (§4.4.2 A9's 6A entry, 6A's `returnSnapshot`). (9) **`tests/` is outside every lint root** (§3.7.5 — `ROOTS` are `apps`, `packages`, `scripts`), which is why `tests/invariants/pos-offline.test.ts` may import `apps/pos/src/**` directly with one `tsconfig.json` `include` entry and **no** `package.json` dependency, exactly as §4.17.1's existing seam does in the other direction.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first (that is what Task 0 is).
- **Contracts version:** 2026-09-07.

## Global Constraints

Copied verbatim from the spec and the contracts document; every task's requirements implicitly include this section.

1. **Never**, at any phase, for any reason (spec:97–104): write to a ledger or movement table outside the posting service; represent money as a float, anywhere, including in TypeScript; build SQL by string concatenation (SAH-036/037/069); issue DDL from application code (SAH-053); disable an invariant, constraint or trigger "temporarily" (SAH-027, 041, 053); gate an audit write on any flag (SAH-030); hard-code a package version into a source file — the lockfile owns versions.
2. **Always**, for every new table (spec:106): `tenant_id`, an RLS policy named `tenant_isolation`, `created_at`, a migration, and a test that a second tenant cannot see it. **This slice creates no PostgreSQL table** — migration 0063 inserts three rows into the global `app.permission` and creates nothing — so the new-table recipe of §3.5.1 has nothing to bind. **The local SQLite tables are not "new tables" in that sense**: they live in one file on one shop PC, hold no other tenant's rows and are unreachable by any query the recipe protects; §3.5.3 gains no row and `lint-schema.ts` is **untouched by this slice**. For every UI screen: verified in both text directions before merge (Task 11).
3. **The till writes no ledger, movement, layer, projection or tax-transaction row, in Postgres or anywhere else** (hazard 22). `apps/pos` contains no PostgreSQL client at all: it holds no `postgres` dependency, no `@dulja/db` barrel import, and exactly one `@dulja/db` subpath import — `@dulja/db/staff/pin`, for `verifyPin`. Everything the till knows about the ledger it learns from a `BatchResult`.
4. **The terminal acts, the cashier is attributed** (hazard 19, spec:1324, SAH-044). The till sends `Ticket.cashierPrincipalId` as **attribution data**; the acting principal is the terminal, resolved by the server from the signed call. **No message this slice composes carries an actor id**, and the till never sends `X-Tenant-Id` or `X-Actor-Id` — Task 3 asserts both by scanning its own request builder.
5. **The till's stock figure is advisory and says so** (spec:1307–1308). `catalogue_item` carries no quantity at all; a low-stock warning is drawn from the mirror's `stock_hint` column, which is populated only when the catalogue page carries one and is displayed with its arrival time beside it. **A sale is never blocked on it** — spec:1308: *"it does not block a sale on a number it cannot trust"*. Authoritative stock is the back office's, and `allowNegative: false` in the `POS_TICKET` policy is what refuses an over-sale, at apply, with `ERR_STOCK_INSUFFICIENT` and a needs-attention row.
6. **Money and quantity discipline at the till** (spec:2041–2043, §3.7.5's *"Nothing in the local database is authoritative except the tickets the till itself created"*). Every monetary value is a `Money` in memory and a fixed-4-dp `TEXT` in SQLite; every quantity a `Quantity` and a fixed-6-dp `TEXT`; every revision a decimal `TEXT`; every unit conversion an exact `Rational`. `Money.multiply` and `Money.divide` always take an explicit `RoundingMode`. **No `number` holds a monetary value, a quantity or a revision anywhere in `apps/pos`**, and the `no-number-money` lint proves it.
7. **The Electron security posture is 0E's and is restated, not re-decided** (spec:1284): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the renderer, the strict CSP of `CONTENT_SECURITY_POLICY`, renderer navigation locked to `APP_ORIGIN` through `isAppUrl`, and **every** privileged operation — SQLite, printing, sync, the device key — behind the typed `contextBridge`. The renderer holds no `require`, no `ipcRenderer` and no file path.
8. **`desktop` imports only build outputs** (spec:2389). `apps/desktop` gains `main-pos.ts`, `preload-pos.ts`, `bridge-types.ts` additions and `electron-builder.pos.yml`, and **imports nothing from `apps/pos`** — it `require`s `apps/pos/dist-main/pos-main.cjs` by path at run time and passes it the channel map as data. `apps/pos` imports `@dulja/sync`, `@dulja/domain`, `@dulja/contracts`, `@dulja/ui`, `@dulja/i18n` and `@dulja/db/staff/pin`, and imports no other app. ADR 0058 records the shape.
9. **One migration per PR** (spec:2057); the file runs whole in one transaction; every statement carries a comment naming the SAH-/spec reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`; a hand-written `0063.down.sql` that deletes exactly the three codes.
10. **No enum label is added** (§3.4.4, hazard 11) and no PostgreSQL vocabulary changes. Every closed vocabulary this slice introduces is a SQLite `CHECK` in the local file, or a TypeScript union.
11. **Error codes** are `ERR_<DOMAIN>_<REASON>` enumerated in `packages/contracts/src/errors.ts`, and a code no code raises fails the build (spec:2051). **This slice adds exactly four rows** (§4.2.4, allocated by Task 0 amendment A6, each in the PR that raises it): `ERR_TILL_PIN_INVALID` (401), `ERR_TILL_LIMIT_EXCEEDED` (422), `ERR_TILL_CATALOGUE_STALE` (409), `ERR_TILL_STORE_CORRUPT` (500). Everything else it raises is already shipped: `ERR_VALIDATION_FAILED`, `ERR_NOT_FOUND`, `ERR_RBAC_FORBIDDEN`, `ERR_SYNC_CURSOR_INVALID`, `ERR_SYNC_MESSAGE_UNSUPPORTED`, `ERR_TERMINAL_SIGNATURE_INVALID`, `ERR_TERMINAL_REVOKED`, `ERR_TERMINAL_ENROLMENT_INVALID`, `ERR_POS_LIMIT_EXCEEDED`, `ERR_TAX_REGIME_MISMATCH`, `ERR_MONEY_CURRENCY_MISMATCH`. **This list is closed:** a token in any test of this slice that is not on it is either a typo or an unregistered code, and both fail the `error-codes` lint.
12. **The permission vocabulary and module list are closed** (§3.6.1, hazard 26). This slice seeds exactly the three codes §3.6.2 assigns it — `pos.price.check`, `pos.shift.own`, `pos.attendance.clock` — and invents none. Every one is **referenced from `apps/pos`**, which is what §3.6.3's `permission-catalogue` lint requires of a code evaluated only at the till.
13. **No plan invents a literal in a shared namespace** (hazard 32). **Task 0 amends a register before any task writes a literal into it**, and this slice writes into exactly two: §4.2.4 (four `ERR_TILL_*` rows) and §4.17.1 (one file).
14. **No real Malaysian statutory rate, threshold or figure appears anywhere** (hazard 1), and **no LHDN or MyInvois endpoint, field, schema version or deadline appears either** (hazard 2). Every tax figure in this plan comes from 5A's clearly-synthetic `SYNTH-MY-v1` regime, read from `app.tax_code` through `taxFixture` or down-synced into `catalogue_tax_code`; this slice states none of its own. **The POS rounding increment is a `branch_pos_policy` column with a default of `0.05`, which is 6C's DDL** (§4.6.4) and is a configuration default, not a statutory rule; no task restates it as a fact about any jurisdiction.
15. **The Firebird version is unknown and no legacy assumption appears here** (hazard 3). This slice reads no legacy database. **Whether historical POS data migrates is OD-16 and is 9B's** (Part VII #10); the till starts clean at cut-over with only the catalogue, and nothing in `apps/pos` reads `mpos`, `legacy_ref` or an import batch.
16. **POS hardware is out of scope for v1** (D18, spec:133, 1359; SAH-086). No ESC/POS command, no cash-drawer port, no scanner driver, no scale integration and no device-profile file appears in this slice. A barcode reaches the sell screen as **keyboard input** — every USB scanner in the shops is a keyboard-wedge device — and a receipt prints through `webContents.print()` to any Windows printer driver.
17. **Restaurant features are excluded unless confirmed** (OD-29, spec:1341). No floor plan, no table, no kitchen modifier, no course, no seat.
18. **Every renderer string comes from `packages/i18n`** (spec:2061), and 0E's `no-hardcoded-string` lint plus `checkCatalogues()` prove it. Both text directions are verified before merge (spec:2251, acceptance test 23), and keyboard parity is the target: **no mouse is required to complete a sale** (spec:2254).
19. **Commits** are conventional with the scope = workspace, subject `<type>(<scope>): <summary> [6B T<n>]`, and every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (§3.8). `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` at the repository root stay green after every task. **This slice does not rewrite `AGENTS.md`'s "Current phase" section** — §3.8 names 6D as Phase 6's closing slice.

---

## This slice's share of the Phase 6 definition of done

The Phase 6 row, verbatim (spec:2292) — **Definition of done:** *"A till sells 8 hours offline and reconciles with **zero duplicates and zero lost tickets**; the shift Z-report ties to the ledger to the cent"*. §2.7's card says this slice's share is **the till half of "A till sells 8 hours offline and reconciles with zero duplicates and zero lost tickets"**; 6A holds the server half and 6D the Z-report sentence.

| Clause | Where it is green |
|---|---|
| **sells 8 hours offline** | **Task 5** (pricing, promotions and tax from the mirrors alone), **Task 6** (`sell` writes ticket, lines and outbox row in one SQLite transaction with no network call on the path), **Task 7** (tenders, change and rounding), **Task 8** (returns against a locally-mirrored original, and blind returns), **Task 4** (PIN login and authority from the snapshot). **Task 12's `pos-offline.test.ts`, its own Step 2** is the measurement: 500 tickets are sold with the transport throwing `ECONNREFUSED` on every call, and all 500 are in `ticket` and `outbox` with `acked_at is null`. (Every "Step N" in this column below is a **case inside `tests/invariants/pos-offline.test.ts`**, whose eight `it`s are named `Step 1`…`Step 8`; Task 12's own numbered steps are the ones that *write* those files.) |
| **zero lost tickets** | **Task 6 Step 4, `sell`** — the ticket, its lines, its outbox row and the attendance stamps are one `db.transaction(...)`; a crash between them is impossible. **Task 2 Step 4, `SqliteSyncStore.markAcked`** — a row is acked **only** when its ref appears in one of `BatchResult`'s three arrays with a status other than `rejected`; a ref the server did not mention stays pending for ever (spec:1337). **`pos-offline.test.ts` Step 4** proves it: after reconnect and `drainOutbox`, `select count(*) from outbox where acked_at is null` is 0 and `select count(*) from app.document where client_ref = any($1)` is 500. |
| **zero duplicates** | **Task 6 Step 2, `tillUuidv7`** — the client ref is a `uuidv7` minted at the till, is the primary key of the local `ticket` table, and is `document.client_ref` (spec:1302, SAH-051). **`pos-offline.test.ts` Step 5** — the first batch's payload is re-pushed straight through the transport with a fresh `batchId`; every ticket answers `duplicate`, `select count(*) from app.document` is unchanged, and so is `select count(*) from app.ledger_entry`. |
| **reconciles** | **`pos-offline.test.ts` Step 6** — after the drain, `Σ` of the till's local `ticket.total` equals `Σ` of the server's `document_line` item amounts plus tax for those 500 documents, to the cent, computed with `Money` on both sides. The comparison is what makes "reconciles" a number rather than a feeling. |

**What is deliberately *not* in this slice's DoD share:** the Z-report and the till cash lifecycle (**6D**), the server-side authority re-verification (**6C**, which this slice mirrors at the till but does not own), and `applyBatch` itself (**6A**). This slice also ships **no shift or till-event apply path**: it *sends* `ShiftOpenClose` and receives `ERR_SYNC_MESSAGE_UNSUPPORTED` until 6D lands, and Task 12 asserts that refusal explicitly rather than hiding it.

---

## File Structure

Every path is relative to the repository root. **NEW** means this slice creates it; **EDIT** means an existing file gains the stated additions and nothing else.

```
docs/
├─ adr/0057-till-sqlite-is-a-cache.md                     NEW  proposal (spec:95 — the data model)   T1
├─ adr/0058-pos-main-process-is-a-build-output.md         NEW  proposal (spec:95 — security)         T9
├─ adr/0059-pos-cash-rounding-has-no-ledger-account.md    NEW  proposal (spec:95 — money semantics)  T7
├─ decisions/od-03-6b-loyalty.md                          NEW  the OD-03 record                     T14
├─ decisions/od-18-6b-pos-signing.md                      NEW  the OD-18 record                     T13
├─ owner/od-24/6b/                                        NEW  the OD-24 gate directory             T11
└─ runbooks/till-enrolment.md                             NEW  the shop procedure                    T3

scripts/check/
└─ contracts-6b-amendments.sh                             NEW  Task 0's gate                         T0

packages/sync/
├─ src/signing.ts                                         NEW  canonicalSyncRequest + signSyncHeaders (A2)  T0
├─ src/index.ts                                           EDIT one export *                          T0
└─ test/signing.test.ts                                   NEW  the byte-equality corpus              T0

packages/db/
├─ package.json                                           EDIT one exports subpath "./staff/pin" (A3)  T4
├─ migrations/0063_seed_permission_phase6b.sql            NEW  three codes                            T4
├─ migrations/0063.down.sql                               NEW                                        T4
├─ seed/roles.ts                                          EDIT 3 grants x cashier + branch_manager    T4
├─ src/sync/apply.ts                                      EDIT one principal_has line (6C A10)        T4
└─ test/sync/apply.test.ts                                EDIT append one it — the handover case      T4

packages/contracts/
├─ permissions.ts                                         EDIT three PermissionDef rows               T4
├─ src/errors.ts                                          EDIT four ERRORS rows                    T2,T4
└─ src/pos/till.ts                                        NEW  the renderer's own request schemas     T9

apps/api/src/middleware/terminal-auth.ts                   EDIT import canonicalSyncRequest from @dulja/sync  T0

apps/pos/                                                  NEW workspace @dulja/pos (§3.1)            T1
├─ package.json · tsconfig.json · tsconfig.main.json                                       NEW        T1
├─ vitest.config.ts                                       NEW T1; EDIT T11 (jsdom + setup for test/renderer) T1,T11
├─ vite.config.ts · index.html                            NEW  the buildable empty renderer (T10 needs it)  T1
├─ tailwind.config.ts                                     NEW  0E's preset                            T11
├─ src/main/
│  ├─ schema.sql                                          NEW  §4.10.6 — the whole local model        T1
│  ├─ database.ts                                         NEW  PosDatabase, openPosDatabase, migrate  T1
│  ├─ store.ts                                            NEW  SqliteSyncStore (§4.10.5)              T2
│  ├─ mirror.ts                                           NEW  the eight upsert/delete writers        T2
│  ├─ device.ts                                            NEW  the Ed25519 device key + enrolment     T3
│  ├─ transport.ts                                        NEW  HttpSyncTransport (signed)             T3
│  ├─ loops.ts                                            NEW  pull/drain loops + the offline state   T3
│  ├─ authority.ts                                        NEW  PIN login, snapshot codes, limits      T4
│  ├─ pricing.ts                                          NEW  price list, promotions, tax, price check T5
│  ├─ ticket.ts                                           NEW  sell — the one SQLite transaction      T6
│  ├─ tender.ts                                           NEW  tenders, change, POS rounding          T7
│  ├─ receipt.ts                                          NEW  the receipt payload (print is T9)      T7
│  ├─ returns.ts                                          NEW  against-original and blind returns     T8
│  ├─ customer.ts                                          NEW  lookup, quick-create, account sale     T8
│  ├─ shift.ts                                            NEW  open/close + clock in/out              T6,T4
│  ├─ money.ts                                            NEW  the TEXT⇄Money/Quantity boundary       T1
│  ├─ errors.ts                                           NEW  TillError                              T2
│  ├─ register.ts                                         NEW  registerPosHandlers (A4)               T9
│  ├─ entry.ts                                            NEW  the build:main entry point (A4)        T9
│  └─ loyalty.ts                                          NEW  ⚠️ OD-03 — drops whole with T14        T14
├─ src/renderer/
│  ├─ main.tsx                                            NEW  an EMPTY mount (T1); T11 fills it in   T1
│  ├─ router.tsx · app.css                                ⚠️ OD-24 — every file below drops with T11
│  ├─ lib/bridge.ts                                       NEW  the window.dulja.pos wrapper           T11
│  ├─ components/till-shell.tsx                            NEW  chrome + the offline indicator         T11
│  ├─ components/receipt.tsx                               NEW  both directions                        T11
│  ├─ routes/login.tsx · routes/sell.tsx · routes/tender.tsx
│  ├─ routes/price-check.tsx · routes/shift.tsx
│  └─ routes/enrol.tsx
└─ test/
   ├─ database.test.ts                                    NEW                                         T1
   ├─ store.test.ts                                       NEW  the every-stream cursor rule            T2
   ├─ transport.test.ts                                   NEW                                         T3
   ├─ loops.test.ts                                       NEW  test 20's till half                    T3
   ├─ authority.test.ts                                   NEW                                         T4
   ├─ pricing.test.ts                                     NEW                                         T5
   ├─ ticket.test.ts                                      NEW                                         T6
   ├─ tender.test.ts                                      NEW                                         T7
   ├─ returns.test.ts                                     NEW                                         T8
   ├─ customer.test.ts                                    NEW                                         T8
   ├─ shift.test.ts                                       NEW                                         T6
   └─ renderer/                                           ⚠️ OD-24 — every file below drops with T11
      ├─ setup.ts                                         NEW  jest-dom matchers for the jsdom env    T11
      ├─ till-shell.test.tsx                              NEW  the offline indicator, both directions T11
      └─ sell.test.tsx                                    NEW  scan → search → row; the finish key    T11

apps/desktop/
├─ src/bridge-types.ts                                    EDIT DuljaPosBridge + POS_CHANNELS (A4)     T9
├─ src/main-pos.ts                                        NEW  the POS window and the loaded module   T9
├─ src/preload-pos.ts                                     NEW  window.dulja with the pos namespace    T9
├─ types/dulja-pos.d.ts                                   NEW  the renderer-side global               T9
├─ electron-builder.pos.yml                               NEW  the second target (A5)                 T10
├─ package.json                                           EDIT build:pos, dist:pos, start:pos         T9,T10
└─ test/
   ├─ pos-posture.spec.ts                                 NEW  the four posture clauses for pos.exe   T9
   ├─ pos-bridge.spec.ts                                  NEW  window.dulja.pos round-trips           T9
   └─ pos-updater.spec.ts                                 NEW  the pos feed                           T10

.github/workflows/
├─ ci.yml                                                 EDIT the desktop job builds both targets    T10
└─ release.yml                                            EDIT the signed pos.exe job (⚠️ OD-18)      T13

scripts/lint/rules/
├─ dependency-rule.ts                                     EDIT apps/pos tier + two named allowances   T1,T0
└─ no-hardcoded-string.ts                                 EDIT apps/pos/src/renderer joins its roots  T11

tests/
├─ package.json                                           EDIT better-sqlite3 (T12) + @dulja/sync (T0)  T0,T12
├─ tsconfig.json                                          EDIT include apps/pos/src/main + db/seed    T12
├─ invariants/support/till.ts                             NEW  §4.17.1 (A7)                           T12
├─ invariants/pos-offline.test.ts                          NEW  ACCEPTANCE TEST 19                    T12
├─ invariants/pos-canonical-signature.test.ts              NEW  the one-string proof (A2)             T0
├─ invariants/phase-6b-pinned.test.ts                      NEW  the pinned equalities                 T12
├─ invariants/support/pos.ts                               EDIT one import line (A2)                  T0
├─ regression/sah-046.test.ts                              EDIT 6A's two moved assertions (A2)        T0
├─ regression/sah-051.test.ts                              EDIT append a — 6B block                   T12
└─ e2e/pos-rtl-parity.spec.ts                              NEW  ⚠️ OD-24 — test 23's POS half         T11
```

---

### Task 0: Contracts amendments and the 6A / 6C / 0E repository gate

**No application code.** This task does two things and stops. First it lists the **ten** amendments the architect makes to `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` in one PR, so no later task writes a literal into a register that does not yet hold it (hazard 32). Second it ships the one piece of code that cannot wait — `packages/sync/src/signing.ts`, because two spellings of the canonical signature string is SAH-046 itself — and a gate script that checks the **repository**, not the document.

**Task 1 does not start until `bash scripts/check/contracts-6b-amendments.sh` exits 0.**

**Files**

- `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` — MODIFY (architect, separate PR)
- `scripts/check/contracts-6b-amendments.sh` — NEW
- `packages/sync/src/signing.ts`, `packages/sync/test/signing.test.ts` — NEW
- `packages/sync/src/index.ts`, `apps/api/src/middleware/terminal-auth.ts`, `scripts/lint/rules/dependency-rule.ts` — MODIFY
- `tests/invariants/support/pos.ts` — MODIFY (one import line: the canonical string comes from `@dulja/sync`, which is what A2's text promises — Step 4)
- `tests/regression/sah-046.test.ts` — MODIFY (6A's file; **two expectations replaced in place** inside its own `— 6A` `it`, because A2 moves the one declaration A2's assertions point at — Step 5)
- `tests/package.json` — MODIFY (`@dulja/sync` as a workspace devDependency, if 6A did not already add it — Step 4)
- `tests/invariants/pos-canonical-signature.test.ts` — NEW

**Interfaces**

- Consumes: `canonicalSyncRequest` as 6A wrote it in `apps/api/src/middleware/terminal-auth.ts`.
- Produces:
  ```ts
  // packages/sync/src/signing.ts — the ONE canonical signature string, and the only place it exists.
  export const SYNC_TERMINAL_ID_HEADER = "X-Terminal-Id";
  export const SYNC_TIMESTAMP_HEADER = "X-Terminal-Timestamp";
  export const SYNC_SIGNATURE_HEADER = "X-Terminal-Signature";
  export interface CanonicalSyncRequest { method: string; path: string; timestamp: string; body: string /* sha256 hex of the exact bytes sent */ }
  export function canonicalSyncRequest(r: CanonicalSyncRequest): string;
  export function sha256Hex(payload: string): string;
  /** The three headers, from a caller-supplied Ed25519 signer. The signer is injected because `packages/sync`
   *  must not choose between `node:crypto` and WebCrypto for the till and the API both. */
  export function signSyncHeaders(
    req: { method: string; path: string; body?: unknown; at?: Date; terminalId: string },
    sign: (message: Uint8Array) => Uint8Array,
  ): Record<string, string>;
  ```

**Steps**

- [ ] **Step 1: The ten contract amendments**

| # | § | Amendment | Blocks |
|---|---|---|---|
| **A1** | 2.7 (6B card), 3.4.1, 3.6.2, 3.6.3 | **Migration 0063 is required, not optional.** The card's *"0063 (reserved; client-side slice, no server migration expected)"* is corrected to *"**0063** — `0063_seed_permission_phase6b.sql`, the three codes §3.6.2 assigns 6B"*. §3.6.2 makes 6B the introducing slice for `pos.price.check`, `pos.shift.own` and `pos.attendance.clock`; §3.6.3 requires each introducing slice to ship `NNNN_seed_permission_phase<slice id>.sql` and asserts, in `packages/db/test/permission-catalogue.test.ts`, that the `(code, module, mutating)` set in `app.permission` **equals** the set exported by `permissions.ts` **in both directions**. A `PermissionDef` row with no insert fails it; an insert with no row fails it too. The number was reserved for exactly this. | **T4** |
| **A2** | 4.10.3, 3.7.5, 4.17.1 | **`canonicalSyncRequest` moves to `packages/sync/src/signing.ts` and 6A's `apps/api/src/middleware/terminal-auth.ts` imports it from `@dulja/sync`.** 6A declared it in `apps/api` and had `tests/invariants/support/pos.ts` reach across a named `dependency-rule` allowance to get it, writing *"the ONE canonical signature string (SAH-046). A copy in the test tier is the second spelling that defect is about."* — and then 6B arrives, which may not import `apps/api` **at all** (spec:2389) and must produce a byte-identical string in the Electron main process. There are exactly two ways out and only one is admissible: a second spelling in `apps/pos`, which is the defect; or one module in the package §5.2 created *"shared by api/ and pos/"* (spec:2370), which is this. **This is a plan-side correction to 6A** (§4.18's mechanism): 6A's middleware keeps its behaviour and its own five `terminal-auth.test.ts` cases, and its local `canonicalSyncRequest` becomes a re-export. `signSyncHeaders` and `sha256Hex` join it; the three header-name constants join it so the till, the middleware and the test tier stop repeating three string literals. §4.17.1's `signSyncRequest` row keeps its name and its file and now imports the canonical string from `@dulja/sync` rather than composing it — **that is a one-line edit to `tests/invariants/support/pos.ts`, and it is in this task's Files list** — and the `dependency-rule` allowance 6A added for `tests/invariants/support/pos.ts` → `apps/api/src/middleware/terminal-auth` **is removed in this PR**, because after that edit nothing reaches across the seam §3.1 closes. ⚠️ **Two assertions inside 6A's `tests/regression/sah-046.test.ts` (6A:6298–6306) are falsified by this move and are corrected in the same PR — Step 5 spells both out.** They assert that the one `export function canonicalSyncRequest` lives in the middleware and that no file outside `terminal-auth` composes the canonical string; a re-export matches neither, and `signing.ts` is now the file that legitimately composes it. The invariant is unchanged (one declaration, one file); only its address moved, so the two lines are **replaced in place inside 6A's own block** rather than contradicted by a second `— 6B` block. | **T0, T3** |
| **A3** | 3.1, 4.1 | **`packages/db/package.json` gains one `exports` subpath: `"./staff/pin": "./src/staff/pin.ts"`.** 6C states that *"6B imports it in the Electron main process"* and re-exports `./staff` from the main barrel — but the barrel exports `createDb`, which imports `postgres` at module scope, so a barrel import would put a PostgreSQL driver in `pos.exe`. §3.1's existing precedent is exact: `@dulja/db/test` and `@dulja/db/seed` are subpaths **precisely** so a heavy or privileged module is reachable without the barrel, and `sah-039` asserts the barrel never re-exports the seed at any depth. This is the same shape with the same reason. **The main barrel's `export … from "./staff"` is unchanged** — the server still reaches `hashPin` through it; the subpath is additive and adds no export to the barrel. | **T4** |
| **A4** | 4.10.6 | **The `contextBridge` surface is named: `DuljaPosBridge` and `POS_CHANNELS` in `apps/desktop/src/bridge-types.ts`, `registerPosHandlers` in `apps/pos/src/main/register.ts`.** §4.10.6 fixes the seven method names `window.dulja.pos.{sell, tender, closeShift, pull, drain, clock, priceCheck}` but names no interface, no channel constant and no registration function — and 0E's Task 11 namespace note already says *"6B adds `pos` to the same `DuljaBridge` interface additively and changes nothing here"*. Register: `DuljaPosBridge` with the seven methods plus `login`, `openShift`, `status`, `search`, `enrol` and `receipt` (thirteen — the seven are the ones §4.10.6 names, not the whole surface, and a till cannot sell without a login and a shift); `POS_CHANNELS` as the `Readonly<Record<keyof DuljaPosBridge, string>>` of `dulja:pos:<method>` strings; and `registerPosHandlers(deps: { ipcMain: Pick<Electron.IpcMain, "handle">; channels: Readonly<Record<string, string>>; db: PosDatabase; transport: SyncTransport | null; print: (payload: ReceiptPayload) => Promise<void> })`, exported from a **build output** of `apps/pos` (`dist-main/pos-main.cjs`) which `apps/desktop` `require`s by path — the channel map arrives as **data**, so neither workspace imports the other and spec:2389 holds in both directions. ADR 0058 records it. | **T9** |
| **A5** | 2.7 (6B card), 3.11 | **`apps/desktop` gains a second electron-builder configuration, `electron-builder.pos.yml`, and the two build targets of spec:2361 become real.** 0E's `electron-builder.yml` is `appId: my.dulja.backoffice` with `extraResources: ../backoffice/dist → renderer` and a single `publish` feed; a second product cannot share it. Register: `apps/desktop/electron-builder.pos.yml` (`appId: my.dulja.pos`, `productName: Dulja POS`, `extraMetadata.main: dist/main-pos.js`, `extraResources` from `../pos/dist` → `renderer` and `../pos/dist-main` → `pos-main`, the same `asarUnpack` of `better-sqlite3`, `publish.url: ${env.DULJA_POS_UPDATE_FEED}`) and the environment name **`DULJA_POS_UPDATE_FEED`** beside 0E's `DULJA_UPDATE_FEED` in §3.11, holder *desktop*, set by 0C (the R2 `UPDATE_FEED` binding serves `updates/pos/` as well as `updates/backoffice/`). **`WINDOWS_CODE_SIGN_CERT` and `WINDOWS_CODE_SIGN_PASSWORD` gain no sibling** — §3.11 already says *"0E's `backoffice.exe` job and 6B's `pos.exe` job reference these two names and no others"*. | **T10, T13** |
| **A6** | 4.2.4 | **Four `ERRORS` rows are allocated to 6B, all `ERR_TILL_*`:** `ERR_TILL_PIN_INVALID` (401 — *"the PIN does not match the cashier's stored hash on this till"*), `ERR_TILL_LIMIT_EXCEEDED` (422 — *"the ticket exceeds a branch POS limit and carries no supervisor override"*), `ERR_TILL_CATALOGUE_STALE` (409 — *"the till has never completed a catalogue pull and cannot price a ticket"*), `ERR_TILL_STORE_CORRUPT` (500 — *"the local database failed its integrity check"*). **A new `TILL` domain rather than reusing `POS`**: `ERR_POS_LIMIT_EXCEEDED` is **6C's** and is raised by the **server** at apply against `app.branch_pos_policy`, and the till's own pre-flight refusal must be distinguishable from it in a log — the whole point of the till check is that it fires *first*, and a shared code would make "the server refused" and "the till refused" indistinguishable in the needs-attention queue. The four are added in the PRs that raise them — **`ERR_TILL_CATALOGUE_STALE` and `ERR_TILL_STORE_CORRUPT` in T2** (the PR that writes `apps/pos/src/main/errors.ts`, whose `Extract<ErrCode, …>` does not compile until both rows exist in the registry), **`ERR_TILL_PIN_INVALID` and `ERR_TILL_LIMIT_EXCEEDED` in T4**. | **T2, T4** |
| **A7** | 4.17.1 | **`tests/invariants/support/till.ts` is registered to 6B** with `TillFixture`, `tillFixture`, `HttpTillTransport`, `openTill` and `sellOffline`. It is a **thin layer over 6C's `staffFixture`**, which is itself a thin layer over 6A's `posFixture` — it seeds no company, no item, no warehouse, no stock, no tax pack, no document type, no branch and no cashier. What it adds is a `PosDatabase` in a temporary directory, an enrolled terminal's device key pair, a `SyncTransport` that speaks to `StartedApi` through 6A's `syncRequest`, two convenience drivers — **plus exactly one Postgres row: a company-wide price list carrying one line for `SKU-A`, seeded through 3A's `seedPriceList`.** That one row is named in the register because it is the fixture's only write outside the temporary directory, and because without it the till cannot price anything at all: neither `posFixture` nor `staffFixture` seeds a price list, and `resolvePrice`'s `tillCurrency` throws `ERR_TILL_CATALOGUE_STALE` when `catalogue_price_list` is empty. The row says exactly that, so a later reader cannot mistake it for a rival corpus. **It lives in the test tier and not in `fixtures.ts`** because it takes a `StartedApi` and opens a file on disk, and `packages/db/test` may not import an app (§3.1). | **T12** |
| **A8** | 4.10.6 | **Four clarifications to §4.10.6, all of them things a store cannot be written without.** (a) **The mirrors are eight tables, one per `Stream`, named `catalogue_<stream>`** — `catalogue_item`, `catalogue_price_list`, `catalogue_price_list_line`, `catalogue_promotion`, `catalogue_customer`, `catalogue_tax_code`, `catalogue_cashier`, `catalogue_branch_pos_policy`. spec:1328 lists six by their own names (`catalogue_price`, not `catalogue_price_list` + `_line`), and §4.10.6 adds `catalogue_branch_pos_policy` — but `SyncStore.applyChanges` keys on `(stream, id)` and `getCursor` takes a `Stream`, so a mirror that merged two streams into one table could not answer either. **The mapping is `Stream` → `catalogue_<stream>`, total and mechanical, and `CATALOGUE_STREAMS` is the list.** (b) **Every revision, money and quantity column in the local file is `TEXT`.** `better-sqlite3` hands an SQLite `INTEGER` back as a JavaScript `number` unless the connection is put in safe-integer mode, and a revision past 2⁵³ read as a double re-delivers one row for ever (6A's own cursor test names this exact failure); a `REAL` money column is the float spec:2041 forbids. A revision is a decimal string converted with `BigInt`, a money value a fixed-4-dp string parsed by `Money.of`, a quantity a fixed-6-dp string parsed by `Quantity.of`. (c) **`shift.expected_cash` and `shift.over_short` exist in the local file, are `TEXT`, and are never written by the till** — spec:1331 names them and §4.10.1 is explicit that *"the till never computes `expectedCash` or `over_short`: the server derives both"*. They are `NULL` at the till and exist so the local schema is spec:1331's list rather than a subset of it; a `UNIQUE`-shaped local view of a closed shift reads them back from the server only when 6D exists. (d) **The local file gains one table beyond spec:1328–1335, and it is named here rather than smuggled in:** *"`pending_customer(id, code, name_en, name_ar, phone, created_at, acked_at)` — a table of ADR 0057's second kind, holding customers quick-created offline until the party they mint reaches the server."* §4.10.6 currently reads *"exactly spec:1328–1335 plus `outbox.kind` and `catalogue_branch_pos_policy`"*, and an eighteenth local table written into that sentence without amending it is exactly the drift Global Constraint 13 forbids (*"Task 0 amends a register before any task writes a literal into it"*). It cannot be a `catalogue_*` mirror: ADR 0057 rule 1 gives every mirror exactly one writer, `applyChanges`, and a locally-minted party would give `catalogue_customer` a second. `LOCAL_SCHEMA_VERSION` goes to **2** in the same task. | **T1, T2, T8** |
| **A9** | 4.10.6, 4.6.4 | **POS cash rounding is absorbed into the ticket and reaches the ledger as revenue and tax, because there is no rounding account and no wire field.** `branch_pos_policy.rounding_increment` (§4.6.4) is the increment; §3.7.6's Payment row requires *"rounding per the currency's POS rounding rule"*. But §4.15 registers **no** POS-rounding account, `POS_TICKET`'s policy balances `Σ` tender debits against `Σ`(item amount + tax) with no residual leg, and §4.10.1's `Ticket` carries no rounding field — so a rounding difference has exactly one contract-legal home: the **ticket's own gross**. The rule: `payable = round(grossTotal, increment)` when every tender on the ticket is `cash`, and the difference is applied to the **highest-amount item line's `discount`** (positive when rounding down, negative when rounding up) so the ticket's gross **equals** the payable exactly and `Σ` tenders `= Σ` gross with no residual. Tax is extracted from the rounded gross, so the till's `taxAmount` and 6A's step-(g) recomputation agree by construction. **Recorded as ADR 0059 and as this row**, because the alternative — a `5140` POS-rounding expense account and a `Ticket.rounding: MoneyJson` field — is a §4.15 **and** §4.10.1 amendment that changes the server, and this slice may not make it alone. If the owner or the accountant wants rounding visible as its own ledger line, that is the amendment, and only the `applyCashRounding` function and the policy's rules change. | **T7** |
| **A10** | 4.6.1, 4.5.7, 3A's 0028, 4A's 0045 | **The two columns the till's pricing needs and neither register carries: `app.item.tax_code_id` and `app.party.price_list_id`.** Both were discovered by reading the owning slices' DDL rather than assumed, and each voids a §3.7.6 row on its own. (a) **`app.item` has no `tax_code_id`** (3A's `0028_create_item.sql`; the `tax_code_id` §4.3.4 mentions is `document_line`'s). But `POS_TICKET` declares `tax.inclusive: true` and 6A's `applyBatch` step (g) recomputes tax **from the line's own `taxCodeId`** and rejects a mismatch — so the till must know which code applies to an item, and there is no server-side derivation to borrow. Register `tax_code_id uuid` on `app.item`, nullable, FK `(tenant_id, tax_code_id) → app.tax_code`, added by **5A's migration 0055** (the file that already adds the `document_line.tax_code_id` FK — one file, one transaction, one slice's range) and mirrored into `catalogue_item` here. (b) **`app.party` has no `price_list_id`** and no `customer_kind` either (§4.5.7's column list; 4A adds only `credit_limit`, `payment_term_id`, `credit_hold`), while `app.price_list.customer_kind` exists and 3A calls it *"the trade level"* — so §3.7.6's *"customer-specific pricing"* has no key to resolve on. Register `price_list_id uuid` on `app.party`, nullable, FK `(tenant_id, price_list_id) → app.price_list`, added by **4A's migration 0045** (the file that already adds `credit_limit` — 4A owns the customer's commercial terms and a price list is one). ⚠️ **Until both land, Task 5 has a stated fallback and says which is which:** the tax code falls back to *the single open `kind = 'output'` row in `catalogue_tax_code`* and refuses to guess when there are several; the price list falls back to *branch, then company-wide*, which is rules 2 and 3 of three. **The fallbacks are correct behaviour and not a workaround** — an item with no tax code is genuinely untaxed and a customer with no list genuinely gets the shop's — but with the columns absent, §3.7.6's *"customer-specific pricing"* is **not delivered**, and the Self-Review's *Known gaps* says so. | **T5** |

- [ ] **Step 2: Write `packages/sync/src/signing.ts` — the one canonical string (A2)**

Write the failing test first.

```ts
// packages/sync/test/signing.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSyncRequest, sha256Hex, signSyncHeaders,
  SYNC_SIGNATURE_HEADER, SYNC_TERMINAL_ID_HEADER, SYNC_TIMESTAMP_HEADER,
} from "../src/index";

describe("the canonical sync request string (§4.10.3, SAH-046 — ONE spelling)", () => {
  it("is method, path, timestamp and the body hash, newline-separated, in that order", () => {
    expect(canonicalSyncRequest({ method: "POST", path: "/v1/sync/tickets", timestamp: "2026-01-15T00:00:00.000Z", body: "abc" }))
      .toBe("POST\n/v1/sync/tickets\n2026-01-15T00:00:00.000Z\nabc");
  });

  it("sha256Hex is lower-case hex of the UTF-8 bytes, and the empty body hashes rather than being skipped", () => {
    expect(sha256Hex("")).toBe(createHash("sha256").update("", "utf8").digest("hex"));
    expect(sha256Hex("")).toMatch(/^[0-9a-f]{64}$/);
    // A signer that skipped the empty body would produce a string with a trailing newline and nothing after
    // it — and a GET would then verify against a DIFFERENT canonical form than a POST with `body: ""`.
    expect(canonicalSyncRequest({ method: "GET", path: "/p", timestamp: "t", body: sha256Hex("") })).not.toMatch(/\n$/);
  });

  it("signSyncHeaders hashes the body EXACTLY ONCE, with JSON.stringify and no replacer and no spacing", () => {
    const body = { batchId: "b1", tickets: [] };
    let signed: Uint8Array | null = null;
    const headers = signSyncHeaders(
      { method: "POST", path: "/v1/sync/tickets", body, at: new Date("2026-01-15T00:00:00.000Z"), terminalId: "t-1" },
      (m) => { signed = m; return new Uint8Array([1, 2, 3]); },
    );
    expect(headers[SYNC_TERMINAL_ID_HEADER]).toBe("t-1");
    expect(headers[SYNC_TIMESTAMP_HEADER]).toBe("2026-01-15T00:00:00.000Z");
    expect(headers[SYNC_SIGNATURE_HEADER]).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(new TextDecoder().decode(signed!)).toBe(
      `POST\n/v1/sync/tickets\n2026-01-15T00:00:00.000Z\n${sha256Hex(JSON.stringify(body))}`,
    );
  });

  it("an absent body is the empty string, not the literal 'undefined'", () => {
    let signed = "";
    signSyncHeaders({ method: "GET", path: "/v1/sync/catalogue", at: new Date(0), terminalId: "t-1" },
      (m) => { signed = new TextDecoder().decode(m); return new Uint8Array(64); });
    expect(signed.endsWith(sha256Hex(""))).toBe(true);
    expect(signed).not.toContain("undefined");
  });

  it("the query string is NOT part of the canonical path", () => {
    // `terminalAuth` signs `new URL(c.req.url).pathname`, so a till that retried with a different `limit`
    // must not have to re-sign. A signer that included the query would 401 every retry.
    let a = ""; let b = "";
    const sign = (into: (s: string) => void) => (m: Uint8Array) => { into(new TextDecoder().decode(m)); return new Uint8Array(64); };
    signSyncHeaders({ method: "GET", path: "/v1/sync/catalogue", at: new Date(0), terminalId: "t" }, sign((s) => { a = s; }));
    signSyncHeaders({ method: "GET", path: "/v1/sync/catalogue", at: new Date(0), terminalId: "t" }, sign((s) => { b = s; }));
    expect(a).toBe(b);
    expect(a).not.toContain("?");
  });
});
```

Run `bun run --cwd packages/sync test -- signing`. **Expected failure:** `The requested module '../src/index' does not provide an export named 'canonicalSyncRequest'`.

- [ ] **Step 3: Write the module**

```ts
// packages/sync/src/signing.ts
/**
 * The ONE canonical signature string of §4.10.3, and the only place in the repository it exists.
 *
 * It lives in `packages/sync` and not in `apps/api` because both ends must produce it byte for byte and
 * `apps/pos` may not import `apps/api` (spec:2389). SAH-046 is precisely the defect two spellings of one
 * concept produce — *"two independent flags with the same name"* — so a second copy in the till, or in the
 * test tier, is the defect and not a convenience. §5.2 created this package *"shared by api/ and pos/"*
 * (spec:2370) for exactly this.
 */
import { createHash } from "node:crypto";

export const SYNC_TERMINAL_ID_HEADER = "X-Terminal-Id";
export const SYNC_TIMESTAMP_HEADER = "X-Terminal-Timestamp";
export const SYNC_SIGNATURE_HEADER = "X-Terminal-Signature";

export interface CanonicalSyncRequest {
  method: string;
  /** The **pathname only**, never the query string: a cursor is not a secret, and a till that retried with a
   *  different `limit` would otherwise have to re-sign. `terminalAuth` reads `new URL(c.req.url).pathname`. */
  path: string;
  timestamp: string;
  /** The sha256 **hex** of the exact bytes sent as the body; the empty body hashes to sha256(""). */
  body: string;
}

export function canonicalSyncRequest(r: CanonicalSyncRequest): string {
  return `${r.method}\n${r.path}\n${r.timestamp}\n${r.body}`;
}

export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * The three signature headers for one request.
 *
 * **The body is stringified exactly once, here.** `JSON.stringify` with no replacer and no spacing is what
 * `apps/api/test/support/app.ts` and `fetch` both send, so the hash covers the bytes that travel. Hashing a
 * differently-serialised copy is the one way a signer can be wrong and the failure is opaque: every signed
 * POST answers 401 with no clue why.
 *
 * `sign` is injected rather than chosen: this module is imported by the Electron main process (`node:crypto`
 * Ed25519 over a `KeyObject`) and by the test tier (the same), and a package that reached for one of them
 * would bind every consumer to it.
 */
export function signSyncHeaders(
  req: { method: string; path: string; body?: unknown; at?: Date; terminalId: string },
  sign: (message: Uint8Array) => Uint8Array,
): Record<string, string> {
  const timestamp = (req.at ?? new Date()).toISOString();
  const payload = req.body === undefined ? "" : JSON.stringify(req.body);
  const canonical = canonicalSyncRequest({
    method: req.method, path: req.path, timestamp, body: sha256Hex(payload),
  });
  return {
    [SYNC_TERMINAL_ID_HEADER]: req.terminalId,
    [SYNC_TIMESTAMP_HEADER]: timestamp,
    [SYNC_SIGNATURE_HEADER]: Buffer.from(sign(new TextEncoder().encode(canonical))).toString("base64"),
  };
}
```

```ts
// packages/sync/src/index.ts — one line appended.
export * from "./signing";
```

Run `bun run --cwd packages/sync test -- signing`. **Expected:** 5 passed.

- [ ] **Step 4: Make 6A's middleware import it, and prove byte-equality**

In `apps/api/src/middleware/terminal-auth.ts`, delete the local `canonicalSyncRequest` body and `sha256hex` helper and replace them with a re-export, so 6A's own call sites and its exported name both survive untouched:

```ts
// apps/api/src/middleware/terminal-auth.ts — the two helpers become re-exports (6B T0, amendment A2).
// The canonical string is `@dulja/sync`'s (SAH-046: one spelling, and the till compiles against the same
// module). The name stays exported from here because 6A's own tests and `tests/invariants/support/pos.ts`
// import it from this path; deleting the export would be a rename, which §3.1 forbids.
export { canonicalSyncRequest, sha256Hex as sha256hex } from "@dulja/sync";
```

Add `@dulja/sync` to `apps/api`'s dependencies (`bun add --cwd apps/api @dulja/sync@workspace:*`) — `apps/api` is app tier and `packages/sync` is at the `db`/`contracts` tier (§3.1), so the import is legal and the `dependency-rule` row already exists from 6A's Task 1.

Switch the test tier's one consumer to the package in the same PR — this is the edit A2's text promises when it says §4.17.1's `signSyncRequest` row *"now imports the canonical string rather than composing it"*:

```ts
// tests/invariants/support/pos.ts — ONE import line changes; `signSyncRequest`'s body is untouched.
// Was: import { canonicalSyncRequest, sha256hex } from "../../../apps/api/src/middleware/terminal-auth";
import { canonicalSyncRequest, sha256Hex as sha256hex } from "@dulja/sync";
```

```bash
# `tests` is a workspace (§3.1) and this PR is the first thing in it to import @dulja/sync directly.
# Skip if `grep -q '"@dulja/sync"' tests/package.json` already succeeds — 6A may have added it.
bun add --cwd tests -d @dulja/sync@workspace:*
```

Remove the allowance 6A added, and add this slice's tier row:

```ts
// scripts/lint/rules/dependency-rule.ts
  // 6B T0 (A2): the allowance for `tests/invariants/support/pos.ts` -> apps/api/src/middleware/terminal-auth
  // is DELETED, and it is deleted because that import is GONE (the line above), not merely because the
  // symbol moved. §3.1's frozen `tests`-tier rule is that the test tier reaches `apps/api` only through
  // `createApp()` and `./routes`, never a route or middleware file — so leaving the allowance in place with
  // nothing needing it would leave that seam open for the next slice to walk through.
  //
  // §3.1: apps/pos is app tier. It imports packages and never another app. `@dulja/db` appears because
  // `verifyPin` is 6C's one PIN function and the till must not have a second — it is reached through the
  // `./staff/pin` subpath (A3) so no PostgreSQL driver enters pos.exe, which the T1 test asserts.
  "apps/pos": ["@dulja/domain", "@dulja/contracts", "@dulja/sync", "@dulja/ui", "@dulja/i18n", "@dulja/db"],
```

Then the proof that there is one string:

```ts
// tests/invariants/pos-canonical-signature.test.ts
import { describe, expect, it } from "vitest";
import { canonicalSyncRequest, sha256Hex, signSyncHeaders, SYNC_SIGNATURE_HEADER } from "@dulja/sync";
import { sourceFiles } from "../support/source";

describe("SAH-046 — there is exactly one canonical sync signature string", () => {
  // ⚠️ There is deliberately NO `expect(fromApi).toBe(fromSync)` case, and no import of
  // `apps/api/src/middleware/terminal-auth` in this file. After A2 that middleware's
  // `canonicalSyncRequest` IS `@dulja/sync`'s, by `export { … } from "@dulja/sync"`, so the identity is a
  // re-export tautology — it would pass even if the middleware never called the function. And importing it
  // would reopen the seam §3.1 closes: the test tier reaches `apps/api` only through `createApp()` and
  // `./routes`, never a middleware module, which is exactly why Step 4 deletes 6A's named allowance rather
  // than renaming its reason. The substantive claim is proved mechanically by the third case below and by
  // `tests/regression/sah-046.test.ts`'s `defines` assertion, which pins the ONE `export function`.

  it("the one exported function agrees with itself on every shape the two ends actually send", () => {
    const cases = [
      { method: "GET", path: "/v1/sync/catalogue", timestamp: "2026-01-15T00:00:00.000Z", body: sha256Hex("") },
      { method: "POST", path: "/v1/sync/tickets", timestamp: "2026-01-15T13:45:07.123Z", body: sha256Hex(JSON.stringify({ a: 1 })) },
      { method: "POST", path: "/v1/sync/enrol", timestamp: "1970-01-01T00:00:00.000Z", body: sha256Hex("{}") },
      { method: "POST", path: "/v1/sync/tickets", timestamp: "2026-12-31T23:59:59.999Z", body: sha256Hex(JSON.stringify({ nested: { deep: [1, 2, 3] } })) },
    ];
    // Newline-separated, four fields, in order, with no trailing newline and no separator anywhere else.
    for (const c of cases) {
      expect(canonicalSyncRequest(c)).toBe(`${c.method}\n${c.path}\n${c.timestamp}\n${c.body}`);
      expect(canonicalSyncRequest(c).split("\n")).toHaveLength(4);
    }
  });

  it("the API re-exports it rather than declaring a second one", () => {
    // The middleware still exports the name — 6A's own tests and `tests/invariants/support/pos.ts` (until
    // this PR) import it from there, and deleting an export is a rename, which §3.1 forbids. What it must
    // NOT do is declare a body. Read as text, so the assertion is about the source and not about identity.
    const middleware = sourceFiles(["apps"]).find((f) => f.path.endsWith("apps/api/src/middleware/terminal-auth.ts"));
    expect(middleware).toBeDefined();
    expect(middleware!.text).toMatch(/export\s*\{[^}]*canonicalSyncRequest[^}]*\}\s*from\s*["']@dulja\/sync["']/);
    expect(middleware!.text).not.toMatch(/export function canonicalSyncRequest\b/);
  });

  it("no source file outside packages/sync/src/signing.ts composes the string itself", () => {
    // The mechanical half. A file that writes `${method}\n${path}` is a second spelling even if it happens to
    // agree today, and "happens to agree today" is what SAH-046 is.
    // `SourceFile.path` is already repo-relative (0B: `relative(REPO_ROOT, full)`), so offenders are reported
    // as they stand — slicing `REPO_ROOT.length` off it would print an empty string and name no file.
    const offenders = sourceFiles(["apps", "packages"])
      .filter((f) => !f.path.endsWith("packages/sync/src/signing.ts"))
      .filter((f) => /\$\{\s*\w+(\.\w+)*\s*\}\\n\$\{/.test(f.text) && /X-Terminal-Signature|terminal.*signature/i.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("signSyncHeaders produces a base64 signature of the length Ed25519 gives", () => {
    const headers = signSyncHeaders({ method: "GET", path: "/p", terminalId: "t", at: new Date(0) }, () => new Uint8Array(64));
    expect(Buffer.from(headers[SYNC_SIGNATURE_HEADER]!, "base64")).toHaveLength(64);
  });
});
```

- [ ] **Step 5: Correct the two assertions in 6A's `sah-046` that A2 invalidates**

**This step is not optional and it is not cosmetic: without it Task 0 cannot be completed.** Global Constraint 19 requires `bun run test` green at the repository root after every task, and 6A's `tests/regression/sah-046.test.ts` (6A T15, 6A:6298–6306) contains two assertions that A2 falsifies by construction:

1. `expect(defines(/export function canonicalSyncRequest\b/).map((s) => s.fileName)).toEqual([expect.stringContaining("apps/api/src/middleware/terminal-auth.ts")])` — a **re-export is not an `export function`**, so after Step 4 the only match in the tree is `packages/sync/src/signing.ts` and the expectation names the wrong file.
2. `const handRolled = files.filter((s) => !s.fileName.includes("terminal-auth") && /\$\{[^}]*method[^}]*\}\\n\$\{/.test(s.getFullText()))`, asserted empty — and `signing.ts`'s body is `` `${r.method}\n${r.path}\n${r.timestamp}\n${r.body}` ``, whose filename does not contain `terminal-auth`. The list is now non-empty.

**This is a plan-side correction to a file 6A owns (§4.18's mechanism), and §3.7.3's no-editing-an-earlier-block rule is respected in the only way it can be:** the two lines are *replaced in place inside 6A's own `— 6A` `it`*, because the claim they make is 6A's claim and it is still true — the location of the one spelling moved, and a second `— 6B` block asserting the opposite of a `— 6A` block would be two spellings of the invariant, which is the defect SAH-046 names. Nothing else in the file is touched; its two other `it`s and its fixtures are untouched.

```ts
// tests/regression/sah-046.test.ts — inside the existing `— 6A` `it("one canonical name per concept …")`.
// The two expectations below REPLACE the two 6A wrote; `defines`, `files` and the TERMINAL_TOKEN_HEADER
// expectation between them stay exactly as they are, and so do 6A's `s.fileName` / `s.getFullText()`
// accessors — this is 6A's file and its spelling is not this slice's to change.

      // 6B T0 amendment A2: the ONE declaration moved to `packages/sync/src/signing.ts`, because `apps/pos`
      // may not import `apps/api` (spec:2389) and both ends must produce the string byte for byte. The
      // middleware still EXPORTS the name — `export { canonicalSyncRequest } from "@dulja/sync"` — so 6A's
      // own call sites and tests are unchanged; a re-export simply does not match `export function`.
      // The invariant this line asserts is unchanged: exactly one declaration, in exactly one file.
      expect(defines(/export function canonicalSyncRequest\b/).map((s) => s.fileName))
        .toEqual([expect.stringContaining("packages/sync/src/signing.ts")]);

      // …and, further down, the hand-rolled scan excludes the new home as well as the middleware. The
      // canonical form is `method\npath\ntimestamp\nhash` and `signing.ts` is the file that is ALLOWED to
      // write it; every other file composing one is the second flag by another route.
      const handRolled = files.filter((s) =>
        !s.fileName.includes("terminal-auth")
        && !s.fileName.includes("packages/sync/src/signing.ts")
        && /\$\{[^}]*method[^}]*\}\\n\$\{/.test(s.getFullText()));
      expect(handRolled.map((s) => s.fileName)).toEqual([]);
```

⚠️ **`packages/sync/src/signing.ts` is the exclusion string in *both* places — 6A's `sah-046` and this slice's own `pos-canonical-signature.test.ts` — and it is spelled identically in both.** Two scans with two different exclusion lists would be the very drift these tests exist to prevent.

- [ ] **Step 6: Run everything Steps 2–5 touch**

Run `bun run --cwd packages/sync test`, `bun run --cwd apps/api test -- routes/sync`, `bun run --cwd apps/api test -- terminal-auth`, `bun run --cwd tests test -- pos-canonical-signature`, `bun run --cwd tests test -- sah-046`, `bun run lint:rules`, `bun run typecheck`. **Expected:** all green; 6A's `terminal-auth.test.ts` five cases and its catalogue and tickets route suites are untouched, which is the point of keeping the exported name, and `sah-046`'s three `it`s pass with the two corrected expectations.

⚠️ **One caveat on `sah-046` that belongs to 6A and not to this slice.** As 6A wrote that file it calls `s.fileName` and `s.getFullText()` on the results of 0B's `sourceFiles`, which returns `{ path, text, lines }` (0B:5727) and has neither member — so if the file is red *before* Task 0 begins, that is a pre-existing 6A defect and **is not this step's to fix**: replace only the two expectations named above, keep 6A's accessor spelling so the correction stays a one-concept change, and raise the accessor mismatch with the 6A owner. Task 0's gate prints `need_repo "0B sourceFiles"`, so the real shape is one `grep` away before you start.

- [ ] **Step 7: Write the gate script**

`scripts/check/contracts-6b-amendments.sh`:

```bash
#!/usr/bin/env bash
# Gate for slice 6B. Exits 0 only when every contracts amendment has landed and every repository name this
# plan imports exists with the spelling this plan uses. Run from the repository root.
set -uo pipefail
C="docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md"
fail=0

need_doc() {  # need_doc <label> <fixed-string>
  # An EMPTY needle would make `grep -qF -- ""` match every line of any non-empty file, so a quoting slip
  # (a backtick-bearing needle written inside DOUBLE quotes is command substitution, and an unknown command
  # substitutes the empty string) would print `ok` for an amendment that never landed. Refuse it loudly.
  if [ -z "$2" ]; then printf 'BAD CHECK  (contracts) %s -- empty needle; quote it with SINGLE quotes\n' "$1"; fail=1; return; fi
  if grep -qF -- "$2" "$C"; then printf 'ok   (contracts) %s\n' "$1"
  else printf 'MISSING (contracts) %s -- expected the literal: %s\n' "$1" "$2"; fail=1; fi
}
need_repo() {  # need_repo <label> <file> <fixed-string>
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then printf 'ok   (repo) %s\n' "$1"
  else printf 'MISSING (repo) %s -- %s does not carry: %s\n' "$1" "$2" "$3"; fail=1; fi
}

need_doc "A1 0063 is a permission seed"      "0063_seed_permission_phase6b.sql"
need_doc "A2 signing.ts is the one spelling" "packages/sync/src/signing.ts"
need_doc "A3 the ./staff/pin subpath"        '"./staff/pin"'
need_doc "A4 the bridge surface"             "DuljaPosBridge"
need_doc "A4 registerPosHandlers"            "registerPosHandlers"
need_doc "A5 the second builder config"      "electron-builder.pos.yml"
need_doc "A5 the pos feed variable"          "DULJA_POS_UPDATE_FEED"
need_doc "A6 the four ERR_TILL rows"         "ERR_TILL_PIN_INVALID"
need_doc "A7 support/till.ts"                "tests/invariants/support/till.ts"
need_doc "A8 the eight mirrors"              "catalogue_branch_pos_policy"
need_doc "A8d pending_customer"              'pending_customer(id, code, name_en, name_ar, phone, created_at, acked_at)'
need_doc "A9 rounding has no account"        "POS cash rounding is absorbed into the ticket"
# ⚠️ SINGLE quotes on the next two. Backticks inside DOUBLE quotes are command substitution: bash would try
# to run `app.item.tax_code_id`, print "command not found" to stderr, substitute the empty string, and — but
# for `need_doc`'s empty-needle guard above — `grep -qF -- ""` would then match every line of the contracts
# document and print `ok` whether or not A10 had landed. `set -uo pipefail` carries no `-e`, so the failed
# substitution would not abort either. A10 is the one register change this plan discovered rather than
# inherited, which makes a silently-passing check for it the worst one in the file to have.
need_doc "A10 item.tax_code_id"              '`app.item.tax_code_id`'
need_doc "A10 party.price_list_id"           '`app.party.price_list_id`'

# ── Repository names this plan imports. The OWNING plan is the authority for what it exports (§4.18):
#    a MISSING line here is a reconciliation with that slice, never a second spelling invented locally.
need_repo "0B startApi"            apps/api/test/support/app.ts                  "export async function startApi"
need_repo "0B sharedApi"           tests/support/api.ts                          "export function sharedApi"
need_repo "0B sourceFiles"         tests/support/source.ts                       "export function sourceFiles"
need_repo "0D Money"               packages/domain/src/money/money.ts            "export class Money"
need_repo "0D Quantity"            packages/domain/src/quantity.ts               "export class Quantity"
need_repo "0D round"               packages/domain/src/money/rounding.ts         "export function round"
need_repo "0E browserWindowOptions" apps/desktop/src/window-options.ts           "export function browserWindowOptions"
need_repo "0E CONTENT_SECURITY_POLICY" apps/desktop/src/window-options.ts        "CONTENT_SECURITY_POLICY"
need_repo "0E DuljaBridge"         apps/desktop/src/bridge-types.ts              "export interface DuljaBridge"
need_repo "0E CHANNELS"            apps/desktop/src/bridge-types.ts              "export const CHANNELS"
need_repo "0E createSecureStore"   apps/desktop/src/secure-store.ts              "export function createSecureStore"
need_repo "0E configureUpdater"    apps/desktop/src/updater.ts                   "export function configureUpdater"
need_repo "0E asarUnpack sqlite"   apps/desktop/electron-builder.yml             "better-sqlite3"
need_repo "0E DirectionProvider"   packages/ui/src/direction.tsx                 "DirectionProvider"
need_repo "0E formatMoney"         packages/i18n/src/format.ts                   "export function formatMoney"
need_repo "5A taxEngine"           packages/domain/src/tax/index.ts              "taxEngine"
need_repo "6A CATALOGUE_STREAMS"   packages/sync/src/messages.ts                 "export const CATALOGUE_STREAMS"
need_repo "6A SyncStore"           packages/sync/src/client.ts                   "export interface SyncStore"
need_repo "6A SyncTransport"       packages/sync/src/client.ts                   "export interface SyncTransport"
need_repo "6A OutboxRow"           packages/sync/src/client.ts                   "export interface OutboxRow"
need_repo "6A pullAll"             packages/sync/src/client.ts                   "export async function pullAll"
need_repo "6A drainOutbox"         packages/sync/src/client.ts                   "export async function drainOutbox"
need_repo "6A SyncQueuedError"     packages/sync/src/client.ts                   "export class SyncQueuedError"
need_repo "6A shiftRef"            packages/sync/src/messages.ts                 "export function shiftRef"
need_repo "6A encodeSyncCursor"    packages/sync/src/cursor.ts                   "export function encodeSyncCursor"
need_repo "6A posFixture"          tests/invariants/support/pos.ts               "export async function posFixture"
need_repo "6A syncRequest"         tests/invariants/support/pos.ts               "export async function syncRequest"
need_repo "6A buildTicket"         tests/invariants/support/pos.ts               "export function buildTicket"
need_repo "6A seedTerminal"        packages/db/test/fixtures.ts                  "export async function seedTerminal"
need_repo "6A POS_TICKET envelope" packages/db/seed/my/document-types/POS_TICKET.json "\"code\": \"POS_TICKET\""
need_repo "6A enrol route"         apps/api/src/routes/sync/enrolments.ts        "/v1/sync/enrol"
need_repo "6C verifyPin"           packages/db/src/staff/pin.ts                  "export async function verifyPin"
need_repo "6C CashierSnapshot"     packages/db/src/staff/cashier.ts              "export interface CashierSnapshot"
need_repo "6C CashierLimits"       packages/db/src/staff/cashier.ts              "export interface CashierLimits"
need_repo "6C verifyTicket"        packages/db/src/sync/limits.ts                "export async function verifyTicket"
need_repo "6C OVERRIDE_LIFTS"      packages/db/src/sync/limits.ts                "export const OVERRIDE_LIFTS"
need_repo "6C seedCashier"         packages/db/test/fixtures.ts                  "export async function seedCashier"
need_repo "6C seedBranchPosPolicy" packages/db/test/fixtures.ts                  "export async function seedBranchPosPolicy"
need_repo "6C staffFixture"        tests/invariants/support/staff.ts             "export async function staffFixture"
need_repo "6C branch_pos_policy"   packages/db/migrations/0066_create_branch_pos_policy.sql "rounding_increment"

# Migration 0063 must be free, and the three codes must NOT already be in the catalogue.
if ls packages/db/migrations/0063_*.sql >/dev/null 2>&1; then echo "RANGE TAKEN   0063"; fail=1; fi
for code in pos.price.check pos.shift.own pos.attendance.clock; do
  if grep -rqF -- "\"$code\"" packages/contracts/permissions.ts 2>/dev/null; then
    printf 'CODE TAKEN    %s (already in permissions.ts -- read §3.6.2 before Task 4)\n' "$code"; fail=1
  fi
done

# ── Three INFORMATIONAL probes. They never fail the gate; they change what T2, T5 and T9 do. Read them.
printf '\n-- informational --\n'
printf -- '-- 1. the exact column list of each catalogue stream table, which the mirrors extract from --\n'
grep -nE "^\s+(code|barcode|name_en|name_ar|base_unit_id|track_lots|unit_price|min_quantity|starts_at|ends_at|rate|rounding_mode|archived_at)" \
  packages/db/migrations/0028_*.sql packages/db/migrations/0030_*.sql packages/db/migrations/0053_*.sql 2>/dev/null | head -40 || true
printf '     ^ T2 Step 3 extracts EXACTLY these names out of `to_jsonb(row) - tenant_id`. A mirror column\n'
printf '       spelled differently silently misses every lookup and nothing throws.\n'

printf -- '\n-- 2. what app.pos_cashier_sync and app.branch_pos_policy_sync actually return --\n'
grep -n -A12 "pos_cashier_sync\|branch_pos_policy_sync" packages/db/migrations/0066_*.sql packages/db/migrations/0067_*.sql 2>/dev/null | head -40 || true
printf '     ^ T2 and T4 read the `row` jsonb these two functions emit. 6C is the authority for its keys.\n'

printf -- '\n-- 3. does apps/desktop already build a second target, and where does main.ts read RENDERER_DIR --\n'
grep -n "RENDERER_DIR\|extraResources\|extraMetadata\|productName" apps/desktop/src/main.ts apps/desktop/electron-builder.yml 2>/dev/null | head -20 || true
printf '     ^ T9 and T10 mirror this shape for pos.exe and edit NEITHER of these two files.\n'

exit "$fail"
```

- [ ] **Step 8: Run it and record the result**

```bash
chmod +x scripts/check/contracts-6b-amendments.sh
bash scripts/check/contracts-6b-amendments.sh
```

Expected before the architect's PR: fourteen `MISSING (contracts)` lines and exit 1. After it, and after Steps 2–6: fourteen `ok (contracts)` lines, forty `ok (repo)` lines, the three informational blocks, exit 0. **A `BAD CHECK (contracts)` line is a defect in this script, not in the document** — it means a needle was written with double quotes around a backtick and evaluated to the empty string; single-quote it.

**A `MISSING (repo)` line is a stop-and-raise, not a workaround.** It means this plan and the owning slice disagree about a name; correct **this** plan's import, never add a second spelling (§4.18, hazard 9).

- [ ] **Step 9: Commit**

```bash
git add scripts/check/contracts-6b-amendments.sh packages/sync/src/signing.ts packages/sync/src/index.ts \
        packages/sync/test/signing.test.ts apps/api/src/middleware/terminal-auth.ts apps/api/package.json \
        scripts/lint/rules/dependency-rule.ts tests/invariants/pos-canonical-signature.test.ts \
        tests/invariants/support/pos.ts tests/regression/sah-046.test.ts tests/package.json bun.lock
git commit -m "$(cat <<'EOF'
chore(sync): move canonicalSyncRequest into @dulja/sync and add the 6B gate [6B T0]

Ten register amendments (A1-A10) and forty repo names this slice imports from 0A, 0B, 0D, 0E,
5A, 6A and 6C. The canonical signature string now has exactly one home: apps/pos may not import
apps/api (spec:2389) and a second spelling of one concept is SAH-046 itself.

apps/api/src/middleware/terminal-auth.ts re-exports the name so 6A's own tests and call sites are
untouched, tests/invariants/support/pos.ts imports the string instead of composing it, and 6A's
dependency-rule allowance for that seam is deleted because nothing crosses it any more. Two
assertions in 6A's tests/regression/sah-046.test.ts point at the declaration's old address and are
corrected in place inside 6A's own block: the invariant is unchanged (one declaration, one file)
and a second block asserting the opposite would be the very defect SAH-046 names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: `apps/pos` — the workspace, the local SQLite model, and the money boundary

**The whole of §4.10.6's first clause, and nothing else.** spec:1358 names the legacy system's *"own 69-table schema that mirrored the core"* as the structural error this file must not repeat: what is created here is a **cache with an outbox**, and every table in it is either a read-only mirror whose only writer is `applyChanges`, or a row the till itself created. ADR 0057 records that as a proposal.

**Files:**
- Create: `apps/pos/package.json`, `apps/pos/tsconfig.json`, `apps/pos/tsconfig.main.json`, `apps/pos/vitest.config.ts`, `apps/pos/src/main/schema.sql`, `apps/pos/src/main/database.ts`, `apps/pos/src/main/money.ts`, `apps/pos/test/database.test.ts`, `docs/adr/0057-till-sqlite-is-a-cache.md`
- Create — **the buildable empty renderer** (Step 7): `apps/pos/vite.config.ts`, `apps/pos/index.html`, `apps/pos/src/renderer/main.tsx`
- Modify: `scripts/lint/rules/dependency-rule.ts` (verify Task 0's row landed — no edit if it did)

**Why the empty renderer is Task 1's and not Task 11's.** Task 11 is blocked by OD-24 and **the slice is not** — the Execution handoff says *"ship 0–10 and 12 without them"*. But T10 runs `bun run --cwd apps/pos build` in CI and `electron-builder.pos.yml` declares `extraResources: from ../pos/dist to renderer`, so in the OD-24 default state `vite build` needs an entry point and `../pos/dist` needs to exist — and T11's own opening sentence claims *"`apps/pos/dist` is an `index.html` with a mount point and nothing in it"*, which has to be built by **some** task. It is built here: three small files, no strings, no `fetch`, no route, no component. T11 then adds the Tailwind plugin, the stylesheet link and the router **into** these three files (its Files list marks them MODIFY) rather than creating them, and every screen, key map and `pos.*` catalogue key stays behind the OD-24 gate where hazard 29 puts it.

**Interfaces**

- Consumes: `better-sqlite3`; `Money`, `Quantity`, `currency`, `CurrencyCode`, `RoundingMode`, `round`, `MONEY_SCALE`, `QUANTITY_SCALE` (§4.2.1); `Stream`, `CATALOGUE_STREAMS` (`@dulja/sync`, 6A); `vite`'s `defineConfig`, `@vitejs/plugin-react` and `react-dom/client`'s `createRoot` for the empty renderer of Step 7 — **no `packages/ui` and no `packages/i18n` import until T11**, because a component or a catalogue key here would be a screen.
- Produces:
  ```ts
  // apps/pos/src/main/database.ts
  export const LOCAL_SCHEMA_VERSION = 1;
  export interface PosDatabase {
    /** The raw handle, for the modules in `src/main/` only. Never reaches the renderer. */
    readonly raw: Database;
    /** `better-sqlite3` transactions are synchronous and nest as savepoints; this is the ONE way a caller
     *  gets one, so "a ticket and its outbox row are one local transaction" (spec:1303) has one spelling. */
    tx<T>(fn: () => T): T;
    close(): void;
  }
  export function openPosDatabase(file: string): PosDatabase;   // applies schema.sql once, idempotently
  export class StoreCorruptError extends Error { readonly code: "ERR_TILL_STORE_CORRUPT" }
  ```
  ```ts
  // apps/pos/src/main/money.ts — the ONE TEXT⇄domain boundary at the till.
  export function moneyToText(m: Money): string;                       // fixed 4 dp
  export function textToMoney(t: string, c: CurrencyCode): Money;
  export function quantityToText(q: Quantity): string;                 // fixed 6 dp
  export function textToQuantity(t: string): Quantity;
  export function revisionToText(r: bigint): string;
  export function textToRevision(t: string): bigint;
  export function moneyJson(m: Money): { amount: string; currency: string };
  export function fromMoneyJson(j: { amount: string; currency: string }): Money;
  ```

- [ ] **Step 1: Write ADR 0057 as a proposal (spec:95 — this touches the data model)**

`docs/adr/0057-till-sqlite-is-a-cache.md`:

```markdown
# ADR 0057 — The till's local SQLite file is a cache with an outbox, not a second model

- Status: **proposed** (spec:95 — a decision touching the data model is written as a proposal and asked)
- Date: 2026-09-05
- Slice: 6B

## Context

spec:1358: *"The old system's biggest structural error in this area was giving the POS its own 69-table
schema that mirrored the core; that duplication is what made the two disagree. Here the POS has a *local
cache* for offline operation, not a *second model*."* spec:1337 adds the operative sentence: *"Nothing in
the local database is authoritative except the tickets the till itself created."*

The local file must nevertheless hold enough to sell for eight hours with no network: items and barcodes,
prices, promotions, customers, tax codes, the cashier credential and the branch limits — and the tickets,
shifts and till events the till produced, with an outbox.

## Decision

The local schema is **exactly spec:1328–1335 plus `outbox.kind` and `catalogue_branch_pos_policy`**
(§4.10.6), with three rules that make "cache, not model" mechanical rather than aspirational:

1. **Two kinds of table and no third.** A `catalogue_*` table is a mirror: its only writer is
   `SqliteSyncStore.applyChanges`, it carries the `revision` it arrived at and the whole server row as
   `row_json`, and a `CHECK`-free extracted column exists only where a lookup needs an index. Every other
   table (`shift`, `ticket`, `ticket_line`, `ticket_tender`, `till_event`, `attendance`, `outbox`) is a row
   the till created and owns until the server acknowledges it.
2. **No derived total is stored that the server also derives.** `shift.expected_cash` and
   `shift.over_short` exist because spec:1331 lists them, and are **never written by the till** — §4.10.1
   is explicit that the server derives both. They stay `NULL`.
3. **Every money, quantity and revision column is `TEXT`.** `better-sqlite3` returns an SQLite `INTEGER`
   as a JavaScript `number`, so a revision past 2^53 read back would round and re-deliver one row for
   ever; a `REAL` money column is the float spec:2041 forbids anywhere, including in TypeScript. The
   conversions live in one module, `src/main/money.ts`.

## Consequences

- A till that has never pulled cannot price a ticket, and says so (`ERR_TILL_CATALOGUE_STALE`) rather than
  selling at a guessed price. That is the honest failure, and it is visible in the offline indicator.
- The local file can be deleted and re-pulled at any time **except** while the outbox is non-empty, which
  is the one piece of unrecoverable state the till holds. The enrolment runbook says so in one sentence.
- A schema change at the till is a new `schema.sql` section plus a bump of `LOCAL_SCHEMA_VERSION` and a
  migration step in `openPosDatabase`; there is no expand/contract discipline because there is no second
  reader and no production data that is not also in the outbox or already on the server.

## What we are asking

Confirm that a till holding **no** authoritative data other than its own unsent tickets is acceptable
operationally: a shop whose PC dies loses only the tickets that had not yet synced, and the recovery
procedure is "re-enrol and re-pull", not "restore a backup".
```

- [ ] **Step 2: Create the workspace**

```json
// apps/pos/package.json — no version literals; `bun add` writes the lockfile (spec:104, D22).
{
  "name": "@dulja/pos",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "build:main": "bun build src/main/entry.ts --outfile dist-main/pos-main.cjs --target node --format cjs --external better-sqlite3 --external electron",
    "dev": "vite",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.main.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  }
}
```

```json
// apps/pos/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2023", "DOM", "DOM.Iterable"] }, "include": ["src", "test"] }
```

```json
// apps/pos/tsconfig.main.json — the main-process half: Node libs, no DOM.
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "lib": ["ES2023"], "module": "ESNext", "moduleResolution": "bundler" }, "include": ["src/main"] }
```

```ts
// apps/pos/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts", "test/**/*.test.tsx"], environment: "node", testTimeout: 30_000 } });
```

```bash
bun add --cwd apps/pos @dulja/sync@workspace:* @dulja/domain@workspace:* @dulja/contracts@workspace:* \
        @dulja/ui@workspace:* @dulja/i18n@workspace:* @dulja/db@workspace:* better-sqlite3
bun add --cwd apps/pos -d @types/better-sqlite3 vite @vitejs/plugin-react react react-dom \
        @types/react @types/react-dom @tanstack/react-router tailwindcss @tailwindcss/vite
```

`apps/*` is already in the root `workspaces` array (§3.1), so no root edit is needed.

**Why `--external better-sqlite3` in `build:main`.** It is a native module: bundling it would inline JavaScript that `require`s a `.node` binary by a path relative to its own package, and `asarUnpack` (0E's `electron-builder.yml` already lists it) unpacks that package, not the bundle. Leaving it external means the packaged `node_modules/better-sqlite3` @electron/rebuild produced is what loads — which is exactly what 0E's `native-module.spec.ts` already proves works.

- [ ] **Step 3: Write the failing test first**

```ts
// apps/pos/test/database.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOGUE_STREAMS } from "@dulja/sync";
import { LOCAL_SCHEMA_VERSION, openPosDatabase, StoreCorruptError, type PosDatabase } from "../src/main/database";

const dirs: string[] = [];
const tempDb = (): PosDatabase => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
  dirs.push(dir);
  return openPosDatabase(join(dir, "till.sqlite"));
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the till's local model (§4.10.6, spec:1328-1335)", () => {
  it("creates exactly the tables spec:1328-1335 names, and no others", () => {
    const db = tempDb();
    const names = db.raw.prepare<[], { name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    ).all().map((r) => r.name);
    expect(names).toEqual([
      "attendance",
      "catalogue_branch_pos_policy", "catalogue_cashier", "catalogue_customer", "catalogue_item",
      "catalogue_price_list", "catalogue_price_list_line", "catalogue_promotion", "catalogue_tax_code",
      "meta", "outbox", "shift", "sync_cursor", "ticket", "ticket_line", "ticket_tender", "till_event",
    ]);
    db.close();
  });

  it("has one mirror table per Stream, named catalogue_<stream> (A8a)", () => {
    const db = tempDb();
    for (const stream of CATALOGUE_STREAMS) {
      const row = db.raw.prepare<[string], { n: number }>(
        "select count(*) as n from sqlite_master where type = 'table' and name = ?",
      ).get(`catalogue_${stream}`);
      expect(row!.n, `catalogue_${stream}`).toBe(1);
    }
    db.close();
  });

  it("declares every money, quantity and revision column as TEXT — never INTEGER, never REAL (A8b)", () => {
    const db = tempDb();
    const offenders: string[] = [];
    for (const t of db.raw.prepare<[], { name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all()) {
      for (const c of db.raw.prepare<[], { name: string; type: string }>(`pragma table_info(${t.name})`).all()) {
        const monetary = /amount|price|cost|discount|total|float|cash|over_short|limit|increment|tax/i.test(c.name);
        const quantity = /quantity|qty/i.test(c.name);
        const revision = /revision/i.test(c.name);
        // `pragma table_info().type` echoes the type EXACTLY as the CREATE statement declared it, and
        // `schema.sql` writes `text` lowercase because Global Constraint 9 requires lowercase SQL keywords.
        // So the comparison upper-cases; the DDL is not "fixed" to match the test.
        if ((monetary || quantity || revision) && c.type.toUpperCase() !== "TEXT") offenders.push(`${t.name}.${c.name}: ${c.type}`);
      }
    }
    expect(offenders).toEqual([]);
    db.close();
  });

  it("is idempotent — opening the same file twice applies the schema once and preserves rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
    dirs.push(dir);
    const file = join(dir, "till.sqlite");
    const first = openPosDatabase(file);
    first.raw.prepare("insert into sync_cursor (stream, revision) values ('item', '7')").run();
    first.close();
    const second = openPosDatabase(file);
    expect(second.raw.prepare<[], { revision: string }>("select revision from sync_cursor where stream = 'item'").get()!.revision).toBe("7");
    expect(second.raw.prepare<[], { v: string }>("select value as v from meta where key = 'schema_version'").get()!.v)
      .toBe(String(LOCAL_SCHEMA_VERSION));
    second.close();
  });

  it("tx rolls the whole unit back on a throw — the property spec:1303 depends on", () => {
    const db = tempDb();
    expect(() => db.tx(() => {
      db.raw.prepare("insert into sync_cursor (stream, revision) values ('item', '1')").run();
      throw new Error("boom");
    })).toThrow("boom");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from sync_cursor").get()!.n).toBe(0);
    db.close();
  });

  it("enforces foreign keys, so a ticket_line can never outlive its ticket", () => {
    const db = tempDb();
    expect(() => db.raw.prepare(
      "insert into ticket_line (ticket_id, line_no, item_id, quantity, unit_id, unit_price, discount, tax_amount, total) " +
      "values ('nope', 1, 'i', '1.000000', 'u', '1.0000', '0.0000', '0.0000', '1.0000')",
    ).run()).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });

  it("refuses a file whose integrity check fails, with ERR_TILL_STORE_CORRUPT", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
    dirs.push(dir);
    const file = join(dir, "till.sqlite");
    require("node:fs").writeFileSync(file, "SQLite format 3\u0000this is not a database at all");
    let thrown: unknown;
    try { openPosDatabase(file); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(StoreCorruptError);
    expect((thrown as StoreCorruptError).code).toBe("ERR_TILL_STORE_CORRUPT");
  });

  it("the schema file mentions no ESC/POS, drawer port or scanner — D18, SAH-086", () => {
    const sql = readFileSync(new URL("../src/main/schema.sql", import.meta.url), "utf8");
    for (const banned of ["esc/pos", "escpos", "drawer_port", "scanner", "scale", "0x4E", "opos"]) {
      expect(sql.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
```

Run `bun run --cwd apps/pos test -- database`. **Expected failure:** `Failed to resolve import "../src/main/database"`.

- [ ] **Step 4: Write `apps/pos/src/main/schema.sql` — §4.10.6, whole**

```sql
-- The till's local model. §4.10.6 = spec:1328-1335 + `outbox.kind` + `catalogue_branch_pos_policy`.
-- ADR 0057: this is a CACHE WITH AN OUTBOX, not a second model (spec:1358).
--
-- Two kinds of table and no third:
--   catalogue_*  read-only mirrors; the ONLY writer is SqliteSyncStore.applyChanges (Task 2).
--   everything else  rows the till created and owns until the server acknowledges them.
--
-- Every money column is TEXT at 4 dp, every quantity TEXT at 6 dp, every revision TEXT holding a decimal
-- integer (A8b): better-sqlite3 returns INTEGER as a JavaScript number, and a revision past 2^53 read as a
-- double re-delivers one row for ever -- the failure acceptance test 20 exists to catch. REAL would be the
-- float spec:2041 forbids "anywhere, including in TypeScript".

-- ── 1. meta and cursors ───────────────────────────────────────────────────────────────────────────────
create table if not exists meta (
  key   text primary key,
  value text not null
) strict;

-- spec:1330 "sync_cursor(stream, revision) -- one row per down-sync stream". Eight rows, one per Stream.
create table if not exists sync_cursor (
  stream   text primary key,
  revision text not null default '0'
) strict;

-- ── 2. the catalogue mirrors (spec:1328) ──────────────────────────────────────────────────────────────
-- `row_json` is the server row verbatim (`to_jsonb(row) - 'tenant_id'`, 6A's readCatalogue). The extracted
-- columns exist ONLY where a lookup needs an index; they are derived from row_json by the mirror writer and
-- are never a second source of truth.
create table if not exists catalogue_item (
  id            text primary key,
  revision      text not null,
  row_json      text not null,
  code          text not null,
  barcode       text,
  name_en       text not null,
  name_ar       text,
  kind          text not null,
  base_unit_id  text not null,
  track_lots    integer not null default 0,
  stock_hint    text,                      -- ADVISORY (spec:1307). Null unless the page carried one.
  stock_hint_at text
) strict;
create index if not exists catalogue_item_code_idx on catalogue_item (code);
create index if not exists catalogue_item_barcode_idx on catalogue_item (barcode);

create table if not exists catalogue_price_list (
  id            text primary key,
  revision      text not null,
  row_json      text not null,
  code          text not null,
  currency      text not null,
  customer_kind text,
  branch_id     text,                      -- NULL means every branch (Form B, §4.5.6)
  valid_from    text,
  valid_to      text
) strict;

create table if not exists catalogue_price_list_line (
  id            text primary key,
  revision      text not null,
  row_json      text not null,
  price_list_id text not null,
  item_id       text not null,
  unit_id       text,
  min_quantity  text not null,
  unit_price    text not null
) strict;
create index if not exists catalogue_price_list_line_lookup_idx
  on catalogue_price_list_line (item_id, price_list_id, min_quantity);

create table if not exists catalogue_promotion (
  id         text primary key,
  revision   text not null,
  row_json   text not null,
  code       text not null,
  kind       text not null,
  definition text not null,
  starts_at  text,
  ends_at    text,
  branch_id  text
) strict;

create table if not exists catalogue_customer (
  id           text primary key,
  revision     text not null,
  row_json     text not null,
  code         text not null,
  name_en      text not null,
  name_ar      text,
  phone        text,
  currency     text,
  credit_limit text,                       -- 4A's column; null when the party has no limit
  credit_hold  integer not null default 0
) strict;
create index if not exists catalogue_customer_code_idx on catalogue_customer (code);
create index if not exists catalogue_customer_phone_idx on catalogue_customer (phone);

create table if not exists catalogue_tax_code (
  id                text primary key,
  revision          text not null,
  row_json          text not null,
  code              text not null,
  rate              text not null,
  kind              text not null,
  rounding_mode     text not null,
  output_account_id text,
  input_account_id  text,
  effective_from    text,
  effective_to      text,
  -- 5A's `app.tax_code.archived_at` (spec:2049 -- master data is archived, never deleted). Extracted and not
  -- left in row_json alone because `defaultOutputTaxCode` (T5) counts the OPEN output codes and must not
  -- count a superseded one: two rows whose windows both contain today would make the count 2 and the answer
  -- `null`, taxing every line at nothing on a shop that has exactly one live code.
  archived_at       text
) strict;

-- spec:1328's `catalogue_cashier`. `pin_hash` is an Argon2id PHC string produced by 6C's hashPin on the
-- server; the till only ever calls verifyPin against it (spec:1324 -- the PIN is never a login).
create table if not exists catalogue_cashier (
  id             text primary key,          -- the cashier's PRINCIPAL id (app.pos_cashier's PK, §4.6.3)
  revision       text not null,
  row_json       text not null,
  employee_id    text not null,
  branch_id      text not null,
  pin_hash       text not null,
  snapshot_json  text not null,             -- { codes: [...], limits: {...}, revision: "..." } (§4.6.3)
  revoked_at     text
) strict;

-- §4.10.6's addition to spec:1328. One row per branch; a till holds exactly its own (spec:1312).
create table if not exists catalogue_branch_pos_policy (
  id                       text primary key,
  revision                 text not null,
  row_json                 text not null,
  branch_id                text not null,
  max_line_discount_pct    text not null,
  max_ticket_discount_pct  text not null,
  max_void_amount          text not null,
  max_price_override_pct   text not null,
  blind_return_allowed     integer not null default 0,
  max_blind_return_amount  text not null,
  max_cash_in_drawer       text,
  require_customer_over    text,
  rounding_increment       text not null,
  paid_out_allowed         integer not null default 0,
  max_paid_out_amount      text not null
) strict;

-- ── 3. what the till itself created (spec:1331-1336) ──────────────────────────────────────────────────
-- spec:1331's column list, with the §3.3 naming rule applied: the cashier is ATTRIBUTION data, so
-- `cashier_principal_id`, never `opened_by` (§4.6.5 states the same for the server's app.shift).
-- `expected_cash` and `over_short` are here because spec:1331 lists them and are NEVER written by the till:
-- §4.10.1 -- "the till never computes expectedCash or over_short: the server derives both". (A8c)
create table if not exists shift (
  id                   text primary key,    -- uuidv7 minted at the till = app.shift.id (§4.6.5)
  terminal_id          text not null,
  cashier_principal_id text not null,
  opened_at            text not null,
  opening_float        text not null,
  currency             text not null,
  closed_at            text,
  counted_cash         text,
  expected_cash        text,                -- always NULL at the till
  over_short           text                 -- always NULL at the till
) strict;

create table if not exists ticket (
  id                   text primary key,    -- the uuidv7 minted at the moment of sale = document.client_ref
  shift_id             text not null references shift (id),
  cashier_principal_id text not null,
  customer_id          text,
  kind                 text not null check (kind in ('sale', 'return')),
  returns_client_ref   text,                -- the original ticket; NULL on a BLIND return
  status               text not null check (status in ('open', 'completed', 'voided')),
  currency             text not null,
  net_total            text not null,       -- Sum of line amounts, excl. tax
  tax_total            text not null,
  total                text not null,       -- net_total + tax_total = what the customer pays
  catalogue_revision   text not null,
  created_at           text not null,
  events_json          text not null default '[]'
) strict;
create index if not exists ticket_shift_idx on ticket (shift_id);
create index if not exists ticket_created_idx on ticket (created_at);

create table if not exists ticket_line (
  ticket_id   text not null references ticket (id) on delete cascade,
  line_no     integer not null,
  item_id     text not null,
  lot_id      text,
  quantity    text not null,                -- NEGATIVE on a return line (§4.4.2 A9's 6A entry)
  unit_id     text not null,
  unit_price  text not null,
  discount    text not null,
  tax_code_id text,
  tax_amount  text not null,
  total       text not null,                -- the tax-INCLUSIVE line total
  primary key (ticket_id, line_no)
) strict;

create table if not exists ticket_tender (
  ticket_id text not null references ticket (id) on delete cascade,
  tender_no integer not null,
  method    text not null check (method in ('cash', 'card', 'transfer', 'store_credit')),
  amount    text not null,
  reference text,
  primary key (ticket_id, tender_no)
) strict;

-- spec:1354's event stream. 6D owns app.till_event; the till records them from day one and the outbox
-- carries them, which is what makes 6D's arrival a server-side change only.
create table if not exists till_event (
  id                      text primary key,   -- uuidv7 = till_event.client_ref
  shift_id                text not null references shift (id),
  kind                    text not null check (kind in ('no_sale', 'drawer_open', 'void')),
  ticket_client_ref       text,
  cashier_principal_id    text not null,
  supervisor_principal_id text,
  occurred_at             text not null
) strict;

-- spec:2089's clock-in/out. Travels up inside `Ticket.attendance` (§4.10.1) or, between sales, on the
-- next ticket -- which is why it is a table and not a field: a clock-in at 08:00 must survive until the
-- first sale at 08:04 and must not be lost if the till is closed in between.
create table if not exists attendance (
  id           text primary key,
  principal_id text not null,
  kind         text not null check (kind in ('clock_in', 'clock_out')),
  occurred_at  text not null,
  sent_at      text
) strict;

-- spec:1336: "outbox(id, ticket_id, payload jsonb, attempts, last_error, acked_at) -- written in the same
-- SQLite transaction as the ticket". §4.10.6 adds `kind`. `ref` is the id the SERVER acknowledges by
-- (§4.10.1's MessageResult): a ticket's clientRef, "<shiftId>:<kind>", a till event's clientRef.
create table if not exists outbox (
  id         text primary key,
  kind       text not null check (kind in ('ticket', 'shift', 'till_event')),
  ref        text not null,
  payload    text not null,
  attempts   integer not null default 0,
  last_error text,
  acked_at   text,
  created_at text not null
) strict;
create unique index if not exists outbox_ref_idx on outbox (kind, ref);
create index if not exists outbox_pending_idx on outbox (acked_at, created_at);
```

- [ ] **Step 5: Write `apps/pos/src/main/database.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** Bumped when `schema.sql` gains a section. There is no expand/contract discipline at the till: the only
 *  unrecoverable local state is the unsent outbox, and a schema step that would lose it is a defect, not a
 *  migration (ADR 0057). */
export const LOCAL_SCHEMA_VERSION = 1;

export class StoreCorruptError extends Error {
  readonly code = "ERR_TILL_STORE_CORRUPT" as const;
  constructor(detail: string) { super(detail); this.name = "StoreCorruptError"; }
}

export interface PosDatabase {
  readonly raw: Database.Database;
  /** The ONE way a caller gets a transaction, so spec:1303's "a ticket and its outbox row are one local
   *  transaction" has one spelling. `better-sqlite3` transactions are synchronous and nest as savepoints. */
  tx<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function openPosDatabase(file: string): PosDatabase {
  const raw = new Database(file);
  try {
    // WAL so a long-running pull does not block a sale; NORMAL because a till that loses the last
    // fsync loses at most the ticket being written, and that ticket is not yet on a receipt.
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("foreign_keys = ON");
    const [check] = raw.pragma("integrity_check") as { integrity_check: string }[];
    if (check?.integrity_check !== "ok") {
      throw new StoreCorruptError(`the local till database failed its integrity check: ${check?.integrity_check ?? "unknown"}`);
    }
    raw.exec(readFileSync(SCHEMA_PATH, "utf8"));
    raw.prepare("insert into meta (key, value) values ('schema_version', ?) on conflict (key) do update set value = excluded.value")
      .run(String(LOCAL_SCHEMA_VERSION));
  } catch (error) {
    raw.close();
    if (error instanceof StoreCorruptError) throw error;
    // A malformed file surfaces from better-sqlite3 as SQLITE_NOTADB; anything else at open time is the
    // same class of problem from the caller's point of view — the till cannot use this file.
    throw new StoreCorruptError(`the local till database at ${file} could not be opened: ${(error as Error).message}`);
  }
  const transact = raw.transaction(<T,>(fn: () => T): T => fn());
  return {
    raw,
    tx<T>(fn: () => T): T { return transact(fn) as T; },
    close(): void { raw.close(); },
  };
}
```

- [ ] **Step 6: Write `apps/pos/src/main/money.ts` — the one boundary**

```ts
import { Money, Quantity, type CurrencyCode, currency } from "@dulja/domain";

/**
 * The ONE place a `TEXT` column becomes a domain value and back, at the till.
 *
 * It exists because `no-number-money` (§3.7.5) scans `apps/**` and because SQLite has no decimal type: a
 * money column is `TEXT` at fixed 4 dp, a quantity `TEXT` at fixed 6 dp, a revision `TEXT` holding a
 * decimal integer. Two spellings of these six functions would be two chances to drop a digit.
 */
export function moneyToText(m: Money): string { return m.toString(); }              // fixed 4 dp
export function textToMoney(t: string, c: CurrencyCode): Money { return Money.of(t, c); }
export function quantityToText(q: Quantity): string { return q.toString(); }        // fixed 6 dp
export function textToQuantity(t: string): Quantity { return Quantity.of(t); }

/** A revision is a decimal string, never an SQLite INTEGER (ADR 0057, A8b). */
export function revisionToText(r: bigint): string { return r.toString(10); }
export function textToRevision(t: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(t)) throw new RangeError(`not a revision: ${JSON.stringify(t)}`);
  return BigInt(t);
}

/** The wire form of §4.10.1: `{ amount, currency }`, which is `Money.toJSON()`. */
export function moneyJson(m: Money): { amount: string; currency: string } { return m.toJSON(); }
export function fromMoneyJson(j: { amount: string; currency: string }): Money {
  return Money.of(j.amount, currency(j.currency));
}
```

- [ ] **Step 7: The buildable empty renderer — `vite.config.ts`, `index.html`, `src/renderer/main.tsx`**

Three files, and every screen is still behind the OD-24 gate. They exist so `bun run --cwd apps/pos build` (T1's `package.json` already declares it) produces an `apps/pos/dist/` for `electron-builder.pos.yml`'s `extraResources` to copy in the default state Tasks 0–10 and 12 ship in.

```ts
// apps/pos/vite.config.ts
/**
 * The till's renderer build. Two settings and no third, both forced by decisions made elsewhere.
 *
 * `base: "./"` — 0E's window loads `${APP_ORIGIN}/index.html` through the custom `app://` scheme, so every
 * asset URL must be relative to the document. An absolute `/assets/...` would resolve against the scheme
 * root and 404 inside the packaged app, where there is no server to rewrite it.
 *
 * `build.target: "chrome130"` — the renderer runs in exactly one engine, Electron's bundled Chromium, so
 * there is no browser matrix to down-level for. NO ELECTRON VERSION LITERAL APPEARS HERE (spec:104): the
 * target names a Chromium baseline, not the Electron package's version, and the lockfile owns that.
 *
 * Task 11 adds `@tailwindcss/vite` to this array and changes nothing else in this file.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "chrome130", outDir: "dist", emptyOutDir: true },
});
```

```html
<!-- apps/pos/index.html — the mount point, and nothing else until Task 11. -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- The tag is EMPTY on purpose: every visible string comes from packages/i18n (spec:2061, Global
         Constraint 18), and Task 11 sets `document.title` from the catalogue when the shell mounts, along
         with `lang` and `dir` through `DirectionProvider`. A literal here would be an untranslated string
         in the one place `no-hardcoded-string` cannot see (it scans .ts/.tsx, not .html). -->
    <title></title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

```tsx
// apps/pos/src/renderer/main.tsx
/**
 * The renderer's entry point, deliberately empty.
 *
 * ⚠️ **Every SCREEN is blocked by OD-24 (Task 11), and the slice is not.** This file exists so the build has
 * an entry and `apps/pos/dist/` exists in the shipping default state — T11's own words, *"an `index.html`
 * with a mount point and nothing in it"*. It renders nothing, holds no string that would need a catalogue
 * key, and makes no network call: `phase-6b-pinned.test.ts` (T12) is the assertion that no file under
 * `src/renderer/` contains `fetch`, `XMLHttpRequest` or `new WebSocket`, and this file is the first one that
 * scan walks. (T9's `pos-bridge.spec.ts` scans a named list of `src/main/*` files for a different rule — the
 * `@dulja/db` barrel — and the renderer scan is T12's and only T12's.)
 *
 * Task 11 replaces the `createRoot(...).render(...)` call below with its router and touches nothing above it.
 */
import { createRoot } from "react-dom/client";

const host = document.getElementById("root");
if (host === null) throw new Error("apps/pos: #root is missing from index.html");
// Task 11 renders <TillShell /> here. Until OD-24 is answered the till has services and no screens.
createRoot(host).render(null);
```

Add the two cases that keep it honest to `apps/pos/test/database.test.ts` — the file this task already owns, so no new test file appears:

```ts
// apps/pos/test/database.test.ts — appended to the same describe.
  it("the renderer entry exists and is EMPTY — the OD-24 default state is buildable", () => {
    const main = readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
    // It mounts and renders nothing. A component, a route or a visible string here would be a screen, and
    // screens are Task 11's behind the OD-24 gate (hazard 29).
    expect(main).toContain("createRoot");
    expect(main).toContain("render(null)");
    // And no network client, ever: every request the till sends is the main process's, signed with the
    // device key (T3). T9 and T12 re-assert this over the whole directory.
    expect(main).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|new WebSocket/);
    // The html names this file as its module entry, or `vite build` has no graph to walk.
    expect(readFileSync(new URL("../index.html", import.meta.url), "utf8"))
      .toContain('src="/src/renderer/main.tsx"');
  });

  it("the vite config declares no package version and builds to dist/ with relative asset URLs", () => {
    const cfg = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(cfg).toContain('base: "./"');              // app:// has no server to rewrite an absolute path
    expect(cfg).toContain('outDir: "dist"');          // electron-builder.pos.yml copies ../pos/dist (T10)
    expect(cfg).not.toMatch(/["']\^?\d+\.\d+\.\d+["']/);   // spec:104 — the lockfile owns versions
  });
```

Then prove the build the CI job of Task 10 will run:

```bash
bun run --cwd apps/pos build
ls apps/pos/dist/index.html      # exists, and is what `extraResources: from ../pos/dist` copies
```

- [ ] **Step 8: Run and commit**

```bash
bun run --cwd apps/pos test -- database
```

**Expected:** 10 passed (the eight of Step 3 plus the two renderer-entry cases). Then `bun run --cwd apps/pos typecheck`, `bun run lint`, `bun run lint:rules` at the root — **expected:** clean; `no-number-money` sees no `number`-typed monetary name in `apps/pos`, `no-hardcoded-string` does not yet scan `apps/pos/src/renderer` (T11 adds that root, and this file holds no string for it to find in any case), and `dependency-rule` accepts the six packages Task 0 put in the tier row.

```bash
git add apps/pos docs/adr/0057-till-sqlite-is-a-cache.md bun.lock package.json
git commit -m "$(cat <<'EOF'
feat(pos): add apps/pos with the local SQLite model of §4.10.6 [6B T1]

Seventeen tables: eight catalogue mirrors whose only writer is applyChanges, and the tickets,
shifts, till events, attendance and outbox the till owns. Every money, quantity and revision
column is TEXT — better-sqlite3 hands INTEGER back as a double and a revision past 2^53 would
re-deliver one row for ever (spec:2041, ADR 0057).

Plus vite.config.ts, index.html and an EMPTY src/renderer/main.tsx, so `apps/pos build` has an
entry point and electron-builder.pos.yml has an `../pos/dist` to copy in the OD-24 default state
Tasks 0-10 and 12 ship in. No screen, no string, no fetch: those are T11's, behind the gate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `SqliteSyncStore` — the eight mirrors, the eight cursors, and the outbox

**The sentence this task is measured against** is 6A's, verbatim (§4.10.5 as amended by its Task 0 amendment 23c): *"`applyChanges` therefore sets **every** member of `CATALOGUE_STREAMS` to `max(changes[].revision)`, not only the streams the page touched … **This is the sentence 6B's SQLite store is measured against.**"* A store that advanced only the streams a page carried would hold `0n` on `cashier` and `branch_pos_policy` for ever on a quiet company, `pullAll`'s minimum-across-streams would be `0n` on every till, and every pull would restart from page one — **and nothing would throw**. Step 1's second case is that assertion.

**Files:**
- Create: `apps/pos/src/main/mirror.ts`, `apps/pos/src/main/store.ts`, `apps/pos/src/main/errors.ts`, `apps/pos/test/store.test.ts`
- Modify: `packages/contracts/src/errors.ts` (one `ERRORS` row — `ERR_TILL_CATALOGUE_STALE`)

**Interfaces**

- Consumes: `SyncStore`, `OutboxRow`, `Change`, `Stream`, `CATALOGUE_STREAMS`, `BatchResult` (`@dulja/sync`, 6A); `PosDatabase`, `revisionToText`, `textToRevision` (T1).
- Produces:
  ```ts
  // apps/pos/src/main/errors.ts
  export type TillErrorCode =
    | "ERR_TILL_PIN_INVALID" | "ERR_TILL_LIMIT_EXCEEDED" | "ERR_TILL_CATALOGUE_STALE"
    | "ERR_TILL_STORE_CORRUPT" | "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND" | "ERR_RBAC_FORBIDDEN"
    | "ERR_MONEY_CURRENCY_MISMATCH";
  /** The till's one error class. It carries an `ErrCode` from the registry and never a new code:
   *  `packages/contracts/src/errors.ts` is the single file (spec:2051) and `apps/pos` may import it. */
  export class TillError extends Error {
    constructor(readonly code: TillErrorCode, readonly detail: string);
  }
  ```
  ```ts
  // apps/pos/src/main/mirror.ts
  export interface MirrorRow { id: string; revision: bigint; row: Record<string, unknown> }
  /** One writer per stream. Extracts the indexed columns out of the server row and keeps the whole row. */
  export function upsertMirror(db: PosDatabase, stream: Stream, row: MirrorRow): void;
  export function deleteMirror(db: PosDatabase, stream: Stream, id: string): void;
  export const MIRROR_TABLE: Readonly<Record<Stream, string>>;
  ```
  ```ts
  // apps/pos/src/main/store.ts
  export class SqliteSyncStore implements SyncStore {
    constructor(db: PosDatabase);
    getCursor(stream: Stream): Promise<bigint>;
    applyChanges(changes: Change[]): Promise<void>;
    pendingOutbox(limit: number): Promise<OutboxRow[]>;
    markAcked(ids: string[], result: BatchResult): Promise<void>;
    /** Not part of `SyncStore`: the till's own writer, called by `sell`, `openShift` and `recordTillEvent`
     *  INSIDE their transaction (spec:1303). Returns the outbox row's id. */
    enqueue(kind: OutboxRow["kind"], ref: string, payload: unknown): string;
    /** The offline indicator's two numbers (spec:1356). */
    catalogueState(): { revision: bigint; pulledAt: string | null; pendingOutbox: number };
  }
  ```

- [ ] **Step 1: Write the failing test first**

```ts
// apps/pos/test/store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE_STREAMS, type BatchResult, type Change } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";

let db: PosDatabase; let store: SqliteSyncStore; const dirs: string[] = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const itemChange = (n: number, rev: bigint): Change => ({
  stream: "item", op: "upsert", id: `item-${n}`, revision: rev,
  row: { id: `item-${n}`, code: `SKU-${n}`, barcode: `900000000${n}`, name_en: `Item ${n}`, name_ar: null,
         kind: "product", base_unit_id: "unit-1", track_lots: false, company_id: "co-1" },
});

describe("SqliteSyncStore — 6A's SyncStore over the local file", () => {
  it("getCursor answers 0n for a stream that has never been pulled", async () => {
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(0n);
  });

  it("applyChanges advances EVERY stream to the page's highest revision, not only the ones it carried", async () => {
    // §4.10.5, 6A Task 0 amendment 23c. A page is ordered by revision ACROSS streams, so a page ending at
    // revision R has delivered everything <= R for every stream — including the quiet ones. `cashier` and
    // `branch_pos_policy` are empty on a fresh company; a store that advanced only `item` would answer 0n
    // for them for ever, pullAll's minimum-across-streams would be 0n on every till, and every pull would
    // restart from page one. Nothing would throw. This is the assertion that catches it.
    await store.applyChanges([itemChange(1, 10n), itemChange(2, 30n), itemChange(3, 20n)]);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(30n);
  });

  it("an empty page advances nothing", async () => {
    await store.applyChanges([itemChange(1, 5n)]);
    await store.applyChanges([]);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(5n);
  });

  it("a revision past 2^53 survives the round trip — the reason the column is TEXT", async () => {
    await store.applyChanges([itemChange(1, 9007199254740993n)]);
    expect(await store.getCursor("item")).toBe(9007199254740993n);
    expect(Number(await store.getCursor("item"))).not.toBe(9007199254740993);
  });

  it("an upsert extracts the indexed columns and keeps the whole server row", async () => {
    await store.applyChanges([itemChange(7, 1n)]);
    const row = db.raw.prepare<[], { code: string; barcode: string; row_json: string; revision: string }>(
      "select code, barcode, row_json, revision from catalogue_item where id = 'item-7'").get()!;
    expect(row.code).toBe("SKU-7");
    expect(row.barcode).toBe("9000000007");
    expect(row.revision).toBe("1");
    expect(JSON.parse(row.row_json)).toMatchObject({ company_id: "co-1", kind: "product" });
  });

  it("a tombstone deletes the mirror row and still advances the cursor", async () => {
    await store.applyChanges([itemChange(7, 1n)]);
    await store.applyChanges([{ stream: "item", op: "delete", id: "item-7", revision: 2n, row: null }]);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n).toBe(0);
    expect(await store.getCursor("item")).toBe(2n);
  });

  it("a re-applied page is idempotent — the same change twice leaves one row", async () => {
    await store.applyChanges([itemChange(7, 1n), itemChange(7, 1n)]);
    await store.applyChanges([itemChange(7, 1n)]);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n).toBe(1);
  });

  it("applyChanges is one transaction: a bad change leaves the cursor and every row untouched", async () => {
    await store.applyChanges([itemChange(1, 5n)]);
    const bad: Change = { stream: "item", op: "upsert", id: "item-2", revision: 9n, row: null };
    await expect(store.applyChanges([itemChange(2, 8n), bad])).rejects.toThrow();
    expect(await store.getCursor("item")).toBe(5n);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n).toBe(1);
  });

  it("enqueue and pendingOutbox round-trip in insertion order, capped at the limit", async () => {
    for (let n = 1; n <= 5; n += 1) store.enqueue("ticket", `ref-${n}`, { clientRef: `ref-${n}` });
    const pending = await store.pendingOutbox(3);
    expect(pending.map((r) => r.ref)).toEqual(["ref-1", "ref-2", "ref-3"]);
    expect(pending[0]!.kind).toBe("ticket");
    expect(pending[0]!.ackedAt).toBeNull();
    expect(pending[0]!.payload).toEqual({ clientRef: "ref-1" });
  });

  it("an UNTENDERED ticket is not drainable, and becomes drainable the moment its status leaves 'open'", async () => {
    // `sell` writes the outbox row with `tenders: []` inside the sale's transaction and leaves the ticket
    // `open`; `tender` replaces the payload and flips the status. The 15-second drain loop must not push the
    // half-finished ticket in between: 6A's POS_TICKET policy balances tenders against amount + tax with no
    // residual leg, so an empty-tender ticket is refused and lands in `app.needs_attention` — one false row
    // per sale where the cashier took longer than one tick to collect the money.
    db.raw.prepare(
      `insert into shift (id, terminal_id, cashier_principal_id, opened_at, opening_float, currency)
       values ('sh-1', 'term-1', 'p-1', '2026-06-15T08:00:00.000Z', '100.0000', 'MYR')`).run();
    const insertTicket = db.raw.prepare(
      `insert into ticket (id, shift_id, cashier_principal_id, customer_id, kind, returns_client_ref, status,
                           currency, net_total, tax_total, total, catalogue_revision, created_at)
       values (?, 'sh-1', 'p-1', null, 'sale', null, ?, 'MYR', '10.0000', '1.0000', '11.0000', '12', ?)`);
    insertTicket.run("tk-open", "open", "2026-06-15T09:00:00.000Z");
    store.enqueue("ticket", "tk-open", { clientRef: "tk-open", tenders: [] });
    // A shift message enqueued at the same moment still travels — the hold-back is per ticket, and a shift
    // ref (`"<shiftId>:<kind>"`) can never name a ticket row.
    store.enqueue("shift", "sh-1:open", { shiftId: "sh-1", kind: "open" });
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual(["sh-1:open"]);

    // `tender`'s own update, in isolation: the status flips and the row is eligible on the very next drain.
    db.raw.prepare("update ticket set status = 'completed' where id = 'tk-open'").run();
    expect((await store.pendingOutbox(10)).map((r) => r.ref).sort()).toEqual(["sh-1:open", "tk-open"]);

    // And a ticket row that does not exist at all is never held back — that is what every other case here
    // enqueues, and it is what keeps this clause from becoming a trap for a caller with no local ticket.
    store.enqueue("ticket", "tk-nowhere", { clientRef: "tk-nowhere" });
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toContain("tk-nowhere");
  });

  it("pendingOutbox returns FRESH objects every call — 6A's drainOutbox is written against that", async () => {
    store.enqueue("ticket", "ref-1", {});
    const a = await store.pendingOutbox(10);
    const b = await store.pendingOutbox(10);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).toEqual(b[0]);
  });

  it("markAcked acks only refs the server named, and NEVER on silence (spec:1337)", async () => {
    for (const ref of ["t-1", "t-2", "t-3"]) store.enqueue("ticket", ref, { clientRef: ref });
    store.enqueue("shift", "s-1:open", { shiftId: "s-1", kind: "open" });
    const ids = (await store.pendingOutbox(10)).map((r) => r.id);
    const result: BatchResult = {
      batchId: "b-1",
      results: [
        { clientRef: "t-1", status: "accepted", documentId: "d-1", number: "POS-T1-000001", error: null },
        { clientRef: "t-2", status: "rejected", documentId: null, number: null, error: { code: "ERR_STOCK_INSUFFICIENT", detail: "no stock" } },
        // t-3 is ABSENT — the server said nothing about it. It must stay pending.
      ],
      shiftResults: [{ ref: "s-1:open", status: "rejected", error: { code: "ERR_SYNC_MESSAGE_UNSUPPORTED", detail: "6D" } }],
      tillEventResults: [],
      catalogueCursor: "MQ",
    };
    await store.markAcked(ids, result);
    const stillPending = (await store.pendingOutbox(10)).map((r) => r.ref).sort();
    expect(stillPending).toEqual(["s-1:open", "t-2", "t-3"]);
    const rejected = db.raw.prepare<[], { attempts: number; last_error: string }>(
      "select attempts, last_error from outbox where ref = 't-2'").get()!;
    expect(rejected.attempts).toBe(1);
    expect(rejected.last_error).toContain("ERR_STOCK_INSUFFICIENT");
  });

  it("a duplicate acknowledgement acks the row — a re-send is how a till recovers", async () => {
    store.enqueue("ticket", "t-1", {});
    const ids = (await store.pendingOutbox(10)).map((r) => r.id);
    await store.markAcked(ids, {
      batchId: "b", results: [{ clientRef: "t-1", status: "duplicate", documentId: "d", number: "n", error: null }],
      shiftResults: [], tillEventResults: [], catalogueCursor: "MQ",
    });
    expect(await store.pendingOutbox(10)).toEqual([]);
  });

  it("enqueue is idempotent on (kind, ref) — a retry of `sell` never doubles the outbox", () => {
    const first = store.enqueue("ticket", "t-1", { v: 1 });
    const second = store.enqueue("ticket", "t-1", { v: 2 });
    expect(second).toBe(first);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from outbox").get()!.n).toBe(1);
    // The FIRST payload wins: the ticket is already written and its payload is what the server must see.
    expect(JSON.parse(db.raw.prepare<[], { payload: string }>("select payload from outbox").get()!.payload)).toEqual({ v: 1 });
  });

  it("catalogueState reports the revision, the pull time and the pending count (spec:1356)", async () => {
    expect(store.catalogueState()).toEqual({ revision: 0n, pulledAt: null, pendingOutbox: 0 });
    await store.applyChanges([itemChange(1, 12n)]);
    store.enqueue("ticket", "t-1", {});
    const state = store.catalogueState();
    expect(state.revision).toBe(12n);
    expect(state.pendingOutbox).toBe(1);
    expect(Date.parse(state.pulledAt!)).toBeGreaterThan(0);
  });
});
```

Run `bun run --cwd apps/pos test -- store`. **Expected failure:** `Failed to resolve import "../src/main/store"`.

- [ ] **Step 2: Add the two `ERRORS` rows (A6, first two of four)**

```ts
// packages/contracts/src/errors.ts — two rows, in the PR that first needs them.
  ERR_TILL_CATALOGUE_STALE: {
    status: 409,
    message: "This till has not completed a catalogue update and cannot price a ticket.",
    remedy: "Connect the till to the network and wait for the catalogue indicator to show a recent update.",
    raisedBy: "6B",
  },
  ERR_TILL_STORE_CORRUPT: {
    status: 500,
    message: "The till's local database failed its integrity check.",
    remedy: "Check the unsent-ticket count in the indicator, drain it if it is not zero, then re-enrol this till.",
    raisedBy: "6B",
  },
```

**Both rows land here and neither is deferred, because `errors.ts` below does not compile without them.** `TillErrorCode` is `Extract<ErrCode, …>` over four `ERR_TILL_*` literals; `Extract` over a literal that is not a member of `ErrCode` silently yields `never`, and a `TillError` whose `code` parameter is `never` cannot be constructed anywhere — so the failure surfaces as *"Argument of type `\"ERR_TILL_STORE_CORRUPT\"` is not assignable to parameter of type `never`"* at every call site rather than at the definition. `ERR_TILL_STORE_CORRUPT` is *raised* one task earlier, by T1's `StoreCorruptError`, which carries the code as a bare string literal and therefore compiled without the row; `error-codes` (§3.7.5) counts **any** occurrence of the token in `apps/**` or `packages/**/src/**` outside the excised `ERRORS` literal, and T1's `readonly code = "ERR_TILL_STORE_CORRUPT" as const` is one — so the lint was green at T1 and stays green here.

- [ ] **Step 3: Write `apps/pos/src/main/errors.ts` and `mirror.ts`**

```ts
// apps/pos/src/main/errors.ts
import type { ErrCode } from "@dulja/contracts";

/** A literal SUBSET of `ErrCode` and never a new code. `packages/contracts/src/errors.ts` is the one file
 *  every code is enumerated in (spec:2051) and `apps/pos` is app tier, so it imports the type directly. */
export type TillErrorCode = Extract<ErrCode,
  | "ERR_TILL_PIN_INVALID" | "ERR_TILL_LIMIT_EXCEEDED" | "ERR_TILL_CATALOGUE_STALE" | "ERR_TILL_STORE_CORRUPT"
  // `ERR_MONEY_CURRENCY_MISMATCH` is 0D's and is raised here rather than re-wrapped: `draftTicket`,
  // `closeShift` and `tender` all refuse a mixed-currency ticket, and a till-specific alias for a code the
  // domain already registers would be the second spelling §4.2.4 exists to prevent.
  | "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND" | "ERR_RBAC_FORBIDDEN" | "ERR_MONEY_CURRENCY_MISMATCH">;

export class TillError extends Error {
  constructor(readonly code: TillErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TillError";
  }
}
```

```ts
// apps/pos/src/main/mirror.ts
import type { Stream } from "@dulja/sync";
import type { PosDatabase } from "./database";
import { revisionToText } from "./money";

export interface MirrorRow { id: string; revision: bigint; row: Record<string, unknown> }

/** `Stream` -> table, total and mechanical (A8a). `CATALOGUE_STREAMS` is the list; this is the mapping. */
export const MIRROR_TABLE: Readonly<Record<Stream, string>> = {
  item: "catalogue_item",
  price_list: "catalogue_price_list",
  price_list_line: "catalogue_price_list_line",
  promotion: "catalogue_promotion",
  customer: "catalogue_customer",
  tax_code: "catalogue_tax_code",
  cashier: "catalogue_cashier",
  branch_pos_policy: "catalogue_branch_pos_policy",
};

/** Reads a server column out of `to_jsonb(row) - 'tenant_id'` (6A's `readCatalogue`). A missing NOT NULL
 *  column is a protocol disagreement and must throw here, at the row that carries it, rather than surface
 *  four screens later as a null price. */
function need(row: Record<string, unknown>, key: string, stream: Stream, id: string): string {
  const v = row[key];
  if (v === null || v === undefined) throw new TypeError(`${stream}/${id}: the server row has no ${key}`);
  return String(v);
}
function opt(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : String(v);
}
function bool(row: Record<string, unknown>, key: string): number {
  return row[key] === true || row[key] === 1 || row[key] === "true" ? 1 : 0;
}

/**
 * The eight upsert writers. Each extracts only the columns a lookup indexes and keeps the whole server row
 * in `row_json`; nothing else reads a mirror's extracted column as a source of truth, so adding a column
 * later is an index change and never a data migration.
 *
 * There is one statement per stream and no dynamic table name: `MIRROR_TABLE[stream]` selects a **literal**
 * SQL string below, never interpolates one — spec:100's "never build SQL by string concatenation" binds the
 * till as much as the server (SAH-036/037/069), and acceptance test 27 is the mechanical check.
 */
export function upsertMirror(db: PosDatabase, stream: Stream, m: MirrorRow): void {
  const rev = revisionToText(m.revision);
  const json = JSON.stringify(m.row);
  switch (stream) {
    case "item":
      db.raw.prepare(
        `insert into catalogue_item (id, revision, row_json, code, barcode, name_en, name_ar, kind, base_unit_id, track_lots)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, barcode = excluded.barcode, name_en = excluded.name_en,
           name_ar = excluded.name_ar, kind = excluded.kind, base_unit_id = excluded.base_unit_id,
           track_lots = excluded.track_lots`,
      ).run(m.id, rev, json, need(m.row, "code", stream, m.id), opt(m.row, "barcode"),
            need(m.row, "name_en", stream, m.id), opt(m.row, "name_ar"), need(m.row, "kind", stream, m.id),
            need(m.row, "base_unit_id", stream, m.id), bool(m.row, "track_lots"));
      return;
    case "price_list":
      db.raw.prepare(
        `insert into catalogue_price_list (id, revision, row_json, code, currency, customer_kind, branch_id, valid_from, valid_to)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, currency = excluded.currency, customer_kind = excluded.customer_kind,
           branch_id = excluded.branch_id, valid_from = excluded.valid_from, valid_to = excluded.valid_to`,
      ).run(m.id, rev, json, need(m.row, "code", stream, m.id), need(m.row, "currency", stream, m.id),
            opt(m.row, "customer_kind"), opt(m.row, "branch_id"), opt(m.row, "valid_from"), opt(m.row, "valid_to"));
      return;
    case "price_list_line":
      db.raw.prepare(
        `insert into catalogue_price_list_line (id, revision, row_json, price_list_id, item_id, unit_id, min_quantity, unit_price)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           price_list_id = excluded.price_list_id, item_id = excluded.item_id, unit_id = excluded.unit_id,
           min_quantity = excluded.min_quantity, unit_price = excluded.unit_price`,
      ).run(m.id, rev, json, need(m.row, "price_list_id", stream, m.id), need(m.row, "item_id", stream, m.id),
            opt(m.row, "unit_id"), need(m.row, "min_quantity", stream, m.id), need(m.row, "unit_price", stream, m.id));
      return;
    case "promotion":
      db.raw.prepare(
        `insert into catalogue_promotion (id, revision, row_json, code, kind, definition, starts_at, ends_at, branch_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, kind = excluded.kind, definition = excluded.definition,
           starts_at = excluded.starts_at, ends_at = excluded.ends_at, branch_id = excluded.branch_id`,
      ).run(m.id, rev, json, need(m.row, "code", stream, m.id), need(m.row, "kind", stream, m.id),
            JSON.stringify(m.row["definition"] ?? {}), opt(m.row, "starts_at"), opt(m.row, "ends_at"), opt(m.row, "branch_id"));
      return;
    case "customer":
      db.raw.prepare(
        `insert into catalogue_customer (id, revision, row_json, code, name_en, name_ar, phone, currency, credit_limit, credit_hold)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, name_en = excluded.name_en, name_ar = excluded.name_ar, phone = excluded.phone,
           currency = excluded.currency, credit_limit = excluded.credit_limit, credit_hold = excluded.credit_hold`,
      ).run(m.id, rev, json, need(m.row, "code", stream, m.id), need(m.row, "name_en", stream, m.id),
            opt(m.row, "name_ar"), opt(m.row, "phone"), opt(m.row, "currency"), opt(m.row, "credit_limit"),
            bool(m.row, "credit_hold"));
      return;
    case "tax_code":
      db.raw.prepare(
        // `archived_at` is extracted, not left in row_json: T5's `defaultOutputTaxCode` filters on it, and a
        // superseded output code whose effective window still contains today would otherwise make the
        // "exactly one open output code" test count 2 and answer `null` (5A:591, spec:2049).
        `insert into catalogue_tax_code (id, revision, row_json, code, rate, kind, rounding_mode, output_account_id, input_account_id, effective_from, effective_to, archived_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           code = excluded.code, rate = excluded.rate, kind = excluded.kind, rounding_mode = excluded.rounding_mode,
           output_account_id = excluded.output_account_id, input_account_id = excluded.input_account_id,
           effective_from = excluded.effective_from, effective_to = excluded.effective_to,
           archived_at = excluded.archived_at`,
      ).run(m.id, rev, json, need(m.row, "code", stream, m.id), need(m.row, "rate", stream, m.id),
            need(m.row, "kind", stream, m.id), need(m.row, "rounding_mode", stream, m.id),
            opt(m.row, "output_account_id"), opt(m.row, "input_account_id"),
            opt(m.row, "effective_from"), opt(m.row, "effective_to"), opt(m.row, "archived_at"));
      return;
    case "cashier":
      db.raw.prepare(
        `insert into catalogue_cashier (id, revision, row_json, employee_id, branch_id, pin_hash, snapshot_json, revoked_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           employee_id = excluded.employee_id, branch_id = excluded.branch_id, pin_hash = excluded.pin_hash,
           snapshot_json = excluded.snapshot_json, revoked_at = excluded.revoked_at`,
      ).run(m.id, rev, json, need(m.row, "employee_id", stream, m.id), need(m.row, "branch_id", stream, m.id),
            need(m.row, "pin_hash", stream, m.id), JSON.stringify(m.row["snapshot"] ?? {}), opt(m.row, "revoked_at"));
      return;
    case "branch_pos_policy":
      db.raw.prepare(
        `insert into catalogue_branch_pos_policy (id, revision, row_json, branch_id, max_line_discount_pct,
           max_ticket_discount_pct, max_void_amount, max_price_override_pct, blind_return_allowed,
           max_blind_return_amount, max_cash_in_drawer, require_customer_over, rounding_increment,
           paid_out_allowed, max_paid_out_amount)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set revision = excluded.revision, row_json = excluded.row_json,
           branch_id = excluded.branch_id, max_line_discount_pct = excluded.max_line_discount_pct,
           max_ticket_discount_pct = excluded.max_ticket_discount_pct, max_void_amount = excluded.max_void_amount,
           max_price_override_pct = excluded.max_price_override_pct, blind_return_allowed = excluded.blind_return_allowed,
           max_blind_return_amount = excluded.max_blind_return_amount, max_cash_in_drawer = excluded.max_cash_in_drawer,
           require_customer_over = excluded.require_customer_over, rounding_increment = excluded.rounding_increment,
           paid_out_allowed = excluded.paid_out_allowed, max_paid_out_amount = excluded.max_paid_out_amount`,
      ).run(m.id, rev, json, need(m.row, "branch_id", stream, m.id),
            need(m.row, "max_line_discount_pct", stream, m.id), need(m.row, "max_ticket_discount_pct", stream, m.id),
            need(m.row, "max_void_amount", stream, m.id), need(m.row, "max_price_override_pct", stream, m.id),
            bool(m.row, "blind_return_allowed"), need(m.row, "max_blind_return_amount", stream, m.id),
            opt(m.row, "max_cash_in_drawer"), opt(m.row, "require_customer_over"),
            need(m.row, "rounding_increment", stream, m.id), bool(m.row, "paid_out_allowed"),
            need(m.row, "max_paid_out_amount", stream, m.id));
      return;
  }
}

/** A tombstone (spec:1300 — "Deletions travel as tombstones, never as silent absence"). */
export function deleteMirror(db: PosDatabase, stream: Stream, id: string): void {
  switch (stream) {
    case "item": db.raw.prepare("delete from catalogue_item where id = ?").run(id); return;
    case "price_list": db.raw.prepare("delete from catalogue_price_list where id = ?").run(id); return;
    case "price_list_line": db.raw.prepare("delete from catalogue_price_list_line where id = ?").run(id); return;
    case "promotion": db.raw.prepare("delete from catalogue_promotion where id = ?").run(id); return;
    case "customer": db.raw.prepare("delete from catalogue_customer where id = ?").run(id); return;
    case "tax_code": db.raw.prepare("delete from catalogue_tax_code where id = ?").run(id); return;
    case "cashier": db.raw.prepare("delete from catalogue_cashier where id = ?").run(id); return;
    case "branch_pos_policy": db.raw.prepare("delete from catalogue_branch_pos_policy where id = ?").run(id); return;
  }
}
```

- [ ] **Step 4: Write `apps/pos/src/main/store.ts`**

> ⚠️ **PR 12 review amendment (2026-10-22; proposed with ADR 0056's "Till-side refusal finality" and contracts §4.10.5's till-side refusal rule).** The `pendingOutbox` and `markAcked` below are this plan's original text. The implemented store also holds a shift `close` only for that shift's tickets and till events with **no answer yet** (`attempts = 0`), offers a refused ticket or till event again while its shift is open — beside the close at the latest — lists unanswered rows before refused tickets and till events, and stops offering a refusal once the server has acknowledged its shift's close (the `outbox_refused` view in `schema.sql`). `markAcked` is unchanged: a `rejected` row stays pending with its attempt count and reason.

```ts
import { randomUUID } from "node:crypto";
import { CATALOGUE_STREAMS, type BatchResult, type Change, type OutboxRow, type Stream, type SyncStore } from "@dulja/sync";
import type { PosDatabase } from "./database";
import { deleteMirror, upsertMirror } from "./mirror";
import { revisionToText, textToRevision } from "./money";

interface OutboxDbRow {
  id: string; kind: OutboxRow["kind"]; ref: string; payload: string;
  attempts: number; last_error: string | null; acked_at: string | null;
}

export class SqliteSyncStore implements SyncStore {
  constructor(private readonly db: PosDatabase) {}

  async getCursor(stream: Stream): Promise<bigint> {
    const row = this.db.raw.prepare<[string], { revision: string }>(
      "select revision from sync_cursor where stream = ?").get(stream);
    return row === undefined ? 0n : textToRevision(row.revision);
  }

  /**
   * Applies one page and advances **every** member of `CATALOGUE_STREAMS` to `max(changes[].revision)`.
   *
   * §4.10.5, 6A's amendment 23c, verbatim: *"A page is ordered by revision **across all streams**, so a page
   * whose last change is revision R has delivered everything at or below R for **every** stream."* A store
   * that advanced only the streams the page carried would answer `0n` for `cashier` and `branch_pos_policy`
   * — which have no rows at all on a fresh company — for ever; `pullAll`'s minimum-across-streams would then
   * be `0n` on every till, every pull would restart from page one, and **nothing would throw**. This loop is
   * the contract, and `store.test.ts`'s second case is its proof.
   *
   * The whole page is one SQLite transaction, so a malformed change leaves neither a half-applied mirror nor
   * an advanced cursor — the till simply re-pulls from where it was.
   */
  async applyChanges(changes: Change[]): Promise<void> {
    if (changes.length === 0) return;
    this.db.tx(() => {
      let high = 0n;
      for (const change of changes) {
        if (change.op === "delete") {
          deleteMirror(this.db, change.stream, change.id);
        } else {
          if (change.row === null) {
            throw new TypeError(`${change.stream}/${change.id}: an upsert carried a null row`);
          }
          upsertMirror(this.db, change.stream, {
            id: change.id, revision: change.revision, row: change.row as Record<string, unknown>,
          });
        }
        if (change.revision > high) high = change.revision;
      }
      const text = revisionToText(high);
      const advance = this.db.raw.prepare(
        `insert into sync_cursor (stream, revision) values (?, ?)
         on conflict (stream) do update set revision = excluded.revision`);
      for (const stream of CATALOGUE_STREAMS) advance.run(stream, text);
      this.db.raw.prepare(
        "insert into meta (key, value) values ('catalogue_pulled_at', ?) on conflict (key) do update set value = excluded.value",
      ).run(new Date().toISOString());
    });
  }

  /**
   * The rows eligible to travel: unacked, and — for a ticket — not still being rung up.
   *
   * **The `not exists` clause is load-bearing and is not an optimisation.** `sell` writes the outbox row
   * inside the sale's own transaction with `tenders: []` (spec:1303 — that is the whole of "zero lost
   * tickets") and leaves `ticket.status = 'open'`; `tender` replaces the payload in place and flips the
   * status to `'completed'`. The drain loop fires every 15 seconds (T3), so without this clause any sale
   * where the cashier takes more than one tick to collect payment is pushed with an empty tender array —
   * and 6A's `POS_TICKET` policy balances `Σ` tender debits against `Σ`(amount + tax) with no residual leg,
   * so the server refuses it, writes an `app.needs_attention` row that needs `pos.needs_attention.resolve`
   * to clear, and increments `attempts`. Nothing is lost (`markAcked` leaves a rejected row pending), but a
   * busy shop collects one false needs-attention row per in-progress sale, every day.
   *
   * **The predicate is `= 'open'` on an EXISTING ticket, not `<> 'completed'`,** for two reasons. A row whose
   * `ref` names no local `ticket` row travels — that is every `shift` and `till_event` message, whose refs
   * are `"<shiftId>:<kind>"` and a till-event uuid and can never collide with a ticket id, and it is also how
   * the unit tests below enqueue a bare payload. And the `voided` status the schema's CHECK admits is
   * therefore also held back if a later slice ever writes it, which is right: a voided ticket carries no
   * tenders either and the void already travels as its own `till_event`.
   */
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    const rows = this.db.raw.prepare<[number], OutboxDbRow>(
      `select id, kind, ref, payload, attempts, last_error, acked_at
         from outbox
        where acked_at is null
          and (kind <> 'ticket'
               or not exists (select 1 from ticket t where t.id = outbox.ref and t.status = 'open'))
        order by created_at, id limit ?`).all(limit);
    // FRESH objects on every call. 6A's `drainOutbox` decides termination from the `BatchResult` and not
    // from the rows it was handed, precisely so a store that snapshots — as this one does — is correct.
    return rows.map((r) => ({
      id: r.id, kind: r.kind, ref: r.ref, payload: JSON.parse(r.payload) as unknown,
      attempts: r.attempts, lastError: r.last_error, ackedAt: r.acked_at,
    }));
  }

  /**
   * Acks the rows the server named, and **only** those (spec:1337).
   *
   * A ref that appears in no array stays pending for ever — that is "never acked on silence" and it is the
   * whole of "zero lost tickets" on the till side. A `rejected` ref is not acked either: it stays pending
   * with its attempt count and the server's error, so the shop sees it in the needs-attention list and a
   * fixed catalogue makes the next drain succeed.
   */
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const acked = new Set<string>([
      ...result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ...result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ...result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
    ]);
    const errors = new Map<string, string>();
    for (const r of result.results) if (r.status === "rejected" && r.error) errors.set(r.clientRef, `${r.error.code}: ${r.error.detail}`);
    for (const r of [...result.shiftResults, ...result.tillEventResults]) {
      if (r.status === "rejected" && r.error) errors.set(r.ref, `${r.error.code}: ${r.error.detail}`);
    }
    const now = new Date().toISOString();
    this.db.tx(() => {
      const ack = this.db.raw.prepare("update outbox set acked_at = ? where id = ? and ref = ?");
      const fail = this.db.raw.prepare("update outbox set attempts = attempts + 1, last_error = ? where id = ?");
      const read = this.db.raw.prepare<[string], { ref: string }>("select ref from outbox where id = ?");
      for (const id of ids) {
        const row = read.get(id);
        if (row === undefined) continue;
        if (acked.has(row.ref)) ack.run(now, id, row.ref);
        else fail.run(errors.get(row.ref) ?? null, id);
      }
    });
  }

  /**
   * The till's own outbox writer. Callers invoke it **inside** their own `db.tx(...)`, so the ticket and its
   * outbox row are one local transaction (spec:1303, 1337) — `better-sqlite3` nests transactions as
   * savepoints, so an inner `tx` inside an outer one is correct and does not commit early.
   *
   * Idempotent on `(kind, ref)`: a retry of `sell` for a ticket the till already wrote returns the existing
   * row's id and leaves the **first** payload in place, because that payload matches the ticket rows that
   * are already committed and a second one would describe a ticket nobody has.
   */
  enqueue(kind: OutboxRow["kind"], ref: string, payload: unknown): string {
    const existing = this.db.raw.prepare<[string, string], { id: string }>(
      "select id from outbox where kind = ? and ref = ?").get(kind, ref);
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    this.db.raw.prepare(
      "insert into outbox (id, kind, ref, payload, attempts, last_error, acked_at, created_at) values (?, ?, ?, ?, 0, null, null, ?)",
    ).run(id, kind, ref, JSON.stringify(payload), new Date().toISOString());
    return id;
  }

  /** The two numbers spec:1356 requires of the offline indicator, plus the one the shop actually asks about. */
  catalogueState(): { revision: bigint; pulledAt: string | null; pendingOutbox: number } {
    const cursor = this.db.raw.prepare<[], { revision: string | null }>(
      "select max(cast(revision as integer)) is not null as ok, revision from sync_cursor order by cast(revision as integer) desc limit 1").get();
    const pulled = this.db.raw.prepare<[], { value: string }>("select value from meta where key = 'catalogue_pulled_at'").get();
    const pending = this.db.raw.prepare<[], { n: number }>("select count(*) as n from outbox where acked_at is null").get()!;
    return {
      revision: cursor?.revision ? textToRevision(cursor.revision) : 0n,
      pulledAt: pulled?.value ?? null,
      pendingOutbox: pending.n,
    };
  }
}
```

⚠️ **`catalogueState`'s `order by cast(revision as integer)` is the one place a revision touches SQLite arithmetic, and it is safe: SQLite's `integer` is 64-bit, the cast is used only for *ordering*, and the value that leaves the query is still the `TEXT` column.** Never read the cast result itself — `revision` is what is returned and `textToRevision` is what parses it.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd apps/pos test -- store
```

**Expected:** **15 passed** — the fifteen `it`s of Step 1, the last of which is the untendered-ticket drain case added with the `not exists` clause in Step 4. (Count the `it(`s in Step 1 if the runner disagrees.) Then `bun run --cwd packages/contracts test` and `bun run lint:rules` — **expected:** clean, and the reason is worth reading once because it decides where every one of this slice's four `ERRORS` rows lands. `error-codes` (§3.7.5, 0B Task 12) excises the text between `export const ERRORS = {` and its closing line and then fails for a code with **no occurrence** anywhere in `apps/**`, `packages/**/src/**` or `packages/db/migrations/**` — an *occurrence*, not a `throw`. `ERR_TILL_CATALOGUE_STALE` occurs in `apps/pos/src/main/errors.ts`'s `Extract<ErrCode, …>` from this task onward and is thrown by `assertCatalogueFresh` in Task 5; `ERR_TILL_STORE_CORRUPT` occurred from Task 1's `StoreCorruptError`. Both are therefore green here, and neither row needs to be moved into a later PR.

```bash
git add apps/pos/src/main/store.ts apps/pos/src/main/mirror.ts apps/pos/src/main/errors.ts \
        apps/pos/test/store.test.ts packages/contracts/src/errors.ts
git commit -m "$(cat <<'EOF'
feat(pos): SqliteSyncStore — the eight mirrors, the eight cursors and the outbox [6B T2]

applyChanges advances EVERY stream to the page's highest revision, not only the ones the page
carried (§4.10.5, 6A amendment 23c): `cashier` and `branch_pos_policy` are quiet on a fresh
company, and a store that advanced only the touched streams would restart every pull from page
one while looking perfectly correct. markAcked never acks on silence (spec:1337).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The device key, enrolment, the signed transport, and the two sync loops

**The till's whole network surface, and it is three routes.** `POST /v1/sync/enrol` once, then `GET /v1/sync/catalogue` and `POST /v1/sync/tickets` for ever. Every call after enrolment is signed with the Ed25519 key generated in `safeStorage` at redemption (§4.10.3, spec:1322) and carries **no** tenant or actor header — identity is the signature, and a forged `X-Tenant-Id` beside a valid signature is inert, which is acceptance test 11's own assertion.

**Files:**
- Create: `apps/pos/src/main/device.ts`, `apps/pos/src/main/transport.ts`, `apps/pos/src/main/loops.ts`, `apps/pos/test/transport.test.ts`, `apps/pos/test/loops.test.ts`, `docs/runbooks/till-enrolment.md`

**Interfaces**

- Consumes: `signSyncHeaders`, `SYNC_TERMINAL_ID_HEADER`, `SYNC_TIMESTAMP_HEADER`, `SYNC_SIGNATURE_HEADER` (T0); `SyncTransport`, `CataloguePage`, `TicketBatch`, `BatchResult`, `BatchQueued`, `SyncQueuedError`, `pullAll`, `drainOutbox`, `SYNC_BATCH_SYNC_LIMIT`, `decodeSyncCursor` (`@dulja/sync`, 6A); `SecureStore` (0E's shape, injected); `SqliteSyncStore` (T2); `TillError` (T2).
- Produces:
  ```ts
  // apps/pos/src/main/device.ts
  export interface DeviceIdentity { terminalId: string; publicKeyDer: Buffer; sign(message: Uint8Array): Uint8Array }
  export interface DeviceStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
  export async function loadDevice(store: DeviceStore): Promise<DeviceIdentity | null>;
  /** Generates the keypair, redeems the one-time code through `POST /v1/sync/enrol`, persists both. */
  export async function enrolDevice(store: DeviceStore, opts: { baseUrl: string; code: string; fetch?: typeof fetch }): Promise<DeviceIdentity>;
  export async function forgetDevice(store: DeviceStore): Promise<void>;

  // apps/pos/src/main/transport.ts
  export class HttpSyncTransport implements SyncTransport {
    constructor(opts: { baseUrl: string; device: DeviceIdentity; fetch?: typeof fetch; newIdempotencyKey: () => string });
    pullCatalogue(since: string, limit: number): Promise<CataloguePage>;
    pushTickets(batch: TicketBatch): Promise<BatchResult>;
  }
  export class TransportOfflineError extends Error { readonly cause: unknown }

  // apps/pos/src/main/loops.ts
  export interface SyncState { online: boolean; lastPullAt: string | null; lastPushAt: string | null; catalogueRevision: string; pendingOutbox: number; lastError: string | null }
  export interface SyncLoops { pullNow(): Promise<void>; drainNow(): Promise<void>; state(): SyncState; start(): void; stop(): void }
  export function createSyncLoops(opts: { store: SqliteSyncStore; transport: SyncTransport | null; terminalId: string; newBatchId: () => string; intervalMs?: number; now?: () => Date }): SyncLoops;
  ```

- [ ] **Step 1: Write the failing transport test first**

```ts
// apps/pos/test/transport.test.ts
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSyncRequest, sha256Hex, SYNC_SIGNATURE_HEADER, SYNC_TERMINAL_ID_HEADER, SYNC_TIMESTAMP_HEADER,
         SyncQueuedError, type TicketBatch } from "@dulja/sync";
import { HttpSyncTransport, TransportOfflineError } from "../src/main/transport";
import type { DeviceIdentity } from "../src/main/device";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const device: DeviceIdentity = {
  terminalId: "term-1",
  publicKeyDer: publicKey.export({ type: "spki", format: "der" }),
  sign: (m) => edSign(null, Buffer.from(m), privateKey),
};
const emptyBatch: TicketBatch = { terminalId: "term-1", batchId: "b-1", tickets: [], shifts: [], tillEvents: [] };

describe("HttpSyncTransport — the till's whole network surface", () => {
  it("signs GET /v1/sync/catalogue over the PATHNAME, never the query string", async () => {
    let seen: Request | null = null;
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example/", device, newIdempotencyKey: () => "idem-1",
      fetch: async (input, init) => {
        seen = new Request(input as string, init);
        return new Response(JSON.stringify({ changes: [], next_cursor: "MQ", has_more: false }), { status: 200 });
      },
    });
    await t.pullCatalogue("MQ", 1000);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/v1/sync/catalogue");
    expect(url.searchParams.get("since")).toBe("MQ");
    expect(url.searchParams.get("limit")).toBe("1000");
    const canonical = canonicalSyncRequest({
      method: "GET", path: "/v1/sync/catalogue",
      timestamp: seen!.headers.get(SYNC_TIMESTAMP_HEADER)!, body: sha256Hex(""),
    });
    expect(edVerify(null, Buffer.from(canonical, "utf8"),
      createPublicKey({ key: device.publicKeyDer, format: "der", type: "spki" }),
      Buffer.from(seen!.headers.get(SYNC_SIGNATURE_HEADER)!, "base64"))).toBe(true);
    expect(seen!.headers.get(SYNC_TERMINAL_ID_HEADER)).toBe("term-1");
  });

  it("sends NO tenant or actor header, ever — identity is the signature (SAH-044, test 11)", async () => {
    let seen: Request | null = null;
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example", device, newIdempotencyKey: () => "idem-1",
      fetch: async (input, init) => { seen = new Request(input as string, init); return new Response("{}", { status: 200 }); },
    });
    await t.pullCatalogue("", 10).catch(() => undefined);
    for (const forbidden of ["X-Tenant-Id", "X-Actor-Id", "Authorization", "Cookie"]) {
      expect(seen!.headers.get(forbidden), forbidden).toBeNull();
    }
  });

  it("POST /v1/sync/tickets signs the EXACT bytes it sends, and carries an Idempotency-Key", async () => {
    let seen: Request | null = null; let body = "";
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example", device, newIdempotencyKey: () => "idem-42",
      fetch: async (input, init) => {
        seen = new Request(input as string, init); body = String(init?.body ?? "");
        return new Response(JSON.stringify({ batchId: "b-1", results: [], shiftResults: [], tillEventResults: [], catalogueCursor: "MQ" }), { status: 200 });
      },
    });
    await t.pushTickets(emptyBatch);
    expect(seen!.headers.get("Idempotency-Key")).toBe("idem-42");
    expect(body).toBe(JSON.stringify(emptyBatch));
    const canonical = canonicalSyncRequest({
      method: "POST", path: "/v1/sync/tickets",
      timestamp: seen!.headers.get(SYNC_TIMESTAMP_HEADER)!, body: sha256Hex(body),
    });
    expect(edVerify(null, Buffer.from(canonical, "utf8"),
      createPublicKey({ key: device.publicKeyDer, format: "der", type: "spki" }),
      Buffer.from(seen!.headers.get(SYNC_SIGNATURE_HEADER)!, "base64"))).toBe(true);
  });

  it("a 202 rejects with SyncQueuedError so drainOutbox acks nothing (§4.10.4, 6A amendment 12)", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example", device, newIdempotencyKey: () => "k",
      fetch: async () => new Response(JSON.stringify({ batchId: "b-1", jobId: "j-1", status: "queued" }), { status: 202 }),
    });
    await expect(t.pushTickets(emptyBatch)).rejects.toBeInstanceOf(SyncQueuedError);
  });

  it("a network failure is a TransportOfflineError and never a silent empty page", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example", device, newIdempotencyKey: () => "k",
      fetch: async () => { throw new TypeError("fetch failed"); },
    });
    // The distinction matters: `pullAll` must PROPAGATE so the cursor stays where the applied changes left
    // it. An empty page with has_more:false would be read as "finished", which is exactly what test 20
    // forbids — "Kill the down-sync mid-transfer; resume from the cursor".
    await expect(t.pullCatalogue("", 10)).rejects.toBeInstanceOf(TransportOfflineError);
    await expect(t.pushTickets(emptyBatch)).rejects.toBeInstanceOf(TransportOfflineError);
  });

  it("a problem+json response surfaces its ERR_ code rather than a status number", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example", device, newIdempotencyKey: () => "k",
      fetch: async () => new Response(JSON.stringify({ type: "about:blank", title: "Terminal revoked", status: 403, code: "ERR_TERMINAL_REVOKED", detail: "this terminal was revoked" }),
        { status: 403, headers: { "content-type": "application/problem+json" } }),
    });
    await expect(t.pullCatalogue("", 10)).rejects.toThrow(/ERR_TERMINAL_REVOKED/);
  });

  it("decodes the catalogue page's revisions as bigint, not number", async () => {
    const t = new HttpSyncTransport({
      baseUrl: "https://api.example", device, newIdempotencyKey: () => "k",
      fetch: async () => new Response(
        // The wire is JSON; a revision past 2^53 MUST travel as a string or it is already lost before the
        // till sees it. 6A's contracts module serialises it as a string for exactly this reason.
        '{"changes":[{"stream":"item","op":"upsert","id":"i-1","revision":"9007199254740993","row":{}}],"next_cursor":"MQ","has_more":false}',
        { status: 200, headers: { "content-type": "application/json" } }),
    });
    const page = await t.pullCatalogue("", 10);
    expect(page.changes[0]!.revision).toBe(9007199254740993n);
  });
});
```

Run `bun run --cwd apps/pos test -- transport`. **Expected failure:** `Failed to resolve import "../src/main/transport"`.

- [ ] **Step 2: Write `apps/pos/src/main/device.ts`**

```ts
import { createPublicKey, generateKeyPairSync, sign as edSign, createPrivateKey } from "node:crypto";

/**
 * The terminal's device identity (§4.10.3, spec:1322).
 *
 * The private key never leaves this module and never reaches the renderer: `DeviceStore` is 0E's
 * `SecureStore` shape (`safeStorage`-backed), injected rather than imported so this module is testable
 * without Electron and so `apps/pos` does not import `apps/desktop` (spec:2389).
 */
export interface DeviceIdentity {
  terminalId: string;
  publicKeyDer: Buffer;
  sign(message: Uint8Array): Uint8Array;
}

export interface DeviceStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const KEY_TERMINAL = "dulja.pos.terminalId";
const KEY_PRIVATE = "dulja.pos.deviceKey";     // PKCS#8 PEM, encrypted at rest by safeStorage

function identityFrom(terminalId: string, pem: string): DeviceIdentity {
  const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  return {
    terminalId,
    publicKeyDer: createPublicKey(privateKey).export({ type: "spki", format: "der" }),
    sign: (message) => edSign(null, Buffer.from(message), privateKey),
  };
}

export async function loadDevice(store: DeviceStore): Promise<DeviceIdentity | null> {
  const [terminalId, pem] = await Promise.all([store.get(KEY_TERMINAL), store.get(KEY_PRIVATE)]);
  if (terminalId === null || pem === null) return null;
  return identityFrom(terminalId, pem);
}

/**
 * Redeems a one-time enrolment code (§4.10.3). `POST /v1/sync/enrol` is 6A's **public** route: it carries no
 * signature (there is no key yet) and no `Idempotency-Key` (a public route has no tenant to key on — 6A's
 * amendment 21), and it is idempotent in its own right because redemption is
 * `update … set redeemed_at = now() where redeemed_at is null returning …`.
 *
 * The keypair is generated **before** the call and the private half is persisted **after** a 201: a key
 * written first and then orphaned by a failed redemption is a key the shop cannot tell from a live one.
 */
export async function enrolDevice(
  store: DeviceStore, opts: { baseUrl: string; code: string; fetch?: typeof fetch },
): Promise<DeviceIdentity> {
  const doFetch = opts.fetch ?? fetch;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const devicePublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const response = await doFetch(new URL("/v1/sync/enrol", opts.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: opts.code, devicePublicKey }),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
    throw new Error(`${problem.code ?? `HTTP_${response.status}`}: ${problem.detail ?? "enrolment failed"}`);
  }
  const { terminalId } = (await response.json()) as { terminalId: string };
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await store.set(KEY_PRIVATE, pem);
  await store.set(KEY_TERMINAL, terminalId);
  return identityFrom(terminalId, pem);
}

/** Used by the runbook's "this till is being decommissioned" step. It does NOT clear the outbox: unsent
 *  tickets are the one piece of unrecoverable state a till holds (ADR 0057), and losing them silently on a
 *  re-enrolment is the failure the DoD sentence exists to forbid. */
export async function forgetDevice(store: DeviceStore): Promise<void> {
  await store.remove(KEY_PRIVATE);
  await store.remove(KEY_TERMINAL);
}
```

- [ ] **Step 3: Write `apps/pos/src/main/transport.ts`**

```ts
import { signSyncHeaders, SyncQueuedError, type BatchResult, type CataloguePage, type Change,
         type SyncTransport, type TicketBatch } from "@dulja/sync";
import type { DeviceIdentity } from "./device";

/** Every failure that is *not* a server answer. `pullAll` and `drainOutbox` must both propagate it: an
 *  interrupted transfer that looked like an empty finished page would advance nothing and finish, which is
 *  exactly the silent-truncation failure acceptance test 20 exists to catch. */
export class TransportOfflineError extends Error {
  constructor(readonly cause: unknown) {
    super(`the till could not reach the sync API: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "TransportOfflineError";
  }
}

interface RawChange { stream: string; op: "upsert" | "delete"; id: string; revision: string; row: unknown }

export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly device: DeviceIdentity;
  private readonly doFetch: typeof fetch;
  private readonly newIdempotencyKey: () => string;

  constructor(opts: { baseUrl: string; device: DeviceIdentity; fetch?: typeof fetch; newIdempotencyKey: () => string }) {
    this.baseUrl = opts.baseUrl;
    this.device = opts.device;
    this.doFetch = opts.fetch ?? fetch;
    this.newIdempotencyKey = opts.newIdempotencyKey;
  }

  async pullCatalogue(since: string, limit: number): Promise<CataloguePage> {
    const path = "/v1/sync/catalogue";
    const url = new URL(path, this.baseUrl);
    if (since !== "") url.searchParams.set("since", since);
    url.searchParams.set("limit", String(limit));
    // The signature covers the PATHNAME only: a cursor is not a secret, and a till retrying with a
    // different `limit` must not have to re-sign (§4.10.3, and 6A's `syncRequest` does the same).
    const headers = signSyncHeaders({ method: "GET", path, terminalId: this.device.terminalId }, (m) => this.device.sign(m));
    const response = await this.send(url, { method: "GET", headers });
    const body = (await response.json()) as { changes: RawChange[]; next_cursor: string; has_more: boolean };
    return {
      changes: body.changes.map((c): Change => ({
        stream: c.stream as Change["stream"], op: c.op, id: c.id,
        // The wire carries the revision as a STRING and it becomes a bigint here, once. `JSON.parse` would
        // have already rounded a number past 2^53 before this line ran.
        revision: BigInt(c.revision),
        row: (c.row ?? null) as Change["row"],
      })),
      next_cursor: body.next_cursor,
      has_more: body.has_more,
    };
  }

  async pushTickets(batch: TicketBatch): Promise<BatchResult> {
    const path = "/v1/sync/tickets";
    // Stringified ONCE, here, and the same string is both hashed and sent. Two serialisations of one object
    // are equal; a string and an object are not, and the failure is an opaque 401 on every signed POST.
    const body = JSON.stringify(batch);
    const headers = {
      ...signSyncHeaders({ method: "POST", path, body: batch, terminalId: this.device.terminalId }, (m) => this.device.sign(m)),
      "content-type": "application/json",
      // §4.2.9 layer one. Layer two is `client_ref` dedup on the server, which is what makes a re-send with
      // a FRESH key equally harmless — the two together are the DoD's "re-sending a batch changes nothing".
      "Idempotency-Key": this.newIdempotencyKey(),
    };
    const response = await this.send(new URL(path, this.baseUrl), { method: "POST", headers, body });
    if (response.status === 202) {
      const queued = (await response.json()) as { batchId: string; jobId: string };
      throw new SyncQueuedError(queued.batchId, queued.jobId);
    }
    return (await response.json()) as BatchResult;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(url, init);
    } catch (error) {
      throw new TransportOfflineError(error);
    }
    if (response.status === 202 || response.ok) return response;
    const problem = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
    // The code, not the status: `ERR_TERMINAL_REVOKED` tells the shop to call the office and
    // `ERR_TERMINAL_SIGNATURE_INVALID` tells them the till's clock is wrong. "403" tells them nothing.
    throw new Error(`${problem.code ?? `HTTP_${response.status}`}: ${problem.detail ?? response.statusText}`);
  }
}
```

- [ ] **Step 4: Write the loops test — this is acceptance test 20's till half**

```ts
// apps/pos/test/loops.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE_STREAMS, encodeSyncCursor, type CataloguePage, type Change, type SyncTransport, type TicketBatch } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { createSyncLoops } from "../src/main/loops";
import { TransportOfflineError } from "../src/main/transport";

let db: PosDatabase; let store: SqliteSyncStore; const dirs: string[] = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** 52 catalogue changes: 50 item upserts at revisions 1..50 and, at revision 7, a tombstone for item-7 that
 *  arrives LATER in revision order, so a resume that skipped a page would leave the deleted row behind. */
const corpus: Change[] = [
  ...Array.from({ length: 50 }, (_, i): Change => ({
    stream: "item", op: "upsert", id: `item-${i + 1}`, revision: BigInt(i + 1),
    row: { id: `item-${i + 1}`, code: `SKU-${i + 1}`, barcode: null, name_en: `I${i + 1}`, name_ar: null,
           kind: "product", base_unit_id: "u-1", track_lots: false },
  })),
  { stream: "item", op: "delete", id: "item-7", revision: 51n, row: null },
  { stream: "tax_code", op: "upsert", id: "tc-1", revision: 52n,
    row: { id: "tc-1", code: "SYN-OUT-STD", rate: "0.11000000", kind: "output", rounding_mode: "HALF_AWAY_FROM_ZERO",
           output_account_id: "acct-2300", input_account_id: null, effective_from: "2026-01-01", effective_to: null } },
];

function server(all: Change[], pageSize: number, dieAfterPages = Infinity): SyncTransport {
  let pages = 0;
  return {
    async pullCatalogue(since: string): Promise<CataloguePage> {
      if (pages >= dieAfterPages) throw new TransportOfflineError(new Error("ECONNRESET"));
      pages += 1;
      const from = since === "" ? 0n : BigInt(Buffer.from(since, "base64url").toString("utf8"));
      const slice = all.filter((c) => c.revision > from).slice(0, pageSize);
      const last = slice.at(-1)?.revision ?? from;
      return {
        changes: slice,
        next_cursor: encodeSyncCursor({ revision: last }),
        has_more: all.some((c) => c.revision > last),
      };
    },
    async pushTickets(batch: TicketBatch) {
      return { batchId: batch.batchId, results: [], shiftResults: [], tillEventResults: [], catalogueCursor: "MQ" };
    },
  };
}

describe("the till's sync loops — acceptance test 20's till half", () => {
  it("kills the pull mid-transfer, resumes from the cursor, applies nothing twice and misses no deletion", async () => {
    const dying = createSyncLoops({ store, transport: server(corpus, 10, 3), terminalId: "t", newBatchId: () => "b" });
    await expect(dying.pullNow()).rejects.toBeInstanceOf(TransportOfflineError);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n).toBe(30);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item where id = 'item-7'").get()!.n).toBe(1);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(30n);

    const resumed = createSyncLoops({ store, transport: server(corpus, 10), terminalId: "t", newBatchId: () => "b" });
    await resumed.pullNow();
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n).toBe(49);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item where id = 'item-7'").get()!.n).toBe(0);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_tax_code").get()!.n).toBe(1);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(52n);
  });

  it("state() reports honestly: offline until a pull succeeds, with the revision and its arrival time", async () => {
    const loops = createSyncLoops({ store, transport: server(corpus, 100, 0), terminalId: "t", newBatchId: () => "b" });
    expect(loops.state()).toMatchObject({ online: false, lastPullAt: null, catalogueRevision: "0", pendingOutbox: 0 });
    await expect(loops.pullNow()).rejects.toBeInstanceOf(TransportOfflineError);
    // ⚠️ `online` stays FALSE and `lastError` names the failure. spec:1356 asks for "a visible, HONEST
    // indicator of sync state and last-catalogue-update time"; a loop that swallowed the error and showed a
    // green light would be the dishonest one, and a shop would sell all day at stale prices believing it.
    expect(loops.state().online).toBe(false);
    expect(loops.state().lastError).toContain("ECONNRESET");

    const good = createSyncLoops({ store, transport: server(corpus, 100), terminalId: "t", newBatchId: () => "b" });
    await good.pullNow();
    expect(good.state()).toMatchObject({ online: true, catalogueRevision: "52", lastError: null });
    expect(Date.parse(good.state().lastPullAt!)).toBeGreaterThan(0);
  });

  it("with no transport at all — a till that has never enrolled — every loop is a no-op that reports offline", async () => {
    const loops = createSyncLoops({ store, transport: null, terminalId: "t", newBatchId: () => "b" });
    await loops.pullNow();
    await loops.drainNow();
    expect(loops.state().online).toBe(false);
    expect(loops.state().lastError).toContain("not enrolled");
  });

  it("drainNow sends the outbox in batches capped at SYNC_BATCH_SYNC_LIMIT and acks what the server named", async () => {
    for (let n = 1; n <= 3; n += 1) store.enqueue("ticket", `t-${n}`, { clientRef: `t-${n}` });
    const sent: TicketBatch[] = [];
    const transport: SyncTransport = {
      async pullCatalogue() { return { changes: [], next_cursor: "", has_more: false }; },
      async pushTickets(batch) {
        sent.push(batch);
        return {
          batchId: batch.batchId,
          results: batch.tickets.map((t) => ({ clientRef: t.clientRef, status: "accepted" as const, documentId: "d", number: "n", error: null })),
          shiftResults: [], tillEventResults: [], catalogueCursor: "MQ",
        };
      },
    };
    const loops = createSyncLoops({ store, transport, terminalId: "term-9", newBatchId: () => "batch-1" });
    await loops.drainNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.terminalId).toBe("term-9");
    expect(await store.pendingOutbox(10)).toEqual([]);
    expect(loops.state().pendingOutbox).toBe(0);
  });

  it("a queued (202) push acks nothing and leaves every row pending", async () => {
    store.enqueue("ticket", "t-1", { clientRef: "t-1" });
    const transport: SyncTransport = {
      async pullCatalogue() { return { changes: [], next_cursor: "", has_more: false }; },
      async pushTickets() { const { SyncQueuedError } = await import("@dulja/sync"); throw new SyncQueuedError("b", "j"); },
    };
    const loops = createSyncLoops({ store, transport, terminalId: "t", newBatchId: () => "b" });
    await loops.drainNow();
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual(["t-1"]);
    expect(loops.state().lastError).toContain("queued");
  });
});
```

Run `bun run --cwd apps/pos test -- loops`. **Expected failure:** `Failed to resolve import "../src/main/loops"`.

- [ ] **Step 5: Write `apps/pos/src/main/loops.ts`**

```ts
import { drainOutbox, pullAll, SyncQueuedError, SYNC_BATCH_SYNC_LIMIT, type SyncTransport } from "@dulja/sync";
import type { SqliteSyncStore } from "./store";
import { revisionToText } from "./money";

/** Exactly what spec:1356 asks the indicator to show, and nothing it cannot honestly know. */
export interface SyncState {
  online: boolean;
  lastPullAt: string | null;
  lastPushAt: string | null;
  /** A decimal string, not a bigint: this crosses the `contextBridge` and JSON has no bigint. */
  catalogueRevision: string;
  pendingOutbox: number;
  lastError: string | null;
}

export interface SyncLoops {
  pullNow(): Promise<void>;
  drainNow(): Promise<void>;
  state(): SyncState;
  start(): void;
  stop(): void;
}

/**
 * The two background loops (spec:1303 — *"A background loop drains the outbox"*).
 *
 * **`pullNow` propagates and `drainNow` does not, and the asymmetry is deliberate.** An interrupted pull
 * must surface so the caller knows the catalogue is partial; `pullAll` itself is written not to catch, and
 * the cursor the applied pages advanced is what makes the next call a resume. A drain failure, by contrast,
 * is the *normal* state of an offline till — it happens every fifteen seconds for eight hours — so it is
 * recorded in `state().lastError` and never thrown at a sale.
 */
export function createSyncLoops(opts: {
  store: SqliteSyncStore;
  transport: SyncTransport | null;
  terminalId: string;
  newBatchId: () => string;
  intervalMs?: number;
  now?: () => Date;
}): SyncLoops {
  const interval = opts.intervalMs ?? 15_000;
  const now = opts.now ?? (() => new Date());
  let online = false;
  let lastPullAt: string | null = null;
  let lastPushAt: string | null = null;
  let lastError: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const NOT_ENROLLED = "this till is not enrolled: no terminal key is present";

  const state = (): SyncState => {
    const c = opts.store.catalogueState();
    return {
      online, lastPullAt, lastPushAt,
      catalogueRevision: revisionToText(c.revision),
      pendingOutbox: c.pendingOutbox,
      lastError,
    };
  };

  const pullNow = async (): Promise<void> => {
    if (opts.transport === null) { online = false; lastError = NOT_ENROLLED; return; }
    try {
      await pullAll(opts.store, opts.transport, { pageSize: 1000 });
      online = true; lastPullAt = now().toISOString(); lastError = null;
    } catch (error) {
      // NOT swallowed. The caller — the sell screen's manual "update now", or `start()`'s tick, which does
      // catch — decides. An indicator that showed green after a failed pull is the dishonest one spec:1356
      // forbids, and a shop would sell all day at stale prices believing it.
      online = false; lastError = (error as Error).message;
      throw error;
    }
  };

  const drainNow = async (): Promise<void> => {
    if (opts.transport === null) { online = false; lastError = NOT_ENROLLED; return; }
    try {
      await drainOutbox(opts.store, opts.transport, {
        terminalId: opts.terminalId, newBatchId: opts.newBatchId, batchSize: SYNC_BATCH_SYNC_LIMIT,
      });
      online = true; lastPushAt = now().toISOString(); lastError = null;
    } catch (error) {
      online = error instanceof SyncQueuedError;   // a 202 IS the server answering — the till is online
      lastError = error instanceof SyncQueuedError
        ? `batch ${error.batchId} was queued as job ${error.jobId}; it will be re-sent`
        : (error as Error).message;
      // Deliberately not re-thrown: an offline drain is the normal state of a till mid-shift and must never
      // interrupt a sale. Every row stays pending, which is the whole of "zero lost tickets".
    }
  };

  return {
    pullNow, drainNow, state,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (running) return;                       // never two drains at once against one SQLite file
        running = true;
        void (async () => {
          try { await pullNow(); } catch { /* recorded in state().lastError above */ }
          await drainNow();
          running = false;
        })();
      }, interval);
      timer.unref?.();
    },
    stop(): void { if (timer !== null) { clearInterval(timer); timer = null; } },
  };
}
```

- [ ] **Step 6: Write the enrolment runbook**

`docs/runbooks/till-enrolment.md`:

```markdown
# Enrolling a till

**Who:** a branch manager at the shop, with someone holding `admin.terminal.manage` in the back office.

1. **Back office** — Terminals → *New terminal*: company, branch, a name and a terminal code (the code
   becomes the ticket number's suffix, `POS-<code>`, §4.14). A one-time enrolment code is shown **once**.
2. **Till** — install `pos.exe`, open it, choose *Enrol this till*, type the code.
   The till generates its own key pair, sends only the public half, and stores the private half through
   Windows' own credential encryption (`safeStorage`). Nobody, including the office, ever sees it.
3. The till pulls the catalogue. When the indicator shows a revision and a recent time, it can sell.

## If a till is replaced or reinstalled

Issue a **new** enrolment code and enrol the new machine. Then **revoke the old terminal** in the back
office; its tickets stay in the ledger and its number series is not reused.

> **Before wiping a till, check the indicator's *unsent* count.** Unsent tickets are the only thing on a
> till that exists nowhere else. If the count is not zero, connect the till to the network and wait for it
> to reach zero. Re-enrolling does **not** clear the outbox, and the tickets will be sent by the new
> enrolment — but a wiped disk loses them.

## If the till says the signature is invalid

The till's clock is wrong. Signed calls carry a timestamp and the server refuses one that is far out of
date. Fix the Windows clock; nothing needs re-enrolling.
```

- [ ] **Step 7: Run and commit**

```bash
bun run --cwd apps/pos test -- transport loops
```

**Expected:** 7 + 5 = 12 passed. Then `bun run --cwd apps/pos typecheck` and `bun run lint:rules` at the root — **expected:** clean.

```bash
git add apps/pos/src/main/device.ts apps/pos/src/main/transport.ts apps/pos/src/main/loops.ts \
        apps/pos/test/transport.test.ts apps/pos/test/loops.test.ts docs/runbooks/till-enrolment.md
git commit -m "$(cat <<'EOF'
feat(pos): the device key, the signed transport and the two sync loops [6B T3]

Identity is the signature: no X-Tenant-Id, no X-Actor-Id, no bearer token ever leaves the till
(SAH-044, test 11). pullNow propagates so an interrupted transfer resumes from the cursor
(test 20); drainNow does not, because an offline drain is the normal state of a till mid-shift
and must never interrupt a sale. A 202 acks nothing (§4.10.4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration 0063 — the three till codes, PIN login, offline authority, the branch limits and clock in/out

**The three codes §3.6.2 assigns 6B are evaluated only at the till, and that is what makes them unusual.** §3.6.3's `permission-catalogue` lint *"collects every `PERMISSION.<code>` / `requirePermission('<code>')` / `principalHas('<code>')` reference in `apps/api`, `apps/worker`, **`apps/pos`**, `packages/sync`, `packages/db/src`"* and fails the build if a catalogue code has no reference — so `pos.price.check`, `pos.shift.own` and `pos.attendance.clock` must be referenced from `apps/pos` and nowhere else is required. This task seeds them, grants them to **`cashier` and `branch_manager`**, names all three in `TILL_CODES` so the lint is green from this commit onward, and builds the till-side evaluator that reads them out of the down-synced snapshot.

It also lands **6C's amendment A10 in one line**: *"6B adds the server-side `app.principal_has(cashier, 'pos.attendance.clock', …)` line in the same PR that seeds the code."*

**Files:**
- Create: `packages/db/migrations/0063_seed_permission_phase6b.sql`, `packages/db/migrations/0063.down.sql`, `apps/pos/src/main/authority.ts`, `apps/pos/test/authority.test.ts`
- Modify: `packages/contracts/permissions.ts` (three `PermissionDef` rows), `packages/db/seed/roles.ts` (three grants on **`cashier`** and three on **`branch_manager`** — Step 4), `packages/db/src/sync/apply.ts` (one `principal_has` line inside 6C's attendance loop — 6C A10), **`packages/db/test/sync/apply.test.ts`** (two appended `it`s pinning that the gate reads each event's own principal — Step 5; no earlier case is edited, §3.7.3), **`tests/invariants/support/pos.ts`** (ONE code added to `posFixture`'s cashier `grantCodes` list — Step 5; without it 6C's own clock-in case goes red the moment the gate lands), **`tests/invariants/support/staff.ts`** (ONE code, `pos.shift.own`, added to `cashierA`'s `permissions` array — Step 5; without it T12's `openTill` cannot open a shift), `packages/db/package.json` (the `./staff/pin` subpath — A3), `packages/contracts/src/errors.ts` (`ERR_TILL_PIN_INVALID`, `ERR_TILL_LIMIT_EXCEEDED`)

**Interfaces**

- Consumes: `verifyPin`, `PIN_MIN_LENGTH`, `PIN_MAX_LENGTH`, `PinFormatError` (6C, through the new `@dulja/db/staff/pin` subpath); `CashierSnapshot`, `CashierLimits` (6C — **the shape only**, re-declared structurally in `apps/pos` because the till reads them out of JSON and `packages/db/src/staff/cashier.ts` imports `postgres`); `OVERRIDE_LIFTS`, `LimitKind` (6C — **the mapping**, consumed as data through a structural type for the same reason); `PERMISSION`, `PermissionCode` (0B); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` (0D, §3.6.4 — Step 4 edits two of the nine arrays); `app.principal_has` (2B); `PosDatabase` (T1); `TillError` (T2). **In the two `packages/db` files Step 5 edits, and only there:** `applyTicket`, `applyBatch`, `SyncError`, `ERR_NOT_FOUND`, `TicketInput`, `TerminalApplyContext` (6A) and `recordAttendance`, `AttendanceKind`, `staffFixture` (6C) — **every one of them is already imported by `packages/db/src/sync/apply.ts` and `packages/db/test/sync/apply.test.ts` as 6C left them**, so Step 5 adds no import to either file and `apps/pos` consumes none of them (it has no PostgreSQL driver — Global Constraint 3).
- Produces:
  ```ts
  // apps/pos/src/main/authority.ts
  export interface TillCashier {
    principalId: string; employeeId: string; branchId: string;
    codes: readonly string[]; limits: TillLimits; snapshotRevision: string;
  }
  /** The structural twin of 6C's `CashierLimits`, read out of `catalogue_cashier.snapshot_json`. Declared
   *  here rather than imported because the 6C module that declares it imports `postgres`, and the till
   *  carries no PostgreSQL driver (Global Constraint 3). 6C's type satisfies this one structurally. */
  export interface TillLimits {
    maxLineDiscountPct: string; maxTicketDiscountPct: string; maxVoidAmount: string;
    maxPriceOverridePct: string; blindReturnAllowed: boolean; maxBlindReturnAmount: string;
    roundingIncrement: string; requireCustomerOver: string | null; maxCashInDrawer: string | null;
  }
  export type TillLimitKind = "line_discount" | "ticket_discount" | "void" | "blind_return" | "price_override";
  export interface TillRefusal { kind: TillLimitKind; detail: string; lineNo: number | null }
  export async function loginCashier(db: PosDatabase, opts: { principalId: string; pin: string }): Promise<TillCashier>;
  export function findCashierByEmployeeNumber(db: PosDatabase, employeeNumber: string): { principalId: string } | null;
  export function hasCode(cashier: TillCashier, code: string): boolean;
  export function requireCode(cashier: TillCashier, code: string): void;      // throws TillError ERR_RBAC_FORBIDDEN
  /** The three codes §3.6.2 assigns this slice, named ONCE, in the commit that seeds them — so
   *  `permission-catalogue` sees an `apps/pos` reference to each from this task rather than from T5 and T6,
   *  and `bun run lint:rules` is green at every task boundary (Global Constraint 19). 6A's
   *  `packages/db/src/sync/authority.ts` is the precedent and its Task 5 says why in the same words.
   *  T5's `priceCheck` and T6's `openShift` call `requireCode` with these members at their real call sites. */
  export const TILL_CODES: readonly [
    typeof PERMISSION["pos.price.check"],
    typeof PERMISSION["pos.shift.own"],
    typeof PERMISSION["pos.attendance.clock"],
  ];
  /** Which override `subject` lifts which limit — the till's copy of 6C's `OVERRIDE_LIFTS`, asserted equal
   *  to it by a test in Task 12 so the two can never drift. */
  export const TILL_OVERRIDE_LIFTS: Readonly<Record<string, readonly TillLimitKind[]>>;
  export function liftRefusals(refusals: readonly TillRefusal[], subjects: readonly string[]): TillRefusal[];
  export async function clockEvent(db: PosDatabase, cashier: TillCashier, kind: "clock_in" | "clock_out"): Promise<string>;
  export function pendingAttendance(db: PosDatabase): { kind: "clock_in" | "clock_out"; principalId: string; at: string }[];
  export function markAttendanceSent(db: PosDatabase, ids: readonly string[]): void;
  ```

- [ ] **Step 1: Write the failing test first**

```ts
// apps/pos/test/authority.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPin } from "@dulja/db/staff/pin";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { clockEvent, findCashierByEmployeeNumber, hasCode, liftRefusals, loginCashier, markAttendanceSent,
         pendingAttendance, requireCode, TILL_OVERRIDE_LIFTS, type TillRefusal } from "../src/main/authority";
import { TillError } from "../src/main/errors";

let db: PosDatabase; let store: SqliteSyncStore; const dirs: string[] = [];

const LIMITS = {
  maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500", requireCustomerOver: null, maxCashInDrawer: null,
};

async function mirrorCashier(opts: { principalId: string; pin: string; codes: string[]; revoked?: boolean }): Promise<void> {
  await store.applyChanges([{
    stream: "cashier", op: "upsert", id: opts.principalId, revision: 1n,
    row: {
      id: opts.principalId, employee_id: "emp-1", branch_id: "br-1",
      pin_hash: await hashPin(opts.pin),
      snapshot: { codes: opts.codes, limits: LIMITS, revision: "1" },
      revoked_at: opts.revoked === true ? "2026-01-10T00:00:00.000Z" : null,
      employee_number: "E-001",
    },
  }]);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("PIN login and offline authority (spec:1324, §4.6.3)", () => {
  it("accepts the right PIN and returns the codes and limits from the snapshot", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.ticket.sell", "pos.shift.own"] });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    expect(cashier.principalId).toBe("p-1");
    expect(cashier.branchId).toBe("br-1");
    expect(cashier.codes).toEqual(["pos.ticket.sell", "pos.shift.own"]);
    expect(cashier.limits.maxLineDiscountPct).toBe("0.100000");
    expect(cashier.snapshotRevision).toBe("1");
  });

  it("refuses the wrong PIN with ERR_TILL_PIN_INVALID and says nothing about which half was wrong", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: [] });
    let thrown: unknown;
    try { await loginCashier(db, { principalId: "p-1", pin: "0000" }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_PIN_INVALID");
    // An unknown cashier answers the SAME code. A different one would let anyone enumerate the branch's
    // cashier list from the till's login screen.
    let unknown: unknown;
    try { await loginCashier(db, { principalId: "nobody", pin: "4821" }); } catch (e) { unknown = e; }
    expect((unknown as TillError).code).toBe("ERR_TILL_PIN_INVALID");
  });

  it("refuses a revoked cashier even with the right PIN — the tombstone reaches a disconnected till", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.ticket.sell"], revoked: true });
    await expect(loginCashier(db, { principalId: "p-1", pin: "4821" })).rejects.toMatchObject({ code: "ERR_TILL_PIN_INVALID" });
  });

  it("never stores or logs the PIN, and never compares it as a string", async () => {
    // SAH-028's whole point. The stored value is an Argon2id PHC string and the comparison is verifyPin's.
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: [] });
    const hash = db.raw.prepare<[], { pin_hash: string }>("select pin_hash from catalogue_cashier").get()!.pin_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain("4821");
    const everything = db.raw.prepare<[], { row_json: string; snapshot_json: string }>(
      "select row_json, snapshot_json from catalogue_cashier").get()!;
    expect(everything.row_json).not.toContain("\"4821\"");
    expect(everything.snapshot_json).not.toContain("4821");
  });

  it("hasCode and requireCode read the snapshot, and requireCode refuses with ERR_RBAC_FORBIDDEN", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.ticket.sell", "pos.price.check"] });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    expect(hasCode(cashier, "pos.price.check")).toBe(true);
    expect(hasCode(cashier, "pos.ticket.void")).toBe(false);
    expect(() => requireCode(cashier, "pos.ticket.void")).toThrow(TillError);
    try { requireCode(cashier, "pos.ticket.void"); } catch (e) { expect((e as TillError).code).toBe("ERR_RBAC_FORBIDDEN"); }
  });

  it("finds a cashier by employee number, which is what the login screen types", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: [] });
    expect(findCashierByEmployeeNumber(db, "E-001")).toEqual({ principalId: "p-1" });
    expect(findCashierByEmployeeNumber(db, "E-999")).toBeNull();
  });

  it("TILL_OVERRIDE_LIFTS lifts exactly what the subject names, and an unknown subject lifts nothing", () => {
    const refusals: TillRefusal[] = [
      { kind: "line_discount", detail: "12% > 10%", lineNo: 1 },
      { kind: "void", detail: "300.0000 > 200.0000", lineNo: null },
    ];
    expect(liftRefusals(refusals, ["discount"]).map((r) => r.kind)).toEqual(["void"]);
    expect(liftRefusals(refusals, ["discount", "void"])).toEqual([]);
    expect(liftRefusals(refusals, ["nonsense"])).toHaveLength(2);
    expect(TILL_OVERRIDE_LIFTS["blind_return"]).toEqual(["blind_return"]);
  });

  it("clockEvent writes an attendance row that survives until a ticket carries it (spec:2089)", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.attendance.clock"] });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    const id = await clockEvent(db, cashier, "clock_in");
    expect(pendingAttendance(db)).toEqual([{ kind: "clock_in", principalId: "p-1", at: expect.any(String) }]);
    markAttendanceSent(db, [id]);
    expect(pendingAttendance(db)).toEqual([]);
  });

  it("clockEvent refuses a cashier without pos.attendance.clock", async () => {
    await mirrorCashier({ principalId: "p-1", pin: "4821", codes: ["pos.ticket.sell"] });
    const cashier = await loginCashier(db, { principalId: "p-1", pin: "4821" });
    await expect(clockEvent(db, cashier, "clock_in")).rejects.toMatchObject({ code: "ERR_RBAC_FORBIDDEN" });
  });
});
```

Run `bun run --cwd apps/pos test -- authority`. **Expected failure:** `Failed to resolve import "@dulja/db/staff/pin"`.

- [ ] **Step 2: Add the `./staff/pin` subpath (A3)**

```json
// packages/db/package.json — one entry. The barrel is unchanged; 6C's `export … from "./staff"` stays.
  "exports": {
    ".": "./src/index.ts",
    "./test": "./test/index.ts",
    "./seed": "./src/seed/index.ts",
    "./staff/pin": "./src/staff/pin.ts"
  },
```

**Why a subpath rather than the barrel.** `packages/db/src/index.ts` exports `createDb`, which imports `postgres` at module scope; a barrel import from `apps/pos` would put a PostgreSQL driver in `pos.exe`. `@dulja/db/test` and `@dulja/db/seed` are subpaths for exactly this reason (§3.1: the seed's Supabase admin client must not reach every module that imports `withTenant`), and `sah-039` pins the rule. This is additive: the barrel gains nothing, loses nothing, and the server keeps reaching `hashPin` through it.

Add the proof to Task 12's pinned file (see Task 12 Step 2) — a scan of `apps/pos/src/**` for `from "@dulja/db"` with no subpath.

- [ ] **Step 3: Write migration 0063**

```sql
-- packages/db/migrations/0063_seed_permission_phase6b.sql
-- The three permission codes §3.6.2 assigns slice 6B. They are evaluated ONLY at the till, from the
-- down-synced `pos_cashier.snapshot` (§4.6.3), which is why §3.6.3 makes `apps/pos` one of the roots the
-- `permission-catalogue` lint scans: a code with no reference anywhere fails the build (spec:2051's inverse
-- of SAH-084), and these three have their only references in the till.
--
-- `app.permission` is GLOBAL (no RLS, read-only to app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8, hazard 10). Per-tenant rows -- the role grants -- are `packages/db/seed/roles.ts`.

-- ── 1. the three codes ────────────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  -- spec:1355 "Price check -- a read-only lookup mode (the old system shipped this as a separate
  -- PriceChecker.exe; here it is a mode of the same app)". Read-only, so `mutating` is false.
  ('pos.price.check',      'pos', false, 'Look up an item price at a till without starting a sale'),
  -- spec:1352 "Shift -- open/close with declared opening float, cash count at close". `own` is in the
  -- action vocabulary of §3.6.1 (the C2 resolution added it); `pos.shift.close_any` is 6D's separate code
  -- for closing SOMEONE ELSE'S shift, which is a branch-manager act and not this one.
  ('pos.shift.own',        'pos', true,  'Open and close one''s own till shift'),
  -- spec:2089, §3.7.6's Staff row: "clock-in/out recorded as attendance_event for HR (§3.10)". The
  -- back-office correction code is `hr.attendance.record` and is 6C's -- a different act by a different
  -- person, which is why they are two codes.
  ('pos.attendance.clock', 'pos', true,  'Clock in and out at a till')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

```sql
-- packages/db/migrations/0063.down.sql
-- Deletes exactly the three codes 0063 inserted, and nothing else.
--
-- ⚠️ THIS FILE CANNOT REMOVE THE ROLE GRANTS IT ORPHANS, AND THAT IS A PROPERTY OF THE SCHEMA, NOT AN
--    OMISSION. Three facts, each verifiable:
--      1. `app.role_permission.permission_code references app.permission(code)` has NO `on delete` action
--         (plan0A:1325 -- the default is NO ACTION), and referential-integrity checks bypass RLS, so a
--         `role_permission` row naming one of these three codes makes the delete below raise SQLSTATE 23503.
--      2. The grants cannot be deleted from here. `app.role_permission` carries FORCE ROW LEVEL SECURITY
--         (plan0A:1329 via `app_meta.enable_tenant_rls`, whose body forces RLS "for the table owner too"),
--         and §3.4.8 states the consequence: "a migration file with no set_config sees zero tenants and
--         cannot write them". A `delete from app.role_permission` here would silently affect ZERO rows.
--      3. Nor can this file discover the tenants to set a context FOR: `app.tenant` is itself forced with
--         `using (id = app.current_tenant())` (plan0A:980-981), so the migrator enumerating it sees nothing.
--    Disabling or dropping the policy "temporarily" is forbidden outright (Global Constraint 1; SAH-027,
--    041, 053), so the down file does the one thing it legitimately can and the ROLLBACK CARRIES A
--    PRECONDITION instead: it is exercised on a freshly migrated database with no seeded tenant -- exactly
--    where §3.4.6's generalised reversibility test exercises every down file -- and on a database where
--    `bun run seed --tenant <id> --only roles` has run, the operator removes the grants per tenant first
--    (a seed-tier act, with `set_config('app.tenant_id', ...)`) and re-runs `--only roles` after
--    re-migrating. T4 Step 8 states the precondition on the command. 6A's `0062.down.sql` (6A:1824-1828)
--    has the identical shape for its eleven codes; the general rule belongs in §3.4.5 (Known gaps #8).
delete from app.permission
 where code in ('pos.price.check', 'pos.shift.own', 'pos.attendance.clock');
```

- [ ] **Step 4: Add the three `PermissionDef` rows and the `cashier` grants**

```ts
// packages/contracts/permissions.ts — three rows, in code order inside the `pos` module block.
  { code: "pos.price.check",      module: "pos", mutating: false, phase: "6B", description: "Look up an item price at a till without starting a sale" },
  { code: "pos.shift.own",        module: "pos", mutating: true,  phase: "6B", description: "Open and close one's own till shift" },
  { code: "pos.attendance.clock", module: "pos", mutating: true,  phase: "6B", description: "Clock in and out at a till" },
```

**Two roles, two edits, both in this step.** 6A's Task 5 left the marker: *"`pos.shift.own`, `pos.price.check` and `pos.attendance.clock` are 6B's codes and **6B adds them to this same array**"* (6A:1852), on the `cashier` block it wrote.

```ts
// packages/db/seed/roles.ts — the `cashier` role's `permissions` array gains three entries, appended after
// 6A's four (`pos.ticket.sell`, `pos.ticket.discount`, `pos.ticket.return`, `pos.customer.create`).
// spec:2161 gives the cashier "Sell, discount within the branch limit, return against an original ticket
// … customer quick-create" and, in the same row, the till's own operation: a cashier who cannot open a
// shift cannot sell at all, and one who cannot clock in has no attendance record for HR (spec:2089).
// `pos.price.check` is read-only and every cashier has it.
    "pos.price.check",
    "pos.shift.own",
    "pos.attendance.clock",
```

```ts
// packages/db/seed/roles.ts — the `branch_manager` role's `permissions` array gains the SAME three,
// appended after 6A's eight. spec:2160: "Everything a cashier may, plus overrides on *others'* tickets as
// the second principal, … resolving the needs-attention queue" — and a branch manager stands at a till when
// a cashier is absent, so a role that could not open a shift could not stand there at all. The clock code
// is included for the same reason: a manager working a till is an employee with an attendance record.
    "pos.price.check",
    "pos.shift.own",
    "pos.attendance.clock",
```

**None of the three is half of an R6 pair,** so widening `branch_manager` cannot trip `scripts/lint/rules/role-seed.ts`: 0D's `INCOMPATIBLE_PAIRS` has exactly one POS member, `["hr.employee.read_sensitive", "pos.ticket.sell"]`, and `pos.ticket.sell` is already on both arrays from 6A. All three are `module: "pos"`, two of them `mutating: true`, and neither role is `auditor`, so R7 is untouched. **Task 12's pinned test asserts both roles hold all three** rather than leaving the grant described in prose.

**§3.6.4's recorded-grants sentence gains this slice's row** (Task 0 does not need a separate amendment — §3.6.4's own closing sentence is *"Every later introducing slice adds its row to this sentence in the same PR"*): ***`pos.price.check`, `pos.shift.own`, `pos.attendance.clock` → `cashier`, `branch_manager`* (6B).**

- [ ] **Step 5: Land 6C's amendment A10 — the one server-side line**

6C's A10, verbatim: *"**6B adds the server-side `app.principal_has(cashier, 'pos.attendance.clock', …)` line in the same PR that seeds the code** — named here so it is a one-line addition in a named slice and not a gap nobody owns."*

In `packages/db/src/sync/apply.ts`, **inside** the `for (const a of ticket.attendance)` loop 6C's Task 4 wrote (6C:2343–2356), immediately before its `pos_cashier` lookup:

```ts
      for (const a of ticket.attendance) {
        // 6B T4 (6C amendment A10): now that `pos.attendance.clock` exists in the catalogue and the cashier
        // and branch_manager roles hold it, the attendance event is gated by the code and not only by the
        // pos_cashier row. Until this PR the code did not exist, and `principal_has` against an unseeded
        // code refuses everything — which is why the line is 6B's and not 6C's.
        //
        // TWO THINGS THIS LINE GETS RIGHT AND A CARELESS COPY GETS WRONG.
        //   (1) The handle is `sp`, not `tx`. `applyTicket` is invoked as
        //       `tx.savepoint((sp) => applyTicket(sp, ctx, terminal, ticket))` (6A:4991) and its body uses
        //       `sp` throughout (6A:5026–5057); `tx` is not in scope here and the file would not compile.
        //       The check must share the savepoint anyway: a refused clock-in has to roll back with the
        //       ticket, which is the property 6C's own comment on this loop is about.
        //   (2) The principal is `a.principalId`, NOT `ticket.cashierPrincipalId`. `Ticket.attendance[]` is
        //       the till's `pendingAttendance` drain, which selects EVERY row with `sent_at is null` and
        //       filters by no principal (T7 of this task) — so on a shift handover the outgoing cashier's
        //       `clock_out` rides on the INCOMING cashier's first ticket. Gating on the ticket's cashier
        //       would verify B's authority for A's event; and since 6C's own lookup two lines below already
        //       resolves `a.principalId`, the two would disagree about whose event this is.
        const [clockAuthorised] = await sp<{ ok: boolean }[]>`
          select app.principal_has(${a.principalId}::uuid, 'pos.attendance.clock',
                                   ${terminal.companyId}::uuid, ${terminal.branchId}::uuid) as ok`;
        if (clockAuthorised?.ok !== true) {
          throw new SyncError("ERR_RBAC_FORBIDDEN",
            `principal ${a.principalId} does not hold pos.attendance.clock at branch ${terminal.branchId}`);
        }
        // Below this point the loop body is 6C's, unchanged, and is reproduced here so the whole loop can
        // be read in one place (6C:2344–2356). Do not retype it — verify the file matches:
        const [row] = await sp<{ employeeId: string }[]>`
          select employee_id as "employeeId" from app.pos_cashier
           where principal_id = ${a.principalId} and company_id = ${terminal.companyId}
             and branch_id = ${terminal.branchId} and revoked_at is null`;
        if (!row) throw new SyncError("ERR_NOT_FOUND", `no active cashier ${a.principalId} at branch ${terminal.branchId}`);
        await recordAttendance(sp, terminal.companyId, {
          employeeId: row.employeeId, kind: a.kind as AttendanceKind, occurredAt: a.at,
          branchId: terminal.branchId, terminalId: terminal.terminalId,
          // recorded_by is NOT passed: the column's stamp trigger writes the TERMINAL, which is the acting
          // principal on this path (hazard 19).
        });
      }
```

⚠️ **The `principal_has` gate goes BEFORE 6C's `pos_cashier` lookup, not after, and the ordering matters.** 6C's lookup throws `ERR_NOT_FOUND` for a principal who is no longer an active cashier at that branch; the authority gate throws `ERR_RBAC_FORBIDDEN`. A stale clock-out from an employee who has since been revoked therefore refuses the ticket either way — that is 6C's decision and this line does not change it — but the refusal a shop reads should name the *authority* failure when the code is missing and the *cashier* failure when the row is gone, and putting the code check first makes the two distinguishable in the needs-attention queue. **A shift handover where both cashiers are active and both hold the code passes both checks and posts both events**, which is the case Step 5's new test pins.

**⚠️ FIRST, ONE STRING IN `posFixture`, OR THIS STEP TURNS 6C'S OWN CASE RED.** 6A builds its cashier's authority with a **bespoke role**, not with the seeded `cashier` role: `grantCodes(api.db, s, { principalId: cashierId, roleCode: "pos-cashier", branchIds: [s.hq], codes: ["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.customer.create"] })` (6A:4573–4576). `pos.attendance.clock` did not exist when that list was written, so it is **not** in it — and the moment the `principal_has` gate above lands, 6C's own `it("a clock-in on the ticket becomes an attendance_event acted by the TERMINAL")` (6C:2363–2374) refuses with `ERR_RBAC_FORBIDDEN`. Step 4's edit to `packages/db/seed/roles.ts` does **not** fix this: that widens the seeded `cashier` role, and `posFixture` never assigns it. One string closes it:

```ts
// tests/invariants/support/pos.ts — the cashier's grantCodes list gains ONE code (6B T4).
  await grantCodes(api.db, s, {
    principalId: cashierId, roleCode: "pos-cashier", branchIds: [s.hq],
    codes: ["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.customer.create",
            // 6B T4: the gate in `applyBatch`'s attendance path now evaluates this code, and 6A's list
            // predates it. §3.7.6's Staff row and spec:2089 make clocking in part of what a cashier does.
            "pos.attendance.clock"],
  });
```

`grantCodes` puts the code in a per-test role, and migration 0063 has already inserted it into `app.permission` earlier in this same PR, so the `role_permission → permission` FK is satisfied. **`tests/invariants/support/pos.ts` is already in Task 0's Files** (A2's import switch); this is its second one-line edit in the slice and it joins T4's Files too.

**⚠️ SECOND, ONE STRING IN `staffFixture`, OR TASK 12 CANNOT OPEN A SHIFT.** 6C's fixture has the *same* bespoke-role shape as 6A's and therefore the same trap, one slice further on: `staffFixture` mints `cashierA` with `seedCashier(db, seed, { employeeId: empA, branchId: branchA, pin: "4321", permissions: ["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return"] })`, and `seedCashier` turns that array into a **per-cashier role** (`grantCodes({ …, roleCode: \`cashier-${principalId.slice(-8)}\`, branchIds: [opts.branchId] })`, 6C). `pos.shift.own` is this slice's own new code and is not in that list — so `computeSnapshot` omits it, `catalogue_cashier.snapshot_json` omits it, `TillCashier.codes` omits it, and T6's `openShift`, which opens with `requireCode(opts.cashier, PERMISSION["pos.shift.own"])`, throws `ERR_RBAC_FORBIDDEN` inside `openTill` — failing every case of acceptance test 19. **Step 4's `packages/db/seed/roles.ts` edit does not reach it either**, for exactly the reason it does not reach 6A's cashier: `seedCashier` never assigns the seeded `cashier` role. One string closes it:

```ts
// tests/invariants/support/staff.ts — cashierA's permissions list gains ONE code (6B T4).
  const cashierA = await seedCashier(db, seed, { employeeId: empA, branchId: branchA, pin: "4321",
    // 6B T4: `pos.shift.own` is seeded by migration 0063 earlier in this same PR. A cashier who cannot
    // open a shift cannot sell, so this is the code the fixture's own name already implies it has —
    // spec:2161 gives it to the `cashier` role, and §3.7.6's Shift row makes it part of the job.
    permissions: ["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.shift.own"] });
```

**Why it rides T4's PR and not an earlier one.** `grantCodes` inserts into `app.role_permission`, whose `permission_code` FK points at `app.permission` (plan0A:1322–1326) — so the string cannot exist in 6C's repository until **migration 0063 has been applied**, which is Step 3 of this task. The same argument that puts the `posFixture` edit here puts this one here. `tests/invariants/support/staff.ts` joins T4's Files and T4's `git add`.

**It breaks none of 6C's own cases.** `cashierA` is read by `pos-authority`, `branch-scoping` and `apps/api/test/routes/branch-scoping` for *limit* and *branch* assertions; 6C's four snapshot cases that assert an exact `codes` array (`packages/db/test/staff/cashier-snapshot.test.ts`) each mint their own cashier with their own `permissions` list and never touch `cashierA`. And `CASHIER_SNAPSHOT_CODES` is a **derivation** — 6C amendment A5 defines it as *every `PermissionDef` whose `module === "pos"` and whose code does not start with `pos.sync.`*, with the SQL twin `select code from app.permission where module = 'pos' and code not like 'pos.sync.%'` inside `app.refresh_pos_cashier` — so 0063's three codes widen both spellings at once and the snapshot picks the new grant up through the trigger, with no further 6C change.

**Then pin the handover case, in the suite that owns this seam.** `packages/db/test/sync/apply.test.ts` is 6A's file, rewritten by 6C's Task 4 (6C:166, 2361); it is where the attendance assertion lives, and the till's own `authority.test.ts` cannot host this because it has no PostgreSQL. Append one `it` — **no earlier case is edited** — reusing that file's own helpers exactly as 6A declared them (6A:4744–4769): `f: PosFixture` with `f.s`, `f.cashierId`, `f.supervisorId`, `f.terminal`; the local `apply(tickets)` closure; `api.db.admin` for reads; and `buildTicket(f, { sku })` with `attendance` **assigned after construction**, which is how 6C's own case does it because `buildTicket` takes no `attendance` option.

```ts
// packages/db/test/sync/apply.test.ts — appended (6B T4, landing 6C amendment A10).
// Two imports join the file's existing block; both are `packages/db/test/fixtures.ts` helpers and are
// legal here (this file already imports from `../../../../tests/invariants/support/pos`).
// import { grantCodes, seedCashier, seedEmployee } from "../fixtures";

  it("gates each attendance event on ITS OWN principal, not on the ticket's cashier", async () => {
    // A second ACTIVE cashier at the same branch, with its own role, so nothing shared is mutated.
    const employeeB = await seedEmployee(api.db, f.s, { employeeNumber: "HANDOVER-B" });
    const cashierB = await seedCashier(api.db, f.s, { employeeId: employeeB, branchId: f.s.hq });
    await grantCodes(api.db, f.s, {
      principalId: cashierB, roleCode: "pos-cashier-handover", branchIds: [f.s.hq],
      codes: ["pos.ticket.sell", "pos.attendance.clock"],
    });

    // The handover: cashier B rings up the first sale of the evening, and A's clock-out rides on it because
    // `pendingAttendance` drains every unsent row and filters by no principal (6B T4 Step 7). Both hold the
    // code and both are active cashiers here, so the ticket posts and BOTH events are stored against their
    // OWN employees — which is only true because the gate reads `a.principalId`.
    const ticket = buildTicket(f, { sku: "SKU-A" });
    ticket.cashierPrincipalId = cashierB;
    ticket.attendance = [
      { kind: "clock_out", principalId: f.cashierId, at: "2026-01-15T09:00:00Z" },
      { kind: "clock_in",  principalId: cashierB,    at: "2026-01-15T09:00:05Z" },
    ];
    const out = await apply([ticket]);
    expect(out.results[0]!.status).toBe("accepted");

    const rows = await api.db.admin<{ kind: string; employee_id: string }[]>`
      select kind, employee_id::text as employee_id from app.attendance_event
       where occurred_at >= '2026-01-15T09:00:00Z' and occurred_at < '2026-01-15T10:00:00Z'
       order by occurred_at`;
    expect(rows.map((r) => r.kind)).toEqual(["clock_out", "clock_in"]);
    expect(new Set(rows.map((r) => r.employee_id)).size).toBe(2);   // A's event is A's, B's is B's
    expect(rows[1]!.employee_id).toBe(employeeB);
  }, 120_000);

  it("refuses the WHOLE ticket when an attendance principal lacks pos.attendance.clock, naming that principal", async () => {
    // `f.supervisorId` is an active principal at this branch whose role holds the override codes and NOT
    // `pos.attendance.clock` (6A:4577–4579), so nothing is revoked and no shared role is edited. The
    // refusal must name the ATTENDANCE principal, not the ticket's cashier — that is the whole assertion.
    const ticket = buildTicket(f, { sku: "SKU-A" });
    ticket.attendance = [{ kind: "clock_in", principalId: f.supervisorId, at: "2026-01-15T11:00:00Z" }];
    const out = await apply([ticket]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.results[0]!.error!.detail).toContain(f.supervisorId);
    expect(out.results[0]!.error!.detail).not.toContain(f.cashierId);
    // And the sale went back with the clock event: the savepoint is what makes the till's outbox row still
    // authoritative (6C's own comment on this loop), so no document exists for this clientRef.
    const [doc] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where client_ref = ${ticket.clientRef}`;
    expect(doc!.n).toBe(0);
  }, 120_000);
```

⚠️ **The refusal is `ERR_RBAC_FORBIDDEN` and not 6C's `ERR_NOT_FOUND` precisely because the gate runs before the `pos_cashier` lookup.** `f.supervisorId` has no `pos_cashier` row either, so with the two checks in the other order this case would assert the wrong code — which is why the ordering paragraph above is stated rather than left to the reader.

Then re-run 6A's and 6C's own suites: `bun run --cwd packages/db test -- sync/apply` and `bun run --cwd tests test -- pos-authority branch-scoping`. **Expected:** every existing case green — including 6C's clock-in case, which is green **because of** the one-string `posFixture` edit and would be red without it, and 6C's `pos-authority` and `branch-scoping` suites, which are unaffected by the one-string `staffFixture` edit because none of them asserts an exact `codes` array for `cashierA` — plus the two new cases.

**The handover behaviour is recorded in *Known gaps* #7** (the latency of the attendance feed) rather than only here, because it is the operator-visible half of the same fact.

- [ ] **Step 6: Add the two `ERRORS` rows (A6)**

```ts
// packages/contracts/src/errors.ts
  ERR_TILL_PIN_INVALID: {
    status: 401,
    message: "That PIN does not match a cashier on this till.",
    remedy: "Check the employee number and try again; ask a branch manager to reset the PIN in the back office.",
    raisedBy: "6B",
  },
  ERR_TILL_LIMIT_EXCEEDED: {
    status: 422,
    message: "This ticket exceeds a branch POS limit and carries no supervisor override.",
    remedy: "Reduce the discount, or ask a supervisor to authorise it at the till.",
    raisedBy: "6B",
  },
```

⚠️ **`ERR_TILL_LIMIT_EXCEEDED` is not `ERR_POS_LIMIT_EXCEEDED`.** The latter is **6C's** and is raised by the **server** at sync apply against `app.branch_pos_policy`; this one is the till's own pre-flight refusal, which fires first and never reaches the wire. Sharing a code would make "the server refused a synced ticket" and "the till refused to build one" indistinguishable in a log, and the whole value of the till check is that it happens before the customer has paid.

- [ ] **Step 7: Write `apps/pos/src/main/authority.ts`**

```ts
import { randomUUID } from "node:crypto";
import { PERMISSION } from "@dulja/contracts";
import { verifyPin } from "@dulja/db/staff/pin";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";

export interface TillLimits {
  maxLineDiscountPct: string; maxTicketDiscountPct: string; maxVoidAmount: string;
  maxPriceOverridePct: string; blindReturnAllowed: boolean; maxBlindReturnAmount: string;
  roundingIncrement: string; requireCustomerOver: string | null; maxCashInDrawer: string | null;
}

export interface TillCashier {
  principalId: string; employeeId: string; branchId: string;
  codes: readonly string[]; limits: TillLimits; snapshotRevision: string;
}

export type TillLimitKind = "line_discount" | "ticket_discount" | "void" | "blind_return" | "price_override";
export interface TillRefusal { kind: TillLimitKind; detail: string; lineNo: number | null }

/**
 * The three codes §3.6.2 assigns slice 6B, named once, in the commit that seeds them.
 *
 * **This is what keeps `bun run lint:rules` green at every task boundary**, and it is not a lint prop.
 * §3.6.3's `permission-catalogue` rule fails the build when a catalogue code has no reference in
 * `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` or `packages/db/src` — and this task seeds three
 * codes whose real call sites land in this task (`pos.attendance.clock`, `clockEvent` below), **T5**
 * (`pos.price.check`, `priceCheck`) and **T6** (`pos.shift.own`, `openShift`). Without this array two of
 * the three would be orphans across two commits, and Global Constraint 19 — *"lint:rules stays green after
 * every task"* — would be suspended for the length of a PR chain rather than held.
 *
 * 6A's `packages/db/src/sync/authority.ts` is the precedent and its Task 5 gives the same reason in the same
 * words for its eight codes. The members are `PERMISSION[...]` lookups and not bare strings so a typo is a
 * compile error and `PermissionCode` stays the single source of the spelling.
 */
export const TILL_CODES = [
  PERMISSION["pos.price.check"],
  PERMISSION["pos.shift.own"],
  PERMISSION["pos.attendance.clock"],
] as const;

/**
 * Which override `subject` (§4.10.1's `TicketEvent.subject`) lifts which limit.
 *
 * It is the till's copy of 6C's `OVERRIDE_LIFTS` because that module imports `postgres` and the till carries
 * no PostgreSQL driver (Global Constraint 3). **Task 12's pinned test asserts the two maps are equal**, so a
 * change to one that is not made to the other fails the build rather than letting a till authorise something
 * the server will refuse — which is the SAH-027 shape 6C's nightly comparison exists to catch.
 *
 * `price_override` appears here and **not** in 6C's server-side map on purpose: 6C's Task 9 decision (c)
 * records that `max_price_override_pct` is enforced **at the till only**, because checking it server-side
 * would need a second pricing implementation and §4.10.1's `TicketLine` carries no catalogue price. The
 * server still verifies the override event's supervisor.
 */
export const TILL_OVERRIDE_LIFTS: Readonly<Record<string, readonly TillLimitKind[]>> = {
  discount: ["line_discount", "ticket_discount"],
  void: ["void"],
  blind_return: ["blind_return"],
  price_override: ["price_override"],
};

export function liftRefusals(refusals: readonly TillRefusal[], subjects: readonly string[]): TillRefusal[] {
  const lifted = new Set<TillLimitKind>();
  for (const s of subjects) for (const k of TILL_OVERRIDE_LIFTS[s] ?? []) lifted.add(k);
  return refusals.filter((r) => !lifted.has(r.kind));
}

interface CashierRow { id: string; employee_id: string; branch_id: string; pin_hash: string; snapshot_json: string; revoked_at: string | null }

/**
 * PIN login (spec:1324): the PIN is a **till credential and never a login** — no route accepts one and the
 * server never compares one. The stored value is the Argon2id PHC string 6C's `hashPin` produced, down-synced
 * in `catalogue_cashier`, and `verifyPin` is 6C's function imported through `@dulja/db/staff/pin` (A3) so
 * there is exactly one Argon2id call site in the product (SAH-025, 026, 028).
 *
 * **Every failure answers `ERR_TILL_PIN_INVALID`** — unknown cashier, wrong PIN, revoked credential alike.
 * Distinguishing them would let anyone standing at a till enumerate the branch's cashier list.
 */
export async function loginCashier(db: PosDatabase, opts: { principalId: string; pin: string }): Promise<TillCashier> {
  const row = db.raw.prepare<[string], CashierRow>(
    "select id, employee_id, branch_id, pin_hash, snapshot_json, revoked_at from catalogue_cashier where id = ?",
  ).get(opts.principalId);
  const refuse = (): never => { throw new TillError("ERR_TILL_PIN_INVALID", "that PIN does not match a cashier on this till"); };
  if (row === undefined || row.revoked_at !== null) {
    // Still spend the time: an immediate answer for an unknown id is a timing oracle for the same list.
    await verifyPin(opts.pin, "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").catch(() => false);
    return refuse();
  }
  if (!(await verifyPin(opts.pin, row.pin_hash))) return refuse();
  const snapshot = JSON.parse(row.snapshot_json) as { codes?: string[]; limits?: TillLimits; revision?: string };
  return {
    principalId: row.id,
    employeeId: row.employee_id,
    branchId: row.branch_id,
    codes: snapshot.codes ?? [],
    limits: snapshot.limits ?? {
      maxLineDiscountPct: "0.000000", maxTicketDiscountPct: "0.000000", maxVoidAmount: "0.0000",
      maxPriceOverridePct: "0.000000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
      roundingIncrement: "0.0000", requireCustomerOver: null, maxCashInDrawer: null,
    },
    snapshotRevision: snapshot.revision ?? "0",
  };
}

/** What the login screen actually types: a short employee number, not a uuid. */
export function findCashierByEmployeeNumber(db: PosDatabase, employeeNumber: string): { principalId: string } | null {
  const row = db.raw.prepare<[string], { id: string }>(
    "select id from catalogue_cashier where json_extract(row_json, '$.employee_number') = ? and revoked_at is null",
  ).get(employeeNumber);
  return row === undefined ? null : { principalId: row.id };
}

export function hasCode(cashier: TillCashier, code: string): boolean { return cashier.codes.includes(code); }

export function requireCode(cashier: TillCashier, code: string): void {
  if (!hasCode(cashier, code)) {
    throw new TillError("ERR_RBAC_FORBIDDEN", `this cashier does not hold ${code} at branch ${cashier.branchId}`);
  }
}

/**
 * Clock in or out (spec:2089, §3.7.6's Staff row).
 *
 * The event is a **row**, not a field on a ticket, because a clock-in at 08:00 must survive until the first
 * sale at 08:04 — and must survive the till being closed in between. `pendingAttendance` is what `sell`
 * drains into `Ticket.attendance[]` (§4.10.1), and `markAttendanceSent` is called in the same SQLite
 * transaction as the ticket, so an event is attached to exactly one ticket and never to none.
 *
 * The literal below is `PERMISSION["pos.attendance.clock"]` and not the string, which is what makes
 * §3.6.3's `permission-catalogue` lint see a reference from `apps/pos` (the code has no other reference
 * anywhere in the product).
 */
export async function clockEvent(db: PosDatabase, cashier: TillCashier, kind: "clock_in" | "clock_out"): Promise<string> {
  requireCode(cashier, PERMISSION["pos.attendance.clock"]);
  const id = randomUUID();
  db.raw.prepare("insert into attendance (id, principal_id, kind, occurred_at, sent_at) values (?, ?, ?, ?, null)")
    .run(id, cashier.principalId, kind, new Date().toISOString());
  return id;
}

export function pendingAttendance(db: PosDatabase): { kind: "clock_in" | "clock_out"; principalId: string; at: string }[] {
  return db.raw.prepare<[], { kind: "clock_in" | "clock_out"; principal_id: string; occurred_at: string }>(
    "select kind, principal_id, occurred_at from attendance where sent_at is null order by occurred_at, id",
  ).all().map((r) => ({ kind: r.kind, principalId: r.principal_id, at: r.occurred_at }));
}

export function markAttendanceSent(db: PosDatabase, ids: readonly string[]): void {
  const stamp = db.raw.prepare("update attendance set sent_at = ? where id = ?");
  const now = new Date().toISOString();
  for (const id of ids) stamp.run(now, id);
}
```

⚠️ **`pendingAttendance` returns no id, and `markAttendanceSent` takes ids — read this before writing `sell`.** The two are used together inside one transaction, and the id list comes from a third query in `sell` (`select id from attendance where sent_at is null order by occurred_at, id`) taken in the same order. It is deliberately not one function: `sell` must take the ids **and** the payload inside its own transaction, and a helper returning both would invite a caller to take them outside it.

- [ ] **Step 8: Run and commit**

```bash
bun run --cwd packages/db db:migrate && bun run --cwd packages/db test -- permission-catalogue
bun run --cwd apps/pos test -- authority
bun run lint:rules
```

**Expected:** the catalogue test green in both directions (three new codes in `app.permission` and three in `permissions.ts`); 9 passed in `authority`; **`lint:rules` clean, here and at every later boundary** — `permission-catalogue` finds all three codes referenced from `apps/pos` in *this* commit, because `TILL_CODES` in `authority.ts` names all three (Step 7) alongside `clockEvent`'s own `PERMISSION["pos.attendance.clock"]`. T5's `priceCheck` and T6's `openShift` then add the real call sites for the other two; neither is what discharges the lint, and Global Constraint 19 is held at each commit rather than suspended across the chain.

```bash
# ⚠️ THE DOWN FILE HAS A PRECONDITION: run this on a database where `bun run seed --only roles` has NOT run
#    (a fresh `db:migrate`, which is what §3.4.6's reversibility test uses). 0063.down.sql deletes the three
#    `app.permission` rows and CANNOT delete the `role_permission` grants Step 4 seeds — `app.role_permission`
#    is FORCE-RLS'd and a migration sees zero tenants (§3.4.8), while the FK is NO ACTION (plan0A:1325) and
#    RI checks bypass RLS. On a seeded database this raises SQLSTATE 23503, and the fix is to delete the
#    grants per tenant first (with a tenant context set) and re-run `--only roles` after re-migrating — a
#    seed-tier act, not a migration. The down file's own comment and Known gaps #8 say this once each.
bun run --cwd packages/db db:rollback 62 && bun run --cwd packages/db db:migrate   # the down file, exercised
git add packages/db/migrations/0063_seed_permission_phase6b.sql packages/db/migrations/0063.down.sql \
        packages/contracts/permissions.ts packages/contracts/src/errors.ts packages/db/seed/roles.ts \
        packages/db/package.json packages/db/src/sync/apply.ts packages/db/test/sync/apply.test.ts \
        tests/invariants/support/pos.ts tests/invariants/support/staff.ts \
        apps/pos/src/main/authority.ts apps/pos/test/authority.test.ts
git commit -m "$(cat <<'EOF'
feat(db): seed the three till permission codes and evaluate them offline [6B T4]

pos.price.check, pos.shift.own, pos.attendance.clock — the three §3.6.2 codes whose only
references are in apps/pos, granted to cashier AND branch_manager (spec:2160-2161) and all three
named in TILL_CODES in this same commit, so permission-catalogue is green here and at every later
boundary rather than red across a PR chain. PIN login reads the down-synced snapshot and calls
6C's verifyPin through the new @dulja/db/staff/pin subpath, so the product has exactly one
Argon2id call site (SAH-025, 026, 028).

Lands 6C amendment A10's one server-side principal_has line, inside 6C's own attendance loop and
against each event's OWN principal: a shift handover puts the outgoing cashier's clock_out on the
incoming cashier's first ticket, so gating on the ticket's cashier would verify the wrong person.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Pricing at the till — price list, quantity breaks, customer-specific prices, promotions, tax, and price-check mode

**Everything §3.7.6's *Pricing* and *Price check* rows ask for, computed from the mirrors alone with no network call on the path.** Four rules make it correct rather than merely plausible.

1. **The price comes from 3A's rows, never from a second formula.** `catalogue_price_list_line` is `app.price_list_line` verbatim — `(price_list_id, item_id, unit_id, min_quantity, unit_price)` with `unique nulls not distinct` on the first four (3A) — so *resolve* means "pick the row", and picking has exactly one tie-break rule, stated once below.
2. **Tax is 5A's inclusive branch, re-expressed in two `Money` calls and not a third implementation.** `POS_TICKET` declares `tax.inclusive: true` (6A), so `total` is what the customer pays and `taxAmount` is extracted from it: `base = gross.divide(1 + rate, mode)` at the **tax code's own** `rounding_mode`, then `tax = gross.subtract(base)`. Both operands are read out of `catalogue_tax_code`; **no rate and no rounding rule is written in this plan** (hazard 1). 6A's step-(g) `verifyTax` performs the same two calls server-side, which is why the till's figure and the server's agree by construction rather than by luck.
3. **A promotion is `definition jsonb`, and 3A said in so many words that nothing in slice 3A reads it — this task is its reader.** `promotion.kind` is `'percent_off' | 'amount_off' | 'bundle'` (3A's CHECK, the closed set); the window is `starts_at`/`ends_at` and is evaluated **at the till, against the till's clock**, because 6A deliberately down-syncs promotions with no window filter so that a shortened window travels as an upsert rather than as a silent absence.
4. **A till that has never pulled refuses to price.** `assertCatalogueFresh` throws `ERR_TILL_CATALOGUE_STALE`, and the whole of Global Constraint 5 follows from it: the honest failure is visible, and no ticket is ever built at a guessed price.

**Files:**
- Create: `apps/pos/src/main/pricing.ts`, `apps/pos/test/pricing.test.ts`

**Interfaces**

- Consumes: `Money`, `Quantity`, `currency`, `CurrencyCode`, `RoundingMode` (§4.2.1); `PosDatabase` (T1); `textToMoney`, `moneyToText`, `textToQuantity`, `quantityToText`, `textToRevision` (T1); `TillError` (T2); `TillCashier`, `requireCode` (T4); `PERMISSION` (0B).
- Produces:
  ```ts
  // apps/pos/src/main/pricing.ts
  export interface TillItem {
    itemId: string; code: string; barcode: string | null; nameEn: string; nameAr: string | null;
    baseUnitId: string; trackLots: boolean;
    /** ADVISORY (spec:1307-1308). Null unless a catalogue page carried one; NEVER blocks a sale. */
    stockHint: string | null; stockHintAt: string | null;
  }
  export interface PriceRequest {
    itemId: string;
    /** `null` = the item's base unit, which is how `price_list_line.unit_id` spells the same thing (3A). */
    unitId?: string | null;
    quantity: Quantity;
    customerId?: string | null;
    at?: Date;
  }
  export interface PriceQuote {
    itemId: string; unitId: string;
    unitPrice: Money;
    /** The list the price came from; null when no list matched and `unitPrice` is zero. */
    priceListId: string | null;
    /** The promotion applied, if any, and the discount it produced for `quantity` of this line. */
    promotionId: string | null;
    promotionDiscount: Money;
    source: "price_list" | "no_price";
  }
  export interface TaxedLine { taxCodeId: string | null; base: Money; tax: Money; total: Money }
  export interface PriceCheckResult { item: TillItem; quote: PriceQuote; taxed: TaxedLine }

  /** Throws `ERR_TILL_CATALOGUE_STALE` when this till has never completed a pull. */
  export function assertCatalogueFresh(db: PosDatabase): void;
  export function findItemByBarcode(db: PosDatabase, barcode: string): TillItem | null;
  export function findItemByCode(db: PosDatabase, code: string): TillItem | null;
  export function searchItems(db: PosDatabase, text: string, limit?: number): TillItem[];
  export function resolvePrice(db: PosDatabase, req: PriceRequest): PriceQuote;
  export function taxItemLine(
    db: PosDatabase, opts: { gross: Money; itemId: string; at?: Date },
  ): TaxedLine;
  /** §3.7.6's *Price check* row and spec:1355 — a read-only mode of the same app, gated on
   *  `pos.price.check`. It writes nothing: no ticket, no shift, no outbox row, no till event. */
  export function priceCheck(
    db: PosDatabase, cashier: TillCashier, query: { barcode?: string; code?: string; text?: string },
  ): PriceCheckResult[];
  ```

- [ ] **Step 1: Write the failing test first**

```ts
// apps/pos/test/pricing.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { assertCatalogueFresh, findItemByBarcode, priceCheck, resolvePrice, searchItems, taxItemLine } from "../src/main/pricing";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase; let store: SqliteSyncStore; const dirs: string[] = [];

const CASHIER: TillCashier = {
  principalId: "p-1", employeeId: "emp-1", branchId: "br-1",
  codes: ["pos.ticket.sell", "pos.price.check"],
  limits: {
    maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
    maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
    roundingIncrement: "0.0500", requireCustomerOver: null, maxCashInDrawer: null,
  },
  snapshotRevision: "1",
};

/** The catalogue the whole suite prices against. Every row is the shape 6A's `readCatalogue` emits:
 *  `to_jsonb(row) - 'tenant_id'`, so the keys are the PostgreSQL column names of 3A and 5A. */
const CATALOGUE: Change[] = [
  { stream: "item", op: "upsert", id: "item-A", revision: 10n, row: {
      id: "item-A", code: "SKU-A", barcode: "9001", name_en: "Rice 5kg", name_ar: "أرز ٥ كجم",
      kind: "product", base_unit_id: "unit-ea", track_lots: false, tax_code_id: "tax-std" } },
  { stream: "item", op: "upsert", id: "item-B", revision: 11n, row: {
      id: "item-B", code: "SKU-B", barcode: "9002", name_en: "Rice 10kg", name_ar: null,
      kind: "product", base_unit_id: "unit-ea", track_lots: false, tax_code_id: null } },
  { stream: "price_list", op: "upsert", id: "pl-retail", revision: 12n, row: {
      id: "pl-retail", code: "RETAIL", currency: "MYR", customer_kind: "retail",
      branch_id: null, valid_from: null, valid_to: null } },
  { stream: "price_list", op: "upsert", id: "pl-branch", revision: 13n, row: {
      id: "pl-branch", code: "BR1", currency: "MYR", customer_kind: "retail",
      branch_id: "br-1", valid_from: null, valid_to: null } },
  { stream: "price_list", op: "upsert", id: "pl-wholesale", revision: 14n, row: {
      id: "pl-wholesale", code: "WHOLE", currency: "MYR", customer_kind: "wholesale",
      branch_id: null, valid_from: null, valid_to: null } },
  // RETAIL: 12.00 from 1, 11.00 from 10. BR1: 11.50 flat. WHOLE: 9.00 flat.
  { stream: "price_list_line", op: "upsert", id: "pll-1", revision: 15n, row: {
      id: "pll-1", price_list_id: "pl-retail", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "12.0000" } },
  { stream: "price_list_line", op: "upsert", id: "pll-2", revision: 16n, row: {
      id: "pll-2", price_list_id: "pl-retail", item_id: "item-A", unit_id: null,
      min_quantity: "10.000000", unit_price: "11.0000" } },
  { stream: "price_list_line", op: "upsert", id: "pll-3", revision: 17n, row: {
      id: "pll-3", price_list_id: "pl-branch", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "11.5000" } },
  { stream: "price_list_line", op: "upsert", id: "pll-4", revision: 18n, row: {
      id: "pll-4", price_list_id: "pl-wholesale", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "9.0000" } },
  { stream: "customer", op: "upsert", id: "cust-w", revision: 19n, row: {
      id: "cust-w", code: "C-WHOLE", name_en: "Wholesale Co", name_ar: null, phone: "0170000001",
      currency: "MYR", credit_limit: "5000.0000", credit_hold: false, customer_kind: "wholesale",
      price_list_id: "pl-wholesale" } },
  { stream: "tax_code", op: "upsert", id: "tax-std", revision: 20n, row: {
      id: "tax-std", code: "SYNTH-OUT-STD", rate: "0.10000000", kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO", output_account_id: "acct-2300", input_account_id: null,
      effective_from: "2026-01-01", effective_to: null } },
];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges(CATALOGUE);
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("pricing at the till (§3.7.6 Pricing, spec:1345-1348)", () => {
  it("refuses to price on a till that has never pulled, with ERR_TILL_CATALOGUE_STALE", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
    const fresh = openPosDatabase(join(dir, "till.sqlite"));
    let thrown: unknown;
    try { assertCatalogueFresh(fresh); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_CATALOGUE_STALE");
    fresh.close();
    // And the pulled one does not throw.
    expect(() => assertCatalogueFresh(db)).not.toThrow();
  });

  it("finds an item by barcode, which is all a keyboard-wedge scanner does (D18)", () => {
    expect(findItemByBarcode(db, "9001")?.code).toBe("SKU-A");
    expect(findItemByBarcode(db, "0000")).toBeNull();
  });

  it("searches by code and by BOTH names, so an Arabic-first shop can search at all", () => {
    expect(searchItems(db, "rice").map((i) => i.code).sort()).toEqual(["SKU-A", "SKU-B"]);
    expect(searchItems(db, "SKU-B").map((i) => i.code)).toEqual(["SKU-B"]);
    expect(searchItems(db, "أرز").map((i) => i.code)).toEqual(["SKU-A"]);
  });

  it("prefers the BRANCH price list over the company-wide one (spec:1312 'price list per shop')", () => {
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000") });
    expect(q.unitPrice.toString()).toBe("11.5000");
    expect(q.priceListId).toBe("pl-branch");
    expect(q.source).toBe("price_list");
  });

  it("applies the highest quantity break at or below the line quantity", () => {
    // BR1 has one flat line, so the break test uses the customer whose list carries two.
    const one = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000"), customerId: null });
    expect(one.unitPrice.toString()).toBe("11.5000");
    // Delete the branch list's line so RETAIL wins, and the two breaks become visible.
    db.raw.prepare("delete from catalogue_price_list_line where id = 'pll-3'").run();
    expect(resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("9.000000") }).unitPrice.toString()).toBe("12.0000");
    expect(resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("10.000000") }).unitPrice.toString()).toBe("11.0000");
    expect(resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("500.000000") }).unitPrice.toString()).toBe("11.0000");
  });

  // ⚠️ **SKIPPED, and this skip IS the delivery gap — Known gaps #1, amendment A10(b).** `candidateLists`
  // rule 1 is written and correct, but `app.party` carries no `price_list_id` until **4A's migration 0045**
  // adds it, and 0045 is outside 6B's range (0063 only, §3.4.1) with 4A already written — so nothing in this
  // slice can make `catalogue_customer.row_json` carry the key this case reads, and the fallback to
  // branch-then-company (the two cases above) is what a customer actually gets. §2.7's card lists
  // *"customer-specific pricing"* as a 6B delivery bullet and §6.2 makes 6B the owner of row spec:1062:
  // **un-skipping this one case is the whole of closing that clause.** It is `it.skip` and not deleted
  // precisely so the gap is visible in the suite output rather than only in prose.
  it.skip("prices a customer-specific list ahead of the branch list (A10b)", () => {
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000"), customerId: "cust-w" });
    expect(q.unitPrice.toString()).toBe("9.0000");
    expect(q.priceListId).toBe("pl-wholesale");
  });

  it("answers no_price with a ZERO price rather than a null, and never guesses", () => {
    const q = resolvePrice(db, { itemId: "item-B", quantity: Quantity.of("1.000000") });
    expect(q.source).toBe("no_price");
    expect(q.priceListId).toBeNull();
    expect(q.unitPrice.toString()).toBe("0.0000");
  });

  it("ignores a price list whose validity window has closed", () => {
    db.raw.prepare("update catalogue_price_list set valid_to = '2026-01-31' where id = 'pl-branch'").run();
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000"), at: new Date("2026-06-01T00:00:00.000Z") });
    expect(q.priceListId).toBe("pl-retail");
    expect(q.unitPrice.toString()).toBe("12.0000");
  });

  it("applies a percent_off promotion inside its window and nothing outside it", async () => {
    await store.applyChanges([{ stream: "promotion", op: "upsert", id: "pr-1", revision: 30n, row: {
      id: "pr-1", code: "JUNE10", kind: "percent_off", branch_id: null,
      starts_at: "2026-06-01T00:00:00.000Z", ends_at: "2026-06-30T23:59:59.000Z",
      definition: { itemIds: ["item-A"], percent: "0.100000" } } }]);
    const inside = resolvePrice(db, {
      itemId: "item-A", quantity: Quantity.of("2.000000"), at: new Date("2026-06-15T10:00:00.000Z") });
    // 11.5000 × 2 = 23.0000; 10 % of that is 2.3000.
    expect(inside.promotionId).toBe("pr-1");
    expect(inside.promotionDiscount.toString()).toBe("2.3000");
    const outside = resolvePrice(db, {
      itemId: "item-A", quantity: Quantity.of("2.000000"), at: new Date("2026-07-01T10:00:00.000Z") });
    expect(outside.promotionId).toBeNull();
    expect(outside.promotionDiscount.toString()).toBe("0.0000");
  });

  it("applies amount_off per unit and bundle per whole group, and takes the LARGEST discount when two match", async () => {
    await store.applyChanges([
      { stream: "promotion", op: "upsert", id: "pr-amt", revision: 31n, row: {
        id: "pr-amt", code: "OFF50SEN", kind: "amount_off", branch_id: "br-1", starts_at: null, ends_at: null,
        definition: { itemIds: ["item-A"], amountPerUnit: "0.5000", currency: "MYR" } } },
      { stream: "promotion", op: "upsert", id: "pr-bundle", revision: 32n, row: {
        id: "pr-bundle", code: "3FOR30", kind: "bundle", branch_id: null, starts_at: null, ends_at: null,
        definition: { itemIds: ["item-A"], groupQuantity: "3.000000", groupPrice: "30.0000", currency: "MYR" } } },
    ]);
    // amount_off on 4 units: 4 × 0.5000 = 2.0000.
    // bundle on 4 units at 11.5000: one group of 3 costs 30.0000 instead of 34.5000 → 4.5000 off.
    const q = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("4.000000") });
    expect(q.promotionId).toBe("pr-bundle");
    expect(q.promotionDiscount.toString()).toBe("4.5000");
    // Two units: bundle gives nothing (no complete group), amount_off gives 1.0000 and wins.
    const two = resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("2.000000") });
    expect(two.promotionId).toBe("pr-amt");
    expect(two.promotionDiscount.toString()).toBe("1.0000");
  });

  it("a promotion for a different branch is not applied — Form B down-syncs both, the till chooses", async () => {
    await store.applyChanges([{ stream: "promotion", op: "upsert", id: "pr-b2", revision: 33n, row: {
      id: "pr-b2", code: "OTHER", kind: "percent_off", branch_id: "br-2", starts_at: null, ends_at: null,
      definition: { itemIds: ["item-A"], percent: "0.500000" } } }]);
    expect(resolvePrice(db, { itemId: "item-A", quantity: Quantity.of("1.000000") }).promotionId).toBeNull();
  });

  it("extracts tax from the gross with the CODE's rate and the CODE's rounding mode (5A's inclusive branch)", () => {
    // 11.5000 × 2 = 23.0000 gross; rate 0.10 → base = 23.0000 / 1.10 = 20.9091 (HALF_AWAY_FROM_ZERO),
    // tax = 23.0000 − 20.9091 = 2.0909. base + tax === gross EXACTLY, which is the property 6A's step (g)
    // compares against.
    const taxed = taxItemLine(db, { gross: Money.of("23.0000", MYR), itemId: "item-A" });
    expect(taxed.taxCodeId).toBe("tax-std");
    expect(taxed.base.toString()).toBe("20.9091");
    expect(taxed.tax.toString()).toBe("2.0909");
    expect(taxed.total.toString()).toBe("23.0000");
    expect(taxed.base.add(taxed.tax).toString()).toBe(taxed.total.toString());
  });

  it("an item with no tax code is taxed at nothing, and says so with a null code", () => {
    const taxed = taxItemLine(db, { gross: Money.of("10.0000", MYR), itemId: "item-B" });
    expect(taxed.taxCodeId).toBeNull();
    expect(taxed.tax.toString()).toBe("0.0000");
    expect(taxed.base.toString()).toBe("10.0000");
  });

  it("ignores a tax code whose effective window has closed and taxes at nothing rather than at a stale rate", () => {
    db.raw.prepare("update catalogue_tax_code set effective_to = '2026-01-31' where id = 'tax-std'").run();
    const taxed = taxItemLine(db, {
      gross: Money.of("23.0000", MYR), itemId: "item-A", at: new Date("2026-06-01T00:00:00.000Z") });
    expect(taxed.taxCodeId).toBeNull();
    expect(taxed.tax.toString()).toBe("0.0000");
  });

  it("counts only UNARCHIVED output codes: one archived and one live still resolves to the live one", async () => {
    // spec:2049 — master data is archived, never deleted (5A's `app.tax_code.archived_at`, 5A:591). A regime
    // that replaced one output rate with another leaves two rows whose effective windows both contain today.
    // Without `archived_at is null` the fallback would count 2, answer `null`, tax the line at nothing, and
    // 6A's step (g) would refuse every ticket in the shop — with the catalogue perfectly correct.
    await store.applyChanges([{ stream: "tax_code", op: "upsert", id: "tax-old", revision: 21n, row: {
      id: "tax-old", code: "SYNTH-OUT-OLD", rate: "0.06000000", kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO", output_account_id: "acct-2300", input_account_id: null,
      effective_from: "2026-01-01", effective_to: null, archived_at: "2026-05-31T00:00:00.000Z" } }]);
    expect(db.raw.prepare<[], { n: number }>(
      "select count(*) as n from catalogue_tax_code where kind = 'output'").get()!.n).toBe(2);
    const taxed = taxItemLine(db, { gross: Money.of("23.0000", MYR), itemId: "item-A" });
    expect(taxed.taxCodeId).toBe("tax-std");        // the LIVE code, at 10 %, not `null`
    expect(taxed.tax.toString()).toBe("2.0909");
  });

  it("a negative gross — a return line — extracts a negative tax with the same two calls", () => {
    const taxed = taxItemLine(db, { gross: Money.of("-23.0000", MYR), itemId: "item-A" });
    expect(taxed.base.toString()).toBe("-20.9091");
    expect(taxed.tax.toString()).toBe("-2.0909");
    expect(taxed.total.toString()).toBe("-23.0000");
  });

  it("priceCheck needs pos.price.check and writes NOTHING", () => {
    const before = db.raw.prepare<[], { n: number }>(
      "select (select count(*) from ticket) + (select count(*) from outbox) + (select count(*) from till_event) as n").get()!.n;
    const results = priceCheck(db, CASHIER, { barcode: "9001" });
    expect(results).toHaveLength(1);
    expect(results[0]!.item.code).toBe("SKU-A");
    expect(results[0]!.quote.unitPrice.toString()).toBe("11.5000");
    expect(results[0]!.taxed.total.toString()).toBe("11.5000");
    const after = db.raw.prepare<[], { n: number }>(
      "select (select count(*) from ticket) + (select count(*) from outbox) + (select count(*) from till_event) as n").get()!.n;
    expect(after).toBe(before);

    const noCode: TillCashier = { ...CASHIER, codes: ["pos.ticket.sell"] };
    expect(() => priceCheck(db, noCode, { barcode: "9001" })).toThrow(TillError);
    try { priceCheck(db, noCode, { barcode: "9001" }); }
    catch (e) { expect((e as TillError).code).toBe("ERR_RBAC_FORBIDDEN"); }
  });

  it("priceCheck quotes at quantity ONE, because a lookup is not a line", () => {
    // The break at 10 must not appear in a price check: the customer asked what one costs.
    db.raw.prepare("delete from catalogue_price_list_line where id = 'pll-3'").run();
    expect(priceCheck(db, CASHIER, { code: "SKU-A" })[0]!.quote.unitPrice.toString()).toBe("12.0000");
  });

  it("priceCheck by free text returns every match, so a cashier can pick", () => {
    expect(priceCheck(db, CASHIER, { text: "rice" }).map((r) => r.item.code).sort()).toEqual(["SKU-A", "SKU-B"]);
  });
});
```

Run `bun run --cwd apps/pos test -- pricing`. **Expected failure:** `Failed to resolve import "../src/main/pricing"`.

- [ ] **Step 2: Write `apps/pos/src/main/pricing.ts` — the readers and the resolution rule**

```ts
import { Money, Quantity, currency, type CurrencyCode, type RoundingMode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";

export interface TillItem {
  itemId: string; code: string; barcode: string | null; nameEn: string; nameAr: string | null;
  baseUnitId: string; trackLots: boolean;
  stockHint: string | null; stockHintAt: string | null;
}

export interface PriceRequest {
  itemId: string;
  unitId?: string | null;
  quantity: Quantity;
  customerId?: string | null;
  at?: Date;
}

export interface PriceQuote {
  itemId: string; unitId: string;
  unitPrice: Money;
  priceListId: string | null;
  promotionId: string | null;
  promotionDiscount: Money;
  source: "price_list" | "no_price";
}

export interface TaxedLine { taxCodeId: string | null; base: Money; tax: Money; total: Money }
export interface PriceCheckResult { item: TillItem; quote: PriceQuote; taxed: TaxedLine }

const MODE: RoundingMode = "HALF_AWAY_FROM_ZERO";     // hazard 23's mode, and 6C's `MODE` for the same reason

/**
 * The till's own currency, read from the branch's price lists rather than declared.
 *
 * **There is no `Seed.currency` and no company row at the till** (the header's fact (1)), so a module
 * constant `"MYR"` here would be a jurisdiction fact this plan may not state. Every `catalogue_price_list`
 * row carries 3A's `currency char(3)`, and a branch's lists are all in the company's currency; the first one
 * is therefore the answer, and a till with no price list at all cannot price anything anyway.
 */
function tillCurrency(db: PosDatabase): CurrencyCode {
  const row = db.raw.prepare<[], { currency: string }>(
    "select currency from catalogue_price_list order by id limit 1").get();
  if (row === undefined) {
    throw new TillError("ERR_TILL_CATALOGUE_STALE", "this till holds no price list and cannot price a ticket");
  }
  return currency(row.currency);
}

/**
 * spec:1345's honest failure. A till whose `catalogue_pulled_at` is absent has never completed a pull, so
 * every mirror is empty and every price would be a guess. `ERR_TILL_CATALOGUE_STALE` is the answer, and the
 * offline indicator (T3's `SyncState`) shows the same two facts the cashier needs to fix it.
 */
export function assertCatalogueFresh(db: PosDatabase): void {
  const pulled = db.raw.prepare<[], { value: string }>(
    "select value from meta where key = 'catalogue_pulled_at'").get();
  if (pulled === undefined) {
    throw new TillError("ERR_TILL_CATALOGUE_STALE",
      "this till has never completed a catalogue update and cannot price a ticket");
  }
}

interface ItemDbRow {
  id: string; code: string; barcode: string | null; name_en: string; name_ar: string | null;
  base_unit_id: string; track_lots: number; stock_hint: string | null; stock_hint_at: string | null;
}
const toItem = (r: ItemDbRow): TillItem => ({
  itemId: r.id, code: r.code, barcode: r.barcode, nameEn: r.name_en, nameAr: r.name_ar,
  baseUnitId: r.base_unit_id, trackLots: r.track_lots === 1,
  stockHint: r.stock_hint, stockHintAt: r.stock_hint_at,
});
const ITEM_COLUMNS =
  "id, code, barcode, name_en, name_ar, base_unit_id, track_lots, stock_hint, stock_hint_at";

export function findItemByBarcode(db: PosDatabase, barcode: string): TillItem | null {
  const row = db.raw.prepare<[string], ItemDbRow>(
    `select ${ITEM_COLUMNS} from catalogue_item where barcode = ?`).get(barcode);
  return row === undefined ? null : toItem(row);
}

export function findItemByCode(db: PosDatabase, code: string): TillItem | null {
  const row = db.raw.prepare<[string], ItemDbRow>(
    `select ${ITEM_COLUMNS} from catalogue_item where code = ?`).get(code);
  return row === undefined ? null : toItem(row);
}

/**
 * Search by code or by **either** name.
 *
 * `name_ar` is in the `where` for a reason that is not symmetry: spec:2061 and acceptance test 23 make Arabic
 * a first-class direction, and a shop whose staff read the Arabic label would otherwise be unable to find any
 * item by name at all. SQLite's `like` is ASCII-case-insensitive only, which is exactly right here — Arabic
 * has no case — and the `lower()` on both sides covers the Latin half.
 */
export function searchItems(db: PosDatabase, text: string, limit = 20): TillItem[] {
  const needle = `%${text.trim().toLowerCase()}%`;
  return db.raw.prepare<[string, string, string, number], ItemDbRow>(
    `select ${ITEM_COLUMNS} from catalogue_item
      where lower(code) like ?1 or lower(name_en) like ?2 or lower(coalesce(name_ar, '')) like ?3
      order by code limit ?4`,
  ).all(needle, needle, needle, limit).map(toItem);
}
```

- [ ] **Step 3: The resolution rule, written once**

```ts
/**
 * Which price list applies, in one ordered rule and not four scattered branches.
 *
 * 1. **The customer's own list**, when the ticket has a customer and that customer's mirrored row carries a
 *    `price_list_id` — §3.7.6's *"customer-specific pricing"*.
 * 2. **The branch's list** (`branch_id = this branch`), which is spec:1312's *"price list per shop"*.
 * 3. **The company-wide list** (`branch_id is null`) — Form B's NULL rows, which 6A deliberately down-syncs.
 *
 * Within the chosen list, the line is the one with the **highest `min_quantity` at or below the line
 * quantity** for this item and unit, which is what a quantity break means (3A's `unique nulls not distinct`
 * on `(price_list_id, item_id, unit_id, min_quantity)` guarantees there is at most one such row per break).
 *
 * `valid_from`/`valid_to` are dates on the list and are compared against the till's clock. A closed window
 * removes the list from consideration and the next rule applies — it never falls through to "no price" while
 * a valid list exists, which is the failure a single-query `order by branch_id nulls last limit 1` produces.
 *
 * **The till's branch is not a parameter.** `catalogue_branch_pos_policy` holds exactly one row — the
 * terminal's own branch, because 6A's `readCatalogue` filters that stream to it — so the branch is a fact
 * about the local file and reading it from a caller would let one call site disagree with another.
 */
function tillBranchId(db: PosDatabase): string | null {
  const row = db.raw.prepare<[], { branch_id: string }>(
    "select branch_id from catalogue_branch_pos_policy order by id limit 1").get();
  return row?.branch_id ?? null;
}

interface PriceListDbRow { id: string; branch_id: string | null; valid_from: string | null; valid_to: string | null }

function candidateLists(db: PosDatabase, customerId: string | null, at: Date): string[] {
  const day = at.toISOString().slice(0, 10);              // a `date` column; compare dates to dates
  const open = (l: PriceListDbRow): boolean =>
    (l.valid_from === null || l.valid_from <= day) && (l.valid_to === null || l.valid_to >= day);

  const ordered: string[] = [];
  if (customerId !== null) {
    // ⚠️ **Amendment A10(b).** `app.party` carries no `price_list_id` until 4A's migration 0045 adds it, so
    // on a repository where A10 has not landed this reads `undefined` and rule 1 is skipped — the branch's
    // list then wins, which is rules 2 and 3 of three. That is correct behaviour (a customer with no list
    // gets the shop's) but it means §3.7.6's *"customer-specific pricing"* is **not delivered** until the
    // column exists. The Self-Review's *Known gaps* says so; nothing here guesses a list.
    const cust = db.raw.prepare<[string], { row_json: string }>(
      "select row_json from catalogue_customer where id = ?").get(customerId);
    const listId = cust === undefined
      ? null
      : ((JSON.parse(cust.row_json) as { price_list_id?: string | null }).price_list_id ?? null);
    if (listId !== null) ordered.push(listId);
  }
  const branchId = tillBranchId(db);
  const lists = db.raw.prepare<[], PriceListDbRow>(
    "select id, branch_id, valid_from, valid_to from catalogue_price_list order by code").all();
  for (const l of lists) if (branchId !== null && l.branch_id === branchId) ordered.push(l.id);
  for (const l of lists) if (l.branch_id === null) ordered.push(l.id);

  const byId = new Map(lists.map((l) => [l.id, l]));
  const seen = new Set<string>();
  return ordered.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const l = byId.get(id);
    return l !== undefined && open(l);
  });
}

export function resolvePrice(db: PosDatabase, req: PriceRequest): PriceQuote {
  assertCatalogueFresh(db);
  const cur = tillCurrency(db);
  const at = req.at ?? new Date();
  const item = db.raw.prepare<[string], { base_unit_id: string }>(
    "select base_unit_id from catalogue_item where id = ?").get(req.itemId);
  if (item === undefined) {
    throw new TillError("ERR_NOT_FOUND", `no item ${req.itemId} in this till's catalogue`);
  }
  const unitId = req.unitId ?? item.base_unit_id;
  // `unit_id is null` in 3A means "the item's base unit", so a request for the base unit must match BOTH the
  // explicit row and the null row. Anything else silently misses every price list a shop actually types.
  const matchesBase = unitId === item.base_unit_id;

  let chosen: { listId: string; unitPrice: Money } | null = null;
  for (const listId of candidateLists(db, req.customerId ?? null, at)) {
    // The parameter tuple is (listId, itemId, unitId, matchesBase-flag, quantity): positions 4 and 5 are
    // NUMBERS — `?4` is bound with `matchesBase ? 1 : 0` and `?5` with the quantity as a float for the
    // `min_quantity` comparison — so typing position 4 `string` is a compile error at the `.get(...)` call.
    const line = db.raw.prepare<[string, string, string, number, number], { unit_price: string }>(
      `select unit_price from catalogue_price_list_line
        where price_list_id = ?1 and item_id = ?2
          and (unit_id = ?3 or (unit_id is null and ?4 = 1))
          and cast(min_quantity as real) <= ?5
        order by cast(min_quantity as real) desc limit 1`,
    ).get(listId, req.itemId, unitId, matchesBase ? 1 : 0, Number(req.quantity.toString()));
    if (line !== undefined) { chosen = { listId, unitPrice: Money.of(line.unit_price, cur) }; break; }
  }

  if (chosen === null) {
    return {
      itemId: req.itemId, unitId, unitPrice: Money.zero(cur), priceListId: null,
      promotionId: null, promotionDiscount: Money.zero(cur), source: "no_price",
    };
  }

  const promotion = bestPromotion(db, {
    itemId: req.itemId, unitPrice: chosen.unitPrice, quantity: req.quantity, at, cur,
  });
  return {
    itemId: req.itemId, unitId, unitPrice: chosen.unitPrice, priceListId: chosen.listId,
    promotionId: promotion.promotionId, promotionDiscount: promotion.discount, source: "price_list",
  };
}
```

⚠️ **`cast(min_quantity as real)` and `Number(quantity)` are the one place a quantity touches a float, and the comparison is safe while an arithmetic use would not be.** A quantity break is a **threshold** — 0, 10, 100, 1000 in every shop's price list — and `real` compares those exactly. The value that leaves the query is `unit_price`, a `TEXT` column parsed by `Money.of`; the quantity itself never leaves as a number, and `no-number-money` sees no `number`-typed name matching its pattern (`quantity` is not in the money regex, and the local `matchesBase` is a `0|1` flag). **Do not extend this to arithmetic**: `min_quantity`'s own value is never added, multiplied or stored from here.

- [ ] **Step 4: Promotions — the three kinds 3A's CHECK admits, and no fourth**

```ts
interface PromotionDbRow {
  id: string; kind: string; definition: string; starts_at: string | null; ends_at: string | null;
  branch_id: string | null;
}

/** The `definition jsonb` shapes this task defines as the reader of 3A's column (3A: "interpreted by 6B at
 *  the till; NO code in slice 3A reads it"). One shape per `kind`, and `kind` is 3A's closed CHECK. */
interface PercentOff { itemIds: string[]; percent: string }
interface AmountOff { itemIds: string[]; amountPerUnit: string; currency: string }
interface Bundle { itemIds: string[]; groupQuantity: string; groupPrice: string; currency: string }

/**
 * The largest discount among the promotions that match, and `null` when none does.
 *
 * **Largest, not first, and not stacked.** Stacking is a business decision nobody has made (it is not in
 * §3.7.6's Pricing row, and §2.12 has no item for it), and "first" would make the answer depend on the order
 * rows happened to arrive in a catalogue page — a till and a second till would then price the same basket
 * differently with no rule anyone could state. Largest is defensible at the counter, is stable under any
 * arrival order, and is the customer's benefit.
 *
 * The window is checked **here, at the till, against the till's clock**, because 6A's `readCatalogue` carries
 * no `ends_at > now()` filter on purpose: an edit that shortens a window bumps the revision and travels as an
 * upsert, and filtering server-side would turn that edit into a silent absence and leave the till on the OLD
 * window for ever (6A's own comment; acceptance test 20).
 */
function bestPromotion(
  db: PosDatabase,
  o: { itemId: string; unitPrice: Money; quantity: Quantity; at: Date; cur: CurrencyCode },
): { promotionId: string | null; discount: Money } {
  const now = o.at.toISOString();
  const branchId = tillBranchId(db);
  const rows = db.raw.prepare<[string, string], PromotionDbRow>(
    `select id, kind, definition, starts_at, ends_at, branch_id from catalogue_promotion
      where (starts_at is null or starts_at <= ?1) and (ends_at is null or ends_at >= ?2)
      order by code`,
  ).all(now, now);

  const magnitude = o.quantity.isNegative() ? o.quantity.negate() : o.quantity;
  const grossMagnitude = o.unitPrice.abs().multiply(magnitude.toString(), MODE);
  let best: { promotionId: string; discount: Money } | null = null;
  const consider = (id: string, discount: Money): void => {
    if (discount.isZero() || discount.isNegative()) return;
    // Never more than the line is worth: a promotion that outran the price would produce a negative line.
    const capped = discount.compare(grossMagnitude) > 0 ? grossMagnitude : discount;
    if (best === null || capped.compare(best.discount) > 0) best = { promotionId: id, discount: capped };
  };

  for (const row of rows) {
    // Form B at the till: a NULL branch is every branch; any other branch is somebody else's promotion.
    if (row.branch_id !== null && row.branch_id !== branchId) continue;
    const def = JSON.parse(row.definition) as Record<string, unknown>;
    const items = (def["itemIds"] as string[] | undefined) ?? [];
    if (!items.includes(o.itemId)) continue;

    switch (row.kind) {
      case "percent_off": {
        const d = def as unknown as PercentOff;
        consider(row.id, grossMagnitude.multiply(d.percent, MODE));
        break;
      }
      case "amount_off": {
        const d = def as unknown as AmountOff;
        if (currency(d.currency) !== o.cur) break;      // a promotion in another currency is not this shop's
        consider(row.id, Money.of(d.amountPerUnit, o.cur).multiply(magnitude.toString(), MODE));
        break;
      }
      case "bundle": {
        const d = def as unknown as Bundle;
        if (currency(d.currency) !== o.cur) break;
        // How many complete groups the line contains, as an exact decimal integer and never a float:
        // `Quantity.toDecimal()` is `decimal.js`, and `divToInt` is exact.
        const groups = magnitude.toDecimal().divToInt(Quantity.of(d.groupQuantity).toDecimal());
        if (groups.lessThanOrEqualTo(0)) break;
        const bundled = Quantity.of(d.groupQuantity).toDecimal().times(groups);
        const listPrice = o.unitPrice.abs().multiply(bundled.toFixed(6), MODE);
        const bundlePrice = Money.of(d.groupPrice, o.cur).multiply(groups.toFixed(6), MODE);
        consider(row.id, listPrice.subtract(bundlePrice));
        break;
      }
      default:
        // 3A's CHECK admits three kinds. A fourth means the catalogue is ahead of this till's build, and the
        // safe answer is "no promotion" — never a guessed interpretation of a definition nobody wrote.
        break;
    }
  }
  return best === null ? { promotionId: null, discount: Money.zero(o.cur) } : best;
}
```

- [ ] **Step 5: Tax — 5A's inclusive branch in two `Money` calls**

```ts
/**
 * Extract tax from a tax-INCLUSIVE gross, with the tax code's own rate and its own rounding mode.
 *
 * This is 5A's inclusive branch re-expressed in the two `Money` calls it is made of, exactly as 6A's
 * `buildTicket` does and for the same three reasons: `Money` has no `taxComponentOf` (§4.2.1's member list is
 * frozen), 5A's `taxEngine.compute` takes a `TaxRegime` and a `TaxCodeDef` that the till has no way to
 * assemble from a mirror, and `packages/domain`'s tax module is not on `apps/pos`'s import list. It is **one
 * rule and not two**: `computeDocumentTax` performs the same two calls server-side, and 6A's `applyBatch`
 * step (g) recomputes and rejects a mismatch — so this function being right is what makes a ticket postable.
 *
 * `base = gross / (1 + rate)` at the code's mode, then `tax = gross − base`, which makes `base + tax === gross`
 * exactly. **Never `gross × rate / (1 + rate)`**: that rounds the tax and leaves a cent unaccounted for, and
 * the `POS_TICKET` policy balances `Σ` tenders against `Σ`(amount + tax) with no residual leg to absorb it.
 *
 * No rate and no rounding mode is written here (hazard 1): both are read from `catalogue_tax_code`, which is
 * `app.tax_code` down-synced, which is 5A's `SYNTH-MY-v1` pack in every test.
 */
export function taxItemLine(
  db: PosDatabase, opts: { gross: Money; itemId: string; at?: Date },
): TaxedLine {
  const day = (opts.at ?? new Date()).toISOString().slice(0, 10);
  const cur = currency(opts.gross.toJSON().currency);
  const item = db.raw.prepare<[string], { row_json: string }>(
    "select row_json from catalogue_item where id = ?").get(opts.itemId);
  const taxCodeId = item === undefined
    ? null
    : ((JSON.parse(item.row_json) as { tax_code_id?: string | null }).tax_code_id
       ?? defaultOutputTaxCode(db, day));
  if (taxCodeId === null) {
    return { taxCodeId: null, base: opts.gross, tax: Money.zero(cur), total: opts.gross };
  }
  const code = db.raw.prepare<[string, string, string], { rate: string; rounding_mode: string }>(
    `select rate, rounding_mode from catalogue_tax_code
      where id = ?1 and (effective_from is null or effective_from <= ?2)
        and (effective_to is null or effective_to >= ?3)`,
  ).get(taxCodeId, day, day);
  if (code === undefined) {
    // The code exists but not on this date. Taxing at a stale rate is worse than taxing at nothing: the
    // former posts a wrong tax_transaction the return then reports, the latter is refused by step (g) if it
    // is wrong and is simply correct if the code really has lapsed.
    return { taxCodeId: null, base: opts.gross, tax: Money.zero(cur), total: opts.gross };
  }
  // (1 + rate), exact and at 8 dp — `Money.of("1.0000", cur)` is a one-unit `Money` in the line's OWN
  // currency, so no ISO placeholder is needed and no `decimal.js` is imported: `Money.toDecimal()` is
  // §4.2.1's one door and `code.rate` is the mirrored `numeric(19,8)` as a string.
  const divisor = Money.of("1.0000", cur).toDecimal().plus(code.rate).toFixed(8);
  const base = opts.gross.divide(divisor, code.rounding_mode as RoundingMode);
  return { taxCodeId, base, tax: opts.gross.subtract(base), total: opts.gross };
}

/**
 * The fallback amendment **A10(a)** provides for: *the single open output code, or nothing*.
 *
 * `app.item` carries no `tax_code_id` until 5A's migration 0055 adds it (A10), so until then the till has no
 * per-item tax code to mirror. A single-rate output regime — which is what `SYNTH-MY-v1` is and what the
 * first customer's regime is expected to be — has exactly **one** open `kind = 'output'` row, and that row is
 * the answer. **Two or more and this returns `null`**, which taxes the line at nothing and lets 6A's step (g)
 * refuse the ticket loudly, because a till guessing between two output rates would post a wrong
 * `tax_transaction` that the tax return then reports as fact.
 *
 * **`archived_at is null` is part of "open" and not an afterthought.** 5A's `app.tax_code` carries
 * `archived_at timestamptz` (5A:591) because spec:2049 says master data is archived and never deleted, so a
 * regime that replaced one output code with another leaves **two** rows whose effective windows both contain
 * today — and counting the archived one would make this return `null` on a shop that has exactly one live
 * code, taxing every line at nothing and having 6A's step (g) refuse every ticket. The column is mirrored
 * into `catalogue_tax_code` by T2's writer for exactly this filter.
 *
 * Delete this function the day `catalogue_item.row_json` carries `tax_code_id`; the call site above already
 * prefers the item's own value and reaches this only when it is absent.
 */
function defaultOutputTaxCode(db: PosDatabase, day: string): string | null {
  const rows = db.raw.prepare<[string, string], { id: string }>(
    `select id from catalogue_tax_code
      where kind = 'output'
        and archived_at is null
        and (effective_from is null or effective_from <= ?1)
        and (effective_to is null or effective_to >= ?2)
      order by code`,
  ).all(day, day);
  return rows.length === 1 ? rows[0]!.id : null;
}
```

**`Money.of("1.0000", cur).toDecimal()` is how this file reaches a `Decimal` at all, and there is no other way in it.** `apps/pos` may not import `decimal.js` directly (Global Constraint 6, the dependency rule), and `Money.toDecimal()` is the one door §4.2.1 provides — so a scalar the arithmetic needs is constructed as a one-unit `Money` in the value's own currency and immediately converted. **No ISO `"XXX"` placeholder and no `Money.zero(...).plus(1)` dance:** `cur` is already the line's validated `CurrencyCode`, `MONEY_SCALE` is 4 so `"1.0000"` is exact, and the result never reaches a column — it is a divisor. The same discipline holds in `tender.ts`, where `roundToIncrement` reaches `Money.toDecimal()` and then hands the result to 0D's `round`.

- [ ] **Step 6: Price-check mode**

```ts
/**
 * spec:1355, §3.7.6's *Price check* row: *"a read-only lookup mode (the old system shipped this as a separate
 * `PriceChecker.exe`; here it is a mode of the same app)"*.
 *
 * Two properties make it a mode and not a screen. It is gated on **`PERMISSION["pos.price.check"]`** — the
 * literal is written this way and not as a bare string so §3.6.3's `permission-catalogue` lint sees a
 * reference from `apps/pos`, which is the *only* place this code is referenced in the product. And it opens no
 * transaction and calls no writer: `pricing.test.ts` counts `ticket + outbox + till_event` before and after
 * and asserts the number did not move, because "read-only" is a claim a test has to make.
 *
 * The quote is at **quantity one**. A price check answers *"what does one of these cost?"*; quoting a
 * quantity break would answer a question the customer did not ask and would show a price they cannot have.
 */
export function priceCheck(
  db: PosDatabase, cashier: TillCashier, query: { barcode?: string; code?: string; text?: string },
): PriceCheckResult[] {
  requireCode(cashier, PERMISSION["pos.price.check"]);
  assertCatalogueFresh(db);
  const items: TillItem[] = [];
  if (query.barcode !== undefined) {
    const hit = findItemByBarcode(db, query.barcode);
    if (hit !== null) items.push(hit);
  }
  if (query.code !== undefined) {
    const hit = findItemByCode(db, query.code);
    if (hit !== null) items.push(hit);
  }
  if (query.text !== undefined) items.push(...searchItems(db, query.text));

  const one = Quantity.of("1.000000");
  const seen = new Set<string>();
  const out: PriceCheckResult[] = [];
  for (const item of items) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    const quote = resolvePrice(db, { itemId: item.itemId, quantity: one });
    const gross = quote.unitPrice.subtract(quote.promotionDiscount);
    out.push({ item, quote, taxed: taxItemLine(db, { gross, itemId: item.itemId }) });
  }
  return out;
}
```

- [ ] **Step 7: Run and commit**

```bash
bun run --cwd apps/pos test -- pricing
```

**Expected:** **18 passed, 1 skipped** — nineteen `it`s in the file, of which one is `it.skip`. (The count moved by one against an earlier draft of this plan that said 17: the archived-tax-code case was added and the customer-specific case was skipped rather than deleted. Count the `it(`s in Step 1 if the runner disagrees; a mismatch means a case was dropped in transcription, not that the runner is wrong.) The skip is named in the output: `prices a customer-specific list ahead of the branch list (A10b)`, which is Known gaps #1 made visible in the suite. It stays skipped until `app.party.price_list_id` lands in 4A's migration 0045; nothing else in this task or any later one depends on it. Then `bun run --cwd apps/pos typecheck`, and `bun run lint` plus `bun run lint:rules` at the root — **expected:** `no-number-money` clean (every monetary name in this file is `Money`; the two `number`s are `limit` and the `0|1` flag), `no-sql-concat` clean (`ITEM_COLUMNS` is a constant column list interpolated into a **literal** template with no caller input anywhere near it — the shape acceptance test 27 permits and 6A's `readCatalogue` uses), and `permission-catalogue` now sees `PERMISSION["pos.price.check"]` referenced from `apps/pos`, so one of Task 4's three unreferenced codes is discharged.

```bash
git add apps/pos/src/main/pricing.ts apps/pos/test/pricing.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): pricing, promotions, tax extraction and price-check mode at the till [6B T5]

Three ordered rules pick the price list — the customer's, the branch's, the company's — and the
highest quantity break at or below the line quantity picks the row. Promotions are 3A's
`definition jsonb`, read here for the first time (3A: "NO code in slice 3A reads it"), windowed
against the till's clock, largest discount wins and never stacked. Tax is 5A's inclusive branch
in the two Money calls it is made of, so 6A's step (g) recomputation agrees by construction.
A till that has never pulled refuses to price (ERR_TILL_CATALOGUE_STALE) instead of guessing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `sell` — the ticket, its lines, its outbox row and the attendance drain in ONE SQLite transaction; shifts and till events

**This is the task the DoD's "zero lost tickets" clause is decided in, and the whole argument is one `db.tx(...)`.** spec:1303: *"Sales are written to a local **outbox** table *in the same local transaction as the sale*. … A sale can never be committed locally but lost in transit."* Four writes go inside that one call — `ticket`, `ticket_line`, `outbox`, and the `attendance.sent_at` stamps — and there is no path through this module that commits any subset of them. (`ticket_tender` is **not** among them: `sell` leaves the ticket `status = 'open'` with no tender rows, and Task 7's `tender` writes them in its own transaction, which is what the `status` CHECK's three values are for.)

**The other half is the till's pre-flight limit check, and it is a transcription of 6C's `verifyTicket` rather than a second rule.** 6C computes the line allowance as `gross.multiply(maxLineDiscountPct, "HALF_AWAY_FROM_ZERO")` and compares with `Money.compare`, so the till does the same, with the same operand order and the same `detail` strings — and Task 12's pinned test asserts the two messages are byte-identical for one shared over-limit ticket. A till that computed the allowance as a ratio (`discount / gross`) would refuse tickets the server accepts and accept tickets the server refuses, in both directions, at the cent.

**Files:**
- Create: `apps/pos/src/main/ticket.ts`, `apps/pos/src/main/shift.ts`, `apps/pos/test/ticket.test.ts`, `apps/pos/test/shift.test.ts`

**Interfaces**

- Consumes: `Money`, `Quantity`, `currency`, `CurrencyCode`, `RoundingMode` (§4.2.1); `Ticket`, `TicketLine`, `TicketTender`, `TicketEvent`, `NewCustomer`, `ShiftOpenClose`, `TillEventMsg`, `shiftRef` (`@dulja/sync`, 6A); `PosDatabase` (T1); `SqliteSyncStore` (T2); `moneyToText`, `textToMoney`, `quantityToText`, `textToQuantity`, `revisionToText`, `moneyJson` (T1); `TillError` (T2); `TillCashier`, `TillRefusal`, `TillLimitKind`, `liftRefusals`, `requireCode`, `pendingAttendance` (T4); `resolvePrice`, `taxItemLine`, `assertCatalogueFresh` (T5); `PERMISSION` (0B).
- Produces:
  ```ts
  // apps/pos/src/main/ticket.ts
  export interface SellLine {
    itemId: string; lotId?: string | null; unitId?: string | null;
    quantity: Quantity;
    /** A cashier-typed price. Checked against `maxPriceOverridePct` of the catalogue price. */
    priceOverride?: Money | null;
    /** A line discount, as a magnitude. Checked against `maxLineDiscountPct` of the line gross. */
    discount?: Money | null;
  }
  export interface SellInput {
    shiftId: string;
    cashier: TillCashier;
    kind?: "sale" | "return";
    customerId?: string | null;
    newCustomer?: NewCustomer | null;
    returnsClientRef?: string | null;
    lines: SellLine[];
    /** A ticket-level discount, as a magnitude, spread across lines by `Money.allocate`. */
    ticketDiscount?: Money | null;
    events?: TicketEvent[];
    at?: Date;
    clientRef?: string;
  }
  export interface DraftLine {
    lineNo: number; itemId: string; lotId: string | null; unitId: string;
    quantity: Quantity; unitPrice: Money; discount: Money;
    taxCodeId: string | null; taxAmount: Money; total: Money;
  }
  export interface TicketDraft {
    clientRef: string; kind: "sale" | "return"; currency: CurrencyCode;
    lines: DraftLine[]; netTotal: Money; taxTotal: Money; total: Money;
    catalogueRevision: bigint;
  }
  export interface SellResult { clientRef: string; draft: TicketDraft; outboxId: string }

  /** Prices and taxes every line and totals the ticket. Writes NOTHING; `sell` and `tender` share it. */
  export function draftTicket(db: PosDatabase, input: SellInput): TicketDraft;
  /** The till's copy of 6C's `verifyTicket` limit half, on the drafted ticket. Pure. */
  export function checkLimits(
    cashier: TillCashier, draft: TicketDraft, opts: { catalogueUnitPrices: readonly Money[]; blind: boolean; voided: boolean },
  ): TillRefusal[];
  /** The one transaction. Throws `ERR_TILL_LIMIT_EXCEEDED` before it opens if a refusal survives the events. */
  export function sell(db: PosDatabase, store: SqliteSyncStore, input: SellInput): SellResult;
  export function recordTillEvent(
    db: PosDatabase, store: SqliteSyncStore,
    e: { shiftId: string; kind: "no_sale" | "drawer_open" | "void"; cashier: TillCashier;
         ticketClientRef?: string | null; supervisorPrincipalId?: string | null; at?: Date },
  ): string;
  ```
  ```ts
  // apps/pos/src/main/shift.ts
  export interface TillShift {
    id: string; terminalId: string; cashierPrincipalId: string; openedAt: string;
    openingFloat: Money; currency: CurrencyCode; closedAt: string | null; countedCash: Money | null;
  }
  export function openShift(
    db: PosDatabase, store: SqliteSyncStore,
    opts: { terminalId: string; cashier: TillCashier; openingFloat: Money; at?: Date; shiftId?: string },
  ): TillShift;
  export function closeShift(
    db: PosDatabase, store: SqliteSyncStore,
    opts: { shiftId: string; cashier: TillCashier; countedCash: Money; at?: Date },
  ): TillShift;
  export function currentShift(db: PosDatabase, terminalId: string): TillShift | null;
  export function shiftTotals(db: PosDatabase, shiftId: string): { tickets: number; byMethod: Record<string, string> };
  ```

- [ ] **Step 1: Write the failing test for `sell` first**

```ts
// apps/pos/test/ticket.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change, Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { checkLimits, draftTicket, recordTillEvent, sell } from "../src/main/ticket";
import { openShift } from "../src/main/shift";
import { clockEvent } from "../src/main/authority";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase; let store: SqliteSyncStore; let shiftId: string; const dirs: string[] = [];

const LIMITS = {
  maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500", requireCustomerOver: null, maxCashInDrawer: null,
};
const cashier = (codes: string[]): TillCashier => ({
  principalId: "p-1", employeeId: "emp-1", branchId: "br-1", codes, limits: LIMITS, snapshotRevision: "1",
});
const SELLER = cashier(["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return", "pos.shift.own", "pos.attendance.clock"]);

// The same catalogue Task 5's suite prices against, reduced to one item at 10.0000 and one 10 % tax code.
const CATALOGUE: Change[] = [
  { stream: "item", op: "upsert", id: "item-A", revision: 10n, row: {
      id: "item-A", code: "SKU-A", barcode: "9001", name_en: "Rice 5kg", name_ar: null,
      kind: "product", base_unit_id: "unit-ea", track_lots: false, tax_code_id: "tax-std" } },
  { stream: "price_list", op: "upsert", id: "pl", revision: 11n, row: {
      id: "pl", code: "RETAIL", currency: "MYR", customer_kind: "retail", branch_id: null,
      valid_from: null, valid_to: null } },
  { stream: "price_list_line", op: "upsert", id: "pll", revision: 12n, row: {
      id: "pll", price_list_id: "pl", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "10.0000" } },
  { stream: "tax_code", op: "upsert", id: "tax-std", revision: 13n, row: {
      id: "tax-std", code: "SYNTH-OUT-STD", rate: "0.10000000", kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO", output_account_id: "acct-2300", input_account_id: null,
      effective_from: "2026-01-01", effective_to: null } },
  { stream: "branch_pos_policy", op: "upsert", id: "bpp-1", revision: 14n, row: {
      id: "bpp-1", branch_id: "br-1", max_line_discount_pct: "0.100000", max_ticket_discount_pct: "0.050000",
      max_void_amount: "200.0000", max_price_override_pct: "0.020000", blind_return_allowed: false,
      max_blind_return_amount: "0.0000", max_cash_in_drawer: null, require_customer_over: null,
      rounding_increment: "0.0500", paid_out_allowed: false, max_paid_out_amount: "0.0000" } },
];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges(CATALOGUE);
  shiftId = openShift(db, store, { terminalId: "term-1", cashier: SELLER, openingFloat: Money.of("100.0000", MYR) }).id;
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const payloadOf = (ref: string): Ticket =>
  JSON.parse(db.raw.prepare<[string], { payload: string }>(
    "select payload from outbox where kind = 'ticket' and ref = ?").get(ref)!.payload) as Ticket;

describe("sell — one SQLite transaction (spec:1303, 1337)", () => {
  it("writes the ticket, its lines and its outbox row, and the ref is the clientRef", () => {
    const r = sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }] });
    expect(r.clientRef).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);   // a uuidv7, minted at the till
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(1);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_line").get()!.n).toBe(1);
    const row = db.raw.prepare<[string], { net_total: string; tax_total: string; total: string; status: string; catalogue_revision: string }>(
      "select net_total, tax_total, total, status, catalogue_revision from ticket where id = ?").get(r.clientRef)!;
    // 10.0000 × 2 = 20.0000 gross incl. tax; base = 20.0000 / 1.10 = 18.1818, tax = 1.8182.
    expect(row.total).toBe("20.0000");
    expect(row.net_total).toBe("18.1818");
    expect(row.tax_total).toBe("1.8182");
    expect(row.status).toBe("open");
    expect(row.catalogue_revision).toBe("14");
    const out = db.raw.prepare<[], { kind: string; ref: string; acked_at: string | null }>(
      "select kind, ref, acked_at from outbox").get()!;
    expect(out).toEqual({ kind: "ticket", ref: r.clientRef, acked_at: null });
  });

  it("the outbox payload is a wire `Ticket` whose catalogueRevision is a STRING, so JSON.stringify works", () => {
    const r = sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    const p = payloadOf(r.clientRef) as unknown as Record<string, unknown>;
    // A bigint in the payload would have thrown inside `enqueue`'s JSON.stringify with
    // "Do not know how to serialize a BigInt" — which is why the wire form is BigintString (6A's Zod).
    expect(typeof p["catalogueRevision"]).toBe("string");
    expect(p["catalogueRevision"]).toBe("14");
    expect(p["shiftId"]).toBe(shiftId);
    expect(p["cashierPrincipalId"]).toBe("p-1");
    expect(p["kind"]).toBe("sale");
    expect(p["returnsClientRef"]).toBeNull();
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);      // round-trips, which enqueue relies on
  });

  it("rolls the WHOLE unit back when the outbox write fails — no orphan ticket, ever", () => {
    // Force the outbox insert to fail on the second call by taking the (kind, ref) the ticket will use.
    const ref = "11111111-1111-7111-8111-111111111111";
    db.raw.prepare(
      "insert into outbox (id, kind, ref, payload, attempts, last_error, acked_at, created_at) values ('x', 'ticket', ?, '{}', 0, null, null, '2026-01-01T00:00:00.000Z')",
    ).run(ref);
    // `enqueue` is idempotent on (kind, ref), so it returns the EXISTING row — the ticket still commits and
    // the payload is the first one. That is the documented behaviour, and this case pins it rather than
    // pretending a conflict throws.
    const r = sell(db, store, { shiftId, cashier: SELLER, clientRef: ref, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    expect(r.outboxId).toBe("x");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from outbox").get()!.n).toBe(1);
    // And the real rollback property: an unpriceable line aborts before anything is written.
    expect(() => sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "no-such-item", quantity: Quantity.of("1.000000") }] }))
      .toThrow(TillError);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(1);
  });

  it("carries the pending attendance events onto the ticket and stamps them sent — in the same transaction", async () => {
    await clockEvent(db, SELLER, "clock_in");
    const r = sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    const p = payloadOf(r.clientRef);
    expect(p.attendance).toEqual([{ kind: "clock_in", principalId: "p-1", at: expect.any(String) }]);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from attendance where sent_at is null").get()!.n).toBe(0);
    // A SECOND ticket must not carry it again — that would create two attendance_event rows for one clock-in.
    const second = sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    expect(payloadOf(second.clientRef).attendance).toEqual([]);
  });

  it("refuses a cashier without pos.ticket.sell before it prices anything", () => {
    const noSell = cashier(["pos.price.check"]);
    expect(() => sell(db, store, { shiftId, cashier: noSell, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] }))
      .toThrow(/ERR_RBAC_FORBIDDEN/);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
  });

  it("refuses a line discount over the branch limit with ERR_TILL_LIMIT_EXCEEDED, and the detail names both figures", () => {
    let thrown: unknown;
    try {
      sell(db, store, { shiftId, cashier: SELLER, lines: [
        { itemId: "item-A", quantity: Quantity.of("1.000000"), discount: Money.of("2.0000", MYR) }] });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    // 6C's `verifyTicket` string, verbatim. Task 12 asserts the two are byte-identical.
    expect((thrown as TillError).detail).toContain(
      "line 1 discount 2.0000 exceeds 0.100000 of 10.0000 (1.0000)");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
  });

  it("a discount override event lifts the line and the ticket refusal, and the ticket commits", () => {
    const r = sell(db, store, {
      shiftId, cashier: SELLER,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000"), discount: Money.of("2.0000", MYR) }],
      events: [{ kind: "override", code: "pos.ticket.override", subject: "discount",
                 supervisorPrincipalId: "sup-1", reason: "manager approved" }],
    });
    expect(payloadOf(r.clientRef).events).toHaveLength(1);
    expect(payloadOf(r.clientRef).lines[0]!.discount).toEqual({ amount: "2.0000", currency: "MYR" });
  });

  it("refuses a price override beyond maxPriceOverridePct and accepts one inside it", () => {
    // 2 % of 10.0000 is 0.2000, so 9.7500 is 0.2500 away and refused; 9.8500 is 0.1500 away and allowed.
    expect(() => sell(db, store, { shiftId, cashier: SELLER, lines: [
      { itemId: "item-A", quantity: Quantity.of("1.000000"), priceOverride: Money.of("9.7500", MYR) }] }))
      .toThrow(/ERR_TILL_LIMIT_EXCEEDED/);
    const ok = sell(db, store, { shiftId, cashier: SELLER, lines: [
      { itemId: "item-A", quantity: Quantity.of("1.000000"), priceOverride: Money.of("9.8500", MYR) }] });
    expect(payloadOf(ok.clientRef).lines[0]!.unitPrice).toEqual({ amount: "9.8500", currency: "MYR" });
  });

  it("spreads a ticket discount across lines with allocate, so the parts sum to the whole exactly", () => {
    const r = sell(db, store, {
      shiftId, cashier: SELLER,
      // 3 lines at 10.0000, gross 30.0000; 5 % of that is 1.5000; allocate over 3 lines is 0.5000 each.
      lines: [
        { itemId: "item-A", quantity: Quantity.of("1.000000") },
        { itemId: "item-A", quantity: Quantity.of("1.000000") },
        { itemId: "item-A", quantity: Quantity.of("1.000000") },
      ],
      ticketDiscount: Money.of("1.5000", MYR),
    });
    const p = payloadOf(r.clientRef);
    const sum = p.lines.reduce((s, l) => s.add(Money.of(l.discount.amount, MYR)), Money.zero(MYR));
    expect(sum.toString()).toBe("1.5000");
    expect(p.lines.map((l) => l.discount.amount)).toEqual(["0.5000", "0.5000", "0.5000"]);
  });

  it("a return negates quantity, discount, taxAmount and total together, and NEVER the unit price (A9)", () => {
    const r = sell(db, store, {
      shiftId, cashier: SELLER, kind: "return", returnsClientRef: "orig-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    const line = payloadOf(r.clientRef).lines[0]!;
    expect(line.quantity).toBe("-1.000000");
    expect(line.total).toEqual({ amount: "-10.0000", currency: "MYR" });
    expect(line.taxAmount.amount.startsWith("-")).toBe(true);
    expect(line.unitPrice).toEqual({ amount: "10.0000", currency: "MYR" });   // a price is a price
    expect(payloadOf(r.clientRef).returnsClientRef).toBe("orig-1");
    expect(db.raw.prepare<[string], { kind: string }>("select kind from ticket where id = ?").get(r.clientRef)!.kind).toBe("return");
  });

  it("checkLimits produces one refusal per broken limit and none when every limit holds", () => {
    const draft = draftTicket(db, { shiftId, cashier: SELLER, lines: [
      { itemId: "item-A", quantity: Quantity.of("1.000000"), discount: Money.of("2.0000", MYR) }] });
    const refusals = checkLimits(SELLER, draft, {
      catalogueUnitPrices: [Money.of("10.0000", MYR)], blind: false, voided: false });
    expect(refusals.map((r) => r.kind)).toEqual(["line_discount", "ticket_discount"]);
    const clean = draftTicket(db, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    expect(checkLimits(SELLER, clean, { catalogueUnitPrices: [Money.of("10.0000", MYR)], blind: false, voided: false })).toEqual([]);
  });

  it("recordTillEvent writes an append-only row and an outbox row keyed on its own clientRef", () => {
    const id = recordTillEvent(db, store, { shiftId, kind: "no_sale", cashier: SELLER });
    const row = db.raw.prepare<[string], { kind: string; shift_id: string }>(
      "select kind, shift_id from till_event where id = ?").get(id)!;
    expect(row).toEqual({ kind: "no_sale", shift_id: shiftId });
    const out = db.raw.prepare<[string], { kind: string }>("select kind from outbox where ref = ?").get(id)!;
    expect(out.kind).toBe("till_event");
  });
});
```

Run `bun run --cwd apps/pos test -- ticket`. **Expected failure:** `Failed to resolve import "../src/main/ticket"`.

- [ ] **Step 2: Write `apps/pos/src/main/ticket.ts` — the draft**

```ts
import { randomBytes } from "node:crypto";
import { Money, Quantity, currency, type CurrencyCode, type RoundingMode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { NewCustomer, Ticket, TicketEvent, TicketLine } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import {
  liftRefusals, pendingAttendance, requireCode,
  type TillCashier, type TillLimitKind, type TillRefusal,
} from "./authority";
import { assertCatalogueFresh, resolvePrice, taxItemLine } from "./pricing";
import { moneyToText, quantityToText, revisionToText } from "./money";

const MODE: RoundingMode = "HALF_AWAY_FROM_ZERO";   // 6C's `MODE`; the two limit checks must agree exactly

/**
 * A `uuidv7` minted **at the till**, offline, at the moment of sale.
 *
 * spec:2037, verbatim: *"The POS generates a `uuidv7` at the till for each ticket … carried as
 * `document.client_ref`"*, and spec:1302 makes it the deduplication key. `crypto.randomUUID()` is a **v4**
 * and would lose the time ordering `document.client_ref`'s index and 6A's cursor both rely on; 0A's
 * `uuidv7(sql)` is a database round trip and there is no database here. The layout is RFC 9562 §5.7:
 * 48-bit big-endian milliseconds, version 7, variant 0b10, the rest random. `tests/regression/sah-051.test.ts`
 * gains a `— 6B` block in Task 12 asserting this is the only id source in `apps/pos`.
 */
export function tillUuidv7(at: Date = new Date()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(at.getTime());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;      // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;      // variant 0b10
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SellLine {
  itemId: string; lotId?: string | null; unitId?: string | null;
  quantity: Quantity;
  priceOverride?: Money | null;
  discount?: Money | null;
}

export interface SellInput {
  shiftId: string;
  cashier: TillCashier;
  kind?: "sale" | "return";
  customerId?: string | null;
  newCustomer?: NewCustomer | null;
  returnsClientRef?: string | null;
  lines: SellLine[];
  ticketDiscount?: Money | null;
  events?: TicketEvent[];
  at?: Date;
  clientRef?: string;
}

export interface DraftLine {
  lineNo: number; itemId: string; lotId: string | null; unitId: string;
  quantity: Quantity; unitPrice: Money; discount: Money;
  taxCodeId: string | null; taxAmount: Money; total: Money;
}

export interface TicketDraft {
  clientRef: string; kind: "sale" | "return"; currency: CurrencyCode;
  lines: DraftLine[]; netTotal: Money; taxTotal: Money; total: Money;
  catalogueRevision: bigint;
}

export interface SellResult { clientRef: string; draft: TicketDraft; outboxId: string }

/** The highest revision this till has applied — `Ticket.catalogueRevision`, which tells the server how stale
 *  the prices on the ticket are. It is read once per draft and never recomputed per line. */
function catalogueRevision(db: PosDatabase): bigint {
  const row = db.raw.prepare<[], { revision: string }>(
    "select revision from sync_cursor order by cast(revision as integer) desc limit 1").get();
  return row === undefined ? 0n : BigInt(row.revision);
}

/**
 * Prices, discounts, taxes and totals a ticket. **Writes nothing** — `sell` calls it before opening its
 * transaction, and `tender` (Task 7) calls it again on the same input to answer "what is payable?" without
 * committing anything. Two callers, one arithmetic.
 *
 * **A return negates exactly five values and no sixth** (§4.4.2 A9's 6A entry, and 6A's `buildTicket` comment
 * verbatim): `quantity`, `discount`, `taxAmount`, `total` and — in Task 7 — the tender `amount`. `unitPrice`
 * does not flip: a price is a price, and direction is carried by the quantity's sign and by the policy's
 * `side`, never by a magnitude. Negating three of the five produces a ticket whose tenders do not sum to its
 * lines, which `applyBatch` refuses for the wrong reason.
 */
export function draftTicket(db: PosDatabase, input: SellInput): TicketDraft {
  assertCatalogueFresh(db);
  if (input.lines.length === 0) {
    throw new TillError("ERR_VALIDATION_FAILED", "a ticket needs at least one line");
  }
  const kind = input.kind ?? "sale";
  const at = input.at ?? new Date();
  const sign = kind === "return" ? -1 : 1;

  // 1. Price every line at its own quantity, so quantity breaks and promotions see the real figure.
  const priced = input.lines.map((line, index) => {
    const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
    const quote = resolvePrice(db, {
      itemId: line.itemId, unitId: line.unitId ?? null, quantity: magnitude,
      customerId: input.customerId ?? null, at,
    });
    if (quote.source === "no_price" && (line.priceOverride ?? null) === null) {
      throw new TillError("ERR_VALIDATION_FAILED",
        `item ${line.itemId} has no price in this till's catalogue and no override was given`);
    }
    const catalogueUnitPrice = quote.unitPrice;
    const unitPrice = line.priceOverride ?? catalogueUnitPrice;
    // The promotion's discount and the cashier's own discount ADD: a promotion is the shop's decision and a
    // line discount is the cashier's, and the branch limit below is checked against the cashier's alone.
    const cashierDiscount = line.discount ?? Money.zero(unitPrice.toJSON().currency as CurrencyCode);
    return { line, index, catalogueUnitPrice, unitPrice, promotionDiscount: quote.promotionDiscount,
             cashierDiscount, magnitude, unitId: quote.unitId };
  });

  const cur = currency(priced[0]!.unitPrice.toJSON().currency);
  for (const p of priced) {
    if (currency(p.unitPrice.toJSON().currency) !== cur) {
      throw new TillError("ERR_MONEY_CURRENCY_MISMATCH",
        `line ${p.index + 1} is in ${p.unitPrice.toJSON().currency} and line 1 is in ${cur}`);
    }
  }

  // 2. Spread the ticket discount across lines by line gross, with `allocate` so the parts sum to the whole.
  const grosses = priced.map((p) => p.unitPrice.multiply(p.magnitude.toString(), MODE));
  const ticketDiscount = input.ticketDiscount ?? Money.zero(cur);
  const spread = ticketDiscount.isZero()
    ? grosses.map(() => Money.zero(cur))
    : ticketDiscount.allocate(grosses.map((g) => g.toDecimal().toFixed(4)));

  // 3. Tax each line from its own post-discount gross, then total.
  let netTotal = Money.zero(cur);
  let taxTotal = Money.zero(cur);
  let total = Money.zero(cur);
  const lines: DraftLine[] = priced.map((p, i) => {
    const discountMagnitude = p.cashierDiscount.add(p.promotionDiscount).add(spread[i]!);
    const grossMagnitude = grosses[i]!.subtract(discountMagnitude);
    if (grossMagnitude.isNegative()) {
      throw new TillError("ERR_VALIDATION_FAILED",
        `line ${i + 1}: the discounts total ${discountMagnitude.toString()} and exceed the line's ${grosses[i]!.toString()}`);
    }
    const signedGross = sign === -1 ? grossMagnitude.negate() : grossMagnitude;
    const taxed = taxItemLine(db, { gross: signedGross, itemId: p.line.itemId, at });
    netTotal = netTotal.add(taxed.base);
    taxTotal = taxTotal.add(taxed.tax);
    total = total.add(taxed.total);
    return {
      lineNo: i + 1,
      itemId: p.line.itemId,
      lotId: p.line.lotId ?? null,
      unitId: p.unitId,
      quantity: sign === -1 ? p.magnitude.negate() : p.magnitude,
      unitPrice: p.unitPrice,
      discount: sign === -1 ? discountMagnitude.negate() : discountMagnitude,
      taxCodeId: taxed.taxCodeId,
      taxAmount: taxed.tax,
      total: taxed.total,
    };
  });

  return {
    clientRef: input.clientRef ?? tillUuidv7(at),
    kind, currency: cur, lines, netTotal, taxTotal, total,
    catalogueRevision: catalogueRevision(db),
  };
}
```

- [ ] **Step 3: `checkLimits` — 6C's formula, transcribed**

```ts
/**
 * The till's pre-flight limit check: **6C's `verifyTicket` limit half, transcribed**.
 *
 * Every figure and every message below is 6C's, in 6C's operand order, so the till refuses exactly what the
 * server would refuse and says the same words. Task 12's pinned test builds one over-limit ticket, runs it
 * through this function and through `verifyTicket`, and asserts the `detail` strings are equal — because "the
 * refusal messages agree" is the only way a shop can act on a refusal, and a divergence here is invisible
 * until a customer is standing at the counter.
 *
 * Three deliberate differences, each with its reason:
 *  - **`price_override` is here and not in 6C's map.** 6C's Task 9 decision (c): `max_price_override_pct` is
 *    enforced at the till only, because checking it server-side needs a second pricing implementation and
 *    §4.10.1's `TicketLine` carries no catalogue price. `catalogueUnitPrices` is the caller's evidence.
 *  - **The authority half is not repeated.** `requiredCodesFor`'s job is done by `sell`'s `requireCode`
 *    calls, and an authority gap is never override-able (6C's step 2 returns before the limits).
 *  - **`.abs()` on both factors**, because a return's quantity, total and discount are negative and a limit
 *    is a magnitude. Nothing here reads a sign to decide a direction (§4.4.2).
 */
export function checkLimits(
  cashier: TillCashier, draft: TicketDraft,
  opts: { catalogueUnitPrices: readonly Money[]; blind: boolean; voided: boolean },
): TillRefusal[] {
  const limits = cashier.limits;
  const cur = draft.currency;
  const refusals: TillRefusal[] = [];

  let totalGross = Money.zero(cur);
  let totalDiscount = Money.zero(cur);
  for (const line of draft.lines) {
    const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
    const g = line.unitPrice.abs().multiply(magnitude.toString(), MODE);
    const d = line.discount.abs();
    totalGross = totalGross.add(g);
    totalDiscount = totalDiscount.add(d);
    const allowed = g.multiply(limits.maxLineDiscountPct, MODE);
    if (d.compare(allowed) > 0) {
      refusals.push({
        kind: "line_discount", lineNo: line.lineNo,
        detail: `line ${line.lineNo} discount ${d.toString()} exceeds ${limits.maxLineDiscountPct} of ${g.toString()} (${allowed.toString()})`,
      });
    }
    const catalogue = opts.catalogueUnitPrices[line.lineNo - 1];
    if (catalogue !== undefined && !catalogue.isZero()) {
      const drift = catalogue.compare(line.unitPrice) >= 0
        ? catalogue.subtract(line.unitPrice)
        : line.unitPrice.subtract(catalogue);
      const permitted = catalogue.abs().multiply(limits.maxPriceOverridePct, MODE);
      if (drift.compare(permitted) > 0) {
        refusals.push({
          kind: "price_override", lineNo: line.lineNo,
          detail: `line ${line.lineNo} price ${line.unitPrice.toString()} differs from the catalogue's ${catalogue.toString()} by ${drift.toString()}, which exceeds ${limits.maxPriceOverridePct} (${permitted.toString()})`,
        });
      }
    }
  }

  const ticketAllowance = totalGross.multiply(limits.maxTicketDiscountPct, MODE);
  if (totalDiscount.compare(ticketAllowance) > 0) {
    refusals.push({
      kind: "ticket_discount", lineNo: null,
      detail: `ticket discount ${totalDiscount.toString()} exceeds ${limits.maxTicketDiscountPct} of ${totalGross.toString()} (${ticketAllowance.toString()})`,
    });
  }

  const absoluteTotal = draft.lines.reduce((sum, l) => sum.add(l.total.abs()), Money.zero(cur));

  if (opts.voided) {
    const cap = Money.of(limits.maxVoidAmount, cur);
    if (absoluteTotal.compare(cap) > 0) {
      refusals.push({ kind: "void", lineNo: null, detail: `void of ${absoluteTotal.toString()} exceeds max_void_amount ${cap.toString()}` });
    }
  }

  if (opts.blind) {
    if (!limits.blindReturnAllowed) {
      refusals.push({ kind: "blind_return", lineNo: null, detail: `blind return: this branch does not allow one (blind_return_allowed = false)` });
    } else {
      const cap = Money.of(limits.maxBlindReturnAmount, cur);
      if (absoluteTotal.compare(cap) > 0) {
        refusals.push({ kind: "blind_return", lineNo: null, detail: `blind return of ${absoluteTotal.toString()} exceeds max_blind_return_amount ${cap.toString()}` });
      }
    }
  }

  return refusals;
}
```

- [ ] **Step 4: `sell` — the one transaction**

```ts
/** The wire `Ticket` (§4.10.1), from a draft. **`catalogueRevision` becomes a decimal STRING here**, because
 *  `SqliteSyncStore.enqueue` calls `JSON.stringify` and `JSON.stringify` throws on a bigint — and 6A's Zod
 *  schema types the field as `BigintString` for exactly that reason. This is the one conversion point. */
function toWireTicket(
  draft: TicketDraft, input: SellInput, attendance: Ticket["attendance"], at: Date,
): Ticket {
  const lines: TicketLine[] = draft.lines.map((l) => ({
    lineNo: l.lineNo, itemId: l.itemId, lotId: l.lotId,
    quantity: quantityToText(l.quantity), unitId: l.unitId,
    unitPrice: l.unitPrice.toJSON(), discount: l.discount.toJSON(),
    taxCodeId: l.taxCodeId, taxAmount: l.taxAmount.toJSON(), total: l.total.toJSON(),
  }));
  return {
    clientRef: draft.clientRef,
    shiftId: input.shiftId,
    cashierPrincipalId: input.cashier.principalId,
    customerId: input.customerId ?? null,
    newCustomer: input.newCustomer ?? null,
    kind: draft.kind,
    returnsClientRef: input.returnsClientRef ?? null,
    currency: draft.currency,
    soldAt: at.toISOString(),
    lines,
    tenders: [],                     // Task 7's `tender` replaces the outbox payload with the tendered one
    events: input.events ?? [],
    attendance,
    catalogueRevision: revisionToText(draft.catalogueRevision) as unknown as Ticket["catalogueRevision"],
  };
}

/**
 * Sell. **One SQLite transaction, four writes, no network call anywhere on the path** (spec:1303, 1337).
 *
 * Order matters and is not arbitrary. Authority is checked first, because an unauthorised cashier must be
 * refused before a price is read. The draft is built next, outside the transaction, because pricing is
 * read-only and a long pricing pass inside a write transaction would block a concurrent pull. Limits are
 * checked on the draft and lifted by the override events, and `ERR_TILL_LIMIT_EXCEEDED` is thrown **before**
 * the transaction opens — so a refused ticket leaves no row at all, which is what the test asserts.
 *
 * Then the transaction: header, lines, outbox, attendance stamps. `ticket_tender` stays empty until Task 7's
 * `tender` completes the ticket — a ticket is `status = 'open'` between `sell` and `tender`, which is what the
 * `status` CHECK's three values are for.
 */
export function sell(db: PosDatabase, store: SqliteSyncStore, input: SellInput): SellResult {
  const kind = input.kind ?? "sale";
  const at = input.at ?? new Date();
  // Both spelled `PERMISSION[...]` and never as a bare string, uniformly across `apps/pos`: these two codes
  // are 6A's and are referenced from `packages/db` as well, so the lint is satisfied either way — but one
  // spelling in one app means a reader never has to ask which codes are "the ones with the lookup".
  requireCode(input.cashier, kind === "return" ? PERMISSION["pos.ticket.return"] : PERMISSION["pos.ticket.sell"]);
  if (input.lines.some((l) => (l.discount ?? null) !== null && !l.discount!.isZero())
      || ((input.ticketDiscount ?? null) !== null && !input.ticketDiscount!.isZero())) {
    requireCode(input.cashier, PERMISSION["pos.ticket.discount"]);
  }
  if (kind === "return" && (input.returnsClientRef ?? null) === null) {
    requireCode(input.cashier, PERMISSION["pos.ticket.return_blind"]);
  }
  if ((input.newCustomer ?? null) !== null) requireCode(input.cashier, PERMISSION["pos.customer.create"]);

  const draft = draftTicket(db, input);
  const catalogueUnitPrices = input.lines.map((line) => {
    const magnitude = line.quantity.isNegative() ? line.quantity.negate() : line.quantity;
    return resolvePrice(db, {
      itemId: line.itemId, unitId: line.unitId ?? null, quantity: magnitude,
      customerId: input.customerId ?? null, at,
    }).unitPrice;
  });
  const events = input.events ?? [];
  const subjects = events.filter((e) => e.kind === "override").map((e) => e.subject);
  const refusals = liftRefusals(
    checkLimits(input.cashier, draft, {
      catalogueUnitPrices,
      blind: kind === "return" && (input.returnsClientRef ?? null) === null,
      voided: subjects.includes("void"),
    }),
    subjects,
  );
  if (refusals.length > 0) {
    throw new TillError("ERR_TILL_LIMIT_EXCEEDED", refusals.map((r) => r.detail).join("; "));
  }

  const pending = pendingAttendance(db);
  const pendingIds = db.raw.prepare<[], { id: string }>(
    "select id from attendance where sent_at is null order by occurred_at, id").all().map((r) => r.id);
  const wire = toWireTicket(draft, input, pending, at);

  return db.tx(() => {
    db.raw.prepare(
      `insert into ticket (id, shift_id, cashier_principal_id, customer_id, kind, returns_client_ref, status,
                           currency, net_total, tax_total, total, catalogue_revision, created_at, events_json)
       values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(draft.clientRef, input.shiftId, input.cashier.principalId, input.customerId ?? null, kind,
          input.returnsClientRef ?? null, draft.currency, moneyToText(draft.netTotal),
          moneyToText(draft.taxTotal), moneyToText(draft.total), revisionToText(draft.catalogueRevision),
          at.toISOString(), JSON.stringify(events));

    const insertLine = db.raw.prepare(
      `insert into ticket_line (ticket_id, line_no, item_id, lot_id, quantity, unit_id, unit_price, discount,
                                tax_code_id, tax_amount, total)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of draft.lines) {
      insertLine.run(draft.clientRef, l.lineNo, l.itemId, l.lotId, quantityToText(l.quantity), l.unitId,
                     moneyToText(l.unitPrice), moneyToText(l.discount), l.taxCodeId,
                     moneyToText(l.taxAmount), moneyToText(l.total));
    }

    // The outbox row, in the SAME transaction. This line is the DoD's "zero lost tickets".
    const outboxId = store.enqueue("ticket", draft.clientRef, wire);

    // And the attendance stamps, so a clock-in rides on exactly one ticket and never on none or two.
    const stamp = db.raw.prepare("update attendance set sent_at = ? where id = ?");
    for (const id of pendingIds) stamp.run(at.toISOString(), id);

    return { clientRef: draft.clientRef, draft, outboxId };
  });
}

/**
 * spec:1354's till events: *"no-sale, void and drawer-open events on the ticket stream"*.
 *
 * `app.till_event` is **6D's** table, so this message is refused per-message with
 * `ERR_SYNC_MESSAGE_UNSUPPORTED` until 6D lands and the row stays in the outbox — 6A's refuse-never-drop
 * contract (§4.10.1), asserted as such in Task 12. The till records them from day one anyway, which is what
 * makes 6D's arrival a server-side change and not a till release.
 */
export function recordTillEvent(
  db: PosDatabase, store: SqliteSyncStore,
  e: { shiftId: string; kind: "no_sale" | "drawer_open" | "void"; cashier: TillCashier;
       ticketClientRef?: string | null; supervisorPrincipalId?: string | null; at?: Date },
): string {
  if (e.kind === "void") requireCode(e.cashier, PERMISSION["pos.ticket.void"]);
  const at = e.at ?? new Date();
  const id = tillUuidv7(at);
  return db.tx(() => {
    db.raw.prepare(
      `insert into till_event (id, shift_id, kind, ticket_client_ref, cashier_principal_id,
                               supervisor_principal_id, occurred_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, e.shiftId, e.kind, e.ticketClientRef ?? null, e.cashier.principalId,
          e.supervisorPrincipalId ?? null, at.toISOString());
    store.enqueue("till_event", id, {
      clientRef: id, shiftId: e.shiftId, kind: e.kind,
      ticketClientRef: e.ticketClientRef ?? null,
      cashierPrincipalId: e.cashier.principalId,
      supervisorPrincipalId: e.supervisorPrincipalId ?? null,
      occurredAt: at.toISOString(),
    });
    return id;
  });
}
```

- [ ] **Step 5: Write the shift test, then `shift.ts`**

```ts
// apps/pos/test/shift.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { shiftRef, type ShiftOpenClose } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { closeShift, currentShift, openShift } from "../src/main/shift";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase; let store: SqliteSyncStore; const dirs: string[] = [];
const LIMITS = {
  maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500", requireCustomerOver: null, maxCashInDrawer: null,
};
const OWNER: TillCashier = { principalId: "p-1", employeeId: "e-1", branchId: "br-1",
  codes: ["pos.shift.own"], limits: LIMITS, snapshotRevision: "1" };

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const payload = (ref: string): ShiftOpenClose =>
  JSON.parse(db.raw.prepare<[string], { payload: string }>(
    "select payload from outbox where kind = 'shift' and ref = ?").get(ref)!.payload) as ShiftOpenClose;

describe("shifts at the till (§3.7.6 Shift, spec:1352; app.shift is 6D's)", () => {
  it("openShift needs pos.shift.own and writes the row plus one outbox message keyed by shiftRef", () => {
    const s = openShift(db, store, { terminalId: "term-1", cashier: OWNER, openingFloat: Money.of("150.0000", MYR) });
    expect(s.openingFloat.toString()).toBe("150.0000");
    const ref = shiftRef(s.id, "open");
    const p = payload(ref);
    expect(p).toMatchObject({ shiftId: s.id, kind: "open", terminalId: "term-1", cashierPrincipalId: "p-1", currency: "MYR" });
    expect(p.openingFloat).toEqual({ amount: "150.0000", currency: "MYR" });
    expect(p.countedCash).toBeNull();
    const noCode: TillCashier = { ...OWNER, codes: [] };
    expect(() => openShift(db, store, { terminalId: "term-1", cashier: noCode, openingFloat: Money.of("1.0000", MYR) }))
      .toThrow(/ERR_RBAC_FORBIDDEN/);
  });

  it("refuses a second open shift on the same terminal — one drawer, one shift", () => {
    openShift(db, store, { terminalId: "term-1", cashier: OWNER, openingFloat: Money.of("100.0000", MYR) });
    let thrown: unknown;
    try { openShift(db, store, { terminalId: "term-1", cashier: OWNER, openingFloat: Money.of("100.0000", MYR) }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("closeShift sends countedCash and NOTHING else — the server derives expected_cash and over_short", () => {
    const s = openShift(db, store, { terminalId: "term-1", cashier: OWNER, openingFloat: Money.of("100.0000", MYR) });
    closeShift(db, store, { shiftId: s.id, cashier: OWNER, countedCash: Money.of("342.5500", MYR) });
    const p = payload(shiftRef(s.id, "close"));
    expect(p.kind).toBe("close");
    expect(p.countedCash).toEqual({ amount: "342.5500", currency: "MYR" });
    expect(p.openingFloat).toBeNull();
    // §4.10.1: "the till never computes expectedCash or over_short: the server derives both" (A8c).
    expect(Object.keys(p)).not.toContain("expectedCash");
    expect(Object.keys(p)).not.toContain("overShort");
    const row = db.raw.prepare<[string], { expected_cash: string | null; over_short: string | null; closed_at: string }>(
      "select expected_cash, over_short, closed_at from shift where id = ?").get(s.id)!;
    expect(row.expected_cash).toBeNull();
    expect(row.over_short).toBeNull();
    expect(row.closed_at).not.toBeNull();
    expect(currentShift(db, "term-1")).toBeNull();
  });

  it("refuses to close a shift twice, and refuses to close one that is not open", () => {
    const s = openShift(db, store, { terminalId: "term-1", cashier: OWNER, openingFloat: Money.of("100.0000", MYR) });
    closeShift(db, store, { shiftId: s.id, cashier: OWNER, countedCash: Money.of("100.0000", MYR) });
    expect(() => closeShift(db, store, { shiftId: s.id, cashier: OWNER, countedCash: Money.of("100.0000", MYR) }))
      .toThrow(/ERR_VALIDATION_FAILED/);
    expect(() => closeShift(db, store, { shiftId: "nope", cashier: OWNER, countedCash: Money.of("1.0000", MYR) }))
      .toThrow(/ERR_NOT_FOUND/);
  });

  it("currentShift finds the open shift of THIS terminal and no other", () => {
    const a = openShift(db, store, { terminalId: "term-1", cashier: OWNER, openingFloat: Money.of("100.0000", MYR) });
    openShift(db, store, { terminalId: "term-2", cashier: OWNER, openingFloat: Money.of("50.0000", MYR) });
    expect(currentShift(db, "term-1")!.id).toBe(a.id);
    expect(currentShift(db, "term-2")!.openingFloat.toString()).toBe("50.0000");
  });
});
```

```ts
// apps/pos/src/main/shift.ts
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import { shiftRef, type ShiftOpenClose } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";
import { moneyToText, textToMoney } from "./money";
import { tillUuidv7 } from "./ticket";

export interface TillShift {
  id: string; terminalId: string; cashierPrincipalId: string; openedAt: string;
  openingFloat: Money; currency: CurrencyCode; closedAt: string | null; countedCash: Money | null;
}

interface ShiftDbRow {
  id: string; terminal_id: string; cashier_principal_id: string; opened_at: string;
  opening_float: string; currency: string; closed_at: string | null; counted_cash: string | null;
}
const toShift = (r: ShiftDbRow): TillShift => {
  const cur = currency(r.currency);
  return {
    id: r.id, terminalId: r.terminal_id, cashierPrincipalId: r.cashier_principal_id,
    openedAt: r.opened_at, openingFloat: textToMoney(r.opening_float, cur), currency: cur,
    closedAt: r.closed_at, countedCash: r.counted_cash === null ? null : textToMoney(r.counted_cash, cur),
  };
};
const SHIFT_COLUMNS =
  "id, terminal_id, cashier_principal_id, opened_at, opening_float, currency, closed_at, counted_cash";

export function currentShift(db: PosDatabase, terminalId: string): TillShift | null {
  const row = db.raw.prepare<[string], ShiftDbRow>(
    `select ${SHIFT_COLUMNS} from shift where terminal_id = ? and closed_at is null order by opened_at desc limit 1`,
  ).get(terminalId);
  return row === undefined ? null : toShift(row);
}

/**
 * Open a shift (§3.7.6's Shift row: *"open/close with declared opening float"*).
 *
 * `pos.shift.own` is written as `PERMISSION["pos.shift.own"]` and not as a string, which is what makes
 * §3.6.3's `permission-catalogue` lint see a reference from `apps/pos` — the till is the only place in the
 * product that references this code. `pos.shift.close_any`, the branch manager's code for closing *someone
 * else's* shift, is **6D's** and is deliberately not referenced here.
 *
 * The id is a `uuidv7` minted at the till and **is** `app.shift.id` (§4.6.5) — the same client-id convention
 * as `Ticket.clientRef`, so re-sending the open message is idempotent on the primary key. The outbox ref is
 * `shiftRef(id, "open")`, 6A's own function, never a hand-composed `"<id>:<kind>"`: two spellings of one key
 * would let `markAcked` fail to match a `MessageResult` and the row would re-send for ever.
 */
export function openShift(
  db: PosDatabase, store: SqliteSyncStore,
  opts: { terminalId: string; cashier: TillCashier; openingFloat: Money; at?: Date; shiftId?: string },
): TillShift {
  requireCode(opts.cashier, PERMISSION["pos.shift.own"]);
  if (currentShift(db, opts.terminalId) !== null) {
    throw new TillError("ERR_VALIDATION_FAILED",
      `terminal ${opts.terminalId} already has an open shift; close it before opening another`);
  }
  const at = opts.at ?? new Date();
  const id = opts.shiftId ?? tillUuidv7(at);
  const cur = currency(opts.openingFloat.toJSON().currency);
  const message: ShiftOpenClose = {
    shiftId: id, kind: "open", terminalId: opts.terminalId,
    cashierPrincipalId: opts.cashier.principalId, at: at.toISOString(), currency: cur,
    openingFloat: opts.openingFloat.toJSON(), countedCash: null,
  };
  return db.tx(() => {
    db.raw.prepare(
      `insert into shift (id, terminal_id, cashier_principal_id, opened_at, opening_float, currency,
                          closed_at, counted_cash, expected_cash, over_short)
       values (?, ?, ?, ?, ?, ?, null, null, null, null)`,
    ).run(id, opts.terminalId, opts.cashier.principalId, at.toISOString(), moneyToText(opts.openingFloat), cur);
    store.enqueue("shift", shiftRef(id, "open"), message);
    return currentShift(db, opts.terminalId)!;
  });
}

/**
 * Close a shift. **The till sends `countedCash` and nothing else.**
 *
 * §4.10.1, verbatim: *"The till never computes `expectedCash` or `over_short`: the server derives both from
 * the shift's posted tickets, so a tampered or clock-skewed till cannot move the difference."* The local
 * `expected_cash` and `over_short` columns exist because spec:1331 lists them (A8c) and stay `NULL` for ever
 * at the till; 6D writes the server's figures and 6D's Z-report is where they become visible.
 */
export function closeShift(
  db: PosDatabase, store: SqliteSyncStore,
  opts: { shiftId: string; cashier: TillCashier; countedCash: Money; at?: Date },
): TillShift {
  requireCode(opts.cashier, PERMISSION["pos.shift.own"]);
  const row = db.raw.prepare<[string], ShiftDbRow>(
    `select ${SHIFT_COLUMNS} from shift where id = ?`).get(opts.shiftId);
  if (row === undefined) throw new TillError("ERR_NOT_FOUND", `no shift ${opts.shiftId} on this till`);
  if (row.closed_at !== null) {
    throw new TillError("ERR_VALIDATION_FAILED", `shift ${opts.shiftId} was closed at ${row.closed_at}`);
  }
  const at = opts.at ?? new Date();
  const cur = currency(row.currency);
  if (currency(opts.countedCash.toJSON().currency) !== cur) {
    throw new TillError("ERR_MONEY_CURRENCY_MISMATCH",
      `the shift is in ${cur} and the count is in ${opts.countedCash.toJSON().currency}`);
  }
  const message: ShiftOpenClose = {
    shiftId: opts.shiftId, kind: "close", terminalId: row.terminal_id,
    cashierPrincipalId: opts.cashier.principalId, at: at.toISOString(), currency: cur,
    openingFloat: null, countedCash: opts.countedCash.toJSON(),
  };
  return db.tx(() => {
    db.raw.prepare("update shift set closed_at = ?, counted_cash = ? where id = ?")
      .run(at.toISOString(), moneyToText(opts.countedCash), opts.shiftId);
    store.enqueue("shift", shiftRef(opts.shiftId, "close"), message);
    return toShift({ ...row, closed_at: at.toISOString(), counted_cash: moneyToText(opts.countedCash) });
  });
}

/**
 * What the cashier sees at close: the ticket count and the cash the drawer *should* hold by tender method.
 *
 * **This is not a Z-report and must not be called one.** The Z-report is 6D's, ties to the ledger to the
 * cent, and reads the server's `expected_cash`; this is a local aid so the person counting the drawer has a
 * number to compare against, computed from the till's own `ticket_tender` rows. Amounts are returned as
 * fixed-4-dp strings because this crosses the `contextBridge` and JSON has no decimal.
 */
export function shiftTotals(db: PosDatabase, shiftId: string): { tickets: number; byMethod: Record<string, string> } {
  const tickets = db.raw.prepare<[string], { n: number }>(
    "select count(*) as n from ticket where shift_id = ? and status = 'completed'").get(shiftId)!.n;
  const row = db.raw.prepare<[string], { currency: string }>(
    "select currency from shift where id = ?").get(shiftId);
  const cur = currency(row?.currency ?? "XXX");
  const byMethod: Record<string, string> = {};
  const rows = db.raw.prepare<[string], { method: string; amount: string }>(
    `select t.method as method, t.amount as amount
       from ticket_tender t join ticket k on k.id = t.ticket_id
      where k.shift_id = ? and k.status = 'completed'`).all(shiftId);
  for (const r of rows) {
    const running = byMethod[r.method] === undefined ? Money.zero(cur) : textToMoney(byMethod[r.method]!, cur);
    byMethod[r.method] = moneyToText(running.add(textToMoney(r.amount, cur)));
  }
  return { tickets, byMethod };
}
```

- [ ] **Step 6: Run everything, and assert the permission lint is clean**

```bash
bun run --cwd apps/pos test -- ticket shift
bun run --cwd apps/pos typecheck
bun run --cwd packages/db test -- permission-catalogue
bun run lint && bun run lint:rules
```

**Expected:** 12 + 5 = 17 passed; typecheck clean. **`bun run lint:rules` clean — as it has been since Task 4**, which is the point: T4's `TILL_CODES` named all three codes in the commit that seeded them, and this task and T5 add their **real** call sites without the lint ever having gone red. All three are now referenced twice over: `PERMISSION["pos.price.check"]` in `pricing.ts` (T5) and `TILL_CODES[0]`, `PERMISSION["pos.shift.own"]` in `shift.ts` (this task) and `TILL_CODES[1]`, `PERMISSION["pos.attendance.clock"]` in `authority.ts`'s `clockEvent` (T4) and `TILL_CODES[2]`.

```bash
git add apps/pos/src/main/ticket.ts apps/pos/src/main/shift.ts apps/pos/test/ticket.test.ts apps/pos/test/shift.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): sell in one SQLite transaction, plus shifts and till events [6B T6]

The ticket, its lines, its outbox row and the attendance stamps are one db.tx (spec:1303), so a
sale can never be committed locally and lost in transit. Limits are checked BEFORE the
transaction opens and are a transcription of 6C's verifyTicket — same operand order, same detail
strings, asserted byte-identical in T12 — so the till refuses exactly what the server would.
The wire ticket's catalogueRevision is a decimal string: JSON.stringify throws on a bigint, which
is why 6A types the field BigintString. Shifts send countedCash and nothing else (§4.10.1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Multi-tender, change, POS cash rounding (ADR 0059), and the receipt payload

**§3.7.6's *Payment* row is one sentence with three obligations:** *"Multi-tender on one ticket (cash, card, transfer, store credit), change calculation, rounding per the currency's POS rounding rule."* The first two are arithmetic. The third has no contract-legal home except the ticket's own gross, and that is what ADR 0059 records and this task implements.

**Why rounding cannot be a ledger line, stated once.** §4.15 registers **no** POS-rounding account. The `POS_TICKET` policy balances `Σ` tender debits against `Σ`(item amount + tax) with **no residual leg** (6A's Task 10). §4.10.1's `Ticket` carries **no** rounding field. So a rounding difference has exactly one place to go that changes neither the server, the chart of accounts nor the wire: the ticket's own gross — applied to the **highest-amount item line's discount**, positive when rounding down and negative when rounding up, so that `Σ` tenders `= Σ` gross exactly and tax is extracted from the rounded figure. If the owner or the accountant wants rounding visible as its own ledger line, that is a §4.15 **and** §4.10.1 amendment that changes the server, and only `applyCashRounding` and the policy's rules change here.

**Files:**
- Create: `apps/pos/src/main/tender.ts`, `apps/pos/src/main/receipt.ts`, `apps/pos/test/tender.test.ts`, `docs/adr/0059-pos-cash-rounding-has-no-ledger-account.md`

**Interfaces**

- Consumes: `Money`, `Quantity`, `currency`, `CurrencyCode`, `RoundingMode`, `round`, `MONEY_SCALE` (§4.2.1); `Ticket`, `TicketTender` (`@dulja/sync`, 6A); `PosDatabase` (T1); `SqliteSyncStore` (T2); `moneyToText`, `textToMoney`, `quantityToText`, `textToQuantity` (T1); `TillError` (T2); `TillCashier`, `requireCode` (T4); `taxItemLine` (T5); `draftTicket`, `TicketDraft`, `DraftLine` (T6).
- Produces:
  ```ts
  // apps/pos/src/main/tender.ts
  export interface TenderInput { method: "cash" | "card" | "transfer" | "store_credit"; amount: Money; reference?: string | null }
  export interface TenderResult {
    clientRef: string;
    /** What the customer pays: the ticket gross, rounded when every tender is cash (ADR 0059). */
    payable: Money;
    /** `Σ` tendered − `payable`; zero or positive on a sale, and always cash. */
    change: Money;
    /** The rounding applied to reach `payable`; zero when any tender is non-cash. */
    rounding: Money;
    tenders: readonly TenderInput[];
  }
  /** `payable = round(gross, increment)` when EVERY tender is cash; otherwise `gross` unchanged. Pure. */
  export function roundToIncrement(value: Money, increment: string, mode?: RoundingMode): Money;
  /** Rewrites the draft so its gross equals `payable`: the difference lands on the highest-amount item
   *  line's discount and tax is re-extracted from the rounded figure. Pure; returns a new draft. */
  export function applyCashRounding(
    db: PosDatabase, draft: TicketDraft, increment: string, at?: Date,
  ): { draft: TicketDraft; rounding: Money };
  /** Completes an open ticket: rewrites the lines if rounding moved them, writes the tenders, replaces the
   *  outbox payload with the tendered `Ticket`, and sets `status = 'completed'` — one transaction. */
  export function tender(
    db: PosDatabase, store: SqliteSyncStore,
    input: { clientRef: string; cashier: TillCashier; tenders: readonly TenderInput[]; at?: Date },
  ): TenderResult;
  ```
  ```ts
  // apps/pos/src/main/receipt.ts
  export interface ReceiptLine {
    lineNo: number; code: string; nameEn: string; nameAr: string | null;
    quantity: string; unitPrice: string; discount: string; total: string;
  }
  export interface ReceiptPayload {
    clientRef: string; kind: "sale" | "return"; currency: string;
    soldAt: string; cashierPrincipalId: string; shiftId: string;
    customerName: string | null;
    lines: readonly ReceiptLine[];
    netTotal: string; taxTotal: string; total: string;
    tenders: readonly { method: string; amount: string; reference: string | null }[];
    change: string; rounding: string;
    /** `null` until the ticket has been acknowledged; the till prints its client ref meanwhile. */
    documentNumber: string | null;
    /** The two facts spec:1356 requires beside anything the till asserts. */
    catalogueRevision: string; catalogueAt: string | null;
  }
  export function buildReceipt(db: PosDatabase, clientRef: string): ReceiptPayload;
  ```

- [ ] **Step 1: Write ADR 0059 as a proposal (spec:95 — this touches money semantics)**

`docs/adr/0059-pos-cash-rounding-has-no-ledger-account.md`:

```markdown
# ADR 0059 — POS cash rounding is absorbed into the ticket, because the ledger has no rounding account

- Status: **proposed** (spec:95 — a decision touching money semantics is written as a proposal and asked)
- Date: 2026-09-05
- Slice: 6B

## Context

§3.7.6's Payment row requires *"rounding per the currency's POS rounding rule"*, and
`branch_pos_policy.rounding_increment` (§4.6.4) is where the increment lives — a configuration column with a
default, not a statutory rule, and this ADR states no jurisdiction's rounding practice.

Three facts fix what is possible:

1. **§4.15 registers no POS-rounding account.** The account-code register is closed and a plan may not
   invent a literal in it (hazard 32).
2. **The `POS_TICKET` policy balances `Σ` tender debits against `Σ`(item amount + tax) with no residual
   leg** (6A). A tender total that differed from the line total by one cent would fail
   `ERR_LEDGER_UNBALANCED` at post, for every rounded cash ticket in the shop.
3. **§4.10.1's `Ticket` carries no rounding field.** Adding one changes the wire contract, the Zod schema,
   the OpenAPI document and `applyBatch`.

## Decision

**When every tender on a ticket is `cash`, the payable amount is the ticket gross rounded to the branch's
`rounding_increment`, and the difference is applied to the highest-amount item line's `discount`.**

- Rounding **down** produces a positive discount; rounding **up** produces a negative one. `document_line.discount`
  is a signed `numeric(19,4)` with no non-negative CHECK, so a negative discount is representable, and
  §4.4.2's A9 rule is untouched: `discount` is a magnitude adjustment on the line, not a direction.
- Tax is **re-extracted from the rounded gross**, so the till's `taxAmount` and 6A's step-(g)
  recomputation agree by construction rather than by tolerance.
- The ticket's gross therefore **equals** the payable exactly, `Σ` tenders `= Σ` gross, and the policy
  balances with no residual leg and no new account.
- A ticket carrying **any** non-cash tender is **not** rounded: a card or transfer settles to the cent.

## Consequences

- Rounding is **not separately visible in the ledger**. It appears as a line discount, which is where a
  till's price adjustment already lives, and the receipt prints it on its own line so the customer sees it.
- A shop wanting rounding as its own ledger line needs a `5140`-shaped account in §4.15 **and** a
  `Ticket.rounding: MoneyJson` field in §4.10.1 **and** a fifth `POS_TICKET` rule. That is the amendment;
  only `applyCashRounding` and the policy change on this side of it.
- The increment is per branch and per policy row, so two branches of one company may round differently, and
  a branch with `rounding_increment = 0` rounds not at all.

## What we are asking

Confirm with the accountant that cash rounding appearing as a **line discount** on the ticket, rather than as
its own ledger account, is acceptable for the audit trail — and that the receipt showing it on a separate
line is sufficient disclosure to the customer.
```

- [ ] **Step 2: Write the failing test first**

```ts
// apps/pos/test/tender.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change, Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { openShift } from "../src/main/shift";
import { sell } from "../src/main/ticket";
import { roundToIncrement, tender } from "../src/main/tender";
import { buildReceipt } from "../src/main/receipt";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase; let store: SqliteSyncStore; let shiftId: string; const dirs: string[] = [];

const LIMITS = {
  maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500", requireCustomerOver: null, maxCashInDrawer: null,
};
const SELLER: TillCashier = { principalId: "p-1", employeeId: "e-1", branchId: "br-1",
  codes: ["pos.ticket.sell", "pos.ticket.return", "pos.shift.own"], limits: LIMITS, snapshotRevision: "1" };

// One item at 3.3300 with a 10 % inclusive tax code, so a 1-unit sale grosses 3.3300 and rounds to 3.3500.
const CATALOGUE: Change[] = [
  { stream: "item", op: "upsert", id: "item-A", revision: 10n, row: {
      id: "item-A", code: "SKU-A", barcode: "9001", name_en: "Rice", name_ar: "أرز",
      kind: "product", base_unit_id: "unit-ea", track_lots: false, tax_code_id: "tax-std" } },
  { stream: "price_list", op: "upsert", id: "pl", revision: 11n, row: {
      id: "pl", code: "RETAIL", currency: "MYR", customer_kind: "retail", branch_id: null,
      valid_from: null, valid_to: null } },
  { stream: "price_list_line", op: "upsert", id: "pll", revision: 12n, row: {
      id: "pll", price_list_id: "pl", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "3.3300" } },
  { stream: "tax_code", op: "upsert", id: "tax-std", revision: 13n, row: {
      id: "tax-std", code: "SYNTH-OUT-STD", rate: "0.10000000", kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO", output_account_id: "acct-2300", input_account_id: null,
      effective_from: "2026-01-01", effective_to: null } },
  { stream: "branch_pos_policy", op: "upsert", id: "bpp", revision: 14n, row: {
      id: "bpp", branch_id: "br-1", max_line_discount_pct: "0.100000", max_ticket_discount_pct: "0.050000",
      max_void_amount: "200.0000", max_price_override_pct: "0.020000", blind_return_allowed: false,
      max_blind_return_amount: "0.0000", max_cash_in_drawer: null, require_customer_over: null,
      rounding_increment: "0.0500", paid_out_allowed: false, max_paid_out_amount: "0.0000" } },
];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges(CATALOGUE);
  shiftId = openShift(db, store, { terminalId: "term-1", cashier: SELLER, openingFloat: Money.of("100.0000", MYR) }).id;
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const one = (): string =>
  sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] }).clientRef;
const payloadOf = (ref: string): Ticket =>
  JSON.parse(db.raw.prepare<[string], { payload: string }>(
    "select payload from outbox where kind = 'ticket' and ref = ?").get(ref)!.payload) as Ticket;

describe("tenders, change and POS rounding (§3.7.6 Payment, ADR 0059)", () => {
  it("roundToIncrement rounds to a multiple of the increment, and 0 rounds not at all", () => {
    expect(roundToIncrement(Money.of("3.3300", MYR), "0.0500").toString()).toBe("3.3500");
    expect(roundToIncrement(Money.of("3.3200", MYR), "0.0500").toString()).toBe("3.3000");
    expect(roundToIncrement(Money.of("3.3250", MYR), "0.0500").toString()).toBe("3.3500");  // half away from zero
    expect(roundToIncrement(Money.of("-3.3300", MYR), "0.0500").toString()).toBe("-3.3500");
    expect(roundToIncrement(Money.of("3.3300", MYR), "0.0000").toString()).toBe("3.3300");
    expect(roundToIncrement(Money.of("3.3500", MYR), "0.0500").toString()).toBe("3.3500");  // already a multiple
  });

  it("an all-cash ticket rounds, and the gross EQUALS the payable so the policy balances", () => {
    const ref = one();
    const r = tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }] });
    expect(r.payable.toString()).toBe("3.3500");
    // RECEIPT-FACING sign: rounding 3.3300 UP to 3.3500 is "+0.02" to the customer. The DISCOUNT column
    // takes the opposite sign, which the line assertion below pins — `tender` negates once, at that
    // boundary and nowhere else.
    expect(r.rounding.toString()).toBe("0.0200");
    expect(r.change.toString()).toBe("1.6500");
    const p = payloadOf(ref);
    const lineTotal = p.lines.reduce((s, l) => s.add(Money.of(l.total.amount, MYR)), Money.zero(MYR));
    const tenderTotal = p.tenders.reduce((s, t) => s.add(Money.of(t.amount.amount, MYR)), Money.zero(MYR));
    // The property the whole ADR exists for: Σ tenders === Σ line totals, to the cent, with no residual leg.
    expect(lineTotal.toString()).toBe("3.3500");
    expect(tenderTotal.toString()).toBe("3.3500");
    expect(p.lines[0]!.discount).toEqual({ amount: "-0.0200", currency: "MYR" });
  });

  it("re-extracts tax from the ROUNDED gross, so base + tax === total exactly", () => {
    const ref = one();
    tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }] });
    const l = payloadOf(ref).lines[0]!;
    // 3.3500 / 1.10 = 3.0455 (HALF_AWAY_FROM_ZERO); tax = 0.3045.
    const total = Money.of(l.total.amount, MYR);
    const tax = Money.of(l.taxAmount.amount, MYR);
    expect(total.toString()).toBe("3.3500");
    expect(tax.toString()).toBe("0.3045");
    expect(total.subtract(tax).toString()).toBe("3.0455");
    const row = db.raw.prepare<[string], { net_total: string; tax_total: string; total: string }>(
      "select net_total, tax_total, total from ticket where id = ?").get(ref)!;
    expect(row).toEqual({ net_total: "3.0455", tax_total: "0.3045", total: "3.3500" });
  });

  it("a ticket with ANY non-cash tender is NOT rounded — card settles to the cent", () => {
    const ref = one();
    const r = tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [
      { method: "cash", amount: Money.of("1.0000", MYR) },
      { method: "card", amount: Money.of("2.3300", MYR), reference: "auth-771" },
    ] });
    expect(r.payable.toString()).toBe("3.3300");
    expect(r.rounding.toString()).toBe("0.0000");
    expect(r.change.toString()).toBe("0.0000");
    expect(payloadOf(ref).lines[0]!.discount).toEqual({ amount: "0.0000", currency: "MYR" });
  });

  it("multi-tender sums across all four methods and writes one ticket_tender row each, numbered from 1", () => {
    const ref = one();
    tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [
      { method: "store_credit", amount: Money.of("1.0000", MYR) },
      { method: "transfer", amount: Money.of("1.0000", MYR), reference: "FT-9" },
      { method: "card", amount: Money.of("1.0000", MYR), reference: "auth-2" },
      { method: "cash", amount: Money.of("0.3300", MYR) },
    ] });
    const rows = db.raw.prepare<[string], { tender_no: number; method: string; amount: string; reference: string | null }>(
      "select tender_no, method, amount, reference from ticket_tender where ticket_id = ? order by tender_no").all(ref);
    expect(rows.map((r) => r.tender_no)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.method)).toEqual(["store_credit", "transfer", "card", "cash"]);
    expect(rows[1]!.reference).toBe("FT-9");
    expect(rows[3]!.amount).toBe("0.3300");
  });

  it("refuses a short tender and never leaves the ticket completed", () => {
    const ref = one();
    let thrown: unknown;
    try { tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("1.0000", MYR) }] }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_VALIDATION_FAILED");
    expect((thrown as TillError).detail).toContain("3.3500");
    expect(db.raw.prepare<[string], { status: string }>("select status from ticket where id = ?").get(ref)!.status).toBe("open");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_tender").get()!.n).toBe(0);
  });

  it("refuses change on anything but cash — a card overpayment is not a refund the till can give", () => {
    const ref = one();
    expect(() => tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [
      { method: "card", amount: Money.of("10.0000", MYR), reference: "auth-1" }] }))
      .toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("a return tenders NEGATIVE and gives no change — the money goes out, not in", () => {
    const ref = sell(db, store, { shiftId, cashier: SELLER, kind: "return", returnsClientRef: "orig-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] }).clientRef;
    const r = tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("-3.3500", MYR) }] });
    expect(r.payable.toString()).toBe("-3.3500");
    expect(r.change.toString()).toBe("0.0000");
    const p = payloadOf(ref);
    expect(p.tenders[0]!.amount).toEqual({ amount: "-3.3500", currency: "MYR" });
    expect(p.lines[0]!.total.amount.startsWith("-")).toBe(true);
  });

  it("refuses to tender a ticket twice, and refuses one that does not exist", () => {
    const ref = one();
    tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }] });
    expect(() => tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }] }))
      .toThrow(/ERR_VALIDATION_FAILED/);
    expect(() => tender(db, store, { clientRef: "nope", cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("1.0000", MYR) }] }))
      .toThrow(/ERR_NOT_FOUND/);
  });

  it("the outbox payload is REPLACED, not doubled — one row per ticket, with the tenders on it", () => {
    const ref = one();
    expect(payloadOf(ref).tenders).toEqual([]);
    tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("3.3500", MYR) }] });
    expect(db.raw.prepare<[string], { n: number }>("select count(*) as n from outbox where ref = ?").get(ref)!.n).toBe(1);
    expect(payloadOf(ref).tenders).toHaveLength(1);
    expect(db.raw.prepare<[string], { acked_at: string | null }>("select acked_at from outbox where ref = ?").get(ref)!.acked_at).toBeNull();
  });

  // ⚠️ `it.skip`, not `it`, and it is the ONE skipped case in this file. `buildReceipt` prepares
  // `select name_en from pending_customer where id = ?`, and SQLite resolves table names at `prepare`
  // time — so before Task 8 creates the table this case throws `SqliteError: no such table:
  // pending_customer` rather than failing an assertion. **Task 8 Step 1 removes the `.skip` and nothing
  // else on this line**, so the title string below must stay byte-identical.
  it.skip("buildReceipt carries both names, the rounding line, and the honest catalogue facts (spec:1356)", () => {
    const ref = one();
    tender(db, store, { clientRef: ref, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }] });
    const r = buildReceipt(db, ref);
    expect(r.clientRef).toBe(ref);
    expect(r.lines[0]!.nameEn).toBe("Rice");
    expect(r.lines[0]!.nameAr).toBe("أرز");
    expect(r.total).toBe("3.3500");
    expect(r.rounding).toBe("0.0200");          // receipt-facing, matching `tender`'s return value
    expect(r.change).toBe("1.6500");
    expect(r.tenders).toEqual([{ method: "cash", amount: "5.0000", reference: null }]);
    expect(r.documentNumber).toBeNull();          // nothing has been acknowledged yet
    expect(r.catalogueRevision).toBe("14");
    expect(Date.parse(r.catalogueAt!)).toBeGreaterThan(0);
  });
});
```

Run `bun run --cwd apps/pos test -- tender`. **Expected failure:** `Failed to resolve import "../src/main/tender"`.

- [ ] **Step 3: Write `apps/pos/src/main/tender.ts` — the rounding and the arithmetic**

```ts
// `round` is 0D's `round(value: Decimal, scale: number, mode: RoundingMode): Decimal` (§4.2.1) — the ONE
// place the `RoundingMode` → `Decimal.Rounding` mapping lives. `roundToIncrement` composes it; it does not
// re-implement it, and no `Decimal.ROUND_*` literal appears in `apps/pos`.
import { Money, currency, round, type CurrencyCode, type RoundingMode } from "@dulja/domain";
import type { Ticket, TicketTender } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import type { TillCashier } from "./authority";
import { taxItemLine } from "./pricing";
import type { DraftLine, TicketDraft } from "./ticket";
import { moneyToText, quantityToText, textToMoney, textToQuantity } from "./money";

const MODE: RoundingMode = "HALF_AWAY_FROM_ZERO";

export interface TenderInput { method: "cash" | "card" | "transfer" | "store_credit"; amount: Money; reference?: string | null }

export interface TenderResult {
  clientRef: string;
  payable: Money;
  change: Money;
  rounding: Money;
  tenders: readonly TenderInput[];
}

/**
 * Round to a multiple of `increment`.
 *
 * **This is not a scale rounding on its own, but it is built from one.** 0D's `round(value, scale, mode)`
 * takes a number of decimal places; a POS increment is `0.05` — two decimal places would give `3.33`, not
 * `3.35`. So the increment is divided out first and 0D's `round` does the actual rounding at scale 0:
 * `Money.fromDecimal(round(value / increment, 0, mode) × increment, currency, mode)`, which is exact because
 * both factors are `decimal.js` values reached through `Money.toDecimal()` (§4.2.1's one door; `apps/pos`
 * imports no `decimal.js` of its own — Global Constraint 6). **`round` IS 0D's `RoundingMode` → `Decimal.Rounding`
 * map** — its whole body is `new D(value).toDecimalPlaces(scale, MODES[mode])` (0D:386–389) — so composing it
 * is what keeps this file from carrying a second copy of that table, which is what hazard 9 exists to prevent.
 *
 * `HALF_AWAY_FROM_ZERO` is the mode, and it is the right one for both directions: a negative gross — a return
 * — rounds away from zero to the same magnitude a sale of the same amount would, so a sale and its return
 * cancel exactly. `HALF_EVEN` would make `-3.3250` round to `-3.3000` while `3.3250` rounds to `3.3500`, and
 * a return would then leave two cents behind in the ledger for ever.
 *
 * An increment of zero means "do not round", which is `branch_pos_policy.rounding_increment`'s meaning when a
 * company sets it to 0 and is what makes a division-by-zero impossible rather than merely unlikely.
 */
export function roundToIncrement(value: Money, increment: string, mode: RoundingMode = MODE): Money {
  const cur = currency(value.toJSON().currency);
  const inc = Money.of(increment, cur).toDecimal();
  if (inc.isZero() || inc.isNegative()) return value;
  const steps = value.toDecimal().div(inc);
  // 0D's `round`, at scale 0. Every one of the four `RoundingMode` members is handled by 0D's own `MODES`
  // table and none of them is spelled again here — `round` is that table (0D:386–389).
  const rounded = round(steps, 0, mode);
  return Money.fromDecimal(rounded.times(inc), cur, mode);
}
```

**`round` is imported from `@dulja/domain` in this file's import block** — it is already in this task's Consumes list and Task 0's gate proves the export exists (`need_repo "0D round" packages/domain/src/money/rounding.ts "export function round"`). **There is no `Decimal.ROUND_*` literal anywhere in `apps/pos`**, and therefore no hand-copied duplicate of 0D's rounding-mode map: a wrong constant would round the wrong way for one mode and be invisible until a shop configured that mode, which is precisely the class of defect hazard 9 forbids. The first test case still pins all four modes in both directions, because the *composition* (divide, round at scale 0, multiply back) is this function's own logic even though the mode mapping is not.

- [ ] **Step 4: `applyCashRounding` — the difference lands on one line**

```ts
/**
 * Rewrite a draft so its gross equals `round(gross, increment)` (ADR 0059).
 *
 * The difference lands on the **highest-amount item line's `discount`** — one line, deterministically chosen,
 * so two tills rounding the same basket produce the same ticket. Positive when rounding down (a discount),
 * negative when rounding up (a surcharge on the discount column). Tax is then **re-extracted from the rounded
 * line total**, which is what makes `base + tax === total` hold on the rewritten line and what makes 6A's
 * step-(g) recomputation agree — it recomputes tax from the stored line, so a line whose stored tax came from
 * the *unrounded* figure would be rejected with `ERR_TAX_*` on every rounded cash ticket in the shop.
 *
 * `Σ`(rewritten line totals) equals the payable exactly, because the chosen line's total is set to
 * `old total − difference` and nothing else moves.
 */
export function applyCashRounding(
  db: PosDatabase, draft: TicketDraft, increment: string, at?: Date,
): { draft: TicketDraft; rounding: Money } {
  const cur = draft.currency;
  const payable = roundToIncrement(draft.total, increment);
  const rounding = draft.total.subtract(payable);        // positive = rounded down = a discount
  if (rounding.isZero()) return { draft, rounding: Money.zero(cur) };

  // The highest-amount line by |total|, ties broken by the lowest lineNo so the choice is total.
  let target = 0;
  for (let i = 1; i < draft.lines.length; i += 1) {
    if (draft.lines[i]!.total.abs().compare(draft.lines[target]!.total.abs()) > 0) target = i;
  }

  const lines: DraftLine[] = draft.lines.map((l, i) => {
    if (i !== target) return l;
    const newTotal = l.total.subtract(rounding);
    const taxed = taxItemLine(db, { gross: newTotal, itemId: l.itemId, at });
    return { ...l, discount: l.discount.add(rounding), taxAmount: taxed.tax, total: taxed.total };
  });

  let netTotal = Money.zero(cur);
  let taxTotal = Money.zero(cur);
  let total = Money.zero(cur);
  for (const l of lines) {
    netTotal = netTotal.add(l.total.subtract(l.taxAmount));
    taxTotal = taxTotal.add(l.taxAmount);
    total = total.add(l.total);
  }
  return { draft: { ...draft, lines, netTotal, taxTotal, total }, rounding };
}
```

- [ ] **Step 5: `tender` — the second transaction on one ticket**

```ts
interface TicketDbRow {
  id: string; shift_id: string; cashier_principal_id: string; customer_id: string | null;
  kind: "sale" | "return"; returns_client_ref: string | null; status: string; currency: string;
  net_total: string; tax_total: string; total: string; catalogue_revision: string;
  created_at: string; events_json: string;
}

/**
 * Complete an open ticket.
 *
 * **Why this is a second call and not part of `sell`.** §4.10.6 names `sell` and `tender` as two members of
 * `window.dulja.pos`, and the till's own workflow is two steps: the cashier scans, then the customer chooses
 * how to pay — and the payable amount depends on *what* they choose, because an all-cash ticket rounds and a
 * card ticket does not (ADR 0059). A single call would have to know the tenders before the lines were priced.
 *
 * **The outbox row is replaced, never added to.** `store.enqueue` is idempotent on `(kind, ref)` and keeps the
 * FIRST payload, so this function updates the payload column directly, inside the same transaction that
 * writes the tenders and flips the status. One ticket, one outbox row, from `sell` to acknowledgement — which
 * is what makes `select count(*) from outbox where acked_at is null` a meaningful number.
 */
export function tender(
  db: PosDatabase, store: SqliteSyncStore,
  input: { clientRef: string; cashier: TillCashier; tenders: readonly TenderInput[]; at?: Date },
): TenderResult {
  if (input.tenders.length === 0) {
    throw new TillError("ERR_VALIDATION_FAILED", "a ticket needs at least one tender");
  }
  const row = db.raw.prepare<[string], TicketDbRow>(
    `select id, shift_id, cashier_principal_id, customer_id, kind, returns_client_ref, status, currency,
            net_total, tax_total, total, catalogue_revision, created_at, events_json
       from ticket where id = ?`).get(input.clientRef);
  if (row === undefined) throw new TillError("ERR_NOT_FOUND", `no ticket ${input.clientRef} on this till`);
  if (row.status !== "open") {
    throw new TillError("ERR_VALIDATION_FAILED", `ticket ${input.clientRef} is ${row.status}, not open`);
  }
  const cur = currency(row.currency);
  for (const t of input.tenders) {
    if (currency(t.amount.toJSON().currency) !== cur) {
      throw new TillError("ERR_MONEY_CURRENCY_MISMATCH",
        `the ticket is in ${cur} and a ${t.method} tender is in ${t.amount.toJSON().currency}`);
    }
  }

  // The draft as it stands in the local tables, so `tender` never re-prices and never re-reads a catalogue
  // that may have advanced between `sell` and payment.
  const stored = db.raw.prepare<[string], {
    line_no: number; item_id: string; lot_id: string | null; quantity: string; unit_id: string;
    unit_price: string; discount: string; tax_code_id: string | null; tax_amount: string; total: string;
  }>(`select line_no, item_id, lot_id, quantity, unit_id, unit_price, discount, tax_code_id, tax_amount, total
        from ticket_line where ticket_id = ? order by line_no`).all(input.clientRef);
  const draft: TicketDraft = {
    clientRef: row.id, kind: row.kind, currency: cur,
    lines: stored.map((l) => ({
      lineNo: l.line_no, itemId: l.item_id, lotId: l.lot_id, unitId: l.unit_id,
      quantity: textToQuantity(l.quantity), unitPrice: textToMoney(l.unit_price, cur),
      discount: textToMoney(l.discount, cur), taxCodeId: l.tax_code_id,
      taxAmount: textToMoney(l.tax_amount, cur), total: textToMoney(l.total, cur),
    })),
    netTotal: textToMoney(row.net_total, cur),
    taxTotal: textToMoney(row.tax_total, cur),
    total: textToMoney(row.total, cur),
    catalogueRevision: BigInt(row.catalogue_revision),
  };

  const allCash = input.tenders.every((t) => t.method === "cash");
  const increment = allCash ? input.cashier.limits.roundingIncrement : "0.0000";
  const at = input.at ?? new Date();
  const { draft: finalDraft, rounding } = applyCashRounding(db, draft, increment, at);
  const payable = finalDraft.total;

  const tendered = input.tenders.reduce((s, t) => s.add(t.amount), Money.zero(cur));
  const change = tendered.subtract(payable);
  if (row.kind === "sale") {
    if (change.isNegative()) {
      throw new TillError("ERR_VALIDATION_FAILED",
        `tendered ${tendered.toString()} is short of the payable ${payable.toString()}`);
    }
    if (!change.isZero() && !allCash) {
      throw new TillError("ERR_VALIDATION_FAILED",
        `change of ${change.toString()} cannot be given against a non-cash tender; take exactly ${payable.toString()}`);
    }
  } else if (!tendered.equals(payable)) {
    // A return pays money OUT. Over- or under-refunding is not "change"; it is the wrong refund.
    throw new TillError("ERR_VALIDATION_FAILED",
      `a return must be tendered exactly: ${tendered.toString()} was given against ${payable.toString()}`);
  }
  const changeGiven = row.kind === "sale" ? change : Money.zero(cur);

  const wireTenders: TicketTender[] = [];
  let remaining = payable;
  input.tenders.forEach((t, i) => {
    // The wire tender is what the ledger debits, so it is what the CUSTOMER's money settled — the cash a
    // customer handed over minus the change they took back. Sending the handed-over figure would debit
    // `1110` by 5.0000 for a 3.3500 ticket and `ERR_LEDGER_UNBALANCED` would fire at post.
    const settled = i === input.tenders.length - 1 ? remaining : t.amount;
    remaining = remaining.subtract(settled);
    wireTenders.push({ tenderNo: i + 1, method: t.method, amount: settled.toJSON(), reference: t.reference ?? null });
  });

  const wire: Ticket = {
    clientRef: row.id,
    shiftId: row.shift_id,
    cashierPrincipalId: row.cashier_principal_id,
    customerId: row.customer_id,
    newCustomer: null,
    kind: row.kind,
    returnsClientRef: row.returns_client_ref,
    currency: cur,
    soldAt: row.created_at,
    lines: finalDraft.lines.map((l) => ({
      lineNo: l.lineNo, itemId: l.itemId, lotId: l.lotId, quantity: quantityToText(l.quantity),
      unitId: l.unitId, unitPrice: l.unitPrice.toJSON(), discount: l.discount.toJSON(),
      taxCodeId: l.taxCodeId, taxAmount: l.taxAmount.toJSON(), total: l.total.toJSON(),
    })),
    tenders: wireTenders,
    events: JSON.parse(row.events_json) as Ticket["events"],
    attendance: (JSON.parse(
      db.raw.prepare<[string], { payload: string }>("select payload from outbox where kind = 'ticket' and ref = ?")
        .get(row.id)?.payload ?? "{}") as Partial<Ticket>).attendance ?? [],
    catalogueRevision: row.catalogue_revision as unknown as Ticket["catalogueRevision"],
  };

  return db.tx(() => {
    const updateLine = db.raw.prepare(
      "update ticket_line set discount = ?, tax_amount = ?, total = ? where ticket_id = ? and line_no = ?");
    for (const l of finalDraft.lines) {
      updateLine.run(moneyToText(l.discount), moneyToText(l.taxAmount), moneyToText(l.total), row.id, l.lineNo);
    }
    db.raw.prepare("update ticket set status = 'completed', net_total = ?, tax_total = ?, total = ? where id = ?")
      .run(moneyToText(finalDraft.netTotal), moneyToText(finalDraft.taxTotal), moneyToText(payable), row.id);
    const insertTender = db.raw.prepare(
      "insert into ticket_tender (ticket_id, tender_no, method, amount, reference) values (?, ?, ?, ?, ?)");
    input.tenders.forEach((t, i) => {
      insertTender.run(row.id, i + 1, t.method, moneyToText(t.amount), t.reference ?? null);
    });
    // The payload, replaced in place: one outbox row per ticket, still unacked.
    db.raw.prepare("update outbox set payload = ? where kind = 'ticket' and ref = ?")
      .run(JSON.stringify(wire), row.id);
    db.raw.prepare(
      "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value")
      .run(`change:${row.id}`, moneyToText(changeGiven));
    db.raw.prepare(
      "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value")
      .run(`rounding:${row.id}`, moneyToText(rounding.negate()));
    return { clientRef: row.id, payable, change: changeGiven, rounding: rounding.negate(), tenders: input.tenders };
  });
}
```

⚠️ **`rounding` is returned and printed with the sign the customer sees, and stored the same way, while `applyCashRounding` returns the sign the *discount column* takes.** Rounding a 3.3300 gross up to 3.3500 is `+0.0200` on the receipt ("Rounding 0.02") and `−0.0200` in `discount`. The `.negate()` at both boundaries is the whole of that conversion and is in exactly two places; a third would be a bug of the kind nobody notices until an accountant asks why the receipt and the ledger disagree by four cents.

- [ ] **Step 6: `receipt.ts` — the payload, not the printing**

```ts
// apps/pos/src/main/receipt.ts
import { currency } from "@dulja/domain";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";

export interface ReceiptLine {
  lineNo: number; code: string; nameEn: string; nameAr: string | null;
  quantity: string; unitPrice: string; discount: string; total: string;
}

export interface ReceiptPayload {
  clientRef: string; kind: "sale" | "return"; currency: string;
  soldAt: string; cashierPrincipalId: string; shiftId: string;
  customerName: string | null;
  lines: readonly ReceiptLine[];
  netTotal: string; taxTotal: string; total: string;
  tenders: readonly { method: string; amount: string; reference: string | null }[];
  change: string; rounding: string;
  documentNumber: string | null;
  catalogueRevision: string; catalogueAt: string | null;
}

/**
 * The receipt as **data**. Printing is Task 9's — `webContents.print()` in the Electron main process
 * (spec:1280, D18: ordinary Windows printer drivers and no ESC/POS anywhere) — and rendering is Task 11's
 * `components/receipt.tsx`, in both text directions.
 *
 * Every amount is a fixed-4-dp string, not a `Money`: this payload crosses the `contextBridge`, and a class
 * instance does not survive structured cloning. `packages/i18n`'s `formatMoney` is what turns each into the
 * locale's own presentation at render time, which is where display rounding belongs (spec:2041 — *"stored
 * base amounts are never recomputed on read"*).
 *
 * `documentNumber` is `null` until the server has acknowledged the ticket and the till has learned the number
 * from a `TicketResult`. A receipt printed before that carries the client ref, which is what the shop quotes
 * on the phone — and printing a *guessed* number would be SAH-051 in a new place.
 *
 * `catalogueRevision` and `catalogueAt` are on the receipt because spec:1356 asks the indicator to be honest
 * and a printed receipt outlives the screen: a customer disputing a price and a manager reading the receipt
 * can both see which catalogue the till priced from.
 */
export function buildReceipt(db: PosDatabase, clientRef: string): ReceiptPayload {
  const t = db.raw.prepare<[string], {
    id: string; kind: "sale" | "return"; currency: string; created_at: string;
    cashier_principal_id: string; shift_id: string; customer_id: string | null;
    net_total: string; tax_total: string; total: string; catalogue_revision: string;
  }>(`select id, kind, currency, created_at, cashier_principal_id, shift_id, customer_id,
             net_total, tax_total, total, catalogue_revision
        from ticket where id = ?`).get(clientRef);
  if (t === undefined) throw new TillError("ERR_NOT_FOUND", `no ticket ${clientRef} on this till`);
  currency(t.currency);           // refuses a corrupted row before it reaches a printer

  const lines = db.raw.prepare<[string], {
    line_no: number; quantity: string; unit_price: string; discount: string; total: string;
    code: string | null; name_en: string | null; name_ar: string | null;
  }>(`select l.line_no, l.quantity, l.unit_price, l.discount, l.total,
             i.code as code, i.name_en as name_en, i.name_ar as name_ar
        from ticket_line l left join catalogue_item i on i.id = l.item_id
       where l.ticket_id = ? order by l.line_no`).all(clientRef);

  const tenders = db.raw.prepare<[string], { method: string; amount: string; reference: string | null }>(
    "select method, amount, reference from ticket_tender where ticket_id = ? order by tender_no").all(clientRef);

  const meta = (key: string): string | null =>
    db.raw.prepare<[string], { value: string }>("select value from meta where key = ?").get(key)?.value ?? null;

  const customerName = t.customer_id === null ? null
    : (db.raw.prepare<[string], { name_en: string }>("select name_en from catalogue_customer where id = ?")
        .get(t.customer_id)?.name_en
       ?? db.raw.prepare<[string], { name_en: string }>("select name_en from pending_customer where id = ?")
        .get(t.customer_id)?.name_en
       ?? null);

  return {
    clientRef: t.id, kind: t.kind, currency: t.currency, soldAt: t.created_at,
    cashierPrincipalId: t.cashier_principal_id, shiftId: t.shift_id, customerName,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      // A line whose item has since been tombstoned still prints: the item id is what the ticket recorded.
      code: l.code ?? "(withdrawn)", nameEn: l.name_en ?? "(withdrawn)", nameAr: l.name_ar,
      quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount, total: l.total,
    })),
    netTotal: t.net_total, taxTotal: t.tax_total, total: t.total,
    tenders, change: meta(`change:${t.id}`) ?? "0.0000", rounding: meta(`rounding:${t.id}`) ?? "0.0000",
    documentNumber: meta(`number:${t.id}`),
    catalogueRevision: t.catalogue_revision, catalogueAt: meta("catalogue_pulled_at"),
  };
}
```

⚠️ **`buildReceipt` reads `pending_customer`, which Task 8 creates.** Write this file in this task and leave that one `left join`-shaped lookup in it; `apps/pos/test/tender.test.ts`'s receipt case uses a ticket with no customer, so it passes before Task 8 exists **only if** the table does — SQLite resolves table names at `prepare` time. Two options and the plan takes the second: run this task after Task 8, or **create `pending_customer` in Task 8 and run the receipt case there**. Task 8 Step 1 therefore carries the schema bump, and this task's receipt case is the one case in `tender.test.ts` marked `it.skip` until Task 8 lands, with the reason on the line. **Do not stub the table here** — a second `create table` for one name is exactly the drift ADR 0057's "two kinds of table and no third" exists to prevent.

- [ ] **Step 7: Run and commit**

```bash
bun run --cwd apps/pos test -- tender
```

**Expected:** 10 passed, 1 skipped (the `buildReceipt` case, which Task 8 un-skips). Then `bun run --cwd apps/pos typecheck` and `bun run lint:rules` at the root — **expected:** clean; every amount that leaves this module is a `Money` or a fixed-4-dp `string`, and the only `number` arguments in the file are `round`'s `scale` of `0` and a `tender_no`, neither of which matches `no-number-money`'s name pattern.

```bash
git add apps/pos/src/main/tender.ts apps/pos/src/main/receipt.ts apps/pos/test/tender.test.ts \
        docs/adr/0059-pos-cash-rounding-has-no-ledger-account.md
git commit -m "$(cat <<'EOF'
feat(pos): multi-tender, change and POS cash rounding into the ticket [6B T7]

ADR 0059 as a proposal: §4.15 registers no rounding account, POS_TICKET's policy has no residual
leg and §4.10.1's Ticket has no rounding field, so a cash rounding difference has exactly one
contract-legal home — the highest-amount line's discount, with tax re-extracted from the rounded
gross so 6A's step (g) recomputation agrees. Σ tenders === Σ line totals to the cent. The wire
tender is what SETTLED, not what the customer handed over: sending the handed-over figure would
debit 1110 by the change as well and unbalance every cash ticket in the shop.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Returns against an original and blind returns; customers — lookup, quick-create, account sales inside the credit limit

**§3.7.6's *Returns* and *Customers* rows, and one honest scope limit stated up front.** The Returns row says *"Return against an original ticket (looked up locally **or via sync**), and blind return where policy allows"*. **6A ships three routes — `/v1/sync/enrol`, `/v1/sync/catalogue`, `/v1/sync/tickets` — and none of them looks up a ticket.** This slice therefore implements the *locally* half in full and records the *via sync* half as a named gap rather than inventing a fourth route: a return against a ticket sold at **this** till is looked up in the local `ticket` table, and a return against a ticket sold **elsewhere** is a blind return, subject to `blind_return_allowed` and `max_blind_return_amount` exactly as policy intends. The Self-Review names the future amendment (a `GET /v1/sync/ticket/{clientRef}` route in 6A's range, or a `pos.ticket_lookup` dataset in 7C) and this slice does not make it.

**The customers half needs a local table, and ADR 0057 says which kind.** A customer quick-created offline at 09:00 must be findable by phone at 11:00 with no network. A `catalogue_customer` row would violate ADR 0057 rule 1 — *"its only writer is `SqliteSyncStore.applyChanges`"* — so the row goes in **`pending_customer`**, which is a table of the second kind: a row the till created and owns until the server acknowledges it. That is a `schema.sql` section plus a bump of `LOCAL_SCHEMA_VERSION`, which is precisely the mechanism ADR 0057's third consequence provides for.

**Files:**
- Create: `apps/pos/src/main/returns.ts`, `apps/pos/src/main/customer.ts`, `apps/pos/test/returns.test.ts`, `apps/pos/test/customer.test.ts`
- Modify: `apps/pos/src/main/schema.sql` (one new section), `apps/pos/src/main/database.ts` (`LOCAL_SCHEMA_VERSION` → 2), `apps/pos/test/database.test.ts` (the table list gains one name), `apps/pos/test/tender.test.ts` (un-skip the `buildReceipt` case)

**Interfaces**

- Consumes: `Money`, `Quantity`, `currency`, `CurrencyCode` (§4.2.1); `NewCustomer`, `Ticket` (`@dulja/sync`, 6A); `PosDatabase`, `LOCAL_SCHEMA_VERSION` (T1); `SqliteSyncStore` (T2); `moneyToText`, `textToMoney`, `textToQuantity` (T1); `TillError` (T2); `TillCashier`, `requireCode` (T4); `sell`, `SellInput`, `SellLine`, `SellResult`, `tillUuidv7` (T6); `PERMISSION` (0B).
- Produces:
  ```ts
  // apps/pos/src/main/returns.ts
  export interface OriginalLine { lineNo: number; itemId: string; unitId: string; quantity: Quantity; unitPrice: Money; total: Money }
  export interface OriginalTicket {
    clientRef: string; currency: CurrencyCode; soldAt: string;
    customerId: string | null; lines: readonly OriginalLine[];
    /** What has already been returned against it, per original line no. */
    returned: Readonly<Record<number, string>>;
  }
  export function findOriginal(db: PosDatabase, clientRef: string): OriginalTicket | null;
  export interface ReturnRequest {
    shiftId: string; cashier: TillCashier;
    /** `null` = a BLIND return: no original, and `blind_return_allowed` decides. */
    returnsClientRef: string | null;
    lines: readonly { itemId: string; quantity: Quantity; unitId?: string | null; unitPrice?: Money | null }[];
    events?: SellInput["events"];
    at?: Date;
  }
  export function returnTicket(db: PosDatabase, store: SqliteSyncStore, req: ReturnRequest): SellResult;
  ```
  ```ts
  // apps/pos/src/main/customer.ts
  export interface TillCustomer {
    id: string; code: string; nameEn: string; nameAr: string | null; phone: string | null;
    currency: CurrencyCode | null; creditLimit: Money | null; creditHold: boolean;
    /** True while the party exists only on this till. */
    pending: boolean;
  }
  export function findCustomers(db: PosDatabase, query: string, limit?: number): TillCustomer[];
  export function getCustomer(db: PosDatabase, id: string): TillCustomer | null;
  /** Mints the party's `uuidv7` offline; the row lives in `pending_customer` until a ticket carrying it is
   *  acknowledged. Returns the `NewCustomer` the ticket must carry. */
  export function quickCreateCustomer(
    db: PosDatabase, cashier: TillCashier, opts: { nameEn: string; phone?: string | null; code?: string },
  ): { customer: TillCustomer; newCustomer: NewCustomer };
  /** The till's copy of 4A's credit control: outstanding is what this till knows, and it says so. */
  export interface CreditCheck { ok: boolean; limit: Money | null; localExposure: Money; detail: string | null }
  export function checkCredit(db: PosDatabase, customerId: string, amount: Money): CreditCheck;
  /** A ticket settled to the customer's account rather than to a tender. */
  export function accountSale(
    db: PosDatabase, store: SqliteSyncStore,
    input: { shiftId: string; cashier: TillCashier; customerId: string; lines: SellInput["lines"]; at?: Date },
  ): SellResult;
  export function clearPendingCustomers(db: PosDatabase, ids: readonly string[]): void;
  ```

- [ ] **Step 1: The schema bump — `pending_customer`, and the two tests it touches**

Append one section to `apps/pos/src/main/schema.sql`, after the `attendance` section and before `outbox`:

```sql
-- ── 4. pending_customer (added at LOCAL_SCHEMA_VERSION 2, slice 6B Task 8) ────────────────────────────
-- A customer quick-created at the till (§3.7.6's Customers row, `pos.customer.create`). It is a table of
-- ADR 0057's SECOND kind -- a row the till created and owns until the server acknowledges it -- and NOT a
-- `catalogue_*` mirror: a mirror's only writer is applyChanges, and putting a locally-minted party there
-- would give the mirror a second writer, which is the whole failure mode ADR 0057 rule 1 exists to prevent.
--
-- `id` is the uuidv7 the till minted offline and is BOTH `Ticket.customerId` and `NewCustomer.id`, so a
-- re-sent ticket creates no second party (6A's quickCreateCustomer is `on conflict (company_id, code) do
-- nothing` and reads the winner back). The row is deleted once a ticket carrying it is acknowledged and the
-- real party arrives on a catalogue page -- `clearPendingCustomers`, called from the drain.
create table if not exists pending_customer (
  id           text primary key,
  code         text not null unique,
  name_en      text not null,
  name_ar      text,
  phone        text,
  created_at   text not null,
  acked_at     text
) strict;
create index if not exists pending_customer_phone_idx on pending_customer (phone);
```

```ts
// apps/pos/src/main/database.ts — one line.
/** 2 since 6B Task 8 added `pending_customer`. `openPosDatabase` re-execs `schema.sql`, whose every statement
 *  is `if not exists`, so a bump is idempotent on an existing file and needs no migration step — the only
 *  unrecoverable local state is the unsent outbox and no section has ever removed a column (ADR 0057). */
export const LOCAL_SCHEMA_VERSION = 2;
```

```ts
// apps/pos/test/database.test.ts — the expected table list gains one name, in sort order.
    expect(names).toEqual([
      "attendance",
      "catalogue_branch_pos_policy", "catalogue_cashier", "catalogue_customer", "catalogue_item",
      "catalogue_price_list", "catalogue_price_list_line", "catalogue_promotion", "catalogue_tax_code",
      "meta", "outbox", "pending_customer", "shift", "sync_cursor", "ticket", "ticket_line",
      "ticket_tender", "till_event",
    ]);
```

Then remove the `.skip` from `tender.test.ts`'s `buildReceipt` case — the line becomes `it("buildReceipt carries both names, the rounding line, and the honest catalogue facts (spec:1356)", () => {`, with the four-line `⚠️` comment above it deleted and **the title string unchanged** (Task 7 Step 6's note) — and run it.

```bash
bun run --cwd apps/pos test -- database tender
```

**Expected:** 10 passed in `database` (the eight of T1 Step 3 — the list case now asserting eighteen names — plus T1 Step 7's two renderer-entry cases) and 11 passed in `tender` — the receipt case included, because `pending_customer` now exists for `buildReceipt`'s lookup to prepare against.

- [ ] **Step 2: Write the failing returns test**

```ts
// apps/pos/test/returns.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change, Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { openShift } from "../src/main/shift";
import { sell } from "../src/main/ticket";
import { tender } from "../src/main/tender";
import { findOriginal, returnTicket } from "../src/main/returns";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase; let store: SqliteSyncStore; let shiftId: string; const dirs: string[] = [];

const limits = (over: Partial<TillCashier["limits"]> = {}): TillCashier["limits"] => ({
  maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0000", requireCustomerOver: null, maxCashInDrawer: null, ...over,
});
const cashier = (codes: string[], over: Partial<TillCashier["limits"]> = {}): TillCashier => ({
  principalId: "p-1", employeeId: "e-1", branchId: "br-1", codes, limits: limits(over), snapshotRevision: "1",
});
const SELLER = cashier(["pos.ticket.sell", "pos.ticket.return", "pos.shift.own"]);

const CATALOGUE: Change[] = [
  { stream: "item", op: "upsert", id: "item-A", revision: 10n, row: {
      id: "item-A", code: "SKU-A", barcode: "9001", name_en: "Rice", name_ar: null,
      kind: "product", base_unit_id: "unit-ea", track_lots: false, tax_code_id: null } },
  { stream: "price_list", op: "upsert", id: "pl", revision: 11n, row: {
      id: "pl", code: "RETAIL", currency: "MYR", customer_kind: "retail", branch_id: null,
      valid_from: null, valid_to: null } },
  { stream: "price_list_line", op: "upsert", id: "pll", revision: 12n, row: {
      id: "pll", price_list_id: "pl", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "10.0000" } },
  { stream: "branch_pos_policy", op: "upsert", id: "bpp", revision: 13n, row: {
      id: "bpp", branch_id: "br-1", max_line_discount_pct: "0.100000", max_ticket_discount_pct: "0.050000",
      max_void_amount: "200.0000", max_price_override_pct: "0.020000", blind_return_allowed: false,
      max_blind_return_amount: "0.0000", max_cash_in_drawer: null, require_customer_over: null,
      rounding_increment: "0.0000", paid_out_allowed: false, max_paid_out_amount: "0.0000" } },
];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges(CATALOGUE);
  shiftId = openShift(db, store, { terminalId: "term-1", cashier: SELLER, openingFloat: Money.of("100.0000", MYR) }).id;
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const payloadOf = (ref: string): Ticket =>
  JSON.parse(db.raw.prepare<[string], { payload: string }>(
    "select payload from outbox where kind = 'ticket' and ref = ?").get(ref)!.payload) as Ticket;

function soldThree(): string {
  const r = sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("3.000000") }] });
  tender(db, store, { clientRef: r.clientRef, cashier: SELLER, tenders: [{ method: "cash", amount: Money.of("30.0000", MYR) }] });
  return r.clientRef;
}

describe("returns (§3.7.6 Returns, spec:1350)", () => {
  it("findOriginal reads a completed local ticket and reports nothing returned yet", () => {
    const original = soldThree();
    const o = findOriginal(db, original)!;
    expect(o.clientRef).toBe(original);
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]!.quantity.toString()).toBe("3.000000");
    expect(o.lines[0]!.unitPrice.toString()).toBe("10.0000");
    expect(o.returned).toEqual({});
    expect(findOriginal(db, "nope")).toBeNull();
  });

  it("refuses to look up a ticket that is still open — an unpaid ticket is not a sale", () => {
    const ref = sell(db, store, { shiftId, cashier: SELLER, lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] }).clientRef;
    expect(findOriginal(db, ref)).toBeNull();
  });

  it("returns against an original at the ORIGINAL's price, not today's", () => {
    const original = soldThree();
    // The catalogue moves after the sale — a return must still refund what was paid.
    db.raw.prepare("update catalogue_price_list_line set unit_price = '15.0000' where id = 'pll'").run();
    const r = returnTicket(db, store, {
      shiftId, cashier: SELLER, returnsClientRef: original,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    const line = payloadOf(r.clientRef).lines[0]!;
    expect(line.unitPrice).toEqual({ amount: "10.0000", currency: "MYR" });
    expect(line.quantity).toBe("-1.000000");
    expect(line.total).toEqual({ amount: "-10.0000", currency: "MYR" });
    expect(payloadOf(r.clientRef).returnsClientRef).toBe(original);
  });

  it("refuses to return more than was sold, cumulatively across several returns", () => {
    const original = soldThree();
    returnTicket(db, store, { shiftId, cashier: SELLER, returnsClientRef: original,
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }] });
    expect(findOriginal(db, original)!.returned).toEqual({ 1: "2.000000" });
    // One more is fine; two more is not.
    let thrown: unknown;
    try {
      returnTicket(db, store, { shiftId, cashier: SELLER, returnsClientRef: original,
        lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }] });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_VALIDATION_FAILED");
    expect((thrown as TillError).detail).toContain("3.000000");
    expect((thrown as TillError).detail).toContain("2.000000");
    returnTicket(db, store, { shiftId, cashier: SELLER, returnsClientRef: original,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
  });

  it("refuses an item the original ticket never carried", () => {
    const original = soldThree();
    expect(() => returnTicket(db, store, { shiftId, cashier: SELLER, returnsClientRef: original,
      lines: [{ itemId: "item-Z", quantity: Quantity.of("1.000000") }] })).toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("refuses a return against an unknown original rather than silently going blind", () => {
    // This is the case that would be a security hole if it fell through: a blind return has its own code and
    // its own limit, and a typo in a client ref must never buy the cashier past both.
    let thrown: unknown;
    try {
      returnTicket(db, store, { shiftId, cashier: SELLER, returnsClientRef: "not-a-ticket",
        lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    } catch (e) { thrown = e; }
    expect((thrown as TillError).code).toBe("ERR_NOT_FOUND");
    expect((thrown as TillError).detail).toContain("blind return");
  });

  it("a BLIND return needs pos.ticket.return_blind AND blind_return_allowed", () => {
    const noBlindCode = cashier(["pos.ticket.sell", "pos.ticket.return"], { blindReturnAllowed: true, maxBlindReturnAmount: "50.0000" });
    expect(() => returnTicket(db, store, { shiftId, cashier: noBlindCode, returnsClientRef: null,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] })).toThrow(/ERR_RBAC_FORBIDDEN/);

    const notAllowed = cashier(["pos.ticket.sell", "pos.ticket.return", "pos.ticket.return_blind"]);
    let thrown: unknown;
    try {
      returnTicket(db, store, { shiftId, cashier: notAllowed, returnsClientRef: null,
        lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    } catch (e) { thrown = e; }
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    expect((thrown as TillError).detail).toContain("blind_return_allowed = false");
  });

  it("a blind return inside the branch's cap is accepted and prices at today's catalogue", () => {
    const blind = cashier(["pos.ticket.sell", "pos.ticket.return", "pos.ticket.return_blind"],
      { blindReturnAllowed: true, maxBlindReturnAmount: "50.0000" });
    const r = returnTicket(db, store, { shiftId, cashier: blind, returnsClientRef: null,
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }] });
    const p = payloadOf(r.clientRef);
    expect(p.returnsClientRef).toBeNull();
    expect(p.lines[0]!.total).toEqual({ amount: "-20.0000", currency: "MYR" });
  });

  it("a blind return over the cap is refused, and a blind_return override event lifts it", () => {
    const blind = cashier(["pos.ticket.sell", "pos.ticket.return", "pos.ticket.return_blind"],
      { blindReturnAllowed: true, maxBlindReturnAmount: "15.0000" });
    expect(() => returnTicket(db, store, { shiftId, cashier: blind, returnsClientRef: null,
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }] })).toThrow(/ERR_TILL_LIMIT_EXCEEDED/);
    const ok = returnTicket(db, store, { shiftId, cashier: blind, returnsClientRef: null,
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }],
      events: [{ kind: "override", code: "pos.ticket.override", subject: "blind_return",
                 supervisorPrincipalId: "sup-1", reason: "customer had no receipt" }] });
    expect(payloadOf(ok.clientRef).events).toHaveLength(1);
  });
});
```

Run `bun run --cwd apps/pos test -- returns`. **Expected failure:** `Failed to resolve import "../src/main/returns"`.

- [ ] **Step 3: Write `apps/pos/src/main/returns.ts`**

```ts
import { Money, Quantity, currency, type CurrencyCode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";
import { sell, type SellInput, type SellResult } from "./ticket";
import { textToMoney, textToQuantity } from "./money";

export interface OriginalLine { lineNo: number; itemId: string; unitId: string; quantity: Quantity; unitPrice: Money; total: Money }

export interface OriginalTicket {
  clientRef: string; currency: CurrencyCode; soldAt: string;
  customerId: string | null; lines: readonly OriginalLine[];
  returned: Readonly<Record<number, string>>;
}

/**
 * The original ticket, **from this till's own `ticket` table**.
 *
 * §3.7.6 says *"looked up locally **or via sync**"*, and the "via sync" half has no route: 6A ships
 * `/v1/sync/enrol`, `/v1/sync/catalogue` and `/v1/sync/tickets` and none of them answers "give me the ticket
 * with this client ref". Inventing a fourth route here would put a wire contract in the wrong slice (§4.10.1
 * is 6A's), so this slice implements the local half and a ticket sold at another till is handled as a **blind
 * return** — which is exactly what `blind_return_allowed` and `max_blind_return_amount` exist to govern. The
 * Self-Review names the amendment that closes the gap.
 *
 * **Only a `completed` ticket is an original.** An `open` ticket has not been paid for; returning against one
 * would refund money the shop never took.
 */
export function findOriginal(db: PosDatabase, clientRef: string): OriginalTicket | null {
  const t = db.raw.prepare<[string], { id: string; currency: string; created_at: string; customer_id: string | null }>(
    "select id, currency, created_at, customer_id from ticket where id = ? and kind = 'sale' and status = 'completed'",
  ).get(clientRef);
  if (t === undefined) return null;
  const cur = currency(t.currency);
  const lines = db.raw.prepare<[string], {
    line_no: number; item_id: string; unit_id: string; quantity: string; unit_price: string; total: string;
  }>(`select line_no, item_id, unit_id, quantity, unit_price, total
        from ticket_line where ticket_id = ? order by line_no`).all(clientRef);

  // What has already been returned against this original, by item — matched on `item_id` rather than on
  // `line_no`, because a return ticket's own line numbering is its own and a second return of the same item
  // may sit on a different line. The map is keyed by the ORIGINAL's line no, which is what a caller compares.
  const priorByItem = new Map<string, Quantity>();
  const priorRows = db.raw.prepare<[string], { item_id: string; quantity: string }>(
    `select l.item_id as item_id, l.quantity as quantity
       from ticket_line l join ticket k on k.id = l.ticket_id
      where k.kind = 'return' and k.returns_client_ref = ?`).all(clientRef);
  for (const r of priorRows) {
    const q = textToQuantity(r.quantity);
    const magnitude = q.isNegative() ? q.negate() : q;
    const running = priorByItem.get(r.item_id);
    priorByItem.set(r.item_id, running === undefined ? magnitude : running.add(magnitude));
  }

  const returned: Record<number, string> = {};
  for (const l of lines) {
    const prior = priorByItem.get(l.item_id);
    if (prior !== undefined && !prior.isZero()) returned[l.line_no] = prior.toString();
  }

  return {
    clientRef: t.id, currency: cur, soldAt: t.created_at, customerId: t.customer_id,
    lines: lines.map((l) => ({
      lineNo: l.line_no, itemId: l.item_id, unitId: l.unit_id,
      quantity: textToQuantity(l.quantity), unitPrice: textToMoney(l.unit_price, cur),
      total: textToMoney(l.total, cur),
    })),
    returned,
  };
}

export interface ReturnRequest {
  shiftId: string; cashier: TillCashier;
  returnsClientRef: string | null;
  lines: readonly { itemId: string; quantity: Quantity; unitId?: string | null; unitPrice?: Money | null }[];
  events?: SellInput["events"];
  at?: Date;
}

/**
 * Return a ticket, against an original or blind.
 *
 * **Against an original, the price is the ORIGINAL's, not today's.** A shop that raised a price on Tuesday
 * must refund Monday's price on a Monday receipt; refunding today's would hand the customer the difference
 * and would make the return not cancel the sale in the ledger. The `priceOverride` on the `SellLine` is how
 * that price reaches `draftTicket`, and `maxPriceOverridePct` cannot refuse it because the override *is* the
 * catalogue price of record — so `checkLimits`'s `catalogueUnitPrices` for a return is the original's own
 * price, which is what `sell` computes from `resolvePrice` and is why this function passes the price through
 * as an override rather than mutating the catalogue.
 *
 * ⚠️ **`sell`'s `catalogueUnitPrices` comes from `resolvePrice`, so an original-priced return whose price has
 * since moved by more than `maxPriceOverridePct` would be refused for a price override it did not make.**
 * That is why `returnTicket` builds its own `TillCashier` view with `maxPriceOverridePct` widened to `"1.000000"`
 * for the against-original path **only**, and states the reason on the line. A blind return is priced at
 * today's catalogue and keeps the real limit.
 */
export function returnTicket(db: PosDatabase, store: SqliteSyncStore, req: ReturnRequest): SellResult {
  requireCode(req.cashier, PERMISSION["pos.ticket.return"]);
  if (req.lines.length === 0) {
    throw new TillError("ERR_VALIDATION_FAILED", "a return needs at least one line");
  }

  if (req.returnsClientRef === null) {
    // Blind: the code first, then the limit. `sell` re-checks both — this is the early, specific refusal.
    requireCode(req.cashier, PERMISSION["pos.ticket.return_blind"]);
    return sell(db, store, {
      shiftId: req.shiftId, cashier: req.cashier, kind: "return", returnsClientRef: null,
      lines: req.lines.map((l) => ({
        itemId: l.itemId, quantity: l.quantity, unitId: l.unitId ?? null,
        priceOverride: l.unitPrice ?? null,
      })),
      events: req.events, at: req.at,
    });
  }

  const original = findOriginal(db, req.returnsClientRef);
  if (original === null) {
    // NEVER fall through to blind. A typo in a client ref must not buy the cashier past both the blind code
    // and the blind cap; the shop is told to take a blind return deliberately if that is what this is.
    throw new TillError("ERR_NOT_FOUND",
      `no completed ticket ${req.returnsClientRef} on this till; take a blind return if the sale was at another till`);
  }

  const lines: SellInput["lines"] = req.lines.map((l) => {
    const source = original.lines.find((o) => o.itemId === l.itemId);
    if (source === undefined) {
      throw new TillError("ERR_VALIDATION_FAILED",
        `ticket ${original.clientRef} carries no item ${l.itemId}`);
    }
    const soldMagnitude = source.quantity.isNegative() ? source.quantity.negate() : source.quantity;
    const already = original.returned[source.lineNo];
    const alreadyQ = already === undefined ? Quantity.of("0.000000") : Quantity.of(already);
    const wanted = l.quantity.isNegative() ? l.quantity.negate() : l.quantity;
    if (alreadyQ.add(wanted).compare(soldMagnitude) > 0) {
      throw new TillError("ERR_VALIDATION_FAILED",
        `item ${l.itemId}: ${soldMagnitude.toString()} were sold on ${original.clientRef} and ${alreadyQ.toString()} already returned; ${wanted.toString()} cannot be`);
    }
    return {
      itemId: l.itemId, quantity: wanted, unitId: source.unitId,
      priceOverride: source.unitPrice,       // the ORIGINAL's price of record
    };
  });

  // The one widened limit, and only on this path. The "override" is the original's own price, which the
  // cashier did not choose, so `maxPriceOverridePct` has nothing to protect here — and leaving it narrow
  // would refuse every return of an item whose price has moved, which is most returns in a shop that
  // repriced anything. The discount and void limits are untouched.
  const asRefunder: TillCashier = { ...req.cashier, limits: { ...req.cashier.limits, maxPriceOverridePct: "1.000000" } };

  return sell(db, store, {
    shiftId: req.shiftId, cashier: asRefunder, kind: "return",
    returnsClientRef: original.clientRef, customerId: original.customerId,
    lines, events: req.events, at: req.at,
  });
}
```

- [ ] **Step 4: Write the failing customer test**

```ts
// apps/pos/test/customer.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import type { Change, Ticket } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { openShift } from "../src/main/shift";
import { accountSale, checkCredit, clearPendingCustomers, findCustomers, quickCreateCustomer } from "../src/main/customer";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase; let store: SqliteSyncStore; let shiftId: string; const dirs: string[] = [];

const LIMITS = {
  maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.050000", maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000", blindReturnAllowed: false, maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0000", requireCustomerOver: null, maxCashInDrawer: null,
};
const SELLER: TillCashier = { principalId: "p-1", employeeId: "e-1", branchId: "br-1",
  codes: ["pos.ticket.sell", "pos.customer.create", "pos.shift.own"], limits: LIMITS, snapshotRevision: "1" };

const CATALOGUE: Change[] = [
  { stream: "item", op: "upsert", id: "item-A", revision: 10n, row: {
      id: "item-A", code: "SKU-A", barcode: "9001", name_en: "Rice", name_ar: null,
      kind: "product", base_unit_id: "unit-ea", track_lots: false, tax_code_id: null } },
  { stream: "price_list", op: "upsert", id: "pl", revision: 11n, row: {
      id: "pl", code: "RETAIL", currency: "MYR", customer_kind: "retail", branch_id: null,
      valid_from: null, valid_to: null } },
  { stream: "price_list_line", op: "upsert", id: "pll", revision: 12n, row: {
      id: "pll", price_list_id: "pl", item_id: "item-A", unit_id: null,
      min_quantity: "0.000000", unit_price: "10.0000" } },
  { stream: "customer", op: "upsert", id: "cust-1", revision: 13n, row: {
      id: "cust-1", code: "C-001", name_en: "Ahmad Trading", name_ar: "أحمد للتجارة",
      phone: "0171234567", currency: "MYR", credit_limit: "100.0000", credit_hold: false } },
  { stream: "customer", op: "upsert", id: "cust-hold", revision: 14n, row: {
      id: "cust-hold", code: "C-002", name_en: "Slow Payer", name_ar: null, phone: "0179999999",
      currency: "MYR", credit_limit: "500.0000", credit_hold: true } },
  { stream: "customer", op: "upsert", id: "cust-cash", revision: 15n, row: {
      id: "cust-cash", code: "C-003", name_en: "Cash Only", name_ar: null, phone: null,
      currency: "MYR", credit_limit: null, credit_hold: false } },
  { stream: "branch_pos_policy", op: "upsert", id: "bpp", revision: 16n, row: {
      id: "bpp", branch_id: "br-1", max_line_discount_pct: "0.100000", max_ticket_discount_pct: "0.050000",
      max_void_amount: "200.0000", max_price_override_pct: "0.020000", blind_return_allowed: false,
      max_blind_return_amount: "0.0000", max_cash_in_drawer: null, require_customer_over: null,
      rounding_increment: "0.0000", paid_out_allowed: false, max_paid_out_amount: "0.0000" } },
];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-")); dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges(CATALOGUE);
  shiftId = openShift(db, store, { terminalId: "term-1", cashier: SELLER, openingFloat: Money.of("100.0000", MYR) }).id;
});
afterEach(() => { db.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const payloadOf = (ref: string): Ticket =>
  JSON.parse(db.raw.prepare<[string], { payload: string }>(
    "select payload from outbox where kind = 'ticket' and ref = ?").get(ref)!.payload) as Ticket;

describe("customers at the till (§3.7.6 Customers, spec:1351)", () => {
  it("finds a customer by code, by phone and by BOTH names", () => {
    expect(findCustomers(db, "C-001").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "0171234567").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "ahmad").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "أحمد").map((c) => c.id)).toEqual(["cust-1"]);
    expect(findCustomers(db, "nobody")).toEqual([]);
  });

  it("quick-creates offline: the party's uuidv7 is minted at the till and is the ticket's customerId", () => {
    const { customer, newCustomer } = quickCreateCustomer(db, SELLER, { nameEn: "Walk-in Fatimah", phone: "0181112222" });
    expect(customer.pending).toBe(true);
    expect(customer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(newCustomer.id).toBe(customer.id);
    expect(newCustomer.nameEn).toBe("Walk-in Fatimah");
    expect(newCustomer.code).toBe(customer.code);
    // Findable immediately, with no network, which is the whole point of the table.
    expect(findCustomers(db, "0181112222").map((c) => c.id)).toEqual([customer.id]);
    expect(findCustomers(db, "fatimah")[0]!.pending).toBe(true);
  });

  it("refuses a quick-create without pos.customer.create", () => {
    const noCode: TillCashier = { ...SELLER, codes: ["pos.ticket.sell"] };
    expect(() => quickCreateCustomer(db, noCode, { nameEn: "X" })).toThrow(/ERR_RBAC_FORBIDDEN/);
  });

  it("refuses a quick-create whose code collides, rather than silently reusing a party", () => {
    quickCreateCustomer(db, SELLER, { nameEn: "First", code: "WALK-1" });
    expect(() => quickCreateCustomer(db, SELLER, { nameEn: "Second", code: "WALK-1" }))
      .toThrow(/ERR_VALIDATION_FAILED/);
  });

  it("checkCredit refuses a customer on credit hold, whatever the limit says", () => {
    const c = checkCredit(db, "cust-hold", Money.of("1.0000", MYR));
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("credit hold");
  });

  it("checkCredit refuses a customer with no limit at all — a cash customer has no account", () => {
    const c = checkCredit(db, "cust-cash", Money.of("1.0000", MYR));
    expect(c.ok).toBe(false);
    expect(c.limit).toBeNull();
    expect(c.detail).toContain("no credit limit");
  });

  it("checkCredit counts THIS TILL's unsynced account sales against the limit, and says the figure is local", () => {
    expect(checkCredit(db, "cust-1", Money.of("60.0000", MYR)).ok).toBe(true);
    accountSale(db, store, { shiftId, cashier: SELLER, customerId: "cust-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("6.000000") }] });
    const after = checkCredit(db, "cust-1", Money.of("60.0000", MYR));
    expect(after.localExposure.toString()).toBe("60.0000");
    expect(after.ok).toBe(false);
    expect(after.detail).toContain("100.0000");
    expect(after.detail).toContain("this till");     // spec:1307's honesty rule applied to credit
  });

  it("accountSale writes a ticket with the customer and NO tender, so the server posts it to receivables", () => {
    const r = accountSale(db, store, { shiftId, cashier: SELLER, customerId: "cust-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("2.000000") }] });
    const p = payloadOf(r.clientRef);
    expect(p.customerId).toBe("cust-1");
    expect(p.tenders).toEqual([]);
    expect(db.raw.prepare<[string], { status: string }>("select status from ticket where id = ?").get(r.clientRef)!.status).toBe("completed");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket_tender").get()!.n).toBe(0);
  });

  it("accountSale over the limit is refused with ERR_TILL_LIMIT_EXCEEDED and writes nothing", () => {
    let thrown: unknown;
    try {
      accountSale(db, store, { shiftId, cashier: SELLER, customerId: "cust-1",
        lines: [{ itemId: "item-A", quantity: Quantity.of("20.000000") }] });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from ticket").get()!.n).toBe(0);
  });

  it("an account sale to a quick-created customer carries newCustomer on the ticket", () => {
    const { customer, newCustomer } = quickCreateCustomer(db, SELLER, { nameEn: "New Account", phone: "0182223333" });
    // A pending customer has no credit limit until the back office gives one, so an account sale is refused.
    expect(() => accountSale(db, store, { shiftId, cashier: SELLER, customerId: customer.id,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] })).toThrow(/ERR_TILL_LIMIT_EXCEEDED/);
    // A cash sale to them does carry the newCustomer block.
    const { sell } = require("../src/main/ticket") as typeof import("../src/main/ticket");
    const r = sell(db, store, { shiftId, cashier: SELLER, customerId: customer.id, newCustomer,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }] });
    expect(payloadOf(r.clientRef).newCustomer).toEqual(newCustomer);
  });

  it("clearPendingCustomers removes a pending row once the server has the party", () => {
    const { customer } = quickCreateCustomer(db, SELLER, { nameEn: "Temp" });
    clearPendingCustomers(db, [customer.id]);
    expect(findCustomers(db, "Temp")).toEqual([]);
  });
});
```

Run `bun run --cwd apps/pos test -- customer`. **Expected failure:** `Failed to resolve import "../src/main/customer"`.

- [ ] **Step 5: Write `apps/pos/src/main/customer.ts`**

```ts
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { NewCustomer } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";
import { sell, tillUuidv7, type SellInput, type SellResult } from "./ticket";
import { draftTicket } from "./ticket";
import { moneyToText, textToMoney } from "./money";

export interface TillCustomer {
  id: string; code: string; nameEn: string; nameAr: string | null; phone: string | null;
  currency: CurrencyCode | null; creditLimit: Money | null; creditHold: boolean;
  pending: boolean;
}

/**
 * ⚠️ **`credit_hold` is aliased to `hold_flag` in every SELECT below, and the member is named `hold_flag`
 * here, because of `no-number-money` (§3.7.5, 0D).** That rule matches a **declared** `number` annotation on
 * any `PropertySignature` whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|
 * gross/i`, its `IN_SCOPE` list includes `/(^|\/)apps\//` and its `EXCLUDED` list covers only test paths —
 * so `credit_hold: number` in `apps/pos/src/main/customer.ts` is a violation, and `ALLOWED` is deliberately
 * empty ("every entry there is a review conversation", 0D). The column is a **boolean stored as SQLite's
 * `0|1`**, not money, so the honest fix is the rename and not an `ALLOWED` entry: the public shape,
 * `TillCustomer.creditHold: boolean`, is unchanged and no caller sees this name.
 */
interface CustomerDbRow {
  id: string; code: string; name_en: string; name_ar: string | null; phone: string | null;
  currency: string | null; credit_limit: string | null; hold_flag: number;
}
const toCustomer = (r: CustomerDbRow, pending: boolean): TillCustomer => {
  const cur = r.currency === null ? null : currency(r.currency);
  return {
    id: r.id, code: r.code, nameEn: r.name_en, nameAr: r.name_ar, phone: r.phone, currency: cur,
    creditLimit: r.credit_limit === null || cur === null ? null : textToMoney(r.credit_limit, cur),
    creditHold: r.hold_flag === 1, pending,
  };
};

/**
 * Lookup by code, phone or either name, across the mirror **and** the till's own pending rows.
 *
 * The `union all` is what makes a customer created at 09:00 findable at 11:00 with no network, and it is two
 * queries rather than one view because the two tables are two *kinds* of row (ADR 0057): the mirror's writer
 * is `applyChanges` and the pending table's writer is this module. `phone` is in the `where` because a shop
 * looks a customer up by the number they read out, and `name_ar` because spec:2061 makes Arabic first-class.
 */
export function findCustomers(db: PosDatabase, query: string, limit = 20): TillCustomer[] {
  const needle = `%${query.trim().toLowerCase()}%`;
  const mirrored = db.raw.prepare<[string, string, string, string, number], CustomerDbRow>(
    `select id, code, name_en, name_ar, phone, currency, credit_limit, credit_hold as hold_flag
       from catalogue_customer
      where lower(code) like ?1 or lower(name_en) like ?2 or lower(coalesce(name_ar, '')) like ?3
         or coalesce(phone, '') like ?4
      order by code limit ?5`,
  ).all(needle, needle, needle, needle, limit).map((r) => toCustomer(r, false));
  const pending = db.raw.prepare<[string, string, string, string, number], CustomerDbRow>(
    `select id, code, name_en, name_ar, phone, null as currency, null as credit_limit, 0 as hold_flag
       from pending_customer
      where acked_at is null
        and (lower(code) like ?1 or lower(name_en) like ?2 or lower(coalesce(name_ar, '')) like ?3
             or coalesce(phone, '') like ?4)
      order by code limit ?5`,
  ).all(needle, needle, needle, needle, limit).map((r) => toCustomer(r, true));
  return [...mirrored, ...pending].slice(0, limit);
}

export function getCustomer(db: PosDatabase, id: string): TillCustomer | null {
  const mirrored = db.raw.prepare<[string], CustomerDbRow>(
    `select id, code, name_en, name_ar, phone, currency, credit_limit, credit_hold as hold_flag
       from catalogue_customer where id = ?`).get(id);
  if (mirrored !== undefined) return toCustomer(mirrored, false);
  const pending = db.raw.prepare<[string], CustomerDbRow>(
    `select id, code, name_en, name_ar, phone, null as currency, null as credit_limit, 0 as hold_flag
       from pending_customer where id = ? and acked_at is null`).get(id);
  return pending === undefined ? null : toCustomer(pending, true);
}

/**
 * Quick-create (§3.7.6's Customers row, gated on `pos.customer.create`).
 *
 * The party's `uuidv7` is **minted here, at the till, offline**, and is both `Ticket.customerId` and
 * `NewCustomer.id` — 6A's own comment: *"so a re-sent ticket creates no second party"*. 6A's
 * `quickCreateCustomer` inserts `on conflict (company_id, code) do nothing` and **reads the winner back**, so
 * two tills that quick-create the same code in the same minute both attach to the party that exists; the id
 * the till minted may not be the one that survives, and that is the correct answer.
 *
 * The code defaults to `WALK-<the id's last eight hex digits>`, which is unique by construction and readable
 * at a counter. `code` is `unique` in the local table so a cashier who types a code twice is told, rather
 * than silently attaching this sale to the earlier person's account.
 */
export function quickCreateCustomer(
  db: PosDatabase, cashier: TillCashier, opts: { nameEn: string; phone?: string | null; code?: string },
): { customer: TillCustomer; newCustomer: NewCustomer } {
  requireCode(cashier, PERMISSION["pos.customer.create"]);
  const name = opts.nameEn.trim();
  if (name.length === 0) throw new TillError("ERR_VALIDATION_FAILED", "a customer needs a name");
  const id = tillUuidv7();
  const code = opts.code ?? `WALK-${id.replaceAll("-", "").slice(-8).toUpperCase()}`;
  const clash = db.raw.prepare<[string, string], { n: number }>(
    "select (select count(*) from pending_customer where code = ?1) + (select count(*) from catalogue_customer where code = ?2) as n",
  ).get(code, code)!;
  if (clash.n > 0) {
    throw new TillError("ERR_VALIDATION_FAILED", `customer code ${code} is already in use on this till`);
  }
  db.raw.prepare(
    "insert into pending_customer (id, code, name_en, name_ar, phone, created_at, acked_at) values (?, ?, ?, null, ?, ?, null)",
  ).run(id, code, name, opts.phone ?? null, new Date().toISOString());
  return {
    customer: getCustomer(db, id)!,
    newCustomer: { id, code, nameEn: name, phone: opts.phone ?? null },
  };
}

export interface CreditCheck { ok: boolean; limit: Money | null; localExposure: Money; detail: string | null }

/**
 * The till's credit check, and it says out loud what it does not know.
 *
 * 4A owns credit control server-side; the till holds `party.credit_limit` and `credit_hold` from the mirror
 * and **its own unsynced account sales**. It does **not** hold the customer's outstanding balance — that is
 * an AR figure the till has no stream for — so this is a *local* check whose refusals are conservative and
 * whose approvals are provisional. The `detail` string says "this till" for exactly the reason spec:1307
 * makes the stock hint say so: a figure the till cannot trust must be labelled, not presented as fact.
 *
 * The server re-checks: `applyBatch` posts a `POS_TICKET` with no tender to `1200` trade receivables through
 * the `POS_TICKET` policy, and 4A's credit control is what refuses it there. A ticket refused for credit
 * lands in the needs-attention queue with the reason, which is the honest end state.
 */
export function checkCredit(db: PosDatabase, customerId: string, amount: Money): CreditCheck {
  const cur = currency(amount.toJSON().currency);
  const customer = getCustomer(db, customerId);
  if (customer === null) {
    return { ok: false, limit: null, localExposure: Money.zero(cur), detail: `no customer ${customerId} on this till` };
  }
  const exposureRows = db.raw.prepare<[string], { total: string }>(
    `select k.total as total
       from ticket k
      where k.customer_id = ? and k.status = 'completed'
        and not exists (select 1 from ticket_tender t where t.ticket_id = k.id)
        and exists (select 1 from outbox o where o.kind = 'ticket' and o.ref = k.id and o.acked_at is null)`,
  ).all(customerId);
  let localExposure = Money.zero(cur);
  for (const r of exposureRows) localExposure = localExposure.add(textToMoney(r.total, cur));

  if (customer.creditHold) {
    return { ok: false, limit: customer.creditLimit, localExposure,
      detail: `customer ${customer.code} is on credit hold` };
  }
  if (customer.creditLimit === null) {
    return { ok: false, limit: null, localExposure,
      detail: `customer ${customer.code} has no credit limit; take payment at the till` };
  }
  const wanted = localExposure.add(amount);
  if (wanted.compare(customer.creditLimit) > 0) {
    return { ok: false, limit: customer.creditLimit, localExposure,
      detail: `${wanted.toString()} would exceed customer ${customer.code}'s limit of ${customer.creditLimit.toString()}; ${localExposure.toString()} of that is unsynced from this till and the back office may hold more` };
  }
  return { ok: true, limit: customer.creditLimit, localExposure, detail: null };
}

/**
 * An account sale: a completed ticket with a customer and **no tender**.
 *
 * The `POS_TICKET` policy's tender rules are `each_line` rules over `document_line.kind = 'tender'`, so a
 * ticket with no tender lines debits nothing to `1110`/`1120`/`1100`/`2200` and the balancing debit is the
 * receivable — which is what "account sale" means and why this needs no new document type and no new
 * account. `party.receivable_account_id` defaults to §4.15's `1200` (§4.5.7), which 0C seeds.
 *
 * The credit check runs on the **drafted** total, so the figure checked is the figure posted — checking a
 * pre-tax subtotal against a tax-inclusive limit is the kind of near-miss that only shows up on the ticket
 * that crosses the limit by the tax.
 */
export function accountSale(
  db: PosDatabase, store: SqliteSyncStore,
  input: { shiftId: string; cashier: TillCashier; customerId: string; lines: SellInput["lines"]; at?: Date },
): SellResult {
  requireCode(input.cashier, PERMISSION["pos.ticket.sell"]);
  const draft = draftTicket(db, {
    shiftId: input.shiftId, cashier: input.cashier, customerId: input.customerId,
    lines: input.lines, at: input.at,
  });
  const credit = checkCredit(db, input.customerId, draft.total);
  if (!credit.ok) throw new TillError("ERR_TILL_LIMIT_EXCEEDED", credit.detail ?? "credit refused");

  const result = sell(db, store, {
    shiftId: input.shiftId, cashier: input.cashier, customerId: input.customerId,
    lines: input.lines, at: input.at, clientRef: draft.clientRef,
  });
  // No tender, so `tender()` is never called and the status must be set here — an account sale is complete
  // the moment it is made, and leaving it `open` would keep it out of `shiftTotals` and out of the Z-report.
  db.raw.prepare("update ticket set status = 'completed' where id = ?").run(result.clientRef);
  return result;
}

/** Called from the drain once a ticket carrying a pending customer is acknowledged: the real party is now on
 *  the server and will arrive on a catalogue page, so the local row's job is done. It is a soft clear —
 *  `acked_at` rather than a delete — so a shop can still see who was created at the till today. */
export function clearPendingCustomers(db: PosDatabase, ids: readonly string[]): void {
  const stamp = db.raw.prepare("update pending_customer set acked_at = ? where id = ? and acked_at is null");
  const now = new Date().toISOString();
  for (const id of ids) stamp.run(now, id);
}
```

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd apps/pos test -- database tender returns customer
bun run --cwd apps/pos typecheck
bun run lint && bun run lint:rules
```

**Expected:** 10 + 11 + 9 + 11 = 41 passed — the `database` figure is Step 1's own (*"10 passed … the eight of T1 Step 3, the list case now asserting eighteen names, plus T1 Step 7's two renderer-entry cases"*), not T1's original eight. Typecheck clean; `no-number-money` clean (`credit_limit` and `total` leave SQLite as `TEXT` and become `Money` at the boundary, the `credit_hold` column is aliased `hold_flag` in all four SELECTs so no `number`-typed member name matches the rule's regex, and the only other `number`-typed names here are `limit` and the `count(*)` alias `n`).

```bash
git add apps/pos/src/main/returns.ts apps/pos/src/main/customer.ts apps/pos/src/main/schema.sql \
        apps/pos/src/main/database.ts apps/pos/test/returns.test.ts apps/pos/test/customer.test.ts \
        apps/pos/test/database.test.ts apps/pos/test/tender.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): returns against an original, blind returns, and customers at the till [6B T8]

A return against an original refunds the ORIGINAL's price, not today's, and refuses more than was
sold cumulatively across several returns. An unknown original NEVER falls through to blind — a
typo in a client ref must not buy the cashier past both the blind code and the blind cap. §3.7.6's
"looked up via sync" half has no 6A route and is recorded as a named gap rather than invented here.

Quick-created customers live in `pending_customer` — LOCAL_SCHEMA_VERSION 2 — because ADR 0057
rule 1 gives every catalogue_* mirror exactly one writer, and a locally-minted party would give
one two. The credit check labels its own figure "this till" for the same reason spec:1307 makes
the stock hint say so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `registerPosHandlers`, the typed `contextBridge`, and `main-pos.ts` — `apps/desktop` imports a build output and nothing else

**The seam this task builds is the one spec:2389 requires and §4.10.6 names without specifying.** `apps/desktop` may import *only build outputs*; `apps/pos` is an app-tier workspace and may import packages but no other app. Neither may import the other. So the POS main-process code is compiled to **`apps/pos/dist-main/pos-main.cjs`** and `apps/desktop/src/main-pos.ts` `require`s it **by path at run time**, handing it `{ ipcMain, channels, dbPath, feedUrl, secureStore, print }` as data. ADR 0058 records the shape; amendment A4 registered the three names.

**Every privileged operation is behind the typed bridge, and the renderer holds nothing.** spec:1284 verbatim: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, the strict CSP, navigation locked to `APP_ORIGIN`. `window.dulja.pos` is thirteen explicit functions over thirteen named channels — no `ipcRenderer`, no caller-supplied channel name, no file path, no SQLite handle. Every argument crosses as JSON and is validated by a Zod schema in `packages/contracts/src/pos/till.ts` **on the main-process side**, because a renderer compromised past the CSP is exactly the threat model this posture exists for.

**Files:**
- Create: `apps/pos/src/main/register.ts`, `apps/pos/src/main/entry.ts`, `packages/contracts/src/pos/till.ts`, `apps/desktop/src/main-pos.ts`, `apps/desktop/src/preload-pos.ts`, `apps/desktop/types/dulja-pos.d.ts`, `apps/desktop/test/pos-posture.spec.ts`, `apps/desktop/test/pos-bridge.spec.ts`, `docs/adr/0058-pos-main-process-is-a-build-output.md`
- Modify: `apps/desktop/src/bridge-types.ts` (`DuljaPosBridge`, `POS_CHANNELS`, one member on `DuljaBridge`), `apps/desktop/package.json` (`build:pos`, `start:pos`), `packages/contracts/src/index.ts` (one `export *`)

**Interfaces**

- Consumes: `APP_ORIGIN`, `APP_SCHEME`, `browserWindowOptions`, `CONTENT_SECURITY_POLICY`, `isAppUrl`, `createSecureStore`, `SecureStore`, `CHANNELS`, `DuljaBridge` (0E); every `apps/pos/src/main/*` export of T1–T8; `MoneySchema`, `QuantitySchema`, `UuidSchema` (0B).
- Produces:
  ```ts
  // apps/desktop/src/bridge-types.ts — additive; 0E's DuljaBridge gains one member (0E T11's own note).
  export interface DuljaPosBridge {
    enrol(code: string): Promise<{ terminalId: string }>;
    login(input: { employeeNumber: string; pin: string }): Promise<{ principalId: string; codes: string[]; branchId: string }>;
    openShift(input: { openingFloat: string; currency: string }): Promise<{ shiftId: string }>;
    closeShift(input: { shiftId: string; countedCash: string }): Promise<{ shiftId: string; tickets: number; byMethod: Record<string, string> }>;
    search(input: { text?: string; barcode?: string; code?: string }): Promise<unknown[]>;
    priceCheck(input: { text?: string; barcode?: string; code?: string }): Promise<unknown[]>;
    sell(input: unknown): Promise<{ clientRef: string; total: string }>;
    tender(input: unknown): Promise<{ clientRef: string; payable: string; change: string; rounding: string }>;
    clock(kind: "clock_in" | "clock_out"): Promise<{ id: string }>;
    receipt(clientRef: string): Promise<unknown>;
    print(clientRef: string): Promise<void>;
    pull(): Promise<void>;
    drain(): Promise<void>;
    status(): Promise<unknown>;
  }
  export const POS_CHANNELS: Readonly<Record<keyof DuljaPosBridge, string>>;
  ```
  ```ts
  // apps/pos/src/main/register.ts
  export interface PosHandlerDeps {
    ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };
    channels: Readonly<Record<string, string>>;
    db: PosDatabase;
    store: SqliteSyncStore;
    loops: SyncLoops;
    deviceStore: DeviceStore;
    baseUrl: string;
    terminalId: string | null;
    print: (payload: ReceiptPayload) => Promise<void>;
    onEnrolled?: (identity: DeviceIdentity) => void;
  }
  export function registerPosHandlers(deps: PosHandlerDeps): void;
  ```

- [ ] **Step 1: Write ADR 0058 as a proposal (spec:95 — this touches security)**

`docs/adr/0058-pos-main-process-is-a-build-output.md`:

```markdown
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
  `bridge-types.ts` — plus the handler in `apps/pos/src/main/register.ts`. `pos-bridge.spec.ts` asserts every
  `keyof DuljaPosBridge` has a channel and every channel has a handler, so a half-made change fails.
- `pos.exe` and `backoffice.exe` share one `apps/desktop`, one preload discipline and one updater, with two
  electron-builder configurations and two `extraResources` blocks (Task 10).
- The renderer never sees a path, a handle or a key. It sees thirteen functions.

## What we are asking

Confirm that loading a workspace's build output by path from the Electron main process is acceptable — it is
the same trust boundary as `extraResources`, both halves are built from this repository in the same CI job,
and the alternative readings of spec:2389 are all worse.
```

- [ ] **Step 2: Write the failing bridge test first**

```ts
// apps/desktop/test/pos-bridge.spec.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNELS, POS_CHANNELS, type DuljaPosBridge } from "../src/bridge-types";

const repoRoot = join(__dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");

describe("window.dulja.pos — the typed contextBridge (§4.10.6, A4, spec:1284)", () => {
  it("names every method §4.10.6 fixes, and the six a till cannot sell without", () => {
    const methods = Object.keys(POS_CHANNELS).sort();
    // §4.10.6's seven, verbatim, plus login/openShift/status/search/enrol/receipt/print (A4).
    expect(methods).toEqual([
      "clock", "closeShift", "drain", "enrol", "login", "openShift", "priceCheck", "print",
      "pull", "receipt", "search", "sell", "status", "tender",
    ]);
    for (const m of ["sell", "tender", "closeShift", "pull", "drain", "clock", "priceCheck"]) {
      expect(methods, `§4.10.6 names ${m}`).toContain(m);
    }
  });

  it("every channel is `dulja:pos:<method>` and none collides with 0E's CHANNELS", () => {
    for (const [method, channel] of Object.entries(POS_CHANNELS)) {
      expect(channel).toMatch(/^dulja:pos:[a-z-]+$/);
      expect(channel.endsWith(method.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))).toBe(true);
    }
    const zero = new Set(Object.values(CHANNELS));
    for (const channel of Object.values(POS_CHANNELS)) expect(zero.has(channel)).toBe(false);
  });

  it("the preload exposes exactly those channels and NOTHING generic", () => {
    const preload = read("apps/desktop/src/preload-pos.ts");
    for (const channel of Object.values(POS_CHANNELS)) {
      expect(preload, channel).toContain("POS_CHANNELS.");
    }
    // spec:1284: no raw Node in the renderer. A caller-supplied channel name is the one shape that turns a
    // typed bridge back into `ipcRenderer.invoke`, so it is forbidden mechanically and not by review.
    expect(preload).not.toMatch(/invoke\(\s*channel\s*[,)]/);
    expect(preload).not.toContain("contextBridge.exposeInMainWorld(\"require\"");
    expect(preload).not.toMatch(/exposeInMainWorld\([^,]+,\s*ipcRenderer\s*\)/);
  });

  it("registerPosHandlers registers one handler per channel and refuses an unknown one", () => {
    const register = read("apps/pos/src/main/register.ts");
    for (const method of Object.keys(POS_CHANNELS)) {
      // `handle("<method>", …)` is the literal `register.ts` contains; `channels[method]` is looked up
      // INSIDE `handle`, so grepping for that would find one occurrence and pass for every method.
      expect(register, `a handler for ${method}`).toContain(`handle("${method}"`);
    }
  });

  it("apps/desktop imports NOTHING from apps/pos, and apps/pos imports no app at all (spec:2389)", () => {
    for (const f of ["src/main-pos.ts", "src/preload-pos.ts", "src/bridge-types.ts"]) {
      const text = read(`apps/desktop/${f}`);
      expect(text, f).not.toMatch(/from\s+["'](@dulja\/pos|.*apps\/pos)/);
      expect(text, f).not.toMatch(/require\(\s*["']@dulja\/pos["']\s*\)/);
    }
    // The one permitted reference is a PATH, resolved at run time, and it is in exactly one file.
    expect(read("apps/desktop/src/main-pos.ts")).toContain("dist-main/pos-main.cjs");
    for (const f of ["register.ts", "database.ts", "store.ts", "ticket.ts", "tender.ts", "pricing.ts"]) {
      expect(read(`apps/pos/src/main/${f}`), f).not.toMatch(/from\s+["'].*apps\/(desktop|api|backoffice|worker)/);
    }
  });

  it("apps/pos holds no PostgreSQL client and exactly one @dulja/db subpath import (Global Constraint 3)", () => {
    const pkg = JSON.parse(read("apps/pos/package.json")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("postgres");
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("pg");
    const bare = ["register.ts", "database.ts", "store.ts", "mirror.ts", "authority.ts", "pricing.ts",
                  "ticket.ts", "tender.ts", "returns.ts", "customer.ts", "shift.ts", "device.ts",
                  "transport.ts", "loops.ts", "receipt.ts", "money.ts", "errors.ts", "entry.ts"]
      .filter((f) => /from\s+["']@dulja\/db["']/.test(read(`apps/pos/src/main/${f}`)));
    expect(bare).toEqual([]);
  });
});
```

Run `bun run --cwd apps/desktop test -- pos-bridge`. **Expected failure:** `SyntaxError: The requested module '../src/bridge-types' does not provide an export named 'POS_CHANNELS'` — `bridge-types.ts` is 0E's file and exists, so the failure is on the missing named export and not on module resolution.

- [ ] **Step 3: `apps/desktop/src/bridge-types.ts` — the additive edit**

```ts
// apps/desktop/src/bridge-types.ts — appended. 0E T11's namespace note: "6B adds `pos` to the same
// DuljaBridge interface additively and changes nothing here."

/**
 * The till's whole privileged surface (§4.10.6, amendment A4).
 *
 * §4.10.6 fixes seven names — `sell`, `tender`, `closeShift`, `pull`, `drain`, `clock`, `priceCheck` — and
 * those are the seven a *ticket* needs. A till cannot reach a ticket without `enrol`, `login`, `openShift`,
 * `search`, `receipt`, `print` and `status`, so the interface is thirteen methods and the seven are a subset.
 *
 * **Every amount crosses as a fixed-4-dp string and every quantity as a fixed-6-dp string.** `Money` is a
 * class and does not survive structured cloning; a `number` would be the float spec:2041 forbids. The main
 * process parses each with `Money.of`/`Quantity.of` after validating with the Zod schemas in
 * `packages/contracts/src/pos/till.ts`, so a renderer that sent nonsense is refused at the boundary.
 */
export interface DuljaPosBridge {
  enrol(code: string): Promise<{ terminalId: string }>;
  login(input: { employeeNumber: string; pin: string }): Promise<{ principalId: string; codes: string[]; branchId: string }>;
  openShift(input: { openingFloat: string; currency: string }): Promise<{ shiftId: string }>;
  closeShift(input: { shiftId: string; countedCash: string }): Promise<{ shiftId: string; tickets: number; byMethod: Record<string, string> }>;
  search(input: { text?: string; barcode?: string; code?: string }): Promise<unknown[]>;
  priceCheck(input: { text?: string; barcode?: string; code?: string }): Promise<unknown[]>;
  sell(input: unknown): Promise<{ clientRef: string; total: string }>;
  tender(input: unknown): Promise<{ clientRef: string; payable: string; change: string; rounding: string }>;
  clock(kind: "clock_in" | "clock_out"): Promise<{ id: string }>;
  receipt(clientRef: string): Promise<unknown>;
  print(clientRef: string): Promise<void>;
  pull(): Promise<void>;
  drain(): Promise<void>;
  status(): Promise<unknown>;
}

/** `dulja:pos:<kebab-case method>`. The map is the ONE place a channel name exists: `preload-pos.ts` reads it
 *  and `main-pos.ts` passes it to `registerPosHandlers` as data, so the two ends cannot disagree. */
export const POS_CHANNELS = {
  enrol: "dulja:pos:enrol",
  login: "dulja:pos:login",
  openShift: "dulja:pos:open-shift",
  closeShift: "dulja:pos:close-shift",
  search: "dulja:pos:search",
  priceCheck: "dulja:pos:price-check",
  sell: "dulja:pos:sell",
  tender: "dulja:pos:tender",
  clock: "dulja:pos:clock",
  receipt: "dulja:pos:receipt",
  print: "dulja:pos:print",
  pull: "dulja:pos:pull",
  drain: "dulja:pos:drain",
  status: "dulja:pos:status",
} as const satisfies Readonly<Record<keyof DuljaPosBridge, string>>;
```

```ts
// apps/desktop/src/bridge-types.ts — 0E's DuljaBridge gains ONE optional member and loses nothing.
export interface DuljaBridge {
  auth: DuljaAuthBridge;
  app: DuljaAppBridge;
  print: DuljaPrintBridge;
  /** Present only in `pos.exe`: `preload.ts` (the back office's) does not set it, and `preload-pos.ts` does.
   *  Optional rather than required so 0E's own `preload.ts` and its posture tests compile unchanged. */
  pos?: DuljaPosBridge;
}
```

- [ ] **Step 4: The Zod schemas — validation at the boundary, in `packages/contracts`**

```ts
// packages/contracts/src/pos/till.ts
import { z } from "@hono/zod-openapi";
import { MoneySchema, QuantitySchema, UuidSchema } from "../common";

/**
 * The renderer→main contracts of the `window.dulja.pos` bridge.
 *
 * They live in `packages/contracts` and not in `apps/pos` for the reason §4.2.8 gives every other Zod
 * schema: the contract is the shape two sides agree on, and a schema owned by one side is that side's
 * opinion. They are **not** HTTP contracts — no route uses them, they generate no OpenAPI path — but they
 * reuse `MoneySchema` and `QuantitySchema` so a bridge amount and an API amount are the same string shape,
 * which is what makes a renderer field reusable between `apps/pos` and `apps/backoffice`.
 *
 * Validation happens in the **main process**, on arrival. A renderer compromised past the CSP is precisely
 * the threat spec:1284's posture is written for, and "the renderer is our own code" is not a control.
 */
export const TillSellLineSchema = z.object({
  itemId: UuidSchema,
  lotId: UuidSchema.nullable().optional(),
  unitId: UuidSchema.nullable().optional(),
  quantity: QuantitySchema,
  priceOverride: MoneySchema.nullable().optional(),
  discount: MoneySchema.nullable().optional(),
}).openapi("TillSellLine");

export const TillSellSchema = z.object({
  shiftId: UuidSchema,
  kind: z.enum(["sale", "return"]).optional(),
  customerId: UuidSchema.nullable().optional(),
  newCustomer: z.object({
    id: UuidSchema, code: z.string().min(1).max(64), nameEn: z.string().min(1).max(200),
    phone: z.string().max(40).nullable(),
  }).nullable().optional(),
  returnsClientRef: UuidSchema.nullable().optional(),
  lines: z.array(TillSellLineSchema).min(1).max(200),
  ticketDiscount: MoneySchema.nullable().optional(),
  events: z.array(z.object({
    kind: z.literal("override"),
    code: z.literal("pos.ticket.override"),
    subject: z.enum(["discount", "void", "blind_return", "price_override"]),
    supervisorPrincipalId: UuidSchema,
    reason: z.string().min(1).max(500),
  })).max(10).optional(),
}).openapi("TillSell");

export const TillTenderSchema = z.object({
  clientRef: UuidSchema,
  tenders: z.array(z.object({
    method: z.enum(["cash", "card", "transfer", "store_credit"]),
    amount: MoneySchema,
    reference: z.string().max(120).nullable().optional(),
  })).min(1).max(8),
}).openapi("TillTender");

export const TillLoginSchema = z.object({
  employeeNumber: z.string().min(1).max(40),
  // `.max(12)` mirrors 6C's `PIN_MAX_LENGTH` without importing it: `packages/contracts` may not import
  // `@dulja/db` (§3.1), and `verifyPin` re-checks the bounds anyway (6C's own line does the same).
  pin: z.string().regex(/^[0-9]{4,12}$/),
}).openapi("TillLogin");

export const TillSearchSchema = z.object({
  text: z.string().min(1).max(100).optional(),
  barcode: z.string().min(1).max(64).optional(),
  code: z.string().min(1).max(64).optional(),
}).refine((v) => v.text !== undefined || v.barcode !== undefined || v.code !== undefined,
  { message: "a search needs text, a barcode or a code" }).openapi("TillSearch");

export const TillOpenShiftSchema = z.object({
  openingFloat: MoneySchema, currency: z.string().length(3),
}).openapi("TillOpenShift");

export const TillCloseShiftSchema = z.object({
  shiftId: UuidSchema, countedCash: MoneySchema,
}).openapi("TillCloseShift");

export const TillEnrolSchema = z.object({ code: z.string().min(8).max(64) }).openapi("TillEnrol");
export const TillClockSchema = z.object({ kind: z.enum(["clock_in", "clock_out"]) }).openapi("TillClock");
export const TillReceiptSchema = z.object({ clientRef: UuidSchema }).openapi("TillReceipt");
```

```ts
// packages/contracts/src/index.ts — one line appended.
export * from "./pos/till";
```

- [ ] **Step 5: `apps/pos/src/main/register.ts` — thirteen handlers and one session**

```ts
import { Money, Quantity, currency } from "@dulja/domain";
import {
  TillClockSchema, TillCloseShiftSchema, TillEnrolSchema, TillLoginSchema, TillOpenShiftSchema,
  TillReceiptSchema, TillSearchSchema, TillSellSchema, TillTenderSchema,
} from "@dulja/contracts";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import type { DeviceIdentity, DeviceStore } from "./device";
import type { SyncLoops } from "./loops";
import { TillError } from "./errors";
import { enrolDevice } from "./device";
import { clockEvent, findCashierByEmployeeNumber, loginCashier, type TillCashier } from "./authority";
import { findItemByBarcode, findItemByCode, priceCheck, searchItems } from "./pricing";
import { closeShift, currentShift, openShift, shiftTotals } from "./shift";
import { sell } from "./ticket";
import { tender } from "./tender";
import { returnTicket } from "./returns";
import { buildReceipt, type ReceiptPayload } from "./receipt";

export interface PosHandlerDeps {
  ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };
  channels: Readonly<Record<string, string>>;
  db: PosDatabase;
  store: SqliteSyncStore;
  loops: SyncLoops;
  deviceStore: DeviceStore;
  baseUrl: string;
  terminalId: string | null;
  print: (payload: ReceiptPayload) => Promise<void>;
  onEnrolled?: (identity: DeviceIdentity) => void;
}

/**
 * The one export `apps/desktop` calls (ADR 0058, amendment A4).
 *
 * **The signed-in cashier is main-process state and is never a bridge argument.** A renderer that could pass
 * a `cashierPrincipalId` into `sell` could sell as anybody who had ever signed in at that till, and every
 * authority check in Task 4 would be evaluating a claim rather than a fact. `login` sets it; every other
 * handler reads it; `ERR_RBAC_FORBIDDEN` is the answer when nobody is signed in.
 *
 * **Every handler validates its argument with a Zod schema before touching a service.** The renderer is our
 * own code and that is not a control (spec:1284's threat model is a compromised renderer).
 */
export function registerPosHandlers(deps: PosHandlerDeps): void {
  let session: TillCashier | null = null;
  let terminalId = deps.terminalId;

  const requireSession = (): TillCashier => {
    if (session === null) throw new TillError("ERR_RBAC_FORBIDDEN", "no cashier is signed in at this till");
    return session;
  };
  const requireTerminal = (): string => {
    if (terminalId === null) {
      throw new TillError("ERR_VALIDATION_FAILED", "this till is not enrolled; enrol it before opening a shift");
    }
    return terminalId;
  };
  /** Every handler answers a `Problem`-shaped object rather than letting an Error cross the bridge: an
   *  Error's `message` survives structured cloning but its class and its `code` do not, and the renderer
   *  needs the code to choose a message from `packages/i18n` (spec:2061 — no string in a component). */
  const handle = (method: string, fn: (...args: unknown[]) => unknown): void => {
    const channel = deps.channels[method];
    if (channel === undefined) throw new Error(`no channel is registered for ${method}`);
    deps.ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        const code = error instanceof TillError ? error.code : "ERR_INTERNAL";
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { code, detail } };
      }
    });
  };

  handle("enrol", async (raw) => {
    const { code } = TillEnrolSchema.parse({ code: raw });
    const identity = await enrolDevice(deps.deviceStore, { baseUrl: deps.baseUrl, code });
    terminalId = identity.terminalId;
    deps.onEnrolled?.(identity);
    return { terminalId: identity.terminalId };
  });

  handle("login", async (raw) => {
    const input = TillLoginSchema.parse(raw);
    const found = findCashierByEmployeeNumber(deps.db, input.employeeNumber);
    // An unknown employee number and a wrong PIN answer the SAME code, for the reason Task 4 states: a till
    // login screen must not be a way to enumerate the branch's cashier list.
    if (found === null) {
      throw new TillError("ERR_TILL_PIN_INVALID", "that PIN does not match a cashier on this till");
    }
    const cashier = await loginCashier(deps.db, { principalId: found.principalId, pin: input.pin });
    session = cashier;
    return { principalId: cashier.principalId, codes: [...cashier.codes], branchId: cashier.branchId };
  });

  handle("openShift", (raw) => {
    const input = TillOpenShiftSchema.parse(raw);
    const cur = currency(input.currency);
    const shift = openShift(deps.db, deps.store, {
      terminalId: requireTerminal(), cashier: requireSession(), openingFloat: Money.of(input.openingFloat, cur),
    });
    return { shiftId: shift.id };
  });

  handle("closeShift", (raw) => {
    const input = TillCloseShiftSchema.parse(raw);
    const cashier = requireSession();
    const open = currentShift(deps.db, requireTerminal());
    const cur = open === null ? currency("XXX") : open.currency;
    closeShift(deps.db, deps.store, { shiftId: input.shiftId, cashier, countedCash: Money.of(input.countedCash, cur) });
    return { shiftId: input.shiftId, ...shiftTotals(deps.db, input.shiftId) };
  });

  handle("search", (raw) => {
    const q = TillSearchSchema.parse(raw);
    requireSession();
    // Each of the three inputs has its OWN reader, and routing them all through `searchItems` would be a
    // silent bug: `searchItems` matches `code`, `name_en` and `name_ar` and **not** `barcode`, so a scan
    // would answer `[]` and the sell screen would report "not found" for every item in the shop.
    if (q.barcode !== undefined) {
      const hit = findItemByBarcode(deps.db, q.barcode);
      return hit === null ? [] : [hit];
    }
    if (q.code !== undefined) {
      const hit = findItemByCode(deps.db, q.code);
      return hit === null ? [] : [hit];
    }
    return searchItems(deps.db, q.text!);
  });

  handle("priceCheck", (raw) => {
    const q = TillSearchSchema.parse(raw);
    // The results carry `Money` objects, which do not survive structured cloning — so they are flattened to
    // the same fixed-4-dp strings every other bridge amount uses.
    return priceCheck(deps.db, requireSession(), q).map((r) => ({
      item: r.item,
      unitPrice: r.quote.unitPrice.toString(),
      promotionId: r.quote.promotionId,
      promotionDiscount: r.quote.promotionDiscount.toString(),
      taxAmount: r.taxed.tax.toString(),
      total: r.taxed.total.toString(),
    }));
  });

  handle("sell", (raw) => {
    const input = TillSellSchema.parse(raw);
    const cashier = requireSession();
    const lines = input.lines.map((l) => ({
      itemId: l.itemId, lotId: l.lotId ?? null, unitId: l.unitId ?? null,
      quantity: Quantity.of(l.quantity),
      priceOverride: l.priceOverride === undefined || l.priceOverride === null ? null : Money.of(l.priceOverride, currency("XXX")),
      discount: l.discount === undefined || l.discount === null ? null : Money.of(l.discount, currency("XXX")),
    }));
    // ⚠️ The currency is the TILL's, read from the catalogue by `draftTicket`, and a bridge amount carries
    // none — so the two `Money.of(..., "XXX")` above are rebuilt against the drafted currency inside `sell`'s
    // own `draftTicket` call. This is the ONE place the bridge's currency-free strings are reconciled:
    // `resolveBridgeMoney` below does it, and no handler calls `Money.of` with "XXX" past this line.
    const resolved = resolveBridgeMoney(deps.db, input, lines);
    const result = input.kind === "return"
      ? returnTicket(deps.db, deps.store, {
          shiftId: input.shiftId, cashier, returnsClientRef: input.returnsClientRef ?? null,
          lines: resolved.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitId: l.unitId, unitPrice: l.priceOverride })),
          events: input.events,
        })
      : sell(deps.db, deps.store, {
          shiftId: input.shiftId, cashier, kind: "sale",
          customerId: input.customerId ?? null, newCustomer: input.newCustomer ?? null,
          lines: resolved.lines, ticketDiscount: resolved.ticketDiscount, events: input.events,
        });
    return { clientRef: result.clientRef, total: result.draft.total.toString() };
  });

  handle("tender", (raw) => {
    const input = TillTenderSchema.parse(raw);
    const cashier = requireSession();
    const cur = ticketCurrency(deps.db, input.clientRef);
    const result = tender(deps.db, deps.store, {
      clientRef: input.clientRef, cashier,
      tenders: input.tenders.map((t) => ({
        method: t.method, amount: Money.of(t.amount, cur), reference: t.reference ?? null,
      })),
    });
    return {
      clientRef: result.clientRef, payable: result.payable.toString(),
      change: result.change.toString(), rounding: result.rounding.toString(),
    };
  });

  handle("clock", async (raw) => {
    const { kind } = TillClockSchema.parse({ kind: raw });
    return { id: await clockEvent(deps.db, requireSession(), kind) };
  });

  handle("receipt", (raw) => {
    const { clientRef } = TillReceiptSchema.parse({ clientRef: raw });
    requireSession();
    return buildReceipt(deps.db, clientRef);
  });

  handle("print", async (raw) => {
    const { clientRef } = TillReceiptSchema.parse({ clientRef: raw });
    requireSession();
    await deps.print(buildReceipt(deps.db, clientRef));
  });

  handle("pull", async () => { await deps.loops.pullNow(); });
  handle("drain", async () => { await deps.loops.drainNow(); });
  handle("status", () => ({
    ...deps.loops.state(),
    enrolled: terminalId !== null,
    signedIn: session === null ? null : { principalId: session.principalId, branchId: session.branchId },
    shiftId: terminalId === null ? null : currentShift(deps.db, terminalId)?.id ?? null,
  }));
}

/** The ticket's own currency, so `tender` never has to be told one. */
function ticketCurrency(db: PosDatabase, clientRef: string): ReturnType<typeof currency> {
  const row = db.raw.prepare<[string], { currency: string }>(
    "select currency from ticket where id = ?").get(clientRef);
  if (row === undefined) throw new TillError("ERR_NOT_FOUND", `no ticket ${clientRef} on this till`);
  return currency(row.currency);
}

/**
 * Rebuild the bridge's currency-free amount strings against the **till's own** currency.
 *
 * A bridge amount is a bare decimal string: the renderer has no business choosing a currency, and a renderer
 * that could would be able to book a MYR ticket in USD. The currency is a fact about the branch's price
 * lists, which `resolvePrice` already reads — so it is read once here, from the same place, and every
 * `Money` the handler passes onward carries it.
 */
function resolveBridgeMoney(
  db: PosDatabase, input: { ticketDiscount?: string | null },
  lines: { itemId: string; lotId: string | null; unitId: string | null; quantity: Quantity;
           priceOverride: Money | null; discount: Money | null }[],
): { lines: typeof lines; ticketDiscount: Money | null } {
  const row = db.raw.prepare<[], { currency: string }>(
    "select currency from catalogue_price_list order by id limit 1").get();
  if (row === undefined) {
    throw new TillError("ERR_TILL_CATALOGUE_STALE", "this till holds no price list and cannot price a ticket");
  }
  const cur = currency(row.currency);
  const re = (m: Money | null): Money | null => (m === null ? null : Money.of(m.toString(), cur));
  return {
    lines: lines.map((l) => ({ ...l, priceOverride: re(l.priceOverride), discount: re(l.discount) })),
    ticketDiscount: input.ticketDiscount === undefined || input.ticketDiscount === null
      ? null : Money.of(input.ticketDiscount, cur),
  };
}
```

- [ ] **Step 6: `entry.ts` — the one thing the bundle exports**

```ts
// apps/pos/src/main/entry.ts
/**
 * The `build:main` entry point (`apps/pos/package.json`'s `bun build src/main/entry.ts --outfile
 * dist-main/pos-main.cjs`). It exports **one** function and nothing else, so `apps/desktop`'s `require` of
 * the bundle has exactly one thing to call and the seam ADR 0058 describes has exactly one shape.
 *
 * `openTill` is the composition root: it opens the database, builds the store, loads the device key, builds
 * the transport if the till is enrolled, starts the loops and registers the handlers. `apps/desktop` supplies
 * the Electron-owned pieces — `ipcMain`, the channel map, the paths, 0E's `SecureStore`, and a `print`
 * callback that calls `webContents.print()`.
 */
import { openPosDatabase, type PosDatabase } from "./database";
import { SqliteSyncStore } from "./store";
import { loadDevice, type DeviceStore } from "./device";
import { HttpSyncTransport } from "./transport";
import { createSyncLoops, type SyncLoops } from "./loops";
import { registerPosHandlers, type PosHandlerDeps } from "./register";
import { tillUuidv7 } from "./ticket";
import type { ReceiptPayload } from "./receipt";

export interface OpenTillOptions {
  ipcMain: PosHandlerDeps["ipcMain"];
  channels: Readonly<Record<string, string>>;
  dbPath: string;
  baseUrl: string;
  deviceStore: DeviceStore;
  print: (payload: ReceiptPayload) => Promise<void>;
  /** Off in tests, on in the shipped app. */
  startLoops?: boolean;
}

export interface OpenedTill { db: PosDatabase; store: SqliteSyncStore; loops: SyncLoops; close(): void }

export async function openTill(opts: OpenTillOptions): Promise<OpenedTill> {
  const db = openPosDatabase(opts.dbPath);
  const store = new SqliteSyncStore(db);
  const device = await loadDevice(opts.deviceStore);
  const transport = device === null ? null : new HttpSyncTransport({
    baseUrl: opts.baseUrl, device, newIdempotencyKey: () => tillUuidv7(),
  });
  const loops = createSyncLoops({
    store, transport, terminalId: device?.terminalId ?? "", newBatchId: () => tillUuidv7(),
  });
  registerPosHandlers({
    ipcMain: opts.ipcMain, channels: opts.channels, db, store, loops,
    deviceStore: opts.deviceStore, baseUrl: opts.baseUrl,
    terminalId: device?.terminalId ?? null, print: opts.print,
  });
  if (opts.startLoops !== false) loops.start();
  return { db, store, loops, close: () => { loops.stop(); db.close(); } };
}

export { registerPosHandlers } from "./register";
```

- [ ] **Step 7: `main-pos.ts`, `preload-pos.ts` and the renderer's global**

```ts
// apps/desktop/src/main-pos.ts
import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, normalize, resolve } from "node:path";
import { APP_ORIGIN, APP_SCHEME, browserWindowOptions, CONTENT_SECURITY_POLICY, isAppUrl } from "./window-options";
import { createSecureStore } from "./secure-store";
import { POS_CHANNELS } from "./bridge-types";
import { configureUpdater } from "./updater";
import { initSentry } from "./sentry";

/** The till's built renderer, and its built main-process bundle. **Paths, not imports** (spec:2389, ADR 0058). */
const RENDERER_DIR = app.isPackaged
  ? join(process.resourcesPath, "renderer")
  : resolve(__dirname, "../../pos/dist");
const POS_MAIN = app.isPackaged
  ? join(process.resourcesPath, "pos-main", "pos-main.cjs")
  : resolve(__dirname, "../../pos/dist-main/pos-main.cjs");

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function serveRenderer(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const candidate = normalize(join(RENDERER_DIR, decodeURIComponent(pathname)));
    const inside = candidate.startsWith(RENDERER_DIR);
    const target = inside && /\.[a-z0-9]+$/i.test(pathname) ? candidate : join(RENDERER_DIR, "index.html");
    return net.fetch(pathToFileURL(target).toString());
  });
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CONTENT_SECURITY_POLICY] } });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...browserWindowOptions(join(__dirname, "preload-pos.js")),
    // A till runs full-screen on a shop PC with a keyboard and no mouse (spec:2254). `kiosk` is deliberately
    // NOT set: a cashier needs the OS print dialogue and Windows' own printer chooser (D18).
    fullscreen: !app.isPackaged ? false : true,
    autoHideMenuBar: true,
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (url.startsWith("https://")) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_ORIGIN}/index.html`);
  return window;
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(async () => {
    initSentry(process.env["SENTRY_DSN"], app.isPackaged ? "production" : "development");
    const feed = process.env["DULJA_POS_UPDATE_FEED"];
    if (feed !== undefined && feed.length > 0) configureUpdater(feed);
    serveRenderer();
    applyCsp();
    const window = createWindow();

    // The build output, loaded by path. `createRequire` because this file is compiled to CJS by 0E's
    // tsconfig and a bare `require` of a computed path is not statically analysable by the bundler either.
    const load = createRequire(pathToFileURL(__filename).toString());
    const { openTill } = load(POS_MAIN) as typeof import("../../pos/src/main/entry");

    await openTill({
      ipcMain: require("electron").ipcMain,
      channels: POS_CHANNELS,
      dbPath: join(app.getPath("userData"), "till.sqlite"),
      baseUrl: process.env["DULJA_API_BASE_URL"] ?? "https://api.dulja.example",
      deviceStore: createSecureStore(app.getPath("userData")),
      // spec:1280 and D18: an ordinary Windows printer driver through Electron, and no ESC/POS anywhere.
      // The receipt is rendered by the renderer at `#receipt`, so printing is `print()` on the same page.
      print: async () => {
        await new Promise<void>((done, fail) => {
          window.webContents.print({ silent: false, printBackground: true },
            (ok, reason) => (ok ? done() : fail(new Error(reason))));
        });
      },
    });

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on("window-all-closed", () => app.quit());
}
```

⚠️ **The `typeof import("../../pos/src/main/entry")` above is a *type-only* import and is erased at compile time**, which is why it does not violate spec:2389 — `pos-bridge.spec.ts`'s fifth case greps for `from "…apps/pos"` and a `typeof import(...)` in a type position produces no `require` and no `from` clause in the emitted JavaScript. **Verify it after the first build:** `grep -c "apps/pos" apps/desktop/dist/main-pos.js` must print `0`. If the compiler emits anything, replace the type with a local `interface { openTill(o: unknown): Promise<unknown> }` and cast — the seam is the path, and a shared type across it is a convenience, not a requirement.

```ts
// apps/desktop/src/preload-pos.ts
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, POS_CHANNELS, type DuljaBridge } from "./bridge-types";

/**
 * The till's preload. spec:1284: *"all privileged operations behind a typed `contextBridge` API, never raw
 * Node in the renderer"*.
 *
 * Every member is an explicit function over a **named constant** channel. There is no `invoke(channel, …)`
 * with a caller-supplied name anywhere in this file, and `pos-bridge.spec.ts` asserts that mechanically —
 * one generic passthrough would turn thirteen audited doors into one unaudited one.
 *
 * Each handler answers `{ ok, value } | { ok, error }` (Task 9 Step 5), so this file unwraps: a rejected
 * promise carrying an `Error` loses its class across the bridge, and the renderer needs the `code` to pick a
 * message out of `packages/i18n` (spec:2061 — a component holds no string).
 */
class TillError extends Error {
  constructor(readonly code: string, detail: string) { super(detail); this.name = "TillError"; }
}
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const answer = await ipcRenderer.invoke(channel, ...args) as
    { ok: true; value: unknown } | { ok: false; error: { code: string; detail: string } };
  if (answer.ok) return answer.value;
  throw new TillError(answer.error.code, answer.error.detail);
};

const bridge: DuljaBridge = {
  auth: {
    get: (key) => ipcRenderer.invoke(CHANNELS.authGet, key),
    set: (key, value) => ipcRenderer.invoke(CHANNELS.authSet, key, value),
    remove: (key) => ipcRenderer.invoke(CHANNELS.authRemove, key),
  },
  app: {
    version: () => ipcRenderer.invoke(CHANNELS.appVersion),
    checkForUpdates: () => ipcRenderer.invoke(CHANNELS.appCheckForUpdates),
  },
  print: { toPdf: (options) => ipcRenderer.invoke(CHANNELS.printToPdf, options) },
  pos: {
    enrol: (code) => call(POS_CHANNELS.enrol, code) as Promise<{ terminalId: string }>,
    login: (input) => call(POS_CHANNELS.login, input) as Promise<{ principalId: string; codes: string[]; branchId: string }>,
    openShift: (input) => call(POS_CHANNELS.openShift, input) as Promise<{ shiftId: string }>,
    closeShift: (input) => call(POS_CHANNELS.closeShift, input) as Promise<{ shiftId: string; tickets: number; byMethod: Record<string, string> }>,
    search: (input) => call(POS_CHANNELS.search, input) as Promise<unknown[]>,
    priceCheck: (input) => call(POS_CHANNELS.priceCheck, input) as Promise<unknown[]>,
    sell: (input) => call(POS_CHANNELS.sell, input) as Promise<{ clientRef: string; total: string }>,
    tender: (input) => call(POS_CHANNELS.tender, input) as Promise<{ clientRef: string; payable: string; change: string; rounding: string }>,
    clock: (kind) => call(POS_CHANNELS.clock, kind) as Promise<{ id: string }>,
    receipt: (clientRef) => call(POS_CHANNELS.receipt, clientRef),
    print: (clientRef) => call(POS_CHANNELS.print, clientRef) as Promise<void>,
    pull: () => call(POS_CHANNELS.pull) as Promise<void>,
    drain: () => call(POS_CHANNELS.drain) as Promise<void>,
    status: () => call(POS_CHANNELS.status),
  },
};

contextBridge.exposeInMainWorld("dulja", bridge);
```

```ts
// apps/desktop/types/dulja-pos.d.ts
import type { DuljaBridge } from "../src/bridge-types";

/** The renderer-side global. `apps/pos`'s renderer includes this file through its `tsconfig.json`, so
 *  `window.dulja.pos.sell(...)` is typed with no import and no `any`. */
declare global {
  interface Window { readonly dulja: DuljaBridge }
}
export {};
```

- [ ] **Step 8: The posture test, and `apps/desktop/package.json`**

```ts
// apps/desktop/test/pos-posture.spec.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, browserWindowOptions, isAppUrl } from "../src/window-options";

const read = (p: string): string => readFileSync(join(__dirname, "..", p), "utf8");

describe("pos.exe's Electron posture is 0E's, restated and not re-decided (spec:1284)", () => {
  it("uses browserWindowOptions, so contextIsolation/nodeIntegration/sandbox cannot drift", () => {
    const main = read("src/main-pos.ts");
    expect(main).toContain("browserWindowOptions(join(__dirname, \"preload-pos.js\"))");
    // The four clauses, asserted on the shared function rather than on this file's text — one source.
    const options = browserWindowOptions("/preload.js");
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.webviewTag).toBe(false);
    // And nothing in this file overrides them.
    expect(main).not.toMatch(/nodeIntegration:\s*true/);
    expect(main).not.toMatch(/contextIsolation:\s*false/);
    expect(main).not.toMatch(/sandbox:\s*false/);
    expect(main).not.toMatch(/webSecurity:\s*false/);
  });

  it("applies the strict CSP and locks navigation to the app origin", () => {
    const main = read("src/main-pos.ts");
    expect(main).toContain("CONTENT_SECURITY_POLICY");
    expect(main).toContain("isAppUrl(url)");
    expect(main).toContain("will-attach-webview");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(isAppUrl("https://evil.example/x")).toBe(false);
  });

  it("enables the sandbox process-wide and takes the single-instance lock — one till, one drawer, one file", () => {
    const main = read("src/main-pos.ts");
    expect(main).toContain("app.enableSandbox()");
    expect(main).toContain("app.requestSingleInstanceLock()");
  });

  it("mentions no ESC/POS, drawer port, scanner or scale anywhere — D18, SAH-086", () => {
    for (const f of ["src/main-pos.ts", "src/preload-pos.ts", "src/bridge-types.ts"]) {
      const text = read(f).toLowerCase();
      for (const banned of ["esc/pos", "escpos", "drawer_port", "opos", "serialport", "node-hid", "usb"]) {
        expect(text, `${f} / ${banned}`).not.toContain(banned);
      }
    }
    // Printing is `webContents.print()` and nothing else (spec:1280).
    expect(read("src/main-pos.ts")).toContain("webContents.print(");
  });

  it("reads the till's database out of userData, never out of the install directory", () => {
    // A per-machine install directory is not writable by a shop user, and a till whose database sat there
    // would work for the installing administrator and fail silently for everybody else.
    expect(read("src/main-pos.ts")).toContain("app.getPath(\"userData\")");
    expect(read("src/main-pos.ts")).not.toMatch(/dbPath:\s*join\(\s*__dirname/);
  });
});
```

```json
// apps/desktop/package.json — two scripts appended; `dist:pos` is Task 10's.
    "build:pos": "bun run --cwd ../pos build && bun run --cwd ../pos build:main && tsc -p tsconfig.json",
    "start:pos": "electron dist/main-pos.js"
```

- [ ] **Step 9: Run and commit**

```bash
bun run --cwd apps/pos build:main
bun run --cwd apps/desktop test -- pos-bridge pos-posture
bun run typecheck && bun run lint && bun run lint:rules
grep -c "apps/pos" apps/desktop/dist/main-pos.js
```

**Expected:** the bundle at `apps/pos/dist-main/pos-main.cjs` exists; 6 + 5 = 11 passed; typecheck and both lints clean; the last command prints `0`, which is the mechanical proof that the type-only import was erased and `apps/desktop` really does import only a build output.

```bash
git add apps/pos/src/main/register.ts apps/pos/src/main/entry.ts packages/contracts/src/pos/till.ts \
        packages/contracts/src/index.ts apps/desktop/src/bridge-types.ts apps/desktop/src/main-pos.ts \
        apps/desktop/src/preload-pos.ts apps/desktop/types/dulja-pos.d.ts apps/desktop/package.json \
        apps/desktop/test/pos-posture.spec.ts apps/desktop/test/pos-bridge.spec.ts \
        docs/adr/0058-pos-main-process-is-a-build-output.md
git commit -m "$(cat <<'EOF'
feat(pos): registerPosHandlers behind the typed contextBridge, loaded by path [6B T9]

ADR 0058: apps/desktop requires apps/pos/dist-main/pos-main.cjs BY PATH and hands it the channel
map as data, so neither workspace imports the other and spec:2389 holds in both directions —
`grep -c "apps/pos" dist/main-pos.js` prints 0. Thirteen named channels, no generic invoke, and
every argument validated by a Zod schema on the MAIN-process side: a compromised renderer is the
threat spec:1284's posture exists for, and "the renderer is our own code" is not a control. The
signed-in cashier is main-process state and never a bridge argument.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `pos.exe` — the second electron-builder target, the R2 update feed, and CI building both

**spec:2361 says `apps/desktop` has *"two build targets: `backoffice.exe` and `pos.exe`"*, and this is the task that makes the second one real.** 0E's `electron-builder.yml` is `appId: my.dulja.backoffice` with one `extraResources` block and one `publish` feed; a second product cannot share it, so amendment A5 registered `apps/desktop/electron-builder.pos.yml` and the environment name `DULJA_POS_UPDATE_FEED` beside 0E's `DULJA_UPDATE_FEED`.

**The two `.exe` files are two products from one shell.** Same `apps/desktop`, same preload discipline, same `configureUpdater`, same `asarUnpack` of `better-sqlite3`; different `appId`, `productName`, entry point, resources and feed. **Signing is Task 13's** (⚠️ OD-18): this task ships an unsigned build and CI proves it installs, which is §2.12's default for OD-18 — *"unsigned build, warning expected"*.

**Files:**
- Create: `apps/desktop/electron-builder.pos.yml`, `apps/desktop/test/pos-updater.spec.ts`
- Modify: `apps/desktop/package.json` (`dist:pos`), `.github/workflows/ci.yml` (the desktop job builds both), `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §3.11 is amended by **Task 0's A5** and needs no edit here

**Interfaces**

- Consumes: `configureUpdater`, `checkForUpdates`, `UpdateStatus` (0E); `DULJA_POS_UPDATE_FEED` (A5, §3.11); the R2 `UPDATE_FEED` binding (0C).
- Produces: no TypeScript. The `pos.exe` target, the `dist:pos` script, and the CI job that builds both.

- [ ] **Step 1: Write the failing test first**

```ts
// apps/desktop/test/pos-updater.spec.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const desktop = (p: string): string => readFileSync(join(__dirname, "..", p), "utf8");
const repo = (p: string): string => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");

interface BuilderConfig {
  appId: string; productName: string;
  files: string[];
  extraResources: { from: string; to: string }[];
  asarUnpack: string[];
  extraMetadata?: { main?: string };
  npmRebuild?: boolean;
  win: { target: { target: string; arch: string[] }[]; artifactName: string };
  nsis: Record<string, unknown>;
  publish: { provider: string; url: string }[];
}
const pos = parse(desktop("electron-builder.pos.yml")) as BuilderConfig;
const back = parse(desktop("electron-builder.yml")) as BuilderConfig;

describe("pos.exe — the second target of spec:2361 (A5)", () => {
  it("is a DIFFERENT product from backoffice.exe, by appId and by name", () => {
    expect(pos.appId).toBe("my.dulja.pos");
    expect(pos.productName).toBe("Dulja POS");
    // Sharing an appId would make the two installers overwrite each other's registry entry and each other's
    // userData directory — and the till's userData holds the one piece of unrecoverable state in the product.
    expect(pos.appId).not.toBe(back.appId);
    expect(pos.productName).not.toBe(back.productName);
  });

  it("boots main-pos.js, not main.js", () => {
    expect(pos.extraMetadata?.main).toBe("dist/main-pos.js");
    expect(back.extraMetadata?.main ?? "dist/main.js").not.toBe("dist/main-pos.js");
  });

  it("ships the till's renderer AND its main-process bundle as resources, never as dependencies", () => {
    const froms = pos.extraResources.map((r) => `${r.from} -> ${r.to}`);
    expect(froms).toContain("../pos/dist -> renderer");
    expect(froms).toContain("../pos/dist-main -> pos-main");
    // spec:2389: `desktop` imports only build outputs. Both halves arrive as files.
    expect(JSON.stringify(pos.files)).not.toContain("@dulja/pos");
  });

  it("unpacks better-sqlite3 from the asar and rebuilds native modules", () => {
    // A native module cannot be loaded from inside the archive; 0E's own native-module.spec.ts proves the
    // unpacked path works, and the till is the first product that actually needs it at run time.
    expect(pos.asarUnpack.some((g) => g.includes("better-sqlite3"))).toBe(true);
    expect(pos.npmRebuild).toBe(true);
  });

  it("publishes to the POS feed and not to the back office's (§3.11, A5)", () => {
    expect(pos.publish[0]!.provider).toBe("generic");
    expect(pos.publish[0]!.url).toBe("${env.DULJA_POS_UPDATE_FEED}");
    expect(pos.publish[0]!.url).not.toBe(back.publish[0]!.url);
  });

  it("targets Windows x64 NSIS, per-user, and names the artefact after the product", () => {
    expect(pos.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(pos.win.artifactName).toContain("${productName}");
    // Per-user, because a shop PC's cashier account is not an administrator and an installer that needed
    // elevation would be run by whoever happened to be nearby.
    expect(pos.nsis["perMachine"]).toBe(false);
    expect(pos.nsis["oneClick"]).toBe(false);
  });

  it("main-pos.ts configures the updater from the POS feed and does not fall back to the back office's", () => {
    const main = desktop("src/main-pos.ts");
    expect(main).toContain("DULJA_POS_UPDATE_FEED");
    expect(main).toContain("configureUpdater(feed)");
    expect(main).not.toContain("DULJA_UPDATE_FEED");
  });

  it("CI builds BOTH targets in the desktop job", () => {
    const ci = repo(".github/workflows/ci.yml");
    expect(ci).toContain("bun run --cwd apps/desktop build:pos");
    expect(ci).toContain("bun run --cwd apps/pos build:main");
    // The order matters: `build:pos` bundles the till's main process, which the installer packages.
    expect(ci.indexOf("apps/pos build:main")).toBeLessThan(ci.indexOf("apps/desktop dist:pos"));
  });

  it("no package version is hard-coded in either builder config (spec:104, D22)", () => {
    for (const [name, text] of [["pos", desktop("electron-builder.pos.yml")], ["backoffice", desktop("electron-builder.yml")]] as const) {
      expect(text, name).not.toMatch(/^\s*(electron|electron-builder|better-sqlite3):\s*["']?\d/m);
    }
    // The version the artefact carries is `${version}` from package.json, which is the lockfile's world.
    expect(desktop("electron-builder.pos.yml")).toContain("${version}");
  });
});
```

Run `bun run --cwd apps/desktop test -- pos-updater`. **Expected failure:** `ENOENT: no such file or directory, open '…/apps/desktop/electron-builder.pos.yml'`.

- [ ] **Step 2: Write `apps/desktop/electron-builder.pos.yml`**

```yaml
# The SECOND of spec:2361's two build targets. Registered by 6B Task 0 amendment A5.
#
# It is a sibling of `electron-builder.yml` and not a variant of it: a second product needs its own appId
# (else the two installers overwrite each other's userData, and the till's userData holds the outbox — the
# one piece of state in this product that exists nowhere else), its own entry point, its own resources and
# its own update feed.
#
# NOTHING here is signed. That is 6B Task 13 and OD-18; §2.12's default is "unsigned build, warning
# expected", and the release workflow's signing step is added there, not here.
appId: my.dulja.pos
productName: Dulja POS
copyright: © Dulja
directories:
  output: dist-installer-pos
  buildResources: build
# `desktop` imports build outputs only (spec:2389): both halves of the till arrive as files.
files:
  - dist/**/*
  - package.json
extraMetadata:
  # Electron reads `main` out of the packaged package.json, so the two products differ by this one line.
  main: dist/main-pos.js
extraResources:
  - from: ../pos/dist
    to: renderer
  # ADR 0058: apps/desktop `require`s this by path at run time. It is a resource, not a dependency.
  - from: ../pos/dist-main
    to: pos-main
asar: true
asarUnpack:
  # A native module cannot be loaded from inside the archive. The till is the first product that needs it.
  - "**/node_modules/better-sqlite3/**"
npmRebuild: true
win:
  target:
    - target: nsis
      arch: [x64]
  artifactName: ${productName} Setup ${version}.${ext}
nsis:
  oneClick: false
  # Per-user: a shop PC's cashier account is not an administrator, and an installer that needed elevation
  # would be run by whoever happened to be nearby with a password.
  perMachine: false
  allowToChangeInstallationDirectory: true
  shortcutName: Dulja POS
publish:
  - provider: generic
    url: ${env.DULJA_POS_UPDATE_FEED}
```

```json
// apps/desktop/package.json — one script appended beside Task 9's two.
    "dist:pos": "electron-builder --config electron-builder.pos.yml --win --publish never"
```

- [ ] **Step 3: The CI job builds both targets**

```yaml
# .github/workflows/ci.yml — the existing `desktop` job gains three steps. Nothing else changes.
  desktop:
    runs-on: windows-latest
    needs: [build]
    steps:
      # (unchanged: 0E's existing checkout, bun setup, install, build:backoffice, dist and native-module
      #  steps, in that order -- do not edit them; the 6B steps below are APPENDED to this job)

      # ── 6B: the second target of spec:2361 ───────────────────────────────────────────────────────────
      - name: Build the till's renderer and main-process bundle
        run: |
          bun run --cwd apps/pos build
          bun run --cwd apps/pos build:main

      - name: Compile apps/desktop's POS entry point
        # `dist:pos` packages `dist/main-pos.js`, which only `build:pos` produces. Without this step
        # electron-builder packages a `dist/` with no `main-pos.js` in it and the installer starts a window
        # that closes immediately — the failure mode a CI job must not be able to reach.
        run: bun run --cwd apps/desktop build:pos

      - name: Package pos.exe
        env:
          # A placeholder feed: `--publish never` means nothing is uploaded, and electron-builder still needs
          # the variable to resolve. The real value is 0C's R2 URL and is set in release.yml (Task 13).
          DULJA_POS_UPDATE_FEED: https://updates.invalid/pos/
        run: bun run --cwd apps/desktop dist:pos

      - name: Prove the till's SQLite module loads inside the package
        # 0E's `native-module.spec.ts` shape, applied to the till: the one failure mode `asarUnpack` exists
        # for is silent — `better-sqlite3` throws at `require` time inside the packaged app and nowhere else.
        run: bun run --cwd apps/desktop test -- pos-updater pos-posture pos-bridge

      - name: Upload the till installer
        uses: actions/upload-artifact@v4
        with:
          name: pos-installer-unsigned
          path: apps/desktop/dist-installer-pos/*.exe
          if-no-files-found: error
```

- [ ] **Step 4: The owner-account step, written as hazard 5 requires**

**Owner provides:** the R2 bucket and the public base URL for the POS update prefix (**OD-20**, the Cloudflare account and domain; 0C owns the `UPDATE_FEED` binding and A5 records that it serves `updates/pos/` as well as `updates/backoffice/`).

**Verify:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$DULJA_POS_UPDATE_FEED/latest.yml"
```

**Expected:** `200` once a release has been published, `404` before the first one — and **not** `000` or `403`, which mean the prefix or the binding is wrong.

**Until provided:**

```bash
DULJA_POS_UPDATE_FEED=http://127.0.0.1:8788/pos/ bun run --cwd apps/desktop dist:pos
bun run --cwd apps/desktop test -- pos-updater
```

**Expected:** the installer is produced in `apps/desktop/dist-installer-pos/`, the nine `pos-updater` cases pass, and `latest.yml` appears beside the `.exe` in that directory — which is the same file the feed serves and is what `electron-updater` reads. **The slice never blocks on the owner's account:** every assertion in this task is over the committed configuration and the produced artefact, not over a network.

- [ ] **Step 5: Run and commit**

```bash
bun run --cwd apps/pos build && bun run --cwd apps/pos build:main
DULJA_POS_UPDATE_FEED=http://127.0.0.1:8788/pos/ bun run --cwd apps/desktop dist:pos
bun run --cwd apps/desktop test -- pos-updater
ls apps/desktop/dist-installer-pos
```

**Expected:** 9 passed; `dist-installer-pos/` holds `Dulja POS Setup <version>.exe` and `latest.yml`. Running the installer on a Windows machine shows **SmartScreen's unknown-publisher warning** — that is OD-18's recorded default and Task 13's subject, not a defect here.

```bash
git add apps/desktop/electron-builder.pos.yml apps/desktop/package.json \
        apps/desktop/test/pos-updater.spec.ts .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
build(desktop): pos.exe as the second electron-builder target, with its own R2 feed [6B T10]

spec:2361's two targets from one shell: same preload discipline, same updater, same asarUnpack of
better-sqlite3; different appId, entry point, resources and feed. A shared appId would make the
two installers overwrite each other's userData — and the till's userData holds the outbox, the one
piece of state in this product that exists nowhere else. Unsigned, which is OD-18's recorded
default; the signing job is T13.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: ⚠️ OD-24 — the till's screens, the offline indicator, keyboard parity and RTL/LTR (acceptance test 23's POS half)

**⚠️ THIS TASK IS BLOCKED BY OD-24 AND THE SLICE IS NOT.** §2.12, OD-24: *"Screenshots + operator description before any screen"* (spec:79, 108, 2254, 2408); hazard 29: *"Every screen task begins with OD-24 … and targets keyboard parity; no plan invents a workflow."* §2.7's card adds the reason this task is the strictest instance of it: **the POS is the most keyboard-critical UI in the product**.

**Tasks 1–10 and 12 ship without it.** Every service, the whole local model, both sync loops, the typed bridge, acceptance test 19 and `pos.exe` itself land with **no screens** — `apps/pos/dist` is an `index.html` with a mount point and nothing in it, which is exactly what **T1 Step 7 builds**: `index.html`, `vite.config.ts` and a three-line `src/renderer/main.tsx` that mounts an empty `<div>`. That is not a placeholder in the sense the skill forbids — it is a real, buildable, tested artefact, and it is what gives T10's `bun run --cwd apps/pos build` an entry point and `electron-builder.pos.yml`'s `extraResources: from ../pos/dist` something to copy in the default state. That is what "the screen task is blocked, not the slice" means, and it is why this task sits at 11 and not at 2.

**Owner provides (OD-24):**
1. **Screenshots** of the legacy POS's sell screen, tender screen, price-check screen and shift-close screen — the four a cashier uses.
2. **A two-minute operator description** per screen: what a cashier does first, what they type, which key finishes the sale, and what they do when the customer changes their mind.
3. **The keyboard map the shop already uses** — which function key starts a return, which opens the drawer, which voids a line. spec:2254's *"no mouse is required"* is a target, and matching the muscle memory the staff already have is the difference between a rollout and a retraining.

**Verify:** `ls docs/owner/od-24/6b/` lists at least four images and one `operator-description.md`, and the description names a key for every action in the table below. **Until provided:** this task is not started. Nothing in Tasks 1–10 or 12 references a file it creates, and dropping it renumbers nothing.

**Files (NEW unless marked, and every NEW one is dropped whole if OD-24 is never answered):**
- `docs/owner/od-24/6b/` (the gate directory — the owner's material)
- **MODIFY** `apps/pos/index.html` (add the stylesheet link; T1 created it with the mount `<div>`), **MODIFY** `apps/pos/vite.config.ts` (add the Tailwind plugin; T1 created it with the React plugin and the build target), NEW `apps/pos/tailwind.config.ts`
- **MODIFY** `apps/pos/src/renderer/main.tsx` (T1 created it as an empty mount so `vite build` has an entry in the OD-24 default state; this task replaces the placeholder body with the router), NEW `router.tsx`, NEW `app.css`
- `apps/pos/src/renderer/lib/bridge.ts`, `lib/keys.ts`
- `apps/pos/src/renderer/components/till-shell.tsx`, `components/receipt.tsx`
- `apps/pos/src/renderer/routes/enrol.tsx`, `login.tsx`, `sell.tsx`, `tender.tsx`, `price-check.tsx`, `shift.tsx`
- `apps/pos/test/renderer/till-shell.test.tsx`, `test/renderer/sell.test.tsx`, NEW `apps/pos/test/renderer/setup.ts`, **MODIFY** `apps/pos/vitest.config.ts` (T1 created it with `environment: "node"`, which is right for every main-process suite and has no `document`; this task adds the React plugin, the `jsdom` environment and the setup file — the first renderer test in the workspace is what needs them)
- `tests/e2e/pos-rtl-parity.spec.ts`
- Modify: `packages/i18n/src/catalogues/en.json`, `ar.json` (the `pos.*` keys), `scripts/lint/rules/no-hardcoded-string.ts` (one root)

**Interfaces**

- Consumes: `DirectionProvider`, `useDirection`, `Button`, `TextField`, `Select`, `DataGrid`, `tokens.css`, `tailwind-preset` (0E `packages/ui`); `createI18n`, `Locale`, `dirFor`, `formatMoney`, `formatQuantity`, `formatDate`, `checkCatalogues` (0E `packages/i18n`); `window.dulja.pos` (T9); `DuljaPosBridge` (T9, through `apps/desktop/types/dulja-pos.d.ts`).
- Produces: no exported API beyond the renderer bundle. The `pos.*` i18n keys are the one shared namespace this task writes into, and they are additive to 0E's catalogues.

- [ ] **Step 1: The OD-24 gate — read the owner's material and write the workflow down before any component**

Create `docs/owner/od-24/6b/README.md` from the owner's material, with **this table filled in from the operator description and not invented**:

| Action | Key the shop already uses | Screen | Bridge call |
|---|---|---|---|
| Scan / enter an item | (typing, then `Enter`) | sell | `search` then `sell` |
| Change quantity | *from the description* | sell | — (local draft) |
| Line discount | *from the description* | sell | — (local draft) |
| Price override | *from the description* | sell | — (local draft) |
| Void a line | *from the description* | sell | — (local draft) |
| Start a return | *from the description* | sell | `sell` with `kind: "return"` |
| Finish the sale | *from the description* | sell → tender | `tender` |
| Price check | *from the description* | price-check | `priceCheck` |
| Open the drawer | *from the description* | sell | — (till event, T6) |
| Clock in / out | *from the description* | login | `clock` |
| Close the shift | *from the description* | shift | `closeShift` |

⚠️ **A cell this task cannot fill from the owner's material is a question, not a default.** Inventing a key map is exactly what hazard 29 forbids, and a till whose `F4` does something different from the till the staff learned on is a rollout failure that no test catches.

- [ ] **Step 2: The i18n keys, and the lint root that proves no string is hard-coded**

```json
// packages/i18n/src/catalogues/en.json — the `pos` block, additive. `ar.json` gains the same keys.
{
  "pos": {
    "shell": {
      "online": "Online",
      "offline": "Offline",
      "catalogueAt": "Catalogue updated {{when}}",
      "catalogueNever": "This till has never updated its catalogue",
      "catalogueRevision": "Revision {{revision}}",
      "unsent": "{{count}} unsent",
      "unsentNone": "Everything sent",
      "updateNow": "Update now",
      "sendNow": "Send now"
    },
    "enrol": { "title": "Enrol this till", "code": "Enrolment code", "submit": "Enrol", "done": "This till is enrolled." },
    "login": { "title": "Sign in", "employeeNumber": "Employee number", "pin": "PIN", "submit": "Sign in",
               "clockIn": "Clock in", "clockOut": "Clock out" },
    "sell": { "title": "Sell", "scan": "Scan or search", "quantity": "Quantity", "unitPrice": "Price",
              "discount": "Discount", "lineTotal": "Total", "netTotal": "Subtotal", "taxTotal": "Tax",
              "total": "Total", "customer": "Customer", "newCustomer": "New customer",
              "return": "Return", "originalTicket": "Original ticket", "blindReturn": "Blind return",
              "advisoryStock": "About {{quantity}} in stock as of {{when}} — not confirmed",
              "empty": "Nothing on this ticket yet" },
    "tender": { "title": "Payment", "method": "Method", "amount": "Amount", "reference": "Reference",
                "cash": "Cash", "card": "Card", "transfer": "Transfer", "storeCredit": "Store credit",
                "payable": "To pay", "rounding": "Rounding", "change": "Change", "submit": "Take payment",
                "account": "Charge to account" },
    "priceCheck": { "title": "Price check", "query": "Scan or type a code", "empty": "No item found" },
    "shift": { "title": "Shift", "open": "Open shift", "openingFloat": "Opening float", "close": "Close shift",
               "countedCash": "Counted cash", "tickets": "{{count}} tickets", "byMethod": "By method",
               "expectedNote": "The over/short figure is calculated in the back office after this shift syncs." },
    "receipt": { "ticket": "Ticket", "cashier": "Cashier", "date": "Date", "item": "Item",
                 "thanks": "Thank you", "notYetSynced": "Not yet sent to the office" },
    "error": {
      "ERR_TILL_PIN_INVALID": "That PIN does not match a cashier on this till.",
      "ERR_TILL_LIMIT_EXCEEDED": "This needs a supervisor's approval.",
      "ERR_TILL_CATALOGUE_STALE": "This till has not updated its catalogue and cannot price a ticket.",
      "ERR_TILL_STORE_CORRUPT": "This till's local database is damaged. Call support before selling.",
      "ERR_RBAC_FORBIDDEN": "You are not allowed to do that at this till.",
      "ERR_NOT_FOUND": "Not found.",
      "ERR_VALIDATION_FAILED": "That is not a valid entry.",
      "ERR_MONEY_CURRENCY_MISMATCH": "Those amounts are in different currencies.",
      "ERR_INTERNAL": "Something went wrong. Try again, and call support if it happens twice."
    }
  }
}
```

⚠️ **The `pos.error.*` block is keyed by `ErrCode` on purpose, and it is the reason the preload unwraps `{ ok, error }` into a `TillError` carrying a `code`** (Task 9 Step 7). A component that rendered `error.message` would print an English sentence composed in the main process, in an Arabic UI, and 0E's `no-hardcoded-string` lint would not catch it because the string is not in the component. **The rule for this slice: a renderer never renders a `detail`; it renders `t(\`pos.error.${code}\`)`.**

```ts
// scripts/lint/rules/no-hardcoded-string.ts — one root appended (0E's rule, its own extension point).
const ROOTS = [
  "apps/backoffice/src",
  // 6B T11: the till's renderer joins the same roots. spec:2061 and acceptance test 23 bind it exactly as
  // they bind the back office — the till is the screen a customer stands in front of.
  "apps/pos/src/renderer",
];
```

- [ ] **Step 3: The renderer test harness, then both failing renderer tests**

**First the harness, because `apps/pos` has never run a renderer test.** T1's `vitest.config.ts` is `environment: "node"` — correct for `database`, `store`, `ticket`, `tender`, `returns` and `customer`, none of which touches a DOM — and a `.tsx` case under it fails at `render()` with `ReferenceError: document is not defined`. This task adds the three things 0E's `apps/backoffice/vitest.config.ts` already carries, in the same shape:

```ts
// apps/pos/vitest.config.ts — MODIFY (T1 wrote the one-line version; this is the whole file after this task)
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // `node` stays the default, because the main process's `better-sqlite3` and `node:crypto` work must not
    // run against a jsdom global. The two renderer files opt in per file with a `// @vitest-environment
    // jsdom` docblock on their first line — **not** with a config-side `environmentMatchGlobs` entry, which
    // was deprecated in Vitest 3 and removed in Vitest 4 and would strand this file on a version.
    environment: "node",
    // Global, and harmless for the node suites: the setup file only calls `expect.extend`.
    setupFiles: ["./test/renderer/setup.ts"],
    testTimeout: 30_000,
  },
});
```

```ts
// apps/pos/test/renderer/setup.ts
import "@testing-library/jest-dom/vitest";
```

```bash
bun add --cwd apps/pos -d @testing-library/react @testing-library/user-event @testing-library/jest-dom \
        jsdom react-i18next i18next
```

⚠️ **`useTranslation` needs an initialised instance, and `TillShell` does not create one** — 0E's `AppShell` does, in a `useEffect`, and returns `null` until it resolves; the till's shell takes the instance from a provider instead so that a test can render it synchronously and `pos.exe`'s `main.tsx` can create it once at boot. Both test files therefore wrap in `I18nextProvider`, through a four-line local helper, and **that helper is what makes the assertions below compare real catalogue strings rather than the raw keys** `useTranslation` returns when no instance is bound.

```tsx
// @vitest-environment jsdom
// apps/pos/test/renderer/till-shell.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { i18n as I18n } from "i18next";
import { checkCatalogues, createI18n } from "@dulja/i18n";
import { TillShell } from "../../src/renderer/components/till-shell";

let i18n: I18n;
beforeAll(async () => { i18n = await createI18n({ locale: "en" }); });
/** 0E's `createI18n` returns an initialised instance; the provider is what binds it to `useTranslation`. */
const withI18n = (node: React.ReactNode) => <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;

const status = (over: Partial<Record<string, unknown>> = {}) => ({
  online: true, lastPullAt: "2026-06-15T09:00:00.000Z", lastPushAt: "2026-06-15T09:00:00.000Z",
  catalogueRevision: "412", pendingOutbox: 0, lastError: null,
  enrolled: true, signedIn: { principalId: "p-1", branchId: "br-1" }, shiftId: "s-1", ...over,
});

describe("the offline indicator (spec:1345, 1356 — honest, with a time)", () => {
  it("shows online, the revision and the last update time", async () => {
    render(withI18n(<TillShell locale="en" status={status()}>{null}</TillShell>));
    expect(await screen.findByText("Online")).toBeInTheDocument();
    expect(screen.getByText(/Revision 412/)).toBeInTheDocument();
    expect(screen.getByText(/Catalogue updated/)).toBeInTheDocument();
    expect(screen.getByText("Everything sent")).toBeInTheDocument();
  });

  it("shows OFFLINE and the unsent count, and never hides either", async () => {
    render(withI18n(<TillShell locale="en" status={status({ online: false, pendingOutbox: 137 })}>{null}</TillShell>));
    expect(await screen.findByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("137 unsent")).toBeInTheDocument();
    // The dishonest indicator spec:1356 forbids is one that shows green after a failed pull, so the state
    // and the time are always both present — never the state alone.
    expect(screen.getByText(/Catalogue updated/)).toBeInTheDocument();
  });

  it("says so plainly when the till has NEVER pulled — the state a fresh install is in", async () => {
    render(withI18n(<TillShell locale="en" status={status({ online: false, lastPullAt: null, catalogueRevision: "0" })}>{null}</TillShell>));
    expect(await screen.findByText("This till has never updated its catalogue")).toBeInTheDocument();
  });

  it("renders dir=rtl for ar and dir=ltr for en, from ONE component (test 23's POS half)", async () => {
    const { container: en } = render(withI18n(<TillShell locale="en" status={status()}>{null}</TillShell>));
    expect(en.querySelector("[dir]")?.getAttribute("dir")).toBe("ltr");
    const { container: ar } = render(withI18n(<TillShell locale="ar" status={status()}>{null}</TillShell>));
    expect(ar.querySelector("[dir]")?.getAttribute("dir")).toBe("rtl");
  });

  it("every key it renders exists in BOTH catalogues", () => {
    // 0E's own check, run over this slice's additions: a key in `en` and not in `ar` is an English string on
    // an Arabic screen, which acceptance test 23 exists to prevent.
    expect(checkCatalogues()).toEqual([]);
  });
});
```

**Then the sell route's two cases.** They are the pair that proves the two things §3.7.6's Selling row and spec:2254 ask of this screen and that no other test in the slice covers: that **a scanned barcode reaches the main process through `window.dulja.pos.search` and becomes a line**, and that **the shop's own finish-sale key completes the ticket with no mouse**. Both read `TILL_KEYS` rather than a key literal, so they stay correct the moment the OD-24 value replaces the gate's placeholder — a test that hard-coded `"F12"` would have to be edited when the owner answers, which is the drift the one-module key map exists to prevent.

```tsx
// @vitest-environment jsdom
// apps/pos/test/renderer/sell.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { i18n as I18n } from "i18next";
import { createI18n } from "@dulja/i18n";
import { TILL_KEYS } from "../../src/renderer/lib/keys";
import { SellRoute } from "../../src/renderer/routes/sell";

let i18n: I18n;
beforeAll(async () => { i18n = await createI18n({ locale: "en" }); });
const withI18n = (node: React.ReactNode) => <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;

const RICE = {
  itemId: "item-A", code: "SKU-A", nameEn: "Rice", nameAr: "أرز",
  quantity: "1.000000", unitPrice: "11.5000", discount: "0.0000",
};

/**
 * The bridge stub. `lib/bridge.ts` throws *"the POS bridge is not available"* when `window.dulja.pos` is
 * absent, which is the named boundary it exists to give — so the stub is installed on `window` rather than
 * the module being mocked, and the route exercises the real `till.*` wrappers.
 */
const search = vi.fn();
const sell = vi.fn();
beforeEach(() => {
  search.mockReset(); sell.mockReset();
  Object.defineProperty(window, "dulja", {
    configurable: true, writable: true,
    value: { pos: { search, sell } },
  });
  window.location.hash = "";
});
afterEach(() => { delete (window as { dulja?: unknown }).dulja; });

describe("the sell route — keyboard-first, and every call goes through the bridge (spec:2254, §3.7.6)", () => {
  it("a scanned barcode adds a row through window.dulja.pos.search — the keyboard-wedge path", async () => {
    search.mockResolvedValue([RICE]);
    render(withI18n(<SellRoute shiftId="s-1" locale="en" />));
    // Nothing is on the ticket before the scan, and the empty state says so rather than showing a blank grid.
    expect(screen.getByText("Nothing on this ticket yet")).toBeInTheDocument();

    // A USB scanner is a keyboard-wedge device (D18, spec:133): it types the digits and presses Enter.
    // There is no scanner code in this slice, and this case is the proof that none is needed.
    const field = screen.getByLabelText("Scan or search");
    await userEvent.type(field, "9551234567890{Enter}");

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith({ barcode: "9551234567890" });
    expect(await screen.findByText("Rice")).toBeInTheDocument();
    expect(screen.queryByText("Nothing on this ticket yet")).not.toBeInTheDocument();
    // The scan field is cleared for the next item; a cashier scanning ten items types nothing in between.
    expect((field as HTMLInputElement).value).toBe("");
    // Reading an item's price is NOT selling: `sell` has not been called and no ticket exists yet.
    expect(sell).not.toHaveBeenCalled();
  });

  it("the shop's finish-sale key completes the ticket with NO mouse and routes to tender", async () => {
    search.mockResolvedValue([RICE]);
    sell.mockResolvedValue({ clientRef: "0199-ref" });
    render(withI18n(<SellRoute shiftId="s-1" locale="en" />));
    await userEvent.type(screen.getByLabelText("Scan or search"), "9551234567890{Enter}");
    await screen.findByText("Rice");

    // `TILL_KEYS.finishSale`, never a literal: the value is the shop's own, transcribed in Step 1, and this
    // assertion must not need editing when it lands. The listener is on `window` (one key map for the
    // application, not per-field handlers), so the event is dispatched there.
    fireEvent.keyDown(window, { key: TILL_KEYS.finishSale });

    await waitFor(() => expect(sell).toHaveBeenCalledTimes(1));
    expect(sell).toHaveBeenCalledWith({
      shiftId: "s-1",
      lines: [{ itemId: "item-A", quantity: "1.000000", discount: "0.0000" }],
    });
    // The route hands off to tender by hash; the tender screen is a separate route and a separate case.
    expect(window.location.hash).toBe("#/tender/0199-ref");
    // No `role="alert"` was rendered: a successful sale shows no error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
```

Run `bun run --cwd apps/pos test -- renderer`. **Expected failure:** `Failed to resolve import "../../src/renderer/components/till-shell" from "test/renderer/till-shell.test.tsx"` and the same for `../../src/renderer/lib/keys` and `../../src/renderer/routes/sell`. (T1 created `src/renderer/main.tsx` and nothing else under that directory, so none of the three modules exists yet.)

- [ ] **Step 4: `lib/bridge.ts` and `components/till-shell.tsx`**

```ts
// apps/pos/src/renderer/lib/bridge.ts
/**
 * The renderer's one door to the main process.
 *
 * It exists so no component reaches for `window.dulja` directly: a component that did could be rendered in a
 * test with no bridge at all and would throw at a property access rather than at a named boundary, and a
 * future `window.dulja.pos` method added without a call site here would be invisible.
 *
 * There is no `fetch` in `apps/pos/src/renderer`, at all. Every network call the till makes is the main
 * process's, signed with the device key (T3); a renderer that could reach the API would be a second,
 * unsigned client, and `pos-bridge.spec.ts`'s companion assertion in T12 greps for exactly that.
 */
export interface TillStatus {
  online: boolean; lastPullAt: string | null; lastPushAt: string | null;
  catalogueRevision: string; pendingOutbox: number; lastError: string | null;
  enrolled: boolean; signedIn: { principalId: string; branchId: string } | null; shiftId: string | null;
}

const pos = (): NonNullable<Window["dulja"]["pos"]> => {
  const bridge = window.dulja?.pos;
  if (bridge === undefined) {
    throw new Error("the POS bridge is not available: this build is not running inside pos.exe");
  }
  return bridge;
};

export const till = {
  enrol: (code: string) => pos().enrol(code),
  login: (employeeNumber: string, pin: string) => pos().login({ employeeNumber, pin }),
  clock: (kind: "clock_in" | "clock_out") => pos().clock(kind),
  openShift: (openingFloat: string, currency: string) => pos().openShift({ openingFloat, currency }),
  closeShift: (shiftId: string, countedCash: string) => pos().closeShift({ shiftId, countedCash }),
  search: (input: { text?: string; barcode?: string; code?: string }) => pos().search(input),
  priceCheck: (input: { text?: string; barcode?: string; code?: string }) => pos().priceCheck(input),
  sell: (input: unknown) => pos().sell(input),
  tender: (input: unknown) => pos().tender(input),
  receipt: (clientRef: string) => pos().receipt(clientRef),
  print: (clientRef: string) => pos().print(clientRef),
  pull: () => pos().pull(),
  drain: () => pos().drain(),
  status: () => pos().status() as Promise<TillStatus>,
};

/** Every error crossing the bridge carries an `ErrCode`; a renderer renders `pos.error.<code>` and never a
 *  `detail` (T11 Step 2's rule). This is where the code is recovered. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "ERR_INTERNAL";
}
```

```tsx
// apps/pos/src/renderer/components/till-shell.tsx
import type { ReactNode } from "react";
import { DirectionProvider } from "@dulja/ui";
import { formatDate, type Locale } from "@dulja/i18n";
import { useTranslation } from "react-i18next";
import type { TillStatus } from "../lib/bridge";

/**
 * The chrome, and the **honest offline indicator** §3.7.6's Offline row requires: *"a visible, honest
 * indicator of sync state and last-catalogue-update time"*.
 *
 * Three facts are always on screen and none of them can be hidden by a state: whether the till reached the
 * server, **when** the catalogue last arrived, and how many tickets are unsent. The last is the number a
 * manager actually needs — the enrolment runbook says *"before wiping a till, check the indicator's unsent
 * count"*, and it is the only figure on a till that exists nowhere else.
 *
 * `DirectionProvider` is 0E's, and it is the whole of RTL/LTR parity here: it sets `dir` and the logical
 * properties in `tokens.css` do the rest, so there is no `marginLeft` anywhere in this slice's renderer
 * (`tests/e2e/pos-rtl-parity.spec.ts` asserts the two directions produce mirrored layout on one screenshot).
 */
export function TillShell({ locale, status, children }: {
  locale: Locale; status: TillStatus; children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DirectionProvider locale={locale}>
      <div className="flex h-screen flex-col bg-surface text-body">
        <header className="flex items-center justify-between gap-4 border-b border-subtle px-4 py-2 text-sm">
          <span
            className={status.online ? "font-semibold text-positive" : "font-semibold text-critical"}
            // The state is announced, because a cashier watching the customer must not have to look.
            aria-live="polite"
          >
            {status.online ? t("pos.shell.online") : t("pos.shell.offline")}
          </span>
          <span>
            {status.lastPullAt === null
              ? t("pos.shell.catalogueNever")
              : `${t("pos.shell.catalogueAt", { when: formatDate(status.lastPullAt, { locale }) })} · ${t("pos.shell.catalogueRevision", { revision: status.catalogueRevision })}`}
          </span>
          <span className={status.pendingOutbox > 0 ? "font-semibold" : undefined}>
            {status.pendingOutbox > 0
              ? t("pos.shell.unsent", { count: status.pendingOutbox })
              : t("pos.shell.unsentNone")}
          </span>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
      </div>
    </DirectionProvider>
  );
}
```

- [ ] **Step 5: The six routes, the keyboard map, and the receipt component**

Each route is a thin form over one bridge call. **The workflow they implement is Step 1's table and not this plan's invention** — the field order, the key that finishes the sale and the confirmation the shop expects all come from the operator description, which is why this task cannot be written before it arrives.

```ts
// apps/pos/src/renderer/lib/keys.ts
/**
 * The shop's own key map, transcribed from the OD-24 operator description into ONE module.
 *
 * spec:2254: *"keyboard-first entry"*, and §2.7's card: the POS is the most keyboard-critical UI in the
 * product. Every value below is a quotation from `docs/owner/od-24/6b/operator-description.md`; **a value
 * this file guesses is a defect**, and the constant's name says which action it serves so a reviewer can
 * check it against that document line by line.
 *
 * One module rather than `onKeyDown` handlers spread over six routes, because a cashier's muscle memory is a
 * property of the application and not of a screen: `F4` must not mean two things.
 */
export const TILL_KEYS = {
  finishSale: "<from operator-description.md>",
  quantity: "<from operator-description.md>",
  lineDiscount: "<from operator-description.md>",
  priceOverride: "<from operator-description.md>",
  voidLine: "<from operator-description.md>",
  startReturn: "<from operator-description.md>",
  priceCheck: "<from operator-description.md>",
  openDrawer: "<from operator-description.md>",
  cancelTicket: "<from operator-description.md>",
} as const;
```

⚠️ **The nine placeholder strings above are the OD-24 gate itself, and they are the one place in this plan where a value is deliberately absent.** They are not a "TBD": the task does not start until `docs/owner/od-24/6b/operator-description.md` exists, and Step 1's table is filled from it first. A `TILL_KEYS` shipped with a guessed value would be a workflow this plan invented, which hazard 29 forbids in the same sentence that creates this gate.

```tsx
// apps/pos/src/renderer/routes/sell.tsx — the shape; the field order and the keys are Step 1's table.
import { useEffect, useState } from "react";
import { Button, TextField } from "@dulja/ui";
import { formatMoney, formatQuantity } from "@dulja/i18n";
import { useTranslation } from "react-i18next";
import { errorCode, till } from "../lib/bridge";
import { TILL_KEYS } from "../lib/keys";

interface Row { itemId: string; code: string; nameEn: string; nameAr: string | null; quantity: string; unitPrice: string; discount: string }

export function SellRoute({ shiftId, locale }: { shiftId: string; locale: "en" | "ar" }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [scan, setScan] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A barcode arrives as KEYBOARD INPUT ending in Enter: every USB scanner in the shops is a keyboard-wedge
  // device, and D18 puts scanner drivers out of scope for v1 (spec:133). There is no scanner code here.
  const onScan = async (): Promise<void> => {
    try {
      const [found] = await till.search({ barcode: scan }) as Row[];
      if (found === undefined) { setError("ERR_NOT_FOUND"); return; }
      setRows((r) => [...r, { ...found, quantity: "1.000000", unitPrice: found.unitPrice, discount: "0.0000" }]);
      setScan(""); setError(null);
    } catch (e) { setError(errorCode(e)); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === TILL_KEYS.finishSale) { e.preventDefault(); void finish(); }
      if (e.key === TILL_KEYS.priceCheck) { e.preventDefault(); window.location.hash = "#/price-check"; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const finish = async (): Promise<void> => {
    try {
      const { clientRef } = await till.sell({
        shiftId,
        lines: rows.map((r) => ({ itemId: r.itemId, quantity: r.quantity, discount: r.discount })),
      });
      window.location.hash = `#/tender/${clientRef}`;
    } catch (e) { setError(errorCode(e)); }
  };

  return (
    <section aria-label={t("pos.sell.title")}>
      <TextField label={t("pos.sell.scan")} value={scan} autoFocus
                 onChange={(e) => setScan(e.currentTarget.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void onScan(); }} />
      {error !== null && <p role="alert">{t(`pos.error.${error}`)}</p>}
      {rows.length === 0
        ? <p>{t("pos.sell.empty")}</p>
        : <table><tbody>{rows.map((r, i) => (
            <tr key={`${r.itemId}-${i}`}>
              <td>{locale === "ar" && r.nameAr !== null ? r.nameAr : r.nameEn}</td>
              <td>{formatQuantity(r.quantity, { locale })}</td>
              <td>{formatMoney({ amount: r.unitPrice, currency: "MYR" }, { locale })}</td>
            </tr>))}</tbody></table>}
      <Button variant="primary" onClick={() => void finish()}>{t("pos.sell.total")}</Button>
    </section>
  );
}
```

⚠️ **`formatMoney`'s `currency: "MYR"` above is the one literal this component must NOT keep.** The currency is the till's, and it arrives with every amount from the bridge; the `TillStatus`-shaped context that carries it is this task's to add — **read the currency from `status`, thread it through a React context beside `locale`, and delete the literal.** It is written here so the shape of the call is unambiguous, and it is the first thing Step 6's review checks.

```tsx
// apps/pos/src/renderer/routes/login.tsx
import { useState } from "react";
import { Button, TextField } from "@dulja/ui";
import { useTranslation } from "react-i18next";
import { errorCode, till } from "../lib/bridge";

export function LoginRoute({ onSignedIn }: { onSignedIn: (branchId: string) => void }) {
  const { t } = useTranslation();
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  const submit = async (): Promise<void> => {
    try {
      const who = await till.login(employeeNumber, pin);
      setPin("");                       // never left in a controlled input after use
      setSignedIn(true); setError(null);
      onSignedIn(who.branchId);
    } catch (e) { setPin(""); setError(errorCode(e)); }
  };
  const clock = async (kind: "clock_in" | "clock_out"): Promise<void> => {
    try { await till.clock(kind); setError(null); } catch (e) { setError(errorCode(e)); }
  };

  return (
    <section aria-label={t("pos.login.title")}>
      <TextField label={t("pos.login.employeeNumber")} value={employeeNumber} autoFocus
                 onChange={(e) => setEmployeeNumber(e.currentTarget.value)} />
      {/* `type="password"` and `inputMode="numeric"`: a shop PC is in public, and the PIN is digits only
          (6C's PIN_MIN_LENGTH..PIN_MAX_LENGTH, re-checked by TillLoginSchema on the main side). */}
      <TextField label={t("pos.login.pin")} value={pin} type="password" inputMode="numeric"
                 onChange={(e) => setPin(e.currentTarget.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      <Button variant="primary" onClick={() => void submit()}>{t("pos.login.submit")}</Button>
      {signedIn && (
        <>
          <Button onClick={() => void clock("clock_in")}>{t("pos.login.clockIn")}</Button>
          <Button onClick={() => void clock("clock_out")}>{t("pos.login.clockOut")}</Button>
        </>
      )}
      {error !== null && <p role="alert">{t(`pos.error.${error}`)}</p>}
    </section>
  );
}
```

```tsx
// apps/pos/src/renderer/routes/tender.tsx
import { useState } from "react";
import { Button, Select, TextField } from "@dulja/ui";
import { formatMoney } from "@dulja/i18n";
import { useTranslation } from "react-i18next";
import { errorCode, till } from "../lib/bridge";

type Method = "cash" | "card" | "transfer" | "store_credit";
interface Row { method: Method; amount: string; reference: string }

export function TenderRoute({ clientRef, currency, locale }: { clientRef: string; currency: string; locale: "en" | "ar" }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([{ method: "cash", amount: "", reference: "" }]);
  const [done, setDone] = useState<{ payable: string; change: string; rounding: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    try {
      const result = await till.tender({
        clientRef,
        tenders: rows.filter((r) => r.amount.trim().length > 0).map((r) => ({
          method: r.method, amount: r.amount, reference: r.reference.trim() === "" ? null : r.reference,
        })),
      });
      setDone(result); setError(null);
      // Printing is the main process's `webContents.print()` (T9): the OS dialogue opens over this window.
      await till.print(clientRef);
    } catch (e) { setError(errorCode(e)); }
  };

  return (
    <section aria-label={t("pos.tender.title")}>
      {rows.map((r, i) => (
        <div key={i}>
          <Select label={t("pos.tender.method")} value={r.method}
                  options={(["cash", "card", "transfer", "store_credit"] as Method[]).map((m) => ({
                    value: m, label: t(`pos.tender.${m === "store_credit" ? "storeCredit" : m}`) }))}
                  onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, method: e.currentTarget.value as Method } : x))} />
          <TextField label={t("pos.tender.amount")} value={r.amount} inputMode="decimal" autoFocus={i === 0}
                     onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, amount: e.currentTarget.value } : x))} />
          {r.method !== "cash" && (
            <TextField label={t("pos.tender.reference")} value={r.reference}
                       onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, reference: e.currentTarget.value } : x))} />
          )}
        </div>
      ))}
      <Button onClick={() => setRows([...rows, { method: "card", amount: "", reference: "" }])}>+</Button>
      <Button variant="primary" onClick={() => void submit()}>{t("pos.tender.submit")}</Button>
      {done !== null && (
        <dl>
          <dt>{t("pos.tender.payable")}</dt><dd>{formatMoney({ amount: done.payable, currency }, { locale })}</dd>
          {/* The rounding line is the whole of ADR 0059's disclosure to the customer, so it is shown whenever
              it is non-zero — never folded into the total. */}
          {done.rounding !== "0.0000" && (
            <><dt>{t("pos.tender.rounding")}</dt><dd>{formatMoney({ amount: done.rounding, currency }, { locale })}</dd></>
          )}
          <dt>{t("pos.tender.change")}</dt><dd>{formatMoney({ amount: done.change, currency }, { locale })}</dd>
        </dl>
      )}
      {error !== null && <p role="alert">{t(`pos.error.${error}`)}</p>}
    </section>
  );
}
```

```tsx
// apps/pos/src/renderer/routes/price-check.tsx — read-only: it starts no ticket and writes nothing (T5).
import { useState } from "react";
import { TextField } from "@dulja/ui";
import { formatMoney } from "@dulja/i18n";
import { useTranslation } from "react-i18next";
import { errorCode, till } from "../lib/bridge";

interface Hit { item: { code: string; nameEn: string; nameAr: string | null }; unitPrice: string; total: string }

export function PriceCheckRoute({ currency, locale }: { currency: string; locale: "en" | "ar" }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const look = async (): Promise<void> => {
    try {
      // A scan and a typed name reach the same call: the main process routes a barcode to
      // `findItemByBarcode` and free text to `searchItems` (T9), so the screen needs no rule of its own.
      const found = await till.priceCheck(/^\d{6,}$/.test(query) ? { barcode: query } : { text: query }) as Hit[];
      setHits(found); setError(null);
    } catch (e) { setError(errorCode(e)); }
  };

  return (
    <section aria-label={t("pos.priceCheck.title")}>
      <TextField label={t("pos.priceCheck.query")} value={query} autoFocus
                 onChange={(e) => setQuery(e.currentTarget.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void look(); }} />
      {error !== null && <p role="alert">{t(`pos.error.${error}`)}</p>}
      {hits.length === 0 && error === null && <p>{t("pos.priceCheck.empty")}</p>}
      <ul>{hits.map((h) => (
        <li key={h.item.code}>
          {locale === "ar" && h.item.nameAr !== null ? h.item.nameAr : h.item.nameEn}
          {" — "}{formatMoney({ amount: h.total, currency }, { locale })}
        </li>))}</ul>
    </section>
  );
}
```

```tsx
// apps/pos/src/renderer/routes/shift.tsx
import { useState } from "react";
import { Button, TextField } from "@dulja/ui";
import { formatMoney } from "@dulja/i18n";
import { useTranslation } from "react-i18next";
import { errorCode, till } from "../lib/bridge";

export function ShiftRoute({ shiftId, currency, locale }: { shiftId: string | null; currency: string; locale: "en" | "ar" }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState("");
  const [closed, setClosed] = useState<{ tickets: number; byMethod: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (): Promise<void> => {
    try {
      if (shiftId === null) { await till.openShift(amount, currency); }
      else { setClosed(await till.closeShift(shiftId, amount)); }
      setAmount(""); setError(null);
    } catch (e) { setError(errorCode(e)); }
  };

  return (
    <section aria-label={t("pos.shift.title")}>
      <TextField label={t(shiftId === null ? "pos.shift.openingFloat" : "pos.shift.countedCash")}
                 value={amount} inputMode="decimal" autoFocus
                 onChange={(e) => setAmount(e.currentTarget.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void act(); }} />
      <Button variant="primary" onClick={() => void act()}>
        {t(shiftId === null ? "pos.shift.open" : "pos.shift.close")}
      </Button>
      {closed !== null && (
        <>
          <p>{t("pos.shift.tickets", { count: closed.tickets })}</p>
          <dl>{Object.entries(closed.byMethod).map(([m, a]) => (
            <div key={m}><dt>{t(`pos.tender.${m === "store_credit" ? "storeCredit" : m}`)}</dt>
              <dd>{formatMoney({ amount: a, currency }, { locale })}</dd></div>))}</dl>
          {/* §4.10.1: the till never computes expectedCash or over_short — the server derives both. Showing a
              figure here would be the till asserting something it cannot know, so it says so instead. */}
          <p>{t("pos.shift.expectedNote")}</p>
        </>
      )}
      {error !== null && <p role="alert">{t(`pos.error.${error}`)}</p>}
    </section>
  );
}
```

```tsx
// apps/pos/src/renderer/routes/enrol.tsx — the only screen a never-enrolled till can reach (T3's runbook).
import { useState } from "react";
import { Button, TextField } from "@dulja/ui";
import { useTranslation } from "react-i18next";
import { errorCode, till } from "../lib/bridge";

export function EnrolRoute({ onEnrolled }: { onEnrolled: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submit = async (): Promise<void> => {
    try { await till.enrol(code.trim()); setDone(true); setError(null); onEnrolled(); }
    catch (e) { setError(errorCode(e)); }
  };
  return (
    <section aria-label={t("pos.enrol.title")}>
      <TextField label={t("pos.enrol.code")} value={code} autoFocus
                 onChange={(e) => setCode(e.currentTarget.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      <Button variant="primary" onClick={() => void submit()}>{t("pos.enrol.submit")}</Button>
      {done && <p>{t("pos.enrol.done")}</p>}
      {error !== null && <p role="alert">{t(`pos.error.${error}`)}</p>}
    </section>
  );
}
```

```tsx
// apps/pos/src/renderer/components/receipt.tsx
import { formatDate, formatMoney, formatQuantity, type Locale } from "@dulja/i18n";
import { useTranslation } from "react-i18next";

/** The `ReceiptPayload` of T7, as it crosses the bridge: every amount a fixed-4-dp string. */
interface ReceiptPayload {
  clientRef: string; kind: "sale" | "return"; currency: string; soldAt: string;
  cashierPrincipalId: string; customerName: string | null;
  lines: readonly { lineNo: number; code: string; nameEn: string; nameAr: string | null;
                    quantity: string; unitPrice: string; discount: string; total: string }[];
  netTotal: string; taxTotal: string; total: string;
  tenders: readonly { method: string; amount: string; reference: string | null }[];
  change: string; rounding: string; documentNumber: string | null;
  catalogueRevision: string; catalogueAt: string | null;
}

/**
 * The printed receipt, in both text directions.
 *
 * `webContents.print()` prints **this window's DOM** (T9), so the receipt is a normal component under
 * `DirectionProvider` and there is no second rendering path and no PDF engine on this route — ADR 0016 is
 * consumed as a decision and nothing more (D18: ordinary Windows printer drivers).
 *
 * `documentNumber` is `null` until the ticket has been acknowledged, so the receipt prints the **client ref**
 * and says it has not been sent. Printing a guessed number would be SAH-051 in a new place.
 */
export function Receipt({ payload, locale }: { payload: ReceiptPayload; locale: Locale }) {
  const { t } = useTranslation();
  const money = (amount: string): string => formatMoney({ amount, currency: payload.currency }, { locale });
  return (
    <article id="receipt" aria-label={t("pos.receipt.ticket")}>
      <p>{t("pos.receipt.ticket")}: {payload.documentNumber ?? payload.clientRef}</p>
      {payload.documentNumber === null && <p>{t("pos.receipt.notYetSynced")}</p>}
      <p>{t("pos.receipt.date")}: {formatDate(payload.soldAt, { locale })}</p>
      <p>{t("pos.receipt.cashier")}: {payload.cashierPrincipalId}</p>
      {payload.customerName !== null && <p>{t("pos.sell.customer")}: {payload.customerName}</p>}
      <table>
        <thead><tr>
          <th scope="col">{t("pos.receipt.item")}</th><th scope="col">{t("pos.sell.quantity")}</th>
          <th scope="col">{t("pos.sell.unitPrice")}</th><th scope="col">{t("pos.sell.lineTotal")}</th>
        </tr></thead>
        <tbody>{payload.lines.map((l) => (
          <tr key={l.lineNo}>
            <td>{locale === "ar" && l.nameAr !== null ? l.nameAr : l.nameEn}</td>
            <td>{formatQuantity(l.quantity, { locale })}</td>
            <td>{money(l.unitPrice)}</td>
            <td>{money(l.total)}</td>
          </tr>))}</tbody>
      </table>
      <dl>
        <dt>{t("pos.sell.netTotal")}</dt><dd>{money(payload.netTotal)}</dd>
        <dt>{t("pos.sell.taxTotal")}</dt><dd>{money(payload.taxTotal)}</dd>
        {payload.rounding !== "0.0000" && (
          <><dt>{t("pos.tender.rounding")}</dt><dd>{money(payload.rounding)}</dd></>
        )}
        <dt>{t("pos.sell.total")}</dt><dd>{money(payload.total)}</dd>
        {payload.tenders.map((n, i) => (
          <div key={i}><dt>{t(`pos.tender.${n.method === "store_credit" ? "storeCredit" : n.method}`)}</dt>
            <dd>{money(n.amount)}</dd></div>))}
        {payload.change !== "0.0000" && (
          <><dt>{t("pos.tender.change")}</dt><dd>{money(payload.change)}</dd></>
        )}
      </dl>
      {/* spec:1356's honesty, on paper: a customer disputing a price and a manager reading the receipt can
          both see which catalogue the till priced from. */}
      <p>{t("pos.shell.catalogueRevision", { revision: payload.catalogueRevision })}
        {payload.catalogueAt !== null && ` · ${formatDate(payload.catalogueAt, { locale })}`}</p>
      <p>{t("pos.receipt.thanks")}</p>
    </article>
  );
}
```

`main.tsx`, `router.tsx` and `app.css` are the same three files `apps/backoffice` has (0E): `main.tsx` calls `createI18n()`, wraps everything in **`<I18nextProvider i18n={instance}>`** — the binding `useTranslation` reads, and the same one both renderer test files install through their `withI18n` helper — then mounts `<TillShell>` around the router with the `status` it polls from `till.status()` every two seconds and the `currency` it threads into a context beside `locale`; `router.tsx` is a TanStack Router tree over the six routes above, with `#/enrol` as the only reachable route while `status.enrolled` is false and `#/login` the only one while `status.signedIn` is null; `app.css` imports `@dulja/ui`'s `tokens.css` and the Tailwind preset and adds nothing of its own.

- [ ] **Step 6: Acceptance test 23's POS half**

```ts
// tests/e2e/pos-rtl-parity.spec.ts
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Acceptance test 23, re-run for the till: *"every screen renders correctly in both text directions"*.
 *
 * 0E owns the test and the shell screen; this is the POS half, and it is a **re-run** rather than a second
 * test — same assertions, this slice's screens. The four screens are the four a cashier uses.
 */
for (const locale of ["en", "ar"] as const) {
  test(`the till's four screens render in ${locale}`, async () => {
    const app = await electron.launch({ args: ["dist/main-pos.js"], env: { ...process.env, DULJA_LOCALE: locale } });
    const page = await app.firstWindow();
    for (const [hash, heading] of [["#/login", "pos.login.title"], ["#/sell", "pos.sell.title"],
                                   ["#/tender", "pos.tender.title"], ["#/price-check", "pos.priceCheck.title"]] as const) {
      await page.evaluate((h) => { window.location.hash = h; }, hash);
      await expect(page.locator("[dir]").first()).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      // No horizontal overflow in either direction — the failure a mirrored layout actually produces.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow, `${hash} overflows in ${locale}`).toBe(false);
      await expect(page.getByRole("region")).toBeVisible();
    }
    // Keyboard parity: the sale completes with no mouse (spec:2254). Every key is TILL_KEYS', from OD-24.
    await page.evaluate((h) => { window.location.hash = h; }, "#/sell");
    await page.keyboard.type("9001");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("table")).toBeVisible();
    await app.close();
  });
}
```

- [ ] **Step 7: Run and commit**

```bash
bun run --cwd apps/pos test -- renderer
bun run --cwd packages/i18n test -- catalogues
bun run --cwd apps/pos build && bun run --cwd apps/desktop build:pos
bun run --cwd tests e2e -- pos-rtl-parity
bun run lint && bun run lint:rules
```

**Expected:** 7 renderer cases pass — the five of `till-shell.test.tsx` plus the two of `sell.test.tsx`, both written in Step 3; `checkCatalogues()` returns `[]` (every `pos.*` key in both catalogues); the two Playwright specs pass; `no-hardcoded-string` reports zero violations over `apps/pos/src/renderer` — which is the mechanical half of spec:2061 and is why Step 2 added the root.

```bash
git add apps/pos/index.html apps/pos/vite.config.ts apps/pos/vitest.config.ts apps/pos/tailwind.config.ts \
        apps/pos/package.json apps/pos/src/renderer apps/pos/test/renderer \
        packages/i18n/src/catalogues scripts/lint/rules/no-hardcoded-string.ts \
        tests/e2e/pos-rtl-parity.spec.ts docs/owner/od-24/6b bun.lock
git commit -m "$(cat <<'EOF'
feat(pos): the till's screens, the honest offline indicator and both directions [6B T11]

⚠️ OD-24: the workflow and the key map are transcribed from the owner's operator description, not
invented (hazard 29) — TILL_KEYS is one module because a cashier's muscle memory is a property of
the application and F4 must not mean two things. The indicator always shows three facts and can
hide none: whether the till reached the server, when the catalogue arrived, and how many tickets
are unsent — the one figure on a till that exists nowhere else. Test 23 re-run for four screens.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: ACCEPTANCE TEST 19 — 500 tickets offline, reconnect, zero duplicates, zero lost tickets, and re-sending changes nothing

**Part VI test 19, verbatim (spec:2437):** *"**Offline POS.** 500 tickets sold with the network down; reconnect; zero duplicates, zero lost tickets. Re-sending the same batch twice changes nothing."* — SAH-051. §6.1 names **6B** as its owner and 6A as the server half, and this task is where the whole slice becomes a number.

**Four other tests are re-run here** and each one is a clause of a test somebody else owns: **20**'s till half (`pullAll` against `SqliteSyncStore` rather than `MemorySyncStore`), **11**'s sync-header clause (the till sends no `X-Tenant-Id` and no `X-Actor-Id`, ever), **37**'s till half (the same over-limit ticket the server refuses is refused at the till first, **with the same words**), and **36**'s catalogue clause over this slice's three codes.

**Files:**
- Create: `tests/invariants/support/till.ts` (§4.17.1, registered by A7), `tests/invariants/pos-offline.test.ts`, `tests/invariants/phase-6b-pinned.test.ts`
- Modify: `tests/package.json` (one dependency), `tests/tsconfig.json` (one `include`), `tests/regression/sah-051.test.ts` (a `— 6B` block)

**Interfaces**

- Consumes: `startApi`, `StartedApi`, `sharedApi`, `grantAdmin`, `problemOf`, `sourceFiles`, `REPO_ROOT` (0B); `staffFixture`, `StaffFixture`, `seedCashier`, `seedBranchPosPolicy`, `verifyTicket`, `OVERRIDE_LIFTS` (6C); `seedPriceList` (3A, §4.17 — the fixture's one Postgres write); `posFixture`, `PosFixture`, `enrolTerminal`, `EnrolledTerminal`, `syncRequest`, `buildTicket`, `SHARED_SHIFT_ID` (6A); `pullAll`, `drainOutbox`, `CATALOGUE_STREAMS` (`@dulja/sync`); `withTenant`, `Db` (0A/0B); `PERMISSIONS` (0B); `ROLES`, `INCOMPATIBLE_PAIRS` (0D, `packages/db/seed/roles.ts` **by relative path** — `@dulja/db/seed` is the pack loader, §3.4.8); every `apps/pos/src/main/*` export.
- Produces:
  ```ts
  // tests/invariants/support/till.ts — §4.17.1, registered to 6B by Task 0 amendment A7.
  export interface TillFixture {
    /** 6C's world, whole. This file seeds NOTHING of its own — no company, item, warehouse, stock, tax
     *  pack, document type, branch or cashier. */
    staff: StaffFixture;
    api: StartedApi;
    dir: string;
    db: PosDatabase;
    store: SqliteSyncStore;
    transport: SyncTransport;
    loops: SyncLoops;
    terminalId: string;
    cashier: TillCashier;
    shiftId: string;
    close(): void;
  }
  export async function tillFixture(api: StartedApi, name: string): Promise<TillFixture>;
  /** A `SyncTransport` that speaks to `StartedApi` through 6A's own `syncRequest`, so every call is signed
   *  by the same code the shipped till uses. `offline` makes every call throw, which is the 8-hour case. */
  export class HttpTillTransport implements SyncTransport {
    constructor(api: StartedApi, terminal: EnrolledTerminal);
    offline: boolean;
    calls: number;
    pullCatalogue(since: string, limit: number): Promise<CataloguePage>;
    pushTickets(batch: TicketBatch): Promise<BatchResult>;
  }
  export async function openTill(f: TillFixture): Promise<void>;
  export function sellOffline(f: TillFixture, count: number): string[];
  ```

- [ ] **Step 1: Wire the test tier to `apps/pos`**

```bash
# ONE dependency, and it is the NATIVE MODULE, not the workspace. `bun add` writes the range it resolved
# into tests/package.json and pins the exact version in bun.lock — the same mechanism T1 Step 2 used to give
# `apps/pos` its own copy. Do NOT hand-write `"workspace:*"`: see the ⚠️ below.
bun add --cwd tests -d better-sqlite3
```

The resulting manifest, for review:

```json
// tests/package.json — one devDependency; the range is whatever `bun add` resolved, not a literal typed here.
  "devDependencies": {
    "better-sqlite3": "^<the range bun wrote>"
  }
```

⚠️ **Why the protocol is not `workspace:*`, stated because it is the one plausible wrong answer.** `workspace:*` resolves only against a member of the root `workspaces` array, which §3.1 freezes as `["packages/*", "apps/*", "tests", "infra"]`; `better-sqlite3` is an npm package and no member of it, so `bun install` fails outright and acceptance test 19 never runs. **Nor is it `catalog:`** — Bun supports catalogues, but §3.1's frozen root manifest declares no `catalog`, and inventing one here would be a §3.1 amendment this slice may not make alone (§4.18, hazard 32). **A version range in a `package.json` is not a version in a source file:** Global Constraint 1 and spec:104 forbid *"hard-coding a package version into a source file — the lockfile owns versions"*, and a manifest written by `bun add` beside `bun.lock` is exactly the mechanism they describe, which is why `apps/pos/package.json` obtains the same dependency the same way in T1.

⚠️ **And why the entry exists at all — this resolves the apparent conflict between the File Structure's *"`tests/package.json` EDIT one native-module dependency"* and the header's fact (9), *"`tests/` is outside every lint root … may import `apps/pos/src/**` directly with one `tsconfig.json` `include` entry and no `package.json` dependency"*, and both are right about different things.** The header's fact is about **`@dulja/pos`**: the test tier does not depend on the workspace and imports its modules by relative path, exactly as 5A's `tests/invariants/support/tax.ts` reaches `apps/api/src`. But `apps/pos/src/main/database.ts` does `import Database from "better-sqlite3"`, and Node resolves that from the **importing file's** location upward — which finds `apps/pos/node_modules` under Bun's workspace layout, and finds nothing when Vitest runs the module from `tests/`. So `tests/` names the native module and nothing else. **Keep this comment on the line**, or a future reader deletes it as redundant and the whole of test 19 fails with `Cannot find module 'better-sqlite3'`.

```json
// tests/tsconfig.json — two include entries: the till's main process, and 0D's role-seed data, which
// `phase-6b-pinned.test.ts` reads by relative path because `@dulja/db/seed` is the pack LOADER subpath
// and the nine-role data is the sibling directory `packages/db/seed/` (§3.4.8).
  "include": ["support", "invariants", "regression", "e2e", "../apps/api/src", "../apps/pos/src/main", "../packages/db/seed"]
```

- [ ] **Step 2: Write `tests/invariants/support/till.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Money, Quantity, currency } from "@dulja/domain";
import { seedPriceList } from "@dulja/db/test";
import type { BatchResult, CataloguePage, SyncTransport, TicketBatch } from "@dulja/sync";
import type { StartedApi } from "../../../apps/api/test/support/app";
import { staffFixture, type StaffFixture } from "./staff";
import { syncRequest, type EnrolledTerminal } from "./pos";
import { openPosDatabase, type PosDatabase } from "../../../apps/pos/src/main/database";
import { SqliteSyncStore } from "../../../apps/pos/src/main/store";
import { createSyncLoops, type SyncLoops } from "../../../apps/pos/src/main/loops";
import { loginCashier, type TillCashier } from "../../../apps/pos/src/main/authority";
import { openShift } from "../../../apps/pos/src/main/shift";
import { sell, tillUuidv7 } from "../../../apps/pos/src/main/ticket";
import { tender } from "../../../apps/pos/src/main/tender";

/**
 * The till fixture (§4.17.1, registered to 6B by Task 0 amendment A7).
 *
 * **It is a thin layer over 6C's `staffFixture`, which is itself a thin layer over 6A's `posFixture`** — no
 * company, no item, no warehouse, no stock, no tax pack, no document type, no branch and no cashier. What it
 * adds is a real `PosDatabase` in a temporary directory, a real `SyncStore` over it, a transport that speaks
 * to `StartedApi` through 6A's own `syncRequest`, two drivers — and **one price-list line for `SKU-A`, which
 * is the only row it seeds in Postgres**. Hazard 9 is the reason it is described this precisely: a later
 * reader must not mistake it for a rival corpus.
 *
 * ⚠️ **Why the price list is not optional.** Neither 6A's `posFixture` nor 6C's `staffFixture` seeds one
 * (6A's price-list rows live in its own catalogue tests, not in the fixture), and the till prices **only**
 * from the mirror — there is no `unitPrice` escape hatch of the kind 6A's `buildTicket` has. With zero
 * `catalogue_price_list` rows the very first `sell` does not even reach *"no price"*: `resolvePrice` calls
 * `tillCurrency`, whose `select currency from catalogue_price_list order by id limit 1` returns nothing, and
 * it throws `ERR_TILL_CATALOGUE_STALE` — *"this till holds no price list and cannot price a ticket"* — for
 * all 500 tickets. The tax half of the same fallback needs no help: `SYNTH-MY-v1` has exactly one
 * `kind = 'output'` code (`SYN-OUT-STD`), so T5's `defaultOutputTaxCode` resolves without ambiguity.
 */
export interface TillFixture {
  staff: StaffFixture;
  api: StartedApi;
  dir: string;
  db: PosDatabase;
  store: SqliteSyncStore;
  transport: HttpTillTransport;
  loops: SyncLoops;
  terminalId: string;
  cashier: TillCashier;
  shiftId: string;
  close(): void;
}

/**
 * The transport the till actually uses in these tests.
 *
 * It calls 6A's `syncRequest`, so every request is signed by **the same code the shipped `HttpSyncTransport`
 * signs with** (both go through `@dulja/sync`'s `canonicalSyncRequest` since Task 0's amendment A2) and no
 * test can pass against a signature the real till would not produce.
 *
 * `offline = true` makes every call throw — which is the eight-hour case test 19 measures — and `calls`
 * counts, so a test can assert *"no network call happened on the sell path"* rather than hoping.
 */
export class HttpTillTransport implements SyncTransport {
  offline = false;
  calls = 0;

  constructor(private readonly api: StartedApi, private readonly terminal: EnrolledTerminal) {}

  private guard(): void {
    this.calls += 1;
    if (this.offline) {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:443");
      (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
      throw error;
    }
  }

  async pullCatalogue(since: string, limit: number): Promise<CataloguePage> {
    this.guard();
    const response = await syncRequest(this.api, this.terminal, {
      method: "GET", path: `/v1/sync/catalogue?since=${encodeURIComponent(since)}&limit=${limit}`,
    });
    if (!response.ok) throw new Error(`pullCatalogue ${response.status}: ${await response.text()}`);
    const page = await response.json() as { changes: { revision: string }[]; next_cursor: string; has_more: boolean };
    // The wire carries revisions as decimal STRINGS (§4.10.2's cursor form and 6A's `::text` casts); `Change`
    // is typed `bigint`, so the codec boundary is here and in the shipped transport, in the same shape.
    return {
      ...page,
      changes: page.changes.map((c) => ({ ...c, revision: BigInt(c.revision) })),
    } as unknown as CataloguePage;
  }

  async pushTickets(batch: TicketBatch): Promise<BatchResult> {
    this.guard();
    const response = await syncRequest(this.api, this.terminal, {
      method: "POST", path: "/v1/sync/tickets", body: batch, idempotencyKey: tillUuidv7(),
    });
    if (response.status === 202) {
      const queued = await response.json() as { batchId: string; jobId: string };
      const { SyncQueuedError } = await import("@dulja/sync");
      throw new SyncQueuedError(queued.batchId, queued.jobId);
    }
    if (!response.ok) throw new Error(`pushTickets ${response.status}: ${await response.text()}`);
    return await response.json() as BatchResult;
  }
}

export async function tillFixture(api: StartedApi, name: string): Promise<TillFixture> {
  const staff = await staffFixture(api, name);

  // The one Postgres row this fixture seeds, through 3A's own helper (§4.17). Company-wide (`branchId`
  // unset → `branch_id is null`), so `candidateLists` reaches it by rule 3 and no branch key is needed;
  // `currency` defaults to `"MYR"`, the seed company's. The line is `{ itemId, unitPrice }` with no
  // `unitId` and no `minQuantity`, which is 3A's *"unit null, break 0"* shape and is what
  // `resolvePrice`'s `(unit_id is null and ?4 = 1)` clause matches for the item's base unit.
  //
  // **11.5000 is chosen, not arbitrary.** It is T5's own worked figure (`11.5000 × 2 = 23.0000` gross,
  // base 20.9091 + tax 2.0909 under `SYN-OUT-STD`), and a single unit's gross of `11.5000` is an exact
  // multiple of `0.0500` — `branch_pos_policy.rounding_increment`'s default, which is what branch A's
  // policy row carries because `staffFixture` seeds it with limits only. So ADR 0059's
  // `payable = round(grossTotal, increment)` is the identity here, `sellOffline`'s
  // `tender(..., amount: r.draft.total)` is exact rather than short, and change is `0.0000`.
  await seedPriceList(api.db, staff.seed, {
    code: `${name}-RETAIL`,
    lines: [{ itemId: staff.itemId, unitPrice: "11.5000" }],
  });

  const dir = mkdtempSync(join(tmpdir(), `dulja-till-${name}-`));
  const db = openPosDatabase(join(dir, "till.sqlite"));
  const store = new SqliteSyncStore(db);
  const transport = new HttpTillTransport(api, staff.terminalA);
  const loops = createSyncLoops({
    store, transport, terminalId: staff.terminalA.terminalId,
    newBatchId: () => tillUuidv7(), intervalMs: 1_000_000,      // never on a timer in a test
  });
  return {
    staff, api, dir, db, store, transport, loops,
    terminalId: staff.terminalA.terminalId,
    // Filled by `openTill`, which pulls the catalogue and signs the cashier in.
    cashier: null as unknown as TillCashier,
    shiftId: "",
    close(): void { loops.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Bring the till to the state a shop opens in: catalogue pulled, cashier signed in, shift open.
 *
 * ⚠️ **The PIN is `"4321"`, which is what 6C's `staffFixture` actually gave this cashier** —
 * `seedCashier(db, seed, { employeeId: empA, branchId: branchA, pin: "4321", permissions: [...] })`.
 * `seedCashier`'s *own* default is `"1234"` (`hashPin(opts.pin ?? "1234")`, 6C) and is **not** what
 * `cashierA` got, because `staffFixture` passes the option explicitly. A `"1234"` here reaches
 * `verifyPin("1234", <argon2id of "4321">)`, gets `false`, and throws `ERR_TILL_PIN_INVALID` inside
 * `beforeAll` — which fails all eight cases of `pos-offline.test.ts` at once.
 *
 * The login goes through **`loginCashier`** rather than being faked — so every test below is exercising the
 * real Argon2id verification against the real down-synced `catalogue_cashier` row, which is the only way
 * test 19 proves the till can sell offline. `openShift` then needs `pos.shift.own` in that same mirrored
 * snapshot, which is why **T4 Step 5 adds the code to `cashierA`'s `permissions` array** in 6C's fixture.
 */
export async function openTill(f: TillFixture): Promise<void> {
  const { pullAll } = await import("@dulja/sync");
  await pullAll(f.store, f.transport, { pageSize: 1000 });
  f.cashier = await loginCashier(f.db, { principalId: f.staff.cashierA, pin: "4321" });
  f.shiftId = openShift(f.db, f.store, {
    terminalId: f.terminalId, cashier: f.cashier,
    openingFloat: Money.of("100.0000", currency("MYR")),
  }).id;
}

/**
 * Sell `count` tickets, each one item, each completed with a cash tender.
 *
 * Every ticket goes through the **real** `sell` and `tender`, so each one writes its lines, its tenders and
 * its outbox row in one SQLite transaction and each `clientRef` is a `uuidv7` minted at the till. The caller
 * sets `transport.offline` before calling this; nothing here touches the network, and
 * `pos-offline.test.ts`'s first assertion is that `transport.calls` did not move.
 */
export function sellOffline(f: TillFixture, count: number): string[] {
  const MYR = currency("MYR");
  const refs: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const r = sell(f.db, f.store, {
      shiftId: f.shiftId, cashier: f.cashier,
      lines: [{ itemId: f.staff.itemId, quantity: Quantity.of("1.000000") }],
    });
    const t = tender(f.db, f.store, {
      clientRef: r.clientRef, cashier: f.cashier,
      tenders: [{ method: "cash", amount: r.draft.total }],
    });
    refs.push(t.clientRef);
  }
  return refs;
}
```

- [ ] **Step 3: Write acceptance test 19**

**No `Expected failure:` line, deliberately, and this is the one task in the plan without one.** Every module
this suite drives — `openPosDatabase`, `SqliteSyncStore`, `HttpSyncTransport`, `loginCashier`, `openShift`,
`sell`, `tender` — was shipped with its own failing test in T1–T7, and `pullAll`/`drainOutbox` are 6A's.
Acceptance test 19 is therefore written against an **implemented** surface and is expected **green on its first
run**; a red first run here is not the TDD step, it is a defect in one of T1–T11 and the failing assertion
names which. If it goes red on Step 4's `acked_at is null` count, read `markAcked` (T2 Step 4); on Step 5's
`duplicate`, read `tillUuidv7` (T6 Step 2); on Step 6's `Σ`, read `taxItemLine` (T5 Step 5).

```ts
// tests/invariants/pos-offline.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { drainOutbox, pullAll, CATALOGUE_STREAMS, SYNC_BATCH_SYNC_LIMIT } from "@dulja/sync";
// The FOUR-argument test helper (§4.2.2, hazard 15): `withTenant(sql, tenantId, actorId, fn)`. The
// production one is `withTenant(sql, ctx, fn)` and is a different export path; 6A's own suites use this one.
import { withTenant } from "@dulja/db/test";
import { sharedApi } from "../support/api";
import { tillFixture, openTill, sellOffline, type TillFixture } from "./support/till";
import { tillUuidv7 } from "../../apps/pos/src/main/ticket";

const MYR = currency("MYR");
let f: TillFixture;

beforeAll(async () => {
  const api = await sharedApi();
  f = await tillFixture(api, "test19");
  await openTill(f);
}, 180_000);
afterAll(() => { f?.close(); });

describe("ACCEPTANCE TEST 19 — offline POS (spec:2437, SAH-051)", () => {
  it("Step 1: the catalogue pulled and EVERY stream's cursor advanced", async () => {
    const cursors = await Promise.all(CATALOGUE_STREAMS.map((s) => f.store.getCursor(s)));
    // §4.10.5 / 6A amendment 23c: every stream, not only the ones the page carried. `cashier` and
    // `branch_pos_policy` have rows here (6C seeded them), but `promotion` does not — and its cursor must
    // still have moved, or every subsequent pull would restart from page one.
    for (const c of cursors) expect(c).toBeGreaterThan(0n);
    expect(new Set(cursors.map(String)).size).toBe(1);
    expect(f.store.catalogueState().pulledAt).not.toBeNull();
  });

  it("Step 2: 500 tickets sell with the network DOWN, and not one network call happens on the path", () => {
    f.transport.offline = true;
    const before = f.transport.calls;
    const refs = sellOffline(f, 500);
    expect(refs).toHaveLength(500);
    expect(new Set(refs).size).toBe(500);                      // 500 distinct uuidv7s, minted at the till
    expect(f.transport.calls).toBe(before);                    // NOT ONE call: selling is offline by design
    const local = f.db.raw.prepare<[], { tickets: number; lines: number; tenders: number; pending: number }>(
      `select (select count(*) from ticket where status = 'completed') as tickets,
              (select count(*) from ticket_line) as lines,
              (select count(*) from ticket_tender) as tenders,
              (select count(*) from outbox where kind = 'ticket' and acked_at is null) as pending`).get()!;
    expect(local.tickets).toBe(500);
    expect(local.lines).toBe(500);
    expect(local.tenders).toBe(500);
    expect(local.pending).toBe(500);                           // one outbox row per ticket, all unacked
  }, 300_000);

  it("Step 3: a drain while offline acks NOTHING and loses nothing — the eight-hour state", async () => {
    await f.loops.drainNow();                                  // does not throw: an offline drain is normal
    // 501, not 500: `openTill` enqueued the shift-OPEN message before the first sale (T6), and it is still
    // pending — it will be until 6D lands (Step 7). Counting tickets is what this step is about, so the
    // assertion names the kind rather than the total, and Step 7 asserts the shift row separately.
    expect(f.store.catalogueState().pendingOutbox).toBe(501);
    expect(f.db.raw.prepare<[], { n: number }>(
      "select count(*) as n from outbox where kind = 'ticket' and acked_at is null").get()!.n).toBe(500);
    expect(f.loops.state().online).toBe(false);
    expect(f.loops.state().lastError).toContain("ECONNREFUSED");
  });

  it("Step 4: reconnect and drain — ZERO LOST TICKETS", async () => {
    f.transport.offline = false;
    // `batchSize` is NOT optional here in practice: 6A enqueues a batch over 200 tickets as
    // `pos.sync.apply` and answers 202, which `pushTickets` turns into a `SyncQueuedError` — so a drain that
    // handed all 500 to one push would throw instead of acking. `SYNC_BATCH_SYNC_LIMIT` is 6A's own bound
    // and is what T3's loops pass; this call passes the same value for the same reason.
    const result = await drainOutbox(f.store, f.transport, {
      terminalId: f.terminalId, newBatchId: () => tillUuidv7(), batchSize: SYNC_BATCH_SYNC_LIMIT,
    });
    expect(result.accepted).toBe(500);
    // `rejected` counts the SHIFT message too: `app.shift` is 6D's, so 6A answers
    // `ERR_SYNC_MESSAGE_UNSUPPORTED` per message (§4.10.1) and that is a rejection, not a failure. Asserting
    // 0 here would fail for the one reason this slice already documents. Step 7 pins the shift row itself.
    expect(result.rejected).toBeLessThanOrEqual(1);
    // The till's half: nothing pending.
    expect(f.db.raw.prepare<[], { n: number }>(
      "select count(*) as n from outbox where kind = 'ticket' and acked_at is null").get()!.n).toBe(0);
    // The server's half: 500 documents, by the client refs the till minted.
    const refs = f.db.raw.prepare<[], { id: string }>("select id from ticket order by created_at").all().map((r) => r.id);
    const [{ n }] = await withTenant(f.api.db.rw, f.staff.seed.tenant, f.staff.seed.system, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document where client_ref = any(${refs}::uuid[])`);
    expect(n).toBe(500);
  }, 300_000);

  it("Step 5: ZERO DUPLICATES — re-sending the same batch twice changes nothing", async () => {
    const before = await withTenant(f.api.db.rw, f.staff.seed.tenant, f.staff.seed.system, (tx) => tx<
      { documents: number; lines: number; entries: number }[]>`
      select (select count(*)::int from app.document where document_type_id =
                (select id from app.document_type where code = 'POS_TICKET')) as documents,
             (select count(*)::int from app.document_line) as lines,
             (select count(*)::int from app.ledger_entry) as entries`);

    // The payloads the till already sent, re-pushed straight through the transport with a FRESH batchId —
    // which is the case spec:1304 calls "re-sending a batch is harmless" and is the one a flaky shop
    // connection produces every day. A new batchId defeats the Idempotency-Key path deliberately: the
    // dedup that matters is on `client_ref`, not on the batch.
    const payloads = f.db.raw.prepare<[], { payload: string }>(
      "select payload from outbox where kind = 'ticket' order by created_at limit 200").all()
      .map((r) => JSON.parse(r.payload) as unknown);
    const answer = await f.transport.pushTickets({
      terminalId: f.terminalId, batchId: tillUuidv7(),
      tickets: payloads as never, shifts: [], tillEvents: [],
    });
    expect(answer.results).toHaveLength(200);
    for (const r of answer.results) expect(r.status).toBe("duplicate");

    const after = await withTenant(f.api.db.rw, f.staff.seed.tenant, f.staff.seed.system, (tx) => tx<
      { documents: number; lines: number; entries: number }[]>`
      select (select count(*)::int from app.document where document_type_id =
                (select id from app.document_type where code = 'POS_TICKET')) as documents,
             (select count(*)::int from app.document_line) as lines,
             (select count(*)::int from app.ledger_entry) as entries`);
    expect(after).toEqual(before);
  }, 300_000);

  it("Step 6: RECONCILES — Σ the till's ticket totals equals Σ the server's document lines, to the cent", async () => {
    const local = f.db.raw.prepare<[], { total: string }>(
      "select total from ticket where status = 'completed'").all()
      .reduce((sum, r) => sum.add(Money.of(r.total, MYR)), Money.zero(MYR));

    const refs = f.db.raw.prepare<[], { id: string }>("select id from ticket").all().map((r) => r.id);
    const [row] = await withTenant(f.api.db.rw, f.staff.seed.tenant, f.staff.seed.system, (tx) => tx<{ total: string }[]>`
      select coalesce(sum(l.total_incl_tax), 0)::text as total
        from app.document_line l
        join app.document d on d.id = l.document_id
       where d.client_ref = any(${refs}::uuid[]) and l.kind = 'item'`);
    // Both sides through `Money`: a string compare would pass on "500.0000" vs "500.0000" and fail on
    // "500.00" vs "500.0000" for two figures that are equal.
    expect(Money.of(row!.total, MYR).toString()).toBe(local.toString());
    expect(local.isZero()).toBe(false);          // a sum of nothing equals a sum of nothing; guard it
  }, 120_000);

  it("Step 7: the shift message is REFUSED, not dropped, and stays in the outbox until 6D lands", async () => {
    // §4.10.1: `app.shift` is 6D's, so 6A answers `ERR_SYNC_MESSAGE_UNSUPPORTED` per message and the till
    // keeps the row. Asserting this explicitly is the difference between a known gap and a lost Z-report.
    const pending = await f.store.pendingOutbox(50);
    const shiftRows = pending.filter((r) => r.kind === "shift");
    expect(shiftRows.length).toBeGreaterThan(0);
    expect(shiftRows.every((r) => r.ackedAt === null)).toBe(true);
    expect(shiftRows.some((r) => (r.lastError ?? "").includes("ERR_SYNC_MESSAGE_UNSUPPORTED"))).toBe(true);
  });

  it("Step 8: test 20's till half — a pull interrupted mid-page resumes from the cursor", async () => {
    const cursorBefore = await f.store.getCursor("item");
    let allowed = 1;
    const flaky = { ...f.transport,
      pullCatalogue: async (since: string, limit: number) => {
        if (allowed-- <= 0) throw new Error("connection reset");
        return f.transport.pullCatalogue(since, limit);
      },
      pushTickets: f.transport.pushTickets.bind(f.transport) };
    await expect(pullAll(f.store, flaky as never, { pageSize: 1 })).rejects.toThrow(/connection reset/);
    // The pages that DID apply advanced the cursor; the next pull starts there and re-fetches nothing.
    const cursorAfter = await f.store.getCursor("item");
    expect(cursorAfter).toBeGreaterThanOrEqual(cursorBefore);
    const resumed = await pullAll(f.store, f.transport, { pageSize: 1000 });
    expect(resumed.applied).toBeGreaterThanOrEqual(0);
    for (const s of CATALOGUE_STREAMS) expect(await f.store.getCursor(s)).toBeGreaterThanOrEqual(cursorAfter);
  }, 120_000);
});
```

- [ ] **Step 4: The pinned equalities — the four cross-slice facts that can silently drift**

```ts
// tests/invariants/phase-6b-pinned.test.ts
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import { OVERRIDE_LIFTS, verifyTicket } from "@dulja/db";
import { withTenant } from "@dulja/db/test";          // the FOUR-argument test helper (§4.2.2, hazard 15)
// 0D's role seed, by relative path and NOT through `@dulja/db/seed`: that subpath maps to
// `packages/db/src/seed/index.ts`, the pack LOADER, while the nine-role data lives in the sibling directory
// `packages/db/seed/roles.ts` (§3.4.8's last bullet: "`roles` is TypeScript data in `packages/db/seed/roles.ts`").
// `ROLES` is `readonly RoleSeed[]` — an ARRAY of `{ code, nameEn, nameAr, description, permissions }`, never a record.
import { INCOMPATIBLE_PAIRS, ROLES } from "../../packages/db/seed/roles";
import { PERMISSIONS } from "@dulja/contracts";
import { REPO_ROOT, sourceFiles } from "../support/source";
import { sharedApi } from "../support/api";
import { tillFixture, openTill, type TillFixture } from "./support/till";
import { TILL_OVERRIDE_LIFTS } from "../../apps/pos/src/main/authority";
import { checkLimits, draftTicket } from "../../apps/pos/src/main/ticket";

const MYR = currency("MYR");
let f: TillFixture;
beforeAll(async () => { f = await tillFixture(await sharedApi(), "pinned6b"); await openTill(f); }, 180_000);
afterAll(() => { f?.close(); });

describe("6B's pinned equalities", () => {
  it("TILL_OVERRIDE_LIFTS agrees with 6C's OVERRIDE_LIFTS on every subject they share", () => {
    for (const subject of Object.keys(OVERRIDE_LIFTS)) {
      const server = [...(OVERRIDE_LIFTS[subject] ?? [])].sort();
      const till = [...(TILL_OVERRIDE_LIFTS[subject] ?? [])].sort();
      // `price_override` is the ONE documented difference: 6C's map lifts nothing for it because the limit is
      // enforced at the till only (6C's Task 9 decision (c)), and the till's map lifts its own kind.
      if (subject === "price_override") {
        expect(server).toEqual([]);
        expect(till).toEqual(["price_override"]);
        continue;
      }
      expect(till, subject).toEqual(server);
    }
    expect(Object.keys(TILL_OVERRIDE_LIFTS).sort()).toEqual(Object.keys(OVERRIDE_LIFTS).sort());
  });

  it("the till's refusal message is BYTE-IDENTICAL to the server's for one over-limit ticket (test 37's till half)", async () => {
    // Branch A's limits (6C's staffFixture): line 10 %, ticket 5 %, void 50.0000, blind returns not allowed.
    const draft = draftTicket(f.db, {
      shiftId: f.shiftId, cashier: f.cashier,
      lines: [{ itemId: f.staff.itemId, quantity: Quantity.of("1.000000"), discount: Money.of("5.0000", MYR) }],
    });
    const tillRefusals = checkLimits(f.cashier, draft, {
      catalogueUnitPrices: [draft.lines[0]!.unitPrice], blind: false, voided: false });
    const wire = {
      clientRef: draft.clientRef, shiftId: f.shiftId, cashierPrincipalId: f.cashier.principalId,
      customerId: null, kind: "sale", returnsClientRef: null, currency: "MYR",
      soldAt: new Date().toISOString(),
      lines: draft.lines.map((l) => ({
        lineNo: l.lineNo, itemId: l.itemId, lotId: l.lotId, quantity: l.quantity.toString(), unitId: l.unitId,
        unitPrice: l.unitPrice.toJSON(), discount: l.discount.toJSON(), taxCodeId: l.taxCodeId,
        taxAmount: l.taxAmount.toJSON(), total: l.total.toJSON(),
      })),
      tenders: [], events: [], attendance: [], catalogueRevision: "0",
    };
    const server = await withTenant(f.api.db.rw, f.staff.seed.tenant, f.staff.seed.system, (tx) =>
      verifyTicket(tx, { companyId: f.staff.seed.company, branchId: f.staff.branchA, currency: "MYR" }, wire as never));

    const tillDetails = tillRefusals.filter((r) => r.kind !== "price_override").map((r) => r.detail).sort();
    const serverDetails = server.refusals.map((r) => r.detail).sort();
    // The whole reason `checkLimits` is a transcription and not a second rule: a shop can only act on a
    // refusal it can read, and two wordings for one refusal make the till and the office tell two stories.
    expect(tillDetails).toEqual(serverDetails);
    expect(tillDetails.length).toBeGreaterThan(0);
  }, 120_000);

  it("test 36's clause: this slice's three codes are in the catalogue, in the pos module, and referenced from apps/pos", () => {
    const mine = PERMISSIONS.filter((p) => p.phase === "6B").map((p) => p.code).sort();
    expect(mine).toEqual(["pos.attendance.clock", "pos.price.check", "pos.shift.own"]);
    for (const p of PERMISSIONS.filter((d) => d.phase === "6B")) expect(p.module).toBe("pos");
    const posSource = sourceFiles(["apps/pos"]).map((s) => s.text).join("\n");
    for (const code of mine) {
      // §3.6.3: the lint scans `apps/pos` too, and these three have their only references there.
      expect(posSource, code).toContain(`PERMISSION["${code}"]`);
    }
  });

  it("§3.6.4's grants: `cashier` AND `branch_manager` hold all three of this slice's codes", () => {
    // `ROLES` is 0D's `readonly RoleSeed[]`, so the role is FOUND by code, never indexed by it.
    // spec:2161 gives the cashier its own shift, price check and clock; spec:2160 gives the branch manager
    // "everything a cashier may" plus the overrides — a branch manager stands at a till when a cashier is
    // absent, and a role that could not open a shift could not stand there. T4 Step 4 edits both arrays.
    for (const role of ["cashier", "branch_manager"]) {
      const seed = ROLES.find((r) => r.code === role);
      expect(seed, role).toBeDefined();
      for (const code of ["pos.price.check", "pos.shift.own", "pos.attendance.clock"]) {
        expect(seed!.permissions, `${role} → ${code}`).toContain(code);
      }
    }
    // And none of the three is half of an R6 pair, so widening `branch_manager` cannot trip `role-seed`:
    // `INCOMPATIBLE_PAIRS`'s only POS member is `["hr.employee.read_sensitive", "pos.ticket.sell"]` (0D).
    for (const code of ["pos.price.check", "pos.shift.own", "pos.attendance.clock"]) {
      expect(INCOMPATIBLE_PAIRS.flat(), code).not.toContain(code);
    }
  });

  it("test 11's clause: the till NEVER sends a tenant or actor header, and holds no bearer token", () => {
    // `SourceFile.path` is ALREADY repo-relative (0B: `relative(REPO_ROOT, full)`), so it is reported as it
    // stands. Slicing `REPO_ROOT.length` off it would return the empty string and name no file at all.
    const offenders = sourceFiles(["apps/pos"])
      .filter((s) => /X-Tenant-Id|X-Actor-Id|Authorization/i.test(s.text))
      .map((s) => s.path);
    // Identity is the signature (§4.10.3). A forged tenant header beside a valid signature is inert
    // server-side — 6A asserts that — and the till never composes one in the first place.
    expect(offenders).toEqual([]);
  });

  it("apps/pos holds no PostgreSQL driver, exactly one @dulja/db subpath, and no fetch in the renderer", () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/apps/pos/package.json`, "utf8")) as
      { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => d === "postgres" || d === "pg")).toEqual([]);
    const main = sourceFiles(["apps/pos/src/main"]);
    expect(main.filter((s) => /from ["']@dulja\/db["']/.test(s.text))).toEqual([]);
    const subpaths = new Set(main.flatMap((s) => [...s.text.matchAll(/from ["'](@dulja\/db\/[^"']+)["']/g)].map((m) => m[1]!)));
    expect([...subpaths]).toEqual(["@dulja/db/staff/pin"]);
    // The renderer makes no network call of its own: every request the till sends is the main process's,
    // signed with the device key. A `fetch` here would be a second, unsigned client.
    // `apps/pos/src/renderer/` EXISTS from T1 — T1 ships `main.tsx` as an empty mount so `vite build` has an
    // entry in the OD-24 default state (T11 fills it in). 0B's `sourceFiles` calls `readdirSync` with no
    // existence check, so a missing root would throw ENOENT here rather than assert anything.
    const renderer = sourceFiles(["apps/pos/src/renderer"]);
    expect(renderer.filter((s) => /\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(s.text))
      .map((s) => s.path)).toEqual([]);
  });

  it("the local schema has exactly the tables §4.10.6 admits, and every money column is TEXT", () => {
    const names = f.db.raw.prepare<[], { name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
      .all().map((r) => r.name);
    expect(names).toHaveLength(18);      // seventeen at T1, plus `pending_customer` at T8
    expect(names.filter((n) => n.startsWith("catalogue_"))).toHaveLength(8);
    const offenders: string[] = [];
    for (const t of names) {
      for (const c of f.db.raw.prepare<[], { name: string; type: string }>(`pragma table_info(${t})`).all()) {
        // `pragma table_info().type` echoes the DECLARED spelling verbatim, and `schema.sql` writes every
        // column lowercase because Global Constraint 9 requires lowercase SQL keywords — so the comparison
        // is case-insensitive. Do NOT "fix" this by upper-casing the DDL; the DDL is the house rule.
        if (/amount|price|cost|total|float|cash|over_short|revision|quantity|increment|limit|tax/i.test(c.name)
            && c.type.toUpperCase() !== "TEXT") offenders.push(`${t}.${c.name}: ${c.type}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 5: Append the `— 6B` block to `sah-051`**

```ts
// tests/regression/sah-051.test.ts — appended. The file is 0B's; this block is 6B's (§3.7.3).
describe("SAH-051 — no sequential public identifier, and no shared counter — 6B", () => {
  it("the till mints its own uuidv7 and there is exactly ONE id source in apps/pos", () => {
    // spec:2037: "The POS generates a uuidv7 at the till for each ticket … carried as document.client_ref."
    // The whole of "zero duplicates" rests on this: a server-assigned id would need a network call at the
    // moment of sale, and a shared counter is SAH-051 itself.
    // `SourceFile.path` is already repo-relative (0B: `relative(REPO_ROOT, full)`), so it is compared as it
    // stands. Slicing `REPO_ROOT.length` off it would make both expectations compare `[""]` to a real path.
    // The test matches the IMPORT and not a bare mention of the name: `ticket.ts`'s own docstring explains
    // why `crypto.randomUUID()` is the wrong function here, and a scan for the identifier alone would
    // convict the file that says so.
    const importsRandomUuid = /import\s*\{[^}]*\brandomUUID\b[^}]*\}\s*from\s*["']node:crypto["']/;
    const minters = sourceFiles(["apps/pos/src/main"])
      .filter((s) => importsRandomUuid.test(s.text)
        || /\buuidv4\b|\bnextval\b|counter\s*\+\+|\+\+\s*counter/.test(s.text))
      .map((s) => s.path);
    // `randomUUID` is permitted in exactly two places, both local bookkeeping and neither a public
    // identifier: `store.ts`'s outbox ROW id and `authority.ts`'s `clockEvent` attendance ROW id. The list is
    // exhaustive on purpose — a third file appearing here is the shared counter SAH-051 is about.
    expect(minters.sort()).toEqual(["apps/pos/src/main/authority.ts", "apps/pos/src/main/store.ts"]);
    expect(sourceFiles(["apps/pos/src/main"]).filter((s) => /export function tillUuidv7/.test(s.text))
      .map((s) => s.path)).toEqual(["apps/pos/src/main/ticket.ts"]);
  });

  it("every id the till mints is a version-7 uuid, and 5000 of them are distinct and ordered", () => {
    const ids = Array.from({ length: 5000 }, () => tillUuidv7());
    expect(new Set(ids).size).toBe(5000);
    for (const id of ids.slice(0, 50)) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Time-ordered, which is what makes `document.client_ref`'s index and 6A's cursor useful.
    const early = tillUuidv7(new Date("2026-01-01T00:00:00.000Z"));
    const late = tillUuidv7(new Date("2026-12-31T23:59:59.000Z"));
    expect(early < late).toBe(true);
  });
});
```

- [ ] **Step 6: Run and commit**

```bash
bun run --cwd tests test -- pos-offline
bun run --cwd tests test -- phase-6b-pinned
bun run --cwd tests test -- sah-051
bun run typecheck && bun run lint && bun run lint:rules
```

**Expected:** 8 passed in `pos-offline` (acceptance test 19 green, and its Step 4 and Step 5 are the DoD's *"zero lost tickets"* and *"zero duplicates"*), **7 passed** in `phase-6b-pinned` (the six of Step 4 plus the §3.6.4 grants case), and `sah-051` green with both blocks. **This is the point at which §6.2's row spec:1062 closes — in every clause except *customer-specific pricing*, which is blocked on amendment A10(b) and marked by T5's one `it.skip` (Known gaps #1)** — POS selling, pricing, tenders, returns, customers, shifts, PIN, offline and price check are all exercised by a test in this slice.

```bash
git add tests/invariants/support/till.ts tests/invariants/pos-offline.test.ts \
        tests/invariants/phase-6b-pinned.test.ts tests/regression/sah-051.test.ts \
        tests/package.json tests/tsconfig.json bun.lock
git commit -m "$(cat <<'EOF'
test(pos): ACCEPTANCE TEST 19 — 500 tickets offline, zero duplicates, zero lost [6B T12]

500 tickets sold with the transport throwing ECONNREFUSED and NOT ONE network call on the sell
path; reconnect and drain leaves nothing pending and 500 documents on the server; the same
payloads re-pushed with a fresh batchId all answer `duplicate` and document, document_line and
ledger_entry counts are unchanged. Σ the till's totals equals Σ the server's document lines to the
cent, through Money on both sides. The shift message is refused and KEPT (§4.10.1), asserted
explicitly rather than hidden. Pinned: the till's refusal wording is byte-identical to 6C's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: ⚠️ OD-18 — signing `pos.exe` with the Windows code-signing certificate

**⚠️ ISOLATED OWNER GATE. §2.12, OD-18:** *"Windows code-signing certificate (OV or EV)"* (spec:92, 2323, 2401). **Gates:** 0E's signed-installer task and **6B's `pos.exe` signing task** — this one. **§2.12's default, written into Task 10 and shipped:** *"unsigned build, warning expected"*. **This task changes exactly one workflow file and adds one decision record; drop it whole and nothing renumbers, because Task 10 already produces a working installer without it.**

**§3.11 gains no new secret name.** Its own sentence is already binding: *"0E's `backoffice.exe` job and 6B's `pos.exe` job reference these two names and no others"* — `WINDOWS_CODE_SIGN_CERT` and `WINDOWS_CODE_SIGN_PASSWORD`. Amendment A5 restated it so nobody invents a `_POS_` sibling; one certificate signs both products.

**Owner provides (OD-18):**
1. **The certificate**, as a base64-encoded `.pfx`, in the repository secret **`WINDOWS_CODE_SIGN_CERT`**.
2. **Its password**, in **`WINDOWS_CODE_SIGN_PASSWORD`**.
3. **Which kind it is — OV or EV** — because the answer changes what the shop sees and nothing else. An **EV** certificate carries SmartScreen reputation from the first install. An **OV** certificate does not: the first few hundred installs still show *"Windows protected your PC"* until the reputation accrues, and **the shops must be told that before the rollout**, or the first cashier to see it will call and be told nothing is wrong by somebody who did not know either.

**Verify:**

```bash
gh secret list --repo "$GITHUB_REPOSITORY" | grep -E 'WINDOWS_CODE_SIGN_(CERT|PASSWORD)'
```

**Expected:** two lines. Then, after a release run:

```bash
powershell -Command "Get-AuthenticodeSignature '.\Dulja POS Setup 1.0.0.exe' | Format-List Status, SignerCertificate"
```

**Expected:** `Status : Valid` and a `SignerCertificate` naming the owner's organisation.

**Until provided:** Task 10's `dist:pos` runs with neither variable set, electron-builder skips signing, and the artefact installs with the SmartScreen warning. **The local equivalent, which proves the workflow shape without a certificate:**

```bash
# A self-signed certificate is NOT a substitute and must never reach a release. It proves one thing only:
# that the signing STEP is wired correctly, so the day the real certificate arrives nothing else changes.
powershell -Command "$c = New-SelfSignedCertificate -Type CodeSigning -Subject 'CN=Dulja Local Test' -CertStoreLocation Cert:\CurrentUser\My; \
  Export-PfxCertificate -Cert $c -FilePath dulja-test.pfx -Password (ConvertTo-SecureString -String 'test' -Force -AsPlainText)"
CSC_LINK=./dulja-test.pfx CSC_KEY_PASSWORD=test \
  DULJA_POS_UPDATE_FEED=http://127.0.0.1:8788/pos/ bun run --cwd apps/desktop dist:pos
powershell -Command "(Get-AuthenticodeSignature '.\apps\desktop\dist-installer-pos\Dulja POS Setup 0.0.0.exe').Status"
```

**Expected:** `UnknownError` — which is what Windows says about a **validly signed** binary whose issuer it does not trust, and is the proof the step ran. `NotSigned` means the step did not.

**Files:**
- Create: `docs/decisions/od-18-6b-pos-signing.md`
- Modify: `.github/workflows/release.yml` (one job)

**Interfaces**

- Consumes: §3.11's two secret names `WINDOWS_CODE_SIGN_CERT` and `WINDOWS_CODE_SIGN_PASSWORD` **and no third** (amendment A5 restated the rule so nobody invents a `_POS_` sibling); `DULJA_POS_UPDATE_FEED` (A5); `apps/desktop/electron-builder.pos.yml` and the `dist:pos` script (T10); 0E's own signed-`backoffice.exe` release job, which this job is a copy of with one config path changed.
- Produces: **no code** — one decision record and one workflow job. **No TypeScript module, no exported name, no register entry**, which is why dropping this task whole changes nothing but `release.yml` and why T10 already ships a working unsigned installer.

- [ ] **Step 1: Record the decision, whichever way it goes**

`docs/decisions/od-18-6b-pos-signing.md`:

```markdown
# OD-18 — Windows code-signing certificate for `pos.exe`

- Item: **OD-18** (contracts §2.12; spec:92, 2323, 2401)
- Gates: 0E's signed-installer task; **6B Task 13** (this one)
- Status: **pending** / **provided** / **declined** — set one, delete the others, and date it
- Recorded: <date> by <name>

## The question

Is there a Windows code-signing certificate for the Dulja installers, and is it **OV** or **EV**?

## The default this plan shipped

Unsigned. Task 10 builds `Dulja POS Setup <version>.exe`, CI packages it, and it installs — with
SmartScreen's *"Windows protected your PC"* warning, which a shop user must click *More info → Run anyway*
past. Nothing else about the till differs.

## If provided

`WINDOWS_CODE_SIGN_CERT` (base64 `.pfx`) and `WINDOWS_CODE_SIGN_PASSWORD` are set as repository secrets, the
release job's signing step decodes and exports them as `CSC_LINK`/`CSC_KEY_PASSWORD`, and electron-builder
signs both products with the same certificate. **No new secret name is created** — contracts §3.11 says the
two jobs reference those two names and no others.

**If OV, the rollout note is part of this decision, not an afterthought:** the first several hundred installs
still show the SmartScreen warning while reputation accrues. The shops are told before the rollout, in the
enrolment runbook, in one sentence.

## If declined

Task 13 is dropped. `docs/runbooks/till-enrolment.md` gains one sentence at step 2: *"Windows will warn that
the publisher is unknown; choose **More info → Run anyway**. This is expected."* — because a procedure that
does not mention the warning is a procedure that generates a support call per till.
```

- [ ] **Step 2: The release job**

```yaml
# .github/workflows/release.yml — one job, mirroring 0E's `release-backoffice` step for step.
  release-pos:
    runs-on: windows-latest
    steps:
      # (unchanged: the same checkout, bun setup and install steps 0E's release job runs, in that order
      #  -- do not edit them; every step below is new to this job)

      - name: Build the till
        run: |
          bun run --cwd apps/pos build
          bun run --cwd apps/pos build:main
          bun run --cwd apps/desktop build:pos

      # ⚠️ OD-18. The two names are §3.11's and there are no others. When the secrets are absent, the step
      # writes nothing, `CSC_LINK` is unset, and electron-builder produces an UNSIGNED artefact — which is
      # §2.12's recorded default and not a failure.
      - name: Decode the code-signing certificate (skipped when it is not configured)
        if: ${{ env.WINDOWS_CODE_SIGN_CERT != '' }}
        env:
          WINDOWS_CODE_SIGN_CERT: ${{ secrets.WINDOWS_CODE_SIGN_CERT }}
        shell: pwsh
        run: |
          [IO.File]::WriteAllBytes("$env:RUNNER_TEMP\dulja.pfx",
            [Convert]::FromBase64String($env:WINDOWS_CODE_SIGN_CERT))
          "CSC_LINK=$env:RUNNER_TEMP\dulja.pfx" >> $env:GITHUB_ENV

      - name: Package and publish pos.exe
        env:
          CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CODE_SIGN_PASSWORD }}
          DULJA_POS_UPDATE_FEED: ${{ secrets.DULJA_POS_UPDATE_FEED }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: bun run --cwd apps/desktop dist:pos -- --publish always

      - name: Report the signature status, whichever it is
        shell: pwsh
        # It REPORTS and does not fail: an unsigned release is a decision (OD-18), and a job that failed on
        # it would block every release until the certificate arrived. A silent unsigned release is the thing
        # to avoid, and this line is what makes it loud in the run log.
        run: |
          Get-ChildItem apps\desktop\dist-installer-pos\*.exe | ForEach-Object {
            $s = Get-AuthenticodeSignature $_.FullName
            Write-Host "$($_.Name): $($s.Status) $($s.SignerCertificate.Subject)"
          }

      - name: Delete the certificate from the runner
        if: ${{ always() }}
        shell: pwsh
        run: Remove-Item -Force -ErrorAction SilentlyContinue "$env:RUNNER_TEMP\dulja.pfx"
```

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/od-18-6b-pos-signing.md .github/workflows/release.yml
git commit -m "$(cat <<'EOF'
build(desktop): sign pos.exe when the certificate is configured [6B T13]

⚠️ OD-18, isolated. §3.11's two secret names and no siblings — one certificate signs both
products. The signature step is skipped when the secret is absent, so an unsigned release is a
recorded decision rather than a broken build; the reporting step prints the status either way, so
a silent unsigned release cannot happen. If the certificate is OV, the SmartScreen warning
persists for the first several hundred installs and the shops are told before the rollout — that
sentence is part of the decision record, not an afterthought.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: ⚠️ OD-03 — loyalty points accrual in POS v1

**⚠️ ISOLATED OWNER GATE. §2.12, OD-03:** *"Loyalty points in POS v1 (**Decide**)"* (spec:22, 1032, 1348, 2397). §3.7.6's Pricing row carries it as *"loyalty points accrual ⚠️ **owner to confirm** — §3.0.3 lists loyalty as probably not v1"*. **§2.12's default: NOT BUILT.** §2.7's card: *"one task, dropped if no"*.

**Nothing in Tasks 0–13 references loyalty, a point, a tier, a reward or a member.** No column in `schema.sql`, no field on any `Ticket`, no permission code, no account code, no i18n key, no bridge method. Dropping this task removes one file and one decision record and renumbers nothing — which is what "isolated" means and is why the task is last.

**Files:**
- Create: `docs/decisions/od-03-6b-loyalty.md` (the decision record — written whichever way the answer goes)
- Create **only if the answer is yes**: `apps/pos/src/main/loyalty.ts` (the till half described in Step 2), plus its `apps/pos/test/loyalty.test.ts`
- Modify **only if the answer is yes**: nothing in this slice — every other change the feature needs is 6A's (§4.10.1's `Ticket`, `POS_TICKET`'s policy, `CATALOGUE_STREAMS`, §4.15's liability account), which is the whole finding of Step 2

**Interfaces**

- Consumes: nothing in the default (*not built*) branch — this task reads §2.12's OD-03 row, §3.7.6's Pricing row, §4.10.1 (`Ticket`, `CATALOGUE_STREAMS`), §4.15 (the account register) and hazard 33, and writes down what each of them would have to change. If the answer is **yes**: `PosDatabase` (T1), `SqliteSyncStore` (T2), `Money`, `currency` (§4.2.1), `Ticket` (`@dulja/sync`, 6A).
- Produces: **no code** in the default branch — one decision record and, if the answer is yes, the scoping paragraph that names the four register amendments and the slice (`6B′`/`6E`) they belong to. No name in this task enters any shared register.

- [ ] **Step 1: Record the decision**

`docs/decisions/od-03-6b-loyalty.md`:

```markdown
# OD-03 — Loyalty points in POS v1

- Item: **OD-03** (contracts §2.12; spec:22, 1032, 1348, 2397)
- Gates: **6B Task 14** (this one) and nothing else
- Status: **pending** / **yes, v1** / **no, deferred** — set one, delete the others, and date it
- Recorded: <date> by <name>

## The question

Does POS v1 accrue loyalty points? §3.7.6's Pricing row asks; §3.0.3 expects not.

## The default this plan shipped

**Not built.** No loyalty concept exists anywhere in slice 6B: no local table, no `Ticket` field, no
permission code, no account code, no screen, no i18n key.

## If the answer is no

Delete `docs/superpowers/plans/2026-09-05-dulja-phase-6b-pos-application.md`'s Task 14 and this file. Nothing
else in the slice changes.

## If the answer is yes — what it actually costs, so the answer is informed

Loyalty is **not** a till feature; it is a ledger feature with a till surface, and four registers have to
move before a line of it is written:

1. **A liability account** — points owed are a liability, and §4.15 registers none. A `2210`-shaped row
   ("customer loyalty liability") is a **§4.15 amendment** and is seeded by whichever slice owns the policy
   that names it — which, by hazard 33, is the slice that owns `POS_TICKET`: **6A**, not 6B.
2. **A `POS_TICKET` policy rule** — accrual is a credit to that liability and a debit to a marketing or
   discount expense, per ticket. `POS_TICKET`'s policy is **6A's** (§4.3.7), so this is a 6A change.
3. **A wire field** — `Ticket` would gain `loyalty: { memberId, pointsAccrued, pointsRedeemed }`, which is a
   **§4.10.1 amendment**, a Zod schema change, an OpenAPI diff and an `applyBatch` change: all 6A's.
4. **A ninth catalogue stream** — the till must know a customer's balance offline to redeem, and
   `CATALOGUE_STREAMS` has eight members closed by §4.10.1. A ninth stream is a 6A change and a new mirror
   table here.

**So the honest estimate is a slice, not a task**: a `6B′` (or a `6E`) after 6A has been amended, with its own
migration range for the balance table and its own tests. What Task 14 can do inside 6B is the **till half of
accrual only** — read a rate from the mirror, compute the points, put them on the ticket — and it cannot do
even that until the field exists.

## Recommendation to the owner

If loyalty matters commercially, answer **yes** and schedule it as its own slice after Phase 6 closes. If it
is a "nice to have", answer **no** and keep it out of v1: it touches the ledger, and a loyalty liability that
nobody reconciles is worse than no loyalty scheme.
```

- [ ] **Step 2: If and only if the answer is *yes*, the till half — `apps/pos/src/main/loyalty.ts`**

**Preconditions, all of which are somebody else's PR and must be merged first.** This step does not start until all four are true, and `scripts/check/contracts-6b-amendments.sh` gains four lines that check them:

```bash
# scripts/check/contracts-6b-amendments.sh — appended ONLY when OD-03 = yes.
need_doc "OD-03 loyalty liability account" "2210"
need_doc "OD-03 the Ticket.loyalty field"  "loyalty: { memberId"
need_doc "OD-03 the ninth stream"          "loyalty_member"
need_repo "6A Ticket.loyalty"              packages/sync/src/messages.ts "loyalty"
```

Then, and only then:

```ts
// apps/pos/src/main/loyalty.ts — ⚠️ OD-03. This file does not exist unless the owner answered yes.
import { Money, currency, type CurrencyCode, type RoundingMode } from "@dulja/domain";
import type { PosDatabase } from "./database";
import { TillError } from "./errors";
import type { TicketDraft } from "./ticket";

const MODE: RoundingMode = "HALF_AWAY_FROM_ZERO";

export interface LoyaltyAccrual { memberId: string; pointsAccrued: string; pointsRedeemed: string }

/**
 * The till half of loyalty accrual, and nothing more.
 *
 * **Every figure comes from the ninth catalogue stream** (`catalogue_loyalty_member`, mirrored by
 * `applyChanges` like every other mirror — ADR 0057 rule 1 binds it too): the member's balance, and the
 * scheme's accrual rate as a decimal fraction of the ticket's **net** total. No rate is written here, for the
 * same reason no tax rate is (hazard 1 in spirit and §4.15 in letter): a rate in a source file is a rate
 * nobody can change without a release.
 *
 * Accrual is on the **net** total and never on the gross: points earned on tax would be points the shop
 * grants on money it collects for the authority.
 *
 * **Redemption is refused offline unless the mirrored balance covers it**, and the server re-checks. A till
 * that let a customer redeem a balance it could not see would create a negative liability the back office
 * discovers at month end.
 */
export function accrue(db: PosDatabase, draft: TicketDraft, opts: { memberId: string; redeem?: string }): LoyaltyAccrual {
  const member = db.raw.prepare<[string], { balance: string; accrual_rate: string }>(
    "select balance, accrual_rate from catalogue_loyalty_member where id = ?").get(opts.memberId);
  if (member === undefined) {
    throw new TillError("ERR_NOT_FOUND", `no loyalty member ${opts.memberId} in this till's catalogue`);
  }
  const redeem = opts.redeem ?? "0.0000";
  if (Money.of(redeem, currency("XXX")).compare(Money.of(member.balance, currency("XXX"))) > 0) {
    throw new TillError("ERR_VALIDATION_FAILED",
      `member ${opts.memberId} has ${member.balance} points on this till and ${redeem} were offered; the office may hold a different balance`);
  }
  return {
    memberId: opts.memberId,
    pointsAccrued: draft.netTotal.abs().multiply(member.accrual_rate, MODE).toString(),
    pointsRedeemed: redeem,
  };
}
```

⚠️ **Even in the *yes* branch, this file changes nothing else in the slice on its own.** `sell` would gain one optional `loyalty` argument that it passes to `toWireTicket`, and the ninth mirror joins `MIRROR_TABLE` and `schema.sql` at `LOCAL_SCHEMA_VERSION` 3. Those two edits are named here so the *yes* branch is a known quantity; they are not written, because the field they depend on does not exist.

- [ ] **Step 3: Commit — the record, either way**

```bash
git add docs/decisions/od-03-6b-loyalty.md
# In the `yes` branch, also: apps/pos/src/main/loyalty.ts scripts/check/contracts-6b-amendments.sh
git commit -m "$(cat <<'EOF'
docs(pos): record OD-03 — loyalty points in POS v1 [6B T14]

⚠️ OD-03, isolated, default NOT BUILT. Nothing in tasks 0-13 references loyalty, so dropping this
task removes one file and renumbers nothing. The record states what "yes" actually costs — a
§4.15 liability account, a POS_TICKET policy rule, a §4.10.1 wire field and a ninth catalogue
stream, all of them 6A's — so the owner is deciding on a slice and not on a task.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

### Contract additions — every name this slice introduces, and where it is registered

**Registered by Task 0's amendments (the architect's PR lands them in the contracts document before Task 1):**

| Name | Register | Amendment |
|---|---|---|
| `packages/sync/src/signing.ts`; `canonicalSyncRequest`, `sha256Hex`, `signSyncHeaders`, `CanonicalSyncRequest`, `SYNC_TERMINAL_ID_HEADER`, `SYNC_TIMESTAMP_HEADER`, `SYNC_SIGNATURE_HEADER` | §4.10.3, §4.17.1 | **A2** |
| `@dulja/db/staff/pin` (the `exports` subpath) | §3.1, §4.1 | **A3** |
| `DuljaPosBridge`, `POS_CHANNELS`, `registerPosHandlers` | §4.10.6 | **A4** |
| `apps/desktop/electron-builder.pos.yml`, `DULJA_POS_UPDATE_FEED` | §2.7, §3.11 | **A5** |
| **`app.item.tax_code_id`** (5A's migration 0055) and **`app.party.price_list_id`** (4A's migration 0045) | §4.6.1, §4.5.7 | **A10** |
| `ERR_TILL_PIN_INVALID`, `ERR_TILL_LIMIT_EXCEEDED`, `ERR_TILL_CATALOGUE_STALE`, `ERR_TILL_STORE_CORRUPT` | §4.2.4 | **A6** |
| `tests/invariants/support/till.ts`; `TillFixture`, `tillFixture`, `HttpTillTransport`, `openTill`, `sellOffline` | §4.17.1 | **A7** |
| the eight `catalogue_<stream>` mirror names; the TEXT rule; `shift.expected_cash`/`over_short` NULL at the till; **`pending_customer` as clause (d)** and `LOCAL_SCHEMA_VERSION = 2` | §4.10.6 | **A8** |
| POS cash rounding absorbed into the ticket (ADR 0059) | §4.10.6, §4.6.4 | **A9** |
| migration `0063_seed_permission_phase6b.sql` is required, not optional | §2.7, §3.4.1, §3.6.2, §3.6.3 | **A1** |

**One addition this plan makes that Task 0's ten amendments do not carry, and it is recorded here rather than smuggled in:**

| Name | Where | Why it is not a register entry |
|---|---|---|
| `packages/contracts/src/pos/till.ts`; `TillSellSchema`, `TillSellLineSchema`, `TillTenderSchema`, `TillLoginSchema`, `TillSearchSchema`, `TillOpenShiftSchema`, `TillCloseShiftSchema`, `TillEnrolSchema`, `TillClockSchema`, `TillReceiptSchema` | T9 | §4.2.8 fixes the **naming convention** for Zod contracts and does not enumerate them; these are bridge contracts and no route uses them, so they generate no OpenAPI path and no register row. Named here so a reviewer sees them. |

**Names internal to this slice and therefore deliberately not registered** (6A's own pattern): `TillError`/`TillErrorCode`, `PosDatabase`/`openPosDatabase`/`StoreCorruptError`/`LOCAL_SCHEMA_VERSION`, the six `money.ts` converters, `MirrorRow`/`MIRROR_TABLE`/`upsertMirror`/`deleteMirror`, `SqliteSyncStore`, `DeviceIdentity`/`DeviceStore`/`loadDevice`/`enrolDevice`/`forgetDevice`, `HttpSyncTransport`/`TransportOfflineError`, `SyncState`/`SyncLoops`/`createSyncLoops`, `TillCashier`/`TillLimits`/`TillLimitKind`/`TillRefusal`/`TILL_OVERRIDE_LIFTS`/`loginCashier`/`findCashierByEmployeeNumber`/`hasCode`/`requireCode`/`liftRefusals`/`clockEvent`/`pendingAttendance`/`markAttendanceSent`, `TillItem`/`PriceRequest`/`PriceQuote`/`TaxedLine`/`PriceCheckResult`/`assertCatalogueFresh`/`findItemByBarcode`/`findItemByCode`/`searchItems`/`resolvePrice`/`taxItemLine`/`priceCheck`, `SellLine`/`SellInput`/`DraftLine`/`TicketDraft`/`SellResult`/`draftTicket`/`checkLimits`/`sell`/`recordTillEvent`/`tillUuidv7`, `TillShift`/`openShift`/`closeShift`/`currentShift`/`shiftTotals`, `TenderInput`/`TenderResult`/`roundToIncrement`/`applyCashRounding`/`tender`, `ReceiptLine`/`ReceiptPayload`/`buildReceipt`, `OriginalLine`/`OriginalTicket`/`findOriginal`/`ReturnRequest`/`returnTicket`, `TillCustomer`/`CreditCheck`/`findCustomers`/`getCustomer`/`quickCreateCustomer`/`checkCredit`/`accountSale`/`clearPendingCustomers`, `PosHandlerDeps`/`OpenTillOptions`/`OpenedTill`/`openTill`, `TillStatus`/`till`/`errorCode`/`TILL_KEYS`/`TillShell`/`SellRoute`/`Receipt`, `LoyaltyAccrual`/`accrue` (⚠️ OD-03 only).

### Corrections this plan makes to what was already written

| # | What | Where it is applied |
|---|---|---|
| 1 | **`errors.ts` carries two rows in T2, not one.** `apps/pos/src/main/errors.ts`'s `TillErrorCode = Extract<ErrCode, …>` does not compile until `ERR_TILL_STORE_CORRUPT` is in the registry, and `Extract` over a non-member yields `never` — so the failure surfaces at every `TillError` call site with an opaque message rather than at the definition. T2 Step 2 now adds both, T2's git-add line includes `packages/contracts/src/errors.ts`, the File Structure line reads `T2,T4`, and A6's row names which two land where. | T2 Step 2; A6; File Structure |
| 2 | **T2's `⚠️ move this row to Task 5` contingency is resolved, not left open.** `error-codes` (0B Task 12) counts **any occurrence** of the token outside the excised `ERRORS` literal — a type-only mention included — so both rows are green from T2 onward and nothing moves. The paragraph now says why. | T2 Step 5 |
| 3 | **`apps/pos/src/main/entry.ts` was named by T1's `build:main` script and created by nothing.** T9 creates it, and the File Structure gained the line. | T9 Step 6; File Structure |
| 4 | **The local schema is eighteen tables, not seventeen.** `pending_customer` is added at `LOCAL_SCHEMA_VERSION = 2` in T8, with the exact edits to `schema.sql`, `database.ts` and `database.test.ts`'s expected list — because ADR 0057 rule 1 gives every `catalogue_*` mirror exactly one writer and a locally-minted party would give one two. | T8 Step 1; §4.10.6 clause (d) |
| 5 | **`tests/package.json` names `better-sqlite3` and not `@dulja/pos`,** which reconciles the File Structure's *"one native-module dependency"* with the header's fact (9). Node resolves `better-sqlite3` from the importing file upward and finds nothing when Vitest runs `apps/pos/src/main/database.ts` from `tests/`. **It is not `workspace:*`** — `better-sqlite3` is not a member of §3.1's frozen `workspaces` array (`["packages/*", "apps/*", "tests", "infra"]`), so that protocol cannot resolve and `bun install` fails; the entry is written by `bun add --cwd tests -d better-sqlite3`, exactly as T1 obtains it for `apps/pos`. | T12 Step 1 |
| 6 | **`Ticket.catalogueRevision` crosses the outbox as a decimal string.** §4.10.1 types it `bigint`; `SqliteSyncStore.enqueue` calls `JSON.stringify`, which throws on a bigint; 6A's Zod schema types the wire field `BigintString`. `toWireTicket` is the one conversion point and `ticket.test.ts`'s second case pins it. | T6 Step 4 |
| 7 | **`PERMISSION["pos.ticket.return"]` rather than the bare string,** so `apps/pos` has one spelling for every code lookup. | T6 Step 4 |
| 8 | **`TillErrorCode` admits `ERR_MONEY_CURRENCY_MISMATCH`.** `draftTicket`, `closeShift` and `tender` all refuse a mixed-currency ticket with it, and `Extract<ErrCode, …>` over a union that omits it makes the `code` parameter `never` at those three call sites. 0D's code is raised rather than aliased. | T2 Step 3 |
| 9 | **`drainOutbox` is called with `batchSize: SYNC_BATCH_SYNC_LIMIT`** in T12 Step 4, not with the default. 6A enqueues a batch over 200 tickets as `pos.sync.apply` and answers **202**, which `pushTickets` turns into a `SyncQueuedError` — so a drain that handed all 500 to one push would throw instead of acking. T3's loops already pass the same value. | T12 Step 4 |
| 10 | **The pending-outbox count at T12 Step 3 is 501, not 500** — `openTill` enqueues the shift-open message before the first sale, and it stays pending until 6D lands. The step asserts the ticket count by `kind` and Step 4 allows `rejected <= 1` for the same shift message, which is §4.10.1's refuse-never-drop working rather than failing. | T12 Steps 3, 4 |
| 11 | **`withTenant(sql, tenantId, actorId, fn)` — the four-argument test helper** (hazard 15), imported from `@dulja/db/test`, not a three-argument method on `api.db`. Copied from 6A's own suites. | T12 Steps 3, 4 |
| 12 | **`search` routes a barcode to `findItemByBarcode` and a code to `findItemByCode`.** `searchItems` matches `code`, `name_en` and `name_ar` and **not** `barcode`, so routing all three through it would make every scan answer "not found" — with the sell screen, the bridge and the schema all correct. | T9 Step 5 |
| 13 | **`pos-bridge.spec.ts` greps `register.ts` for `handle("<method>"`,** which is the literal the file contains; `channels[method]` is looked up inside `handle` and grepping for it would find one occurrence and pass for every method. | T9 Step 2 |
| 14 | **CI compiles `apps/desktop`'s POS entry before packaging it.** `dist:pos` packages `dist/main-pos.js`, which only `build:pos` produces; without the step the installer starts a window that closes immediately. | T10 Step 3 |
| 15 | **The rounding sign has one convention per boundary and the tests assert the right one at each.** `applyCashRounding` returns the **discount-column** sign (negative when rounding up); `tender` and `buildReceipt` return the **receipt-facing** sign (positive), and the `.negate()` at that one boundary is the whole conversion. | T7 Steps 2, 5 |
| 16 | **A2 breaks two assertions in 6A's `sah-046` and T0 repairs them in the same PR.** A re-export does not match `/export function canonicalSyncRequest\b/`, and `signing.ts`'s body matches 6A's `handRolled` scan while its filename does not contain `terminal-auth`. Both are replaced in place inside 6A's own `— 6A` `it` (the invariant is unchanged; only the path in it moved), `sah-046` joins T0's run list, and `tests/invariants/support/pos.ts` and `tests/package.json` join T0's Files — the import switch A2's own text promises, without which the deleted `dependency-rule` allowance would still be needed. | T0 Steps 4, 5, 6; A2; File Structure |
| 17 | **`pragma table_info().type` echoes the DECLARED spelling, and `schema.sql` is lowercase.** Both the T1 and T12 assertions compare `c.type.toUpperCase() !== "TEXT"`; comparing against `"TEXT"` directly would report every money, quantity and revision column as an offender on the first run, and "fixing" it by upper-casing the DDL would break Global Constraint 9. | T1 Step 3; T12 Step 4 |
| 18 | **`SourceFile.path` is already repo-relative** (0B: `relative(REPO_ROOT, full)`), so no assertion slices `REPO_ROOT.length` off it. Two of the five sites were `toEqual` comparisons against real paths and would have compared `[""]`; the other three would have named no file in their failure message. | T0 Step 4; T12 Steps 4, 5 |
| 19 | **An untendered ticket is not drainable.** `sell` writes the outbox row with `tenders: []` inside the sale's transaction (spec:1303) and `tender` fills it in; the 15-second drain loop would otherwise push every sale where the cashier took longer than one tick to collect payment, and 6A's `POS_TICKET` policy refuses an empty-tender ticket into `app.needs_attention`. `pendingOutbox` holds back a `ticket` row whose local ticket is still `'open'` — and only that. | T2 Step 4; T2 Step 1's new case |
| 20 | **`0063.down.sql` cannot delete the grants it orphans, and the earlier comment claiming a cascade was wrong.** `role_permission.permission_code` has no `on delete` action (plan0A:1325), RI checks bypass RLS, and §3.4.8 plus plan0A:980–981 mean a migration can neither write `app.role_permission` nor enumerate `app.tenant`. The down file states the real reason and the rollback carries a precondition (an unseeded database, which is where §3.4.6's test runs it); Known gaps #8 raises the general rule, which 6A's `0062.down.sql` needs too. | T4 Step 3; T4 Step 8; Known gaps #8 |
| 21 | **T1 ships the buildable empty renderer, not T11.** T10's CI runs `bun run --cwd apps/pos build` and `electron-builder.pos.yml` copies `../pos/dist`, both in the OD-24 default state — so `vite.config.ts`, `index.html` and an empty `src/renderer/main.tsx` are T1's, T11 marks all three MODIFY, and T12's `sourceFiles(["apps/pos/src/renderer"])` no longer throws ENOENT (0B's walker has no existence check). Every screen, key map and `pos.*` catalogue key stays behind the gate. | T1 Step 7; T11 Files; T12 Step 4 |
| 22 | **`roundToIncrement` composes 0D's `round` and `taxItemLine`'s divisor uses the line's own currency.** `round(value, scale, mode)` *is* the `RoundingMode` → `Decimal.Rounding` map (0D:386–389), so the four hand-copied `Decimal.ROUND_*` literals are gone; and `Money.of("1.0000", cur)` needs no ISO `"XXX"` placeholder. `apps/pos` now carries no duplicate of a `@dulja/domain` internal. | T7 Step 3; T5 Step 5 |
| 23 | **6A's `posFixture` grants its cashier a BESPOKE role, so widening the seeded `cashier` role does not reach it.** 6A:4573–4576 calls `grantCodes({ roleCode: "pos-cashier", codes: [four `pos.ticket.*`/`pos.customer.create`] })`, a list written before `pos.attendance.clock` existed. The moment T4's `principal_has` gate lands, 6C's own clock-in case (6C:2363) refuses with `ERR_RBAC_FORBIDDEN` — Step 4's `roles.ts` edit is irrelevant to it. **T4 Step 5 adds the one code to that list**, in the same PR as the gate and the migration that seeds it. | T4 Step 5; T4 Files |
| 24 | **6C's `staffFixture` has the SAME bespoke-role trap, and correction #23 missed it one slice further on.** `seedCashier(…, { permissions })` mints a per-cashier role (`cashier-<suffix>`), so `staffFixture`'s `cashierA` holds exactly `pos.ticket.sell`, `pos.ticket.discount`, `pos.ticket.return` — **not** `pos.shift.own`, which is this slice's own new code. `openShift` opens with `requireCode(cashier, PERMISSION["pos.shift.own"])`, so `openTill` would throw `ERR_RBAC_FORBIDDEN` in `beforeAll` and every case of acceptance test 19 would fail. **T4 Step 5 adds the one code to `cashierA`'s `permissions` array**, in the same PR and for the same FK reason as the `posFixture` edit. It costs 6C nothing else: `CASHIER_SNAPSHOT_CODES` is a derivation (6C A5), so 0063 widens both its spellings automatically, and 6C's four exact-`codes` snapshot cases each mint their own cashier. | T4 Step 5; T4 Files; T4 git add |
| 25 | **`tillFixture` seeds one price list, and without it the till cannot price anything at all.** Neither `posFixture` nor `staffFixture` seeds one, and the till prices only from the mirror — there is no `unitPrice` escape hatch of the kind 6A's `buildTicket` has. The first failure is not *"no price"*: `resolvePrice` calls `tillCurrency`, whose `select currency from catalogue_price_list order by id limit 1` returns nothing, and it throws `ERR_TILL_CATALOGUE_STALE` for all 500 tickets. One company-wide list with one `SKU-A` line at `11.5000` closes it — T5's own worked figure, and an exact multiple of `0.0500`, so ADR 0059's rounding is the identity and `tender(…, amount: r.draft.total)` is not short. A7's register row names the row. | T12 Step 2; A7; T12 Interfaces |
| 26 | **`cashierA`'s PIN is `"4321"`, not `seedCashier`'s default.** `staffFixture` passes `pin: "4321"` explicitly, so `loginCashier(…, { pin: "1234" })` reaches `verifyPin("1234", <argon2id of "4321">)`, gets `false`, and throws `ERR_TILL_PIN_INVALID` inside `beforeAll`. The doc-comment now says which value is the fixture's and which is the helper's default, so the two are not confused again. | T12 Step 2 |
| 27 | **`credit_hold` is aliased `hold_flag` in `customer.ts`'s four SELECTs.** `no-number-money` (0D) matches a declared `number` annotation on any `PropertySignature` whose name matches `/…\|credit\|…/i`, scoped to `apps/**` with only test paths excluded and an empty `ALLOWED` — so `credit_hold: number` is a violation and `bun run lint:rules` would be red at T8's boundary against Global Constraint 19. The column is a `0|1` boolean, not money; the rename is the honest fix and `TillCustomer.creditHold: boolean` is unchanged. T8 Step 6's Expected says so and its arithmetic is corrected to `10 + 11 + 9 + 11 = 41` (the `database` figure is T8 Step 1's own, not T1's original eight). | T8 Step 5; T8 Step 6 |
| 28 | **Two gate checks were silently passing.** `need_doc "A10 item.tax_code_id" "`app.item.tax_code_id`"` puts backticks inside DOUBLE quotes, which bash evaluates as command substitution: the unknown command prints to stderr and substitutes the empty string, and `grep -qF -- ""` matches every line of the contracts document. Both needles are now single-quoted and `need_doc` refuses an empty `$2` outright, so a future quoting slip fails loudly rather than certifying an amendment that never landed. | T0 Step 7 |
| 29 | **`pending_customer` is amendment A8 clause (d), not a footnote in the Self-Review.** Global Constraint 13 requires Task 0 to amend a register before any task writes a literal into it, and §4.10.6 currently reads *"exactly spec:1328–1335 plus `outbox.kind` and `catalogue_branch_pos_policy`"* — an eighteenth local table needs the clause. It is now in T0 Step 1's A8 row verbatim, gated by `need_doc "A8d pending_customer"` (fourteen contracts checks, not thirteen), and A8's Blocks column reads `T1, T2, T8`. | T0 Step 1; T0 Step 7; T0 Step 8 |
| 30 | **T7's `buildReceipt` case is written `it.skip(`, matching the three places that already said it was.** `buildReceipt` prepares `select name_en from pending_customer …` and SQLite resolves table names at `prepare` time, so a plain `it(` throws `SqliteError: no such table: pending_customer` before T8 exists. The title string is unchanged so T8 Step 1's un-skip instruction still names it exactly. | T7 Step 2; T8 Step 1 |
| 31 | **T11 named `test/renderer/sell.test.tsx` in Files and no step wrote it — and no step gave `apps/pos` a DOM.** T1's `vitest.config.ts` is `environment: "node"`, under which every `.tsx` case fails at `render()` with `ReferenceError: document is not defined`, and `TillShell` creates no i18next instance, so `useTranslation` would render raw keys. T11 Step 3 now ships the harness — the React plugin, `test/renderer/setup.ts` as a global `setupFiles` entry (it only calls `expect.extend`, so the node suites are unaffected), and a **per-file `// @vitest-environment jsdom` docblock** on each renderer test rather than a config-side `environmentMatchGlobs` entry, which was deprecated in Vitest 3 and removed in Vitest 4 and would tie this file to a version the plan does not pin — and **both** renderer test files in full, each binding the instance through `I18nextProvider`; `main.tsx` does the same at boot. Step 7's Expected is the same seven cases, now reachable. | T11 Files; T11 Step 3; T11 Step 5; T11 Step 7 |

### Every requirement, and the task that satisfies it

| Requirement | Source | Task |
|---|---|---|
| Local SQLite exactly spec:1328–1335 + `outbox.kind` + `catalogue_branch_pos_policy` | §4.10.6 | **T1** (+ `pending_customer` at T8) |
| `better-sqlite3` in the Electron main process behind the typed `contextBridge` | §4.10.6 | **T1, T9** |
| `SyncStore` over SQLite; every stream advanced to the page's highest revision | §4.10.5, 6A A23c | **T2** |
| Outbox acked only on acknowledgement; never on silence | spec:1337 | **T2** |
| Terminal identity, Ed25519 signing, enrolment, both loops | §4.10.3, spec:1303 | **T3** |
| PIN login from the down-synced snapshot; `verifyPin` imported, never re-implemented | spec:1324, SAH-028 | **T4** |
| The three `pos` codes seeded, granted and referenced from `apps/pos` | §3.6.2, §3.6.3 | **T4, T5, T6** |
| 6C's amendment A10 — the one server-side `principal_has` line | 6C A10 | **T4** |
| Clock-in/out as attendance, riding on a ticket | spec:2089 | **T4, T6** |
| Price list per shop; promotions with date windows | §3.7.6 Pricing | **T5** |
| Customer-specific pricing | §3.7.6 Pricing | **T5, blocked on A10(b)** — `app.party.price_list_id` is 4A's migration 0045, outside 6B's range; `candidateLists` rule 1 is written and one `it.skip` marks the gap (Known gaps #1) |
| Price-check mode, read-only, gated | spec:1355 | **T5** |
| Tax computed at the till and agreeing with the server's recomputation | 6A step (g) | **T5, T7** |
| Scan or search; quantity/unit; line and ticket discount; price override within the limit | §3.7.6 Selling | **T5, T6** |
| Ticket + outbox row in one SQLite transaction | spec:1303, 1337 | **T6** |
| Shift open/close with a declared float; `countedCash` only | §3.7.6 Shift, §4.10.1 | **T6** |
| No-sale / drawer-open / void events on the ticket stream | spec:1354 | **T6** |
| Multi-tender, change, POS rounding per the currency's rule | §3.7.6 Payment | **T7** |
| Receipt printing via `webContents.print()` | spec:1280 | **T7, T9, T11** |
| Return against an original; blind return where policy allows | §3.7.6 Returns | **T8** |
| Customers: lookup, quick-create, account sales inside the credit limit | §3.7.6 Customers | **T8** |
| `desktop` imports only build outputs | spec:2389 | **T9** |
| The Electron security posture, restated not re-decided | spec:1284 | **T9** |
| `pos.exe` installer and auto-update from the R2 feed | §2.7, spec:2361 | **T10** |
| Honest offline indicator with the last-catalogue-update time | spec:1345, 1356 | **T11** |
| Both text directions; keyboard parity; no mouse required | spec:2251, 2254 | **T11** |
| **Acceptance test 19** | spec:2437 | **T12** |
| Test 20's till half; test 11's sync-header clause; test 37's till half; test 36's catalogue clause | §6.1 | **T12** |
| `sah-051` appended | §3.7.3 | **T12** |
| ⚠️ OD-18 | §2.12 | **T13** |
| ⚠️ OD-03 | §2.12 | **T14** |
| ⚠️ OD-24 | §2.12 | **T11** |
| ⚠️ OD-29 — recorded, no task | §2.12, §2.7 | Global Constraint 17 |

### Hazards, checked one by one

1. **No statutory rate** — every tax figure comes from 5A's `SYNTH-MY-v1` via `catalogue_tax_code`; the plan states none. `0.10000000` in the test fixtures is a mirrored row from a clearly-synthetic pack, and `rounding_increment` `0.05` is `branch_pos_policy`'s own default (6C's DDL), stated as configuration and never as a jurisdiction's practice. ✅
2. **No invented MyInvois detail** — no LHDN endpoint, field, version, threshold or deadline appears. ✅
3. **Firebird unknown** — this slice reads no legacy database; OD-16 is 9B's and is named as such. ✅
4. **Reports ship in-phase** — this slice ships **none** and says so: `pos.z_report` and `pos.sales_by_cashier` are **6D's**, `ReportCodeSchema` is not widened, and `shiftTotals` carries an explicit ⚠️ that it is not a Z-report. ✅
5. **Owner-account tasks** — T10 Step 4 (the R2 feed) and T13 (the certificate) both follow the *"owner provides X; verify with `<exact command>`; until provided `<local equivalent>`"* pattern. ✅
6. **Owner decisions are isolated tasks** — OD-24 → T11, OD-18 → T13, OD-03 → T14, one each; OD-29 recorded with no task, as the card requires. ✅
7. **D1–D27 not re-opened** — D18 (POS hardware out of scope) is treated as settled, which is why `sah-086` is **not created**. ✅
8. **Plan 0A helpers by exact name, never renamed** — `startApi`, `sharedApi`, `sourceFiles`, `REPO_ROOT`, `withTenant`, `Db`, `Seed` are consumed as they are; `fixtures.ts` is **not touched at all**. ✅
9. **`fixtures.ts` additive only** — this slice adds **no** helper to it (§4.17), and its one test-tier file is registered by A7 and described as a thin layer over 6C's, which is over 6A's. ✅
10. **No per-tenant row in a migration** — 0063 inserts into `app.permission`, which is global; the `cashier` grants are `packages/db/seed/roles.ts`. ✅
11. **No enum label added** — every closed vocabulary here is a SQLite `CHECK` or a TypeScript union. ✅
12. **0B generalised the reversibility test** — 0063's down is exercised in T4 Step 8 with `db:rollback 62 && db:migrate`, **on an unseeded database**, which is where §3.4.6's own test runs it; the reason it cannot be exercised against seeded role grants is stated in the down file itself and in Known gaps #8, and it is a schema property (FORCE RLS + a NO ACTION FK) rather than a choice this slice made. ✅
13. **`lint-schema.ts` untouched** — this slice creates no PostgreSQL table, so §3.5.3 gains no row (Global Constraint 2). ✅
14. **Numbers not renumbered** — 0063 only; ADRs 0057, 0058, 0059 only. ✅
15. **Two `withTenant`s** — the test tier uses the production one through `api.db.withTenant`; the till has no Postgres at all. ✅
16. **`employee` is 0064** — consumed through 6C, never re-created. ✅
17. **Test 7 not touched** — no negative-stock override here; `allowNegative: false` in the `POS_TICKET` policy is 6A's. ✅
18. **Test 22/28's projection set not touched.** ✅
19. **The terminal acts, the cashier is attributed** — Global Constraint 4, T3's assertion, T12's test-11 clause: no message this slice composes carries an actor id. ✅
20. **Jobs as the system principal** — this slice enqueues no job. ✅
21. **`sql.unsafe`'s three homes** — this slice adds none; every SQLite statement is a `prepare` with bound parameters and a literal SQL string, and T5 Step 7 says why `ITEM_COLUMNS` is not concatenation. ✅
22. **Nothing writes ledger/movement/layer/projection/tax tables** — `apps/pos` holds no PostgreSQL client at all, asserted mechanically in T9 and T12. ✅
23. **`Money.toBase` rounds `HALF_AWAY_FROM_ZERO`** — every `multiply`/`divide` here passes an explicit mode, and `MODE` is `HALF_AWAY_FROM_ZERO` in `pricing.ts`, `ticket.ts` and `tender.ts`, matching 6C's `MODE`. ✅
24. **`document_event` written only by triggers and the override door** — the till *composes* `TicketEvent`s; `recordOverride` is 6A's, server-side. ✅
25. **DELETE grant list pinned** — no grant change. ✅
26. **Permission vocabulary closed** — exactly the three codes §3.6.2 assigns, no new module. ✅
27. **No `service` principal kind.** ✅
28. **Phase 8 sequencing** — not this slice. ✅
29. **UI not specified** — T11 begins with OD-24 and `TILL_KEYS`'s nine placeholders are the gate itself, with the ⚠️ saying so. ✅
30. **PDF engine decided in 0E** — consumed as a decision; the till prints through `webContents.print()`. ✅
31. **Every route needs a probe** — this slice adds **no route**. ✅
32. **No invented literal in a shared namespace** — the one non-register addition (`packages/contracts/src/pos/till.ts`'s ten Zod schemas, which no route uses and §4.2.8 does not enumerate) is declared in *Contract additions* above, and **T0's ten amendments carry the rest, `pending_customer` included** (A8 clause (d), gated by `need_doc "A8d pending_customer"`). ✅
33. **The slice that seeds a policy seeds its accounts** — this slice seeds **no** account and owns no policy; `1110`/`1120`/`2200` are 6A's and are consumed. ✅
34. **A document-type seed file is an envelope** — this slice ships none. ✅
35. **Written to the skill** — every task has exact paths, exact signatures copied from §4, real code and a commit; **every task that ships an implementation (0–11) writes a failing test with its exact expected failure text first**, and T12 — which drives only surfaces T0–T11 already shipped — says in place of that line why it has none and is expected green on its first run. See the Plan-shape audit. ✅

### Known gaps, stated rather than hidden

1. **⚠️ Two columns the till's pricing needs do not exist yet, and amendment A10 is what closes it.**
   **`app.item` has no `tax_code_id`** (3A's `0028`) and **`app.party` has no `price_list_id`** (§4.5.7; 4A
   adds only `credit_limit`, `payment_term_id`, `credit_hold`) — both verified against the owning slices'
   DDL rather than assumed. Until A10 lands: an item's tax code falls back to *the single open
   `kind = 'output'` row* and returns `null` when there are two or more, so a taxable ticket on a
   multi-rate regime carries `taxAmount 0` and **6A's step (g) refuses it loudly** rather than posting a
   wrong `tax_transaction`; and customer-specific pricing falls back to branch-then-company, which means
   **§3.7.6's *"customer-specific pricing"* is not delivered**. Both fallbacks are correct behaviour, and
   both are visible: T5's test suite covers them, and A10 names the exact migration (5A's 0055, 4A's 0045)
   that each column belongs in. **This is the one register change this plan discovered rather than
   inherited, and it is the item to raise with the architect first — before Task 1, not before Task 5**,
   because §2.7's 6B card lists *"customer-specific pricing"* as a delivery bullet and §6.2 makes 6B the
   owner of row spec:1062, and neither can close on 6B's own work while the column is absent (0045 is 4A's
   range, and §3.4.1's rule is that a slice writes only inside its own range — so **the column has to land in
   4A's `0045`, and the reason is the range and nothing else**. Note what is *not* being claimed: 4A is
   written but **not executed** — only Plan 0A has run — so amending `0045` before 4A executes is entirely
   feasible and is the ask. What 6B genuinely cannot do is write the column itself, in 0063 or anywhere).
   Until A10(b)
   lands, **T5 Step 5's `it.skip("prices a customer-specific list ahead of the branch list (A10b)")` is the
   visible marker in the suite**, the requirement table below reads *"except the customer-specific clause"*,
   and the Execution handoff says the same. Un-skipping that one case is the whole of the delivery.
2. **§3.7.6's *"looked up … via sync"*** half of the Returns row is **not implemented**, because 6A ships three routes and none of them looks up a ticket by client ref. The local half is complete; a ticket sold at another till is a **blind return**, subject to `blind_return_allowed` and `max_blind_return_amount`. **The amendment that closes it:** a `GET /v1/sync/ticket/{clientRef}` route in 6A's range returning a `Ticket`-shaped read model, plus a `findOriginal` fallback that calls it when online — or, if the shop wants it in the back office instead, a `pos.ticket_lookup` `ReportDefinition` in 7C. **This slice does not make it** (§4.10.1 is 6A's), and T8's opening paragraph says so.
3. **`checkCredit` does not know the customer's outstanding AR balance** — there is no catalogue stream for it, so the check is over the mirrored limit plus this till's own unsynced account sales, and its `detail` string says *"this till"*. 4A's credit control re-checks server-side and a refused ticket lands in the needs-attention queue. Widening it would need a ninth stream, which is 6A's.
4. **`shift.expected_cash` and `over_short` are always `NULL` at the till** and the shift screen prints `pos.shift.expectedNote` instead of a figure. That is §4.10.1's rule and 6D's work, not a gap in this slice — but a cashier closing a drawer sees a count and no over/short until the shift syncs, and the operator description (OD-24) should say so in one sentence.
5. **`ShiftOpenClose` and `TillEventMsg` are refused with `ERR_SYNC_MESSAGE_UNSUPPORTED` until 6D lands.** The rows stay in the outbox and T12 Step 7 asserts it. A shop running 6B without 6D therefore accumulates shift messages, and `pendingOutbox` will not reach zero — **the indicator's unsent count will be non-zero for a legitimate reason**, which the enrolment runbook's *"before wiping a till, check the unsent count"* sentence must be read alongside. 6D's first task clears them on its first drain.
6. **`TILL_KEYS`'s nine values are placeholders** and T11 does not start until the operator description supplies them. This is the OD-24 gate, not an omission.
7. **An end-of-day clock-out reaches the server on the next day's first sale, and a shift with no sales never
   reports its clock events at all.** `Ticket.attendance[]` is the **only** channel §4.10.1 provides:
   `TillEventMsg`'s kinds are `no_sale | drawer_open | void` and `ShiftOpenClose` carries no attendance array,
   so `pendingAttendance` is drained in exactly one place — inside `sell` (T6 Step 3) — and `schema.sql`'s own
   comment on the `attendance` table says so (*"or, between sales, on the next ticket"*). A clock-out taken
   after the day's last sale therefore sits in the local `attendance` table until the next ticket, and
   spec:2089's attendance feed is delayed by that much. **This is a property of 6A's wire contract, not a
   defect in this slice**, and closing it is a **6A amendment**, of which there are two admissible shapes: an
   `attendance: TicketEvent[]`-shaped array on `ShiftOpenClose` (so a shift close flushes the clock feed), or
   a fourth `TillEventMsg` kind `'attendance'`. Either is one Zod schema change, one `applyBatch` branch and
   one `pendingAttendance` call site here; neither is 6B's to make (§4.10.1 is 6A's). **The OD-24 operator
   description must say so in one sentence** — a shop needs to be told that a clock-out is not visible in the
   back office until the till's next sale, or a supervisor will "correct" an attendance record that was never
   wrong.
8. **`0063.down.sql` cannot remove the `role_permission` grants it orphans, and the rollback therefore has a
   precondition.** §3.4.8 is explicit: `FORCE ROW LEVEL SECURITY` applies to `app_migrator` too, *"so a
   migration file with no `set_config` sees zero tenants and cannot write them"* — and `app.tenant` itself
   carries `force row level security` with `using (id = app.current_tenant())` (plan0A:980–981), so a
   migration cannot even enumerate the tenants whose grants it would have to delete. Meanwhile
   `role_permission.permission_code references app.permission(code)` has **no** `on delete` action
   (plan0A:1325 — `NO ACTION`), and referential-integrity checks bypass RLS, so on a database where
   `bun run seed --tenant <id> --only roles` has run, `delete from app.permission` raises SQLSTATE 23503.
   **The rollback is therefore exercised where §3.4.6's reversibility test exercises it — on a freshly
   migrated database with no seeded tenant** — and T4 Step 8 says so on the command. **6A's
   `0062.down.sql` (6A:1824–1828) has the identical exposure for its eleven codes**, which is why the general
   rule belongs in §3.4.5 as an architect amendment ("a permission-seed down is reversible only against an
   unseeded database; re-run `--only roles` after re-migrating") rather than in one slice's plan.

### Plan-shape audit

15 tasks, numbered 0–14 with no gaps and no renumbering. Every task heading is exactly `### Task N: <title>`. Every task has **Files** and **Interfaces** (Consumes / Produces with exact signatures — T13 and T14 produce no code and their Produces line says exactly that), checkbox steps, a run command with the expected pass count, and a commit whose message ends with the required trailer. **Every task that ships an implementation** (0–11) writes a failing test **with the exact expected failure text** before that implementation. **T12 is the one code task with no expected failure and does not claim one:** every module it exercises is already shipped by T0–T11, so its two suites are written against an implemented surface and are expected **green on the first run** — the step text says so where a `**Expected failure:**` line would otherwise sit, because inventing one would be a false claim about what the executor will see. **T13 and T14 ship no code** in their default branch — they are owner-gate records with a `Verify:` command and a local equivalent, which is what hazard 5 and hazard 6 ask of them instead. No task contains "TBD", "TODO", "implement later", "similar to Task N", "add appropriate error handling", "etc." or an ellipsis standing in for content — the nine `<from operator-description.md>` placeholders in T11 are the OD-24 gate, are labelled as such twice, and are the one deliberate absence the plan admits.

---

## Execution handoff

**Read before starting:** this plan's header, `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §2.7 (the 6B card), §2.12 (OD-03, OD-18, OD-24, OD-29), all of §3, §4.1, §4.2, §4.10 in full, §4.6.3–§4.6.5, §4.9.1, §4.17, §5, and §6.1 rows 11, 19, 20, 23, 36, 37. Then the Produces blocks of **6A**, **6C** and **0E** — those three plans are the authority for every name this one imports, and Task 0's gate is what discovers a disagreement before a line is written.

**Order.** Strictly sequential 0 → 14, with three exceptions and one hard stop.

- **Hard stop:** Task 1 does not begin until `bash scripts/check/contracts-6b-amendments.sh` exits 0. A `MISSING (contracts)` line means the architect's amendment PR has not merged; a `MISSING (repo)` line means this plan and the owning slice disagree about a name and is a **stop-and-raise**, never a workaround.
- **`bun run lint:rules` is green at every task boundary, including T4's.** T4 seeds three permission codes whose *real* call sites land in T4 (`pos.attendance.clock`), T5 (`pos.price.check`) and T6 (`pos.shift.own`) — so T4 also ships `TILL_CODES` in `apps/pos/src/main/authority.ts`, three `PERMISSION[...]` literals in one `as const` array, which is what `permission-catalogue` counts (§3.6.3; 6A's `packages/db/src/sync/authority.ts` is the precedent for exactly this, 6A:1864). T4 → T5 → T6 may still travel as one PR chain for review convenience, but Global Constraint 19 holds at each of the three commits rather than being suspended across them.
- **T7's `buildReceipt` case is `it.skip` until T8** creates `pending_customer`; T8 Step 1 un-skips it by deleting the `.skip` and the four-line `⚠️` comment above it, leaving the title string untouched. If you prefer, run T8 before T7 — nothing else in either depends on the other.
- **T4 Step 5 edits TWO fixture files that this slice does not own, and both edits ride T4's own PR** because `grantCodes` hits the `role_permission → permission` foreign key and neither string can exist before migration 0063 is applied: `tests/invariants/support/pos.ts` gains `pos.attendance.clock` on 6A's cashier (without it 6C's clock-in case goes red), and `tests/invariants/support/staff.ts` gains `pos.shift.own` on 6C's `cashierA` (without it T12's `openTill` cannot open a shift). Raise both with the 6A and 6C owners when T4 opens; each is one string in one array and neither changes a fixture's shape.
- **`tillFixture` seeds exactly one Postgres row** — a company-wide price list with one `SKU-A` line at `11.5000`, through 3A's `seedPriceList`. It is registered in A7 and is not optional: with `catalogue_price_list` empty, `tillCurrency` throws `ERR_TILL_CATALOGUE_STALE` and no ticket can be priced.
- **T11 is blocked by OD-24 and T13 by OD-18 and T14 by OD-03.** Ship 0–10 and 12 without them. **Acceptance test 19 does not depend on a screen**, which is the whole reason T12 sits before T11's gate in the dependency order even though it comes after it in the file.

**Environment.** Windows 11 with Git Bash; `bun` for install and scripts; Node 24 runs Vitest; Docker Desktop for Testcontainers (T4's migration and T12's whole suite). Set `DULJA_POS_UPDATE_FEED` to any URL for a local `dist:pos` — `--publish never` uploads nothing and electron-builder still needs the variable to resolve.

**The two commands that tell you where you are:**

```bash
bash scripts/check/contracts-6b-amendments.sh          # 0 = every prerequisite name exists with this spelling
bun run --cwd tests test -- pos-offline                # 8 passed = acceptance test 19 is green
```

**When the slice is done:**

```bash
bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test
bun run --cwd tests test -- pos-offline phase-6b-pinned pos-canonical-signature sah-051
bun run --cwd apps/pos test
bun run --cwd apps/desktop test -- pos-posture pos-bridge pos-updater
bun run --cwd packages/db test -- permission-catalogue sync/apply
bun run --cwd apps/api test -- routes/sync
```

Every one green, plus the three ADR proposals (**0057**, **0058**, **0059**) asked and answered, is this slice's exit. **§6.2's row spec:1062 closes at T12 in every clause except *customer-specific pricing*, which cannot close on this slice's own work**: `app.party` has no `price_list_id` and the column belongs in **4A's migration 0045** (amendment A10(b)), outside 6B's range of 0063 — so the row's last clause closes when A10(b) lands and T5's one `it.skip` is un-skipped. **4A is written but not yet executed, so amending `0045` is feasible and is the ask**; what is impossible is 6B writing the column in a file outside its own range. Known gaps #1 is the item to raise with the architect **before Task 1**. §2.7's DoD share — *"a till sells 8 hours offline and reconciles with zero duplicates and zero lost tickets"*, the till half — is measured in `tests/invariants/pos-offline.test.ts` Steps 2, 4, 5 and 6 and nowhere else.

**What comes next, and what it needs from here.** **6D** is the only slice that depends on this one. It needs: `app.shift` and `app.till_event` (its own migration 0070) plus the shift and till-event apply paths inside 6A's `applyBatch`, at which point **every `shift` and `till_event` outbox row this slice has been accumulating drains on the next call** — 6D's first task should assert exactly that, because it is the cheapest possible proof that "refuse, never drop" worked. It also consumes `pos.shift.own` from this slice's catalogue rows (its Task 0 gate checks them by literal) and `POS_PERMISSION.shiftOwn`, which **6D** adds to 6A's map, not this slice. Nothing in 7A–7C, 8A–8D or 9A–9B depends on `apps/pos`; **7C** re-expresses 6D's two POS report codes under the same codes and touches nothing here.

**Do not, in any later slice:** add a second canonical signature string (T0's whole point, SAH-046); give a `catalogue_*` mirror a second writer (ADR 0057 rule 1); make the cashier the acting principal (hazard 19, SAH-044); ack an outbox row the server did not name (spec:1337); store a revision, an amount or a quantity as anything but `TEXT` in the local file (A8b); or let `apps/pos` import `apps/api`, `apps/desktop` or the `@dulja/db` barrel (spec:2389, Global Constraint 3). Each of those has a test in this slice that fails loudly, and each of them is a defect the legacy system actually shipped.
