#!/usr/bin/env bash
# Verifies that every cross-slice contracts name 2C's interfaces depend on is present in the frozen
# document. Task 0 of plan 2C; run by that task only — it is not wired into `bun run lint`, because the
# round-2 amendment pass has landed and it can never fail again on a current checkout. It only READS.
set -euo pipefail
DOC=docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md
missing=0
need() {
  if ! grep -qF -- "$1" "$DOC"; then echo "MISSING from $DOC: $1"; missing=1; fi
}
need 'objectStore: ObjectStore'                 # §4.2.7 — AppDeps' sixth member
need 'attachment: { row: AttachmentRow; module: DocumentTypeModule }'   # §4.2.3 — AppEnv Variables
need 'documentModule: DocumentTypeModule'       # §4.2.3 — AppEnv Variables
need 'ERR_PRINT_ENGINE_UNSUPPORTED'             # §4.2.4 — the allocated code table
need 'R2_ATTACHMENTS_BUCKET'                    # §3.11 — the four R2 names
need 'REPLAY_BY_RERUN'                          # §4.2.9 — idempotency
need '"document-types" | "templates"'           # §4.2.13 — SubPack widening
need 'pdfText'                                  # §4.17.1 — the shared helper register
need 'version int not null check (version > 0)'                                  # §4.5.9
need "paper text not null default 'A4' check (paper in ('A4','A5','receipt'))"   # §4.5.9
need 'grantCodes(db, s, opts?: { codes?; principalId?; roleCode?; branchIds? })'  # §4.17 — 2B's fixture row
exit "$missing"
