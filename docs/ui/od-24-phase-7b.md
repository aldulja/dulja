# OD-24 — the Phase 7B catalogue's screens (Plan 7B Task 13)

**Status:** 🚫 **NOT STARTED: blocked on owner material — and by design 7B ships no screen either way.** Plan 7B
Task 13 is the only 7B task that touches OD-24 (contracts §2.12; spec:79, 108, 2408). Tasks 0–12 and 14 are
written. Earlier slices recorded the same posture in their own files:

- 1B, the accounting screens: `docs/ui/od-24-phase-1-screens.md`
- 2C, the document screens: `docs/ui/od-24-phase-2-screens.md`
- 3A, the inventory screens: `docs/ui/od-24-phase-3a-screens.md`
- 3C, the purchasing screens: `docs/ui/od-24-phase-3c-screens.md`
- 3D, the inventory-operations screens: `docs/ui/od-24-phase-3d-screens.md`
- 4A, the AR/AP screens: `docs/ui/od-24-phase-4a-screens.md`
- 4B, the ageing and bank-reconciliation screens: `docs/ui/od-24-phase-4b-screens.md`
- 7A, the report designer and viewer: `docs/ui/od-24-phase-7a.md`

This file is 7B's record. It adds no code, no route, no component, no navigation entry, no catalogue key and no
`ReportDefinition` member.

## The discrepancy this task sits inside

Plan 7B records it in its Task 13 preamble, and it is repeated here so whoever reconciles the two sources can
see which one was followed:

- **§2.8's 7B card names OD-27 and no other owner gate**, and §2.12's OD-24 row scopes that decision to "every
  slice with a screen task". 7B has none.
- The **orchestrator's slice record** for 7B lists OD-24, and hazard 6 requires one isolated task per owner
  decision a slice carries, so the plan wrote the task rather than dropping it silently.

Under either reading the task ships no file of code. If the card is the authority, Task 13 can be deleted
without renumbering anything; no task depends on it.

## The gate, and what it checks

Task 13 Step 1: *Owner provides* screenshots of the legacy report **menu** (how a user finds a report among a
few dozen), a two-minute description of how a clerk runs one, and which reports they run daily. *Verify:*
`ls docs/owner/od-24/7b/` lists at least one image and one `description.md`. Run on 2026-11-05 against this
tree:

```
$ ls -1 docs/owner/od-24/7b/
ls: cannot access 'docs/owner/od-24/7b/': No such file or directory
$ ls -1 docs/owner/
od-10
od-15
```

`docs/owner/od-24/` does not exist, so no item has been supplied for this slice or any other. The directory was
not created: an empty one would only look like material had arrived. **Step 1 stopped; Steps 2 and 3 did not
run.**

## What the owner must provide

Placed in `docs/owner/od-24/7b/` (7A's `docs/owner/od-24/7a/` items cover the list, viewer and designer
themselves; these are only what 7B's catalogue adds):

1. **Screenshots of the Sahlisoft report menu** — how a user finds one report among the few dozen in daily use,
   including any grouping, favourites or search.
2. **A two-minute `description.md`** of how a clerk runs a report: the keys pressed, the parameters retyped every
   time, and which reports are run more than once a day.

## Why nothing ships while the gate is closed — and little when it opens

The twenty-two definitions appear in **7A's** report list and designer the moment they are seeded with
`bun run seed --tenant <id> --only reports` — that is what a definition is for — and this slice adds no route,
component or navigation entry. The catalogue is runnable today through 7A's API
(`POST /v1/companies/{companyId}/reports/{code}/runs`, `GET …/report-definitions`), which 7B Task 11's roll-up
reaches for all seventeen new codes.

When the material arrives, Task 13 does two things and no more:

- **Step 2 — a proposal, not code.** The only thing 7B could add to a menu is a *grouping* of the catalogue; the
  seventeen new codes otherwise arrive as a flat list. A `layout.group` or `category` member is what a grouped
  menu would read, and §4.11.1's frozen format carries neither, so the step writes it as a proposal (spec:95) in
  the same PR as the screenshots and stops. Adding the member first and discussing it after is the failure
  this step exists to prevent.
- **Step 3 — a re-run, not a new spec.** `bun run --cwd tests test:e2e -- --grep "report"` through 0E's
  `bootLocalStack()`, in both text directions, over 7A's list and viewer with this slice's catalogue seeded —
  acceptance test 23 against a fuller catalogue (spec:2377). 7A owns those screens and their spec file, and
  7A's own screen task (`docs/ui/od-24-phase-7a.md`) must land first, since there is no report screen to re-run
  against until it does.

## What this blocks, cumulatively

Nothing in 7B: Plan 7B's definition of done ("every report's numbers tie to the ledger", the SAH-070 index gate,
the regression appends) has no screen clause, and the slice exits on its defaults. Task 14's slice-exit record
carries the one-line outcome the plan prescribes: _"OD-24: no material; 7B shipped no screen, as designed."_ The
gate stays open for 7C's export screen, which does need it. OD-24 still blocks eight whole screen tasks across
the tree (1B T11, 2C T12, 3A T15, 3C T13, 3D T13, 4A T13, 4B T11, 7A T15); this one is a ninth only in name,
since it would ship no screen of its own.
