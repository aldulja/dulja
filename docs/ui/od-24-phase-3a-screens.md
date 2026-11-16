# OD-24 — the Phase 3A item, warehouse and stock screens (Plan 3A Task 15)

**Status:** 🚫 **NOT STARTED — blocked on owner material.** Plan 3A Task 15 is the only task in Plan 3A that
touches OD-24 (contracts §2.12; spec:79, 108, 2408), and it is the only 3A task that did not ship. Tasks
1–14 are all written. 1B recorded the same posture for the accounting screens in
`docs/ui/od-24-phase-1-screens.md` and 2C for the document screens in `docs/ui/od-24-phase-2-screens.md`;
this file is 3A's record, and it is the third task OD-24 now blocks.

## The gate, and what it checks

Plan 3A Task 15 Step 1 states the gate as an exact command:

```
ls -1 docs/owner/od-24/3a/
```

It must list six files — `items.png`, `warehouses.png`, `stock.png` and `items.md`, `warehouses.md`,
`stock.md`, each `.md` being a transcribed two-minute description of what the operator does on that screen,
in order, including which keys they press. Run on 2026-09-20 against this tree it fails outright:
`docs/owner/` does not exist. Step 1 then reads, verbatim: *"If the directory is missing or incomplete: stop
here. Record in the task 'OD-24 unanswered for 3A; screens deferred', leave Steps 2–5 unchecked, and ship
the slice. Nothing in Tasks 1–14 depends on this task. Do **not** substitute a guess: hazard 29, and the
legacy screens are the only record of the workflow this business actually runs."*

That is what was done.

## What the slice ships instead

The API is the deliverable, and it is complete. An operator's own tooling can already drive every screen
this task would have built:

| Screen | Endpoints already shipped (3A Tasks 11, 12) |
|---|---|
| Item master | `GET\|POST /v1/companies/{companyId}/items`, `GET\|PATCH …/items/{itemId}`, `POST …/items/{itemId}/archive`, `GET\|PUT …/items/{itemId}/unit-conversions`, `GET\|POST …/items/{itemId}/lots`, `GET\|POST …/units` |
| Warehouse list | `GET\|POST …/warehouses`, `GET …/warehouses/tree`, `GET\|PATCH …/warehouses/{warehouseId}`, `POST …/warehouses/{warehouseId}/archive` |
| Stock enquiry | `GET …/stock-on-hand`, `GET …/stock-on-hand/fefo` |

All twenty 3A paths carry a permission gate `assertRouteGates` checks at boot, an `Idempotency-Key` on every
unsafe method, a `PROBES` entry, and company-binding on every entity id in a path.

## The exact file list that changes when the material arrives

Nothing above this line moves. Task 15 Steps 2–5 create:

- `apps/backoffice/src/lib/inventory-api.ts` — the typed fetch layer, which is **independent of the
  workflow**: it wraps the endpoints above and would not change even if the owner's material showed a
  completely different screen.
- `apps/backoffice/src/routes/inventory/items.tsx`, `warehouses.tsx`, `stock.tsx`
- `apps/backoffice/test/inventory-items.test.tsx`, `inventory-warehouses.test.tsx`, `inventory-stock.test.tsx`
- `tests/e2e/inventory-screens.spec.ts` — acceptance test 23's 3A re-run, both text directions
- Modify: `apps/backoffice/src/router.tsx` (three routes), `apps/backoffice/src/components/app-shell.tsx`
  (three nav entries), `packages/i18n/src/locales/en.json` and `ar.json` (every `inventory.*` key, in BOTH)

## Why a default layout was not written down and built anyway

The plan does state a default — a two-pane list-and-detail per screen, 0E's `DataGrid` inline-start and a
form inline-end, with `/` focusing the filter, arrow keys moving cell focus direction-mapped, `Enter`
activating a row, and `Ctrl+S` / `Esc` / `Ctrl+N` as this task's own additions. The field *set* is dictated
by the API and cannot change.

But everything the gate actually asks about is what the default cannot supply: the order the fields are
filled, what is typed versus chosen, whether the line grid is entered row-first or column-first, and which
keys a fast operator's hands already know. spec:79 and spec:108 are explicit that the UI is not specified
and that workflows are not to be invented from the specification, and hazard 29 forbids it. A screen built
against a guess is worse than no screen: it looks finished, so nobody re-opens the question, and the
operator it was built for is slower on it than on the system it replaced.

## What this blocks, cumulatively

OD-24 now blocks three whole tasks across three phases — 1B Task 11 (three accounting screens), 2C Task 12
(the document list and entry screens) and 3A Task 15 (these three). None of the three phases' definitions of
done contains a screen clause, so none of them is blocked *by* this; but the back-office application ships
with no screen for any of accounting, documents or inventory until the material arrives.
