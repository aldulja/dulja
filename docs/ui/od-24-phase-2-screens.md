# OD-24 — the Phase 2 document screens (Plan 2C Task 12)

**Status:** 🚫 **NOT STARTED — blocked on owner material.** Plan 2C Task 12 is the only task in Plans 2A, 2B
or 2C that touches OD-24 (contracts §2.12; spec:79, 108, 2408), and it is the only Phase 2 task that did
not ship. Every other task of the three plans is written. 2A recorded the same posture for the party screen
in `docs/ui/phase-2a-party-api-surface.md`, and 1B for the accounting screens in
`docs/ui/od-24-phase-1-screens.md`; this file is the 2C record.

## The gate, and what it checks

Plan 2C Task 12 Step 1 states the gate as an exact command:

```
test -s docs/owner/od-24/document-entry.md && ls -1 docs/owner/od-24/*.png | wc -l
```

It must print a count of at least 2 — one screenshot per screen, the document **list** and the document
**entry** screen of any legacy module — with `document-entry.md` non-empty. Run on 2026-09-19 against
this tree it fails on its first clause: `docs/owner/` does not exist. Task 12 Step 1 then reads, verbatim:
*"If it fails, stop: mark the task blocked in the PR, and proceed to Task 13. Do not build a screen against
a guess (hazard 29)."*

## Why a default was not written down instead

The two screens are **data-entry** screens, and the gate's subject is the keyboard path a fast operator
takes through them: the order fields are filled, what is typed versus chosen, which keys are used, whether
the line grid is entered row-first or column-first, and whether printing is a button on the form or an
action on the list row. spec:108 — "Do not invent workflows from this document." 1B took the same position
for the journal-entry grid and 2C follows it: the field *set* is dictated by the API and cannot change, but
everything the gate asks about is exactly what the owner's material decides, and inventing it produces
work the owner has to throw away.

## What the owner provides

1. Screenshots of the legacy **document list** and **document entry** screens (any module) —
   `docs/owner/od-24/*.png`, at least one per screen.
2. A two-minute recorded or written description, `docs/owner/od-24/document-entry.md`, of how an operator
   actually works them: the order fields are filled, what is typed versus chosen, which keys are used, what
   is printed and when.

## What is already built, so the screens are a thin layer when they start

Nothing in Task 12 is blocked on code. Everything the two screens consume exists on this branch, gated as
the API gates it:

| The screen needs | Where it is | Slice |
|---|---|---|
| list, read, create a document; replace its lines | `GET`/`POST …/documents`, `GET …/documents/{id}`, `PUT …/documents/{id}/lines` | 1A, 2A |
| walk the lifecycle (`draft → submitted → approved → issued → posted`, `void`) | `POST …/documents/{id}/transitions` (`TransitionBody`) | 1A, 2B |
| reverse, override, delete a draft, read the timeline | `POST …/{id}/reverse`, `POST …/{id}/overrides`, `DELETE …/{id}`, `GET …/{id}/events` | 2B |
| choose a type; choose a party | `GET …/document-types`, `GET …/parties` | 2A |
| attach a file; list and download attachments | `POST`/`GET …/attachments`, `GET …/attachments/{id}/content` | 2C |
| print in either direction | `POST …/documents/{id}/print { templateCode?, lang }` → `application/pdf` | 2C |
| branch picker | `GET …/dimension-types` and `…/{id}/values`, membership-only | 0D |
| wire shapes | `DocumentSchema`, `DocumentList`, `TransitionBody`, `AttachmentSchema`, `AttachmentList`, `PrintDocumentBody`, `PrintTemplateSchema` — all exported from `@dulja/contracts`; the screens import them and re-declare nothing | 1A–2C |
| shell, grid, i18n, RTL | `@dulja/ui`, `packages/i18n`, `apps/backoffice` | 0E |

Two facts the screen must respect, both fixed by the API and not by the owner's material: a PDF is fetched
with an `Idempotency-Key` like every other POST (printing re-runs on a replayed key — contracts §4.2.9), and
an attachment upload is multipart with the file's bytes hashed server-side, so the client sends no digest.

## What changes when the material arrives

Task 12's own file list, and nothing outside it: two routes under `apps/backoffice/src/routes/documents/`
(`index.tsx`, `$documentId.tsx`), four components under `apps/backoffice/src/features/documents/`
(`DocumentTable`, `DocumentForm`, `AttachmentPanel`, `PrintButton`), the three binary-body members of
`apps/backoffice/src/lib/admin-api.ts`, two `createRoute` declarations in `apps/backoffice/src/router.tsx`,
the `documents.*` namespace in the two i18n catalogues, `apps/backoffice/test/documents.test.tsx` and
`tests/e2e/documents.spec.ts` (acceptance test 23 for these screens). The owner's answer changes the
**order** of fields in `DocumentForm`, which of them get keyboard shortcuts, whether the line grid is entered
row-first or column-first, and where the print action sits. Each is a prop or a re-order inside those files;
no route, no schema, no permission and no other task changes. Phase 2's definition of done (spec:2288)
contains no screen clause, so the phase exits without this task and the screens land in the PR that follows
the owner's answer.
