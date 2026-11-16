# 0080 — Rotating the HR field-encryption key

- Status: **Proposed** — asked, not decided (spec:95: it touches security). Implemented in 8D Task 7 as the plan's
  default, ahead of approval, under the owner's direction to implement Phase 8 entirely (2026-11-07).
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8D · Task 7
- Contracts: round 19, 8D A1, A12; §3.11, §4.2.6, §4.12.5. Builds on ADR 0071 (the envelope).

## Context

spec:2273 lists "the **HR field-encryption key** (§4.6, rotated with re-encryption as a pg-boss job)" in the v1 secret
inventory, and §4.2.6's closed `JOBS` registry gives 8D exactly one name, `hr.encryption_key.rotate`
(`schedule: null`). ADR 0071 fixed the envelope every `employee_sensitive.*_enc` value carries —
`version(1) || nonce(12) || ciphertext || tag(16)`, AES-256-GCM, AAD `employee_id:column` — and `key_version`, which
records the **oldest** version any column of the row still carries (a partial write re-seals only what it touched).
8A left one question open: where `createHrKeyRing`'s `currentVersion` comes from; the API passed a literal `1`.

## Decision

1. **`HR_FIELD_ENCRYPTION_KEY_VERSION` joins §3.11** (8D A1) for the api and the worker: the envelope version the
   current key seals under, optional, default `1`, an integer from 1 to 255 (one envelope byte). There is no
   `…_PREVIOUS_VERSION`: the previous key lives at the current version − 1, which is what a rotation produces, so a
   previous key bound beside version 1 is refused at boot by name. `apps/api/src/config.ts` reads it into
   `ApiConfig.hrFieldEncryptionKeyVersion` and `apps/api/src/index.ts` passes it where 8A's literal stood;
   `apps/worker/src/hr-keys.ts` (8D A12) reads the same three names on the same terms. `apps/edge`'s
   `containerSecrets` forwards it to both containers, so the API seals new writes under the version the worker
   re-seals old ones under.
2. **The worker composes its ring once, at boot** (`setHrKeyRing(hrKeyRingFromEnv(process.env, appEnv))`, exiting 2 on
   a configuration error, like the object store), and the handler reads it through `hrKeyRing()`; a test injects one
   with `setHrKeyRing`. A handler never reads the environment.
3. **Rotation opens per column under that column's own byte-0 version and re-seals under the ring's current key**
   (`rotateSensitiveBatch`, `packages/db/src/hr/rotate.ts`, using 8A's `openField` / `sealField` unchanged). Every
   value is opened, even one already at the current version (kept byte for byte), so a value that does not
   authenticate refuses the batch rather than being carried forward. A NULL stays NULL.
4. **Bounded and idempotent.** The job walks the tenant's rows in keyset batches (`employee_id` order, `batchSize`
   rows, default 200, at most 5 000) — one short `withTenant` transaction per batch (spec:1368) — selecting
   `key_version < current`. A crash leaves every completed batch committed, and a re-run is a no-op over them.
   The batch's rows are read `for update`, so a concurrent `writeSensitive` waits for the batch and then applies over
   the re-sealed row instead of being overwritten by the old value. An optional `companyId` narrows the walk to one
   company's employees.
5. **As the tenant's system principal** (hazard 20): `runJob` hands the handler `systemContext`; `sensitive_gate`'s
   `app.actor_has` admits the system principal; 0081's `stamp_updated_by` stamps it and `audit_row` audits each
   update under it. The job logs one line — `hr_key_rotation_complete` (or `…_incomplete` at the batch bound) — with
   the counts and the version, and no key material or identifier.
6. **The operator procedure** (`docs/runbooks/hr-key-rotation.md`): bind the new key as `HR_FIELD_ENCRYPTION_KEY`, the
   old one as `HR_FIELD_ENCRYPTION_KEY_PREVIOUS`, the version plus one as `HR_FIELD_ENCRYPTION_KEY_VERSION`; deploy;
   enqueue the job per tenant; verify that no row is below the new version; only then retire `…_PREVIOUS`. The
   verification query, not a calendar reminder, is the gate on the retirement.

## Consequences

- A crash mid-rotation is safe and a re-run continues from what is left.
- Retiring `…_PREVIOUS` too early makes every un-rotated row unreadable (`HrKeyError` on read, `ERR_INTERNAL` at the
  API) — which is why the runbook's last step is a query.
- A rotated row's `updated_by` becomes the system principal and its `updated_at` the rotation time: a mechanical
  re-seal is recorded as what it is; the audit trail keeps who last changed the data.
- An `hr.employee_ytd`-style nightly schedule is not added: rotation is an operator action after a key change.

## Alternatives rejected

- **One transaction per tenant** — an unbounded lock on a tenant's whole HR table, and a crash rolls everything back.
- **Rotating on read** — a read path that writes is a surprise, and a row never read is never rotated.
- **Trusting `key_version` to choose the key** — a half-moved row would throw on every column already at the current
  version; the envelope's own byte is the authority (ADR 0071).
- **A `…_PREVIOUS_VERSION` variable** — one more value an operator can get wrong; current − 1 is what a rotation
  produces.

## Owner questions

1. May the rotation stamp `updated_by` with the system principal (0081's always-stamp makes any other choice a trigger
   change), or should a re-seal leave the row's last-editor fields alone?
2. Should the job be enqueued through an operator route (it has none: today an operator enqueues it with the worker's
   job client or SQL against pg-boss, as the runbook shows), and under which permission code?
