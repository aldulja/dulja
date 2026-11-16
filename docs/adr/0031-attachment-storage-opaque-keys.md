# ADR 0031 — Attachment storage: opaque server-generated keys and an `ObjectStore` port

**Status:** PROPOSED — this touches security and the data model, so spec:95 requires it to be asked before it is relied on.
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2C
**Spec:** §3.2.2 R2 row (spec:1138), §3.3 Attachment (spec:1192), §3.0.4 Attachments (spec:1067), Part I SAH-038 (spec:545)

## Context

SAH-038 is a path traversal to arbitrary file write: `ProcCopyExternalFile.sql` concatenated a caller-supplied
`vDstID` into a filesystem path and handed it to a native `BlobToFile` UDF running as the Firebird service
account. The prefix itself came from an unprotected `Options` table, so both halves of the path were
attacker-influenceable. The same shape reached file deletion.

## Decision

1. **The object key is derived, never supplied.** `objectKeyFor(tenantId, attachmentId)` in
   `packages/db/src/attachment/object-store.ts` is the only producer of a key. Both arguments are server-minted
   `uuidv7` values validated against a uuid pattern; anything else throws `ObjectKeyError`. The key is
   `<tenant_id>/<attachment id>` and `app.attachment.object_key` is `unique`, so a duplicate is impossible.
   `file_name` is stored as data and used only for the `Content-Disposition` header, never for addressing.
2. **A port, not a client.** `ObjectStore { put, get, delete }` lives in `packages/db` because both `apps/api`
   (upload and download) and `apps/worker` (7C's export job) need it, and `apps/worker` may not import
   `apps/api` (§3.1). `MemoryObjectStore` serves tests and a laptop; `R2ObjectStore` signs SigV4 requests
   against R2's S3-compatible endpoint.
3. **Not the Workers binding.** §3.11 binds `ATTACHMENTS` on `apps/edge`, but the ledger-bearing API is a
   Cloudflare **Container**, and containers receive no Workers bindings. Routing every upload through the edge
   Worker would put file bytes on a code path whose job is explicitly "a pre-filter, not a trust boundary"
   (spec §3.2.1). The container therefore talks to R2 directly with four secrets
   (`R2_ACCOUNT_ID`, `R2_ATTACHMENTS_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), assembled by
   `containerSecrets()` like every other §3.11 name. The `ATTACHMENTS` binding stays for the edge's own future
   use and is untouched by this slice.
4. **Integrity is recorded, not assumed.** `sha256` is computed by the server over the received bytes and
   stored on the row; the download path re-computes it and refuses to serve a mismatch.

## Consequences

- A traversal payload cannot be expressed: the function's domain is two uuids.
- `tests/regression/sah-038.test.ts` additionally scans `apps/**` and `packages/**` for any other line that
  composes an object key or joins a request-supplied name into a path, so a second spelling fails the build.
- The four R2 values are secrets and never enter the repository or a committed `.env` (spec:2273).
- **Asked:** is direct container-to-R2 access acceptable, or must attachment bytes traverse the edge Worker?
  This ADR assumes the former; the port makes the answer a one-file change either way.
