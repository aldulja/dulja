# OD-24 — Users and roles screen

**Status:** ⚠️ PENDING owner material (contracts §2.12 OD-24; spec:79, 108, 2408).
**Default in force:** the generic keyboard model below, derived from spec:2254 ("tab order, type-ahead
pickers, keyboard shortcuts, no mouse required") and 0B's OpenAPI document. **No workflow is invented
beyond it** — where the old screen's behaviour is unknown, the new screen does the obvious thing and
says so here.

## Operator description
_(pending — paste the owner's two-minute description here verbatim)_

## Screenshots
_(pending — `docs/ui/od-24-*.png`)_

## Keyboard model the default implements

This table describes what `apps/backoffice/src/routes/admin/users.tsx` actually does, so it can be
diffed against the owner's screenshots when they arrive. Every row is covered by a test in
`apps/backoffice/test/users.test.tsx`.

| Key | Action |
|---|---|
| `Tab` | skip link → language switcher → search box → grid → role picker → "Assign role" |
| `/` | focus the search box from anywhere on the screen — except while a field or the role picker has focus, where "/" is a character or a type-ahead |
| `↑ ↓` | move a row inside the grid |
| `→ ←` | move a column, mapped through `dir` (Arabic reverses them) |
| `Home` / `End` | first / last column |
| `Enter` on a row | select that person for the role controls below the grid |
| `Enter` / `Space` on "Assign role" | assign the chosen role, returning focus to the row it was made from |
| `Esc` | drop the selection, returning focus to the row it was made from — except in the role picker, where `Esc` dismisses the picker's own list |

## Where the shipped screen differs from this table's first draft

Recorded so the difference is visible against the owner's material rather than silently absorbed.

- **Assignment is inline, not a panel.** The first draft said `Enter` "opens the role-assignment
  panel" and `Esc` "closes" it. What shipped is a role picker and an "Assign role" button below the
  grid, enabled once a row is selected — no panel, so `Esc` drops the selection instead, and keeps
  the focus-return the panel model promised.
- **There is no "Invite user" button.** `POST /v1/admin/users` exists and `InviteUserBody` is
  registered, but nothing sources what the form asks for or where it sits, so it is not built
  (spec:108). `admin.users.invite` stays in both catalogues, unrendered.
- **The Status column says "Has roles" / "No roles".** 0B's `activeAssignments` is a bare
  `z.number().int()` with no description in the OpenAPI document, and 0B's own invite handler creates
  a member holding 0 — so any "Active/Expired" reading of it would label every freshly invited person
  expired. The column states what the field is until the owner's material defines a real status. The
  `admin.users.status.active`/`.expired` keys that encoded that wrong reading were **removed from both
  catalogues** in the 0E final review, and `packages/i18n/test/catalogue.test.ts` now fails if they
  come back: unlike `admin.users.invite` they are not waiting on the owner's material, they are wrong.
- **There is no "expire assignment" control and no "assigned by" line.** 0B answers both — role
  assignments can be expired, and `RoleAssignmentSchema` carries `grantedBy`/`grantedAt` — but nothing
  sources where either belongs on the screen, so neither is built. `admin.users.expireAssignment` and
  `admin.users.assignedBy` stay in both catalogues, unrendered, for the same reason
  `admin.users.invite` does. (`app.direction` did not: direction is derived from the locale by
  `dirFor`, never chosen, so a label for a control that cannot exist was removed instead.)
- **The list is one page and says so.** `ListEnvelope` carries `next_cursor` and `UserQuery` has no
  search term, so search filters the page in hand. No pager is offered (none is sourced); when
  another page exists, the count and the empty state say "on this page" rather than claiming the
  tenant is empty.

## What changes when the owner's material arrives
Only `apps/backoffice/src/routes/admin/users.tsx` and `apps/backoffice/test/users.test.tsx` — plus
the catalogue keys those two render. No API call, no contract, no other task.
