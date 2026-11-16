# 0071 — The HR field-encryption envelope

- Status: **Proposed** — this touches security and the data model, so it is asked, not decided (spec:95).
  Implemented in 8A Task 3 ahead of approval, as ADRs 0054–0070 were, under the owner's direction to
  implement Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-08)
- Slice: 8A · Task 3
- Contracts: round 16, amendments A8, A15, A19 and A21

## Context

spec:2076 and spec:2211 require the nine identity, bank and statutory-reference fields of
`employee_sensitive` to be field-level encrypted in the application with a dedicated key from the
§4.11 inventory, gated by `hr.employee.read_sensitive`, with documented rotation (spec:2273 makes
rotation a pg-boss job, which 8D owns). The spec fixes the requirement and not the format.

Three properties have to hold together. A row must not be openable after being moved to another
employee or another column — otherwise "swap two rows" is a data-integrity attack the audit log
cannot see. Rotation must be able to run over a live table one batch at a time, so two key versions
must be readable at once. And the ciphertext must be self-describing enough that a restored backup
taken mid-rotation is still readable.

## Decision

1. **The envelope.** `version(1 byte) || nonce(12) || ciphertext || tag(16)`, AES-256-GCM, with
   `AAD = "<employee_id>:<column name>"` and the key selected by the leading version byte (§4.12.5).
   `packages/db/src/hr/sensitive.ts` (`sealField`, `openField`) is the only module that calls
   `node:crypto`'s cipher, and `packages/db/src/hr/keys.ts` the only one that holds key bytes. Neither
   lives in `apps/api`, because 8D's rotation job runs in `apps/worker` and §3.1 forbids an app
   importing an app.
2. **The envelope's own leading byte is the authority on which key opens a column**;
   `app.employee_sensitive.key_version` is a row-level *index* for the rotation scan and records the
   **oldest** version any column of that row still carries. A rotation batch re-seals the whole row,
   and only such a full write moves the stamp forward; a partial write (`writeSensitive` with one
   field — a bank-account change) re-seals what it touched under the current key and leaves
   `key_version` where it was, because a row claiming a version some of its columns have not reached
   would be skipped by a scan of `key_version < current` and would become unreadable the day
   `HR_FIELD_ENCRYPTION_KEY_PREVIOUS` is retired.
3. **The key ring.** `HR_FIELD_ENCRYPTION_KEY` (current) plus the optional
   `HR_FIELD_ENCRYPTION_KEY_PREVIOUS`, both **base64 of exactly 32 bytes**. `readConfig()` refuses any
   other length, and any text outside the base64 alphabet, with a `ConfigError` naming the variable, so
   the container exits 2 at boot. `APP_ENV = dev` falls back to an all-zero key (`DEV_HR_KEY`) so a
   laptop and CI need no secret; staging and production do not. The ring reaches routes through
   `AppDeps.hrKeys`, never `process.env`, and the production ring's version is the literal `1` until
   8D registers a version variable with its rotation job.
4. **A failure is an operator incident, not a caller code.** A wrong key, a tampered ciphertext or a
   moved value fails `decipher.final()` and raises `HrKeyError`, which carries no code, so the API
   answers `ERR_INTERNAL` (contracts round 16, A15). No `ERRORS` row exists for it: a wire code would
   tell an attacker which of the three happened.
5. **`updated_by` is an always-stamp.** The row is edited by design, so migration 0081's
   `app.stamp_actor_always()` (trigger `stamp_updated_by`) sets it to the session's actor on every
   INSERT and UPDATE; 0A's write-once `app.stamp_actor()` would pin it to the creator (A19).

## Consequences

- A moved row or a copied column value fails authentication. That is a hard failure, never a silent
  empty string.
- Two key versions are readable at once and no more, **including within a single row**: a partially
  rotated row opens field by field from the same two-key ring, which is what makes an interrupted
  rotation a resumable state rather than a corrupt one. A rotation interrupted twice, leaving three
  live versions, is refused by `forVersion` with a message naming the version — deliberately, so the
  operator re-runs the rotation rather than accumulating keys.
- 8D's rotation job scans `where key_version < <current>` and re-seals every column of each row it
  finds. Because a partial write can lower a row's stamp but never raise it, that scan cannot miss a
  row; the cost is that a row already fully current can be re-sealed once more if a later write lowers
  its stamp, which is idempotent work and not a correctness problem.
- The gate, not the cipher, is the access control. Encryption protects a stolen backup; the
  `sensitive_gate` RESTRICTIVE policy protects a live query, for reads and — having no `with check` —
  for writes. Both are required, and acceptance test 32 tests the gate.
- The audit trail keeps before/after images of the row, and they are ciphertext (§3.5.3); the tenant
  export pins the table whole until 8A Task 14 registers its metadata-only row (A20).
- Replacing `HR_FIELD_ENCRYPTION_KEY` without first binding the old one as `…_PREVIOUS` makes every
  sealed column unreadable; `docs/runbooks/deploy.md` says so beside the command that binds it.

## Not decided here

- **Where the key is stored in production.** Supabase Vault, a Cloudflare secret binding and an
  external KMS all satisfy this ADR; spec:2273 says "Supabase vault or a KMS". The owner's answer is
  0C's deployment decision applied to a new name (OD-20), and 8D's rotation job consumes whichever it
  is through the same two environment variables.

## Rejected

- **`pgcrypto` in the database.** The key would have to reach the SQL text or a session setting, which
  puts it in `pg_stat_activity` and in any query log. spec:2076 says "encrypted in the application".
- **One key for the whole tenant table with no version byte.** Rotation then has to be atomic across
  every row, which is a lock on a live HR table.
- **Deterministic encryption so the columns stay searchable.** A searchable national-ID column is a
  side channel, and test 32 forbids exactly that. Searching sensitive fields is not a v1 requirement.

## Owner questions

1. Is AES-256-GCM with the `employee_id:column` AAD the envelope you want, or is a KMS-wrapped data key
   per tenant (envelope encryption) required instead?
2. Where will the production key live (Supabase Vault, Cloudflare secret, external KMS)?
3. Should the all-zero development key be refused in CI as well as in staging and production?
