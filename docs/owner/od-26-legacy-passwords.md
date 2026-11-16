# OD-26 — `Users.Password`, and the proof that no credential is imported

**Status: open.** Contracts §2.12, OD-26; spec:2468, Part VII #4: "Is `Users.Password` hashed client-side? Changes the
migration plan (forced reset vs. rehash-on-login). The schema has no salt or algorithm column either way, so a forced
reset is the safe default." §2.12's default: **forced reset, never imported.** Recorded by plan 9B Task 12
(2026-11-13); this record decides nothing.

**Owner provides:** an answer to Part VII #4 — whether the legacy client hashed the password before storing it and, if
so, with what algorithm. A "yes" comes with one example row and the algorithm's parameters, and re-opens the question
as an ADR proposal (spec:95) before any code is written.

**Until provided — and expected to stay so:** there is no `Users` loader, no `Users` column is declared or read, 9A's
`NEVER_READ` (`USERS.PASSWORD`, `USERS.PIN`, `packages/importer/src/snapshot.ts`) keeps both out of every snapshot, and
every user is invited fresh through `POST /v1/admin/users` and enrols MFA (`docs/runbooks/cut-over.md` step 6).

**Why a "yes" changes nothing in 9B.** SAH-028 records the passwords as cleartext; Part VII #4 admits a client-side
hash and answers itself. Dulja's identity is Supabase with MFA, so there is no password column in Dulja to rehash
_into_: a migrated credential would have to become a Supabase user's password, which the invite flow sets. A "yes"
only decides whether the archived legacy database is worth retaining for a forensic reason.

**What keeps it true** (each a test that fails the day a loader reads a credential):

- `tests/regression/sah-028.test.ts`, block "— 9B, the import path": no registered loader's source table is `USERS`;
  no declared source column matches `PASSWORD`, `PASSWD` or `PIN`; no file under `packages/importer/src` names
  `USERPASSWORD`, `USRPASSWORD`, `USRPIN` or `USERPIN`, and no file under `packages/importer/src/load` names a password
  or a PIN at all; the invite body has exactly `email` and `displayName`.
- `packages/importer/test/load/registry.test.ts`, "keeps 9A's NEVER_READ deny-list intact, and no loader declares a
  column it lists".

Implementation authorization for the default: `docs/review/2026-11-13-phase-9-decisions.md`, row "9B T12".
