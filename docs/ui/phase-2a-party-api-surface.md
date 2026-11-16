# The API surface a party screen consumes (frozen by Phase 2A)

**Status:** the OD-24 material for the party screen has **not** been received (contracts §2.12, OD-24;
spec:2408). No screen ships in 2A. This file records what 2A froze, so that whichever slice ships the
screen — see the open question at the bottom — builds against a surface that already exists, and so that
the diff when the owner's material arrives is a set of components and not a set of routes.

## What exists after Phase 2A

| Capability | Endpoint | Gate | Notes |
|---|---|---|---|
| List parties, filtered and paged | `GET /v1/companies/{companyId}/parties?filter[kind][eq]=&filter[code][eq]=&includeArchived=&limit=&cursor=` | `accounting.party.manage` | keyset paging on `(code, id)`; `includeArchived` defaults to `false` |
| Read one party | `GET /v1/companies/{companyId}/parties/{partyId}` | `accounting.party.manage` | 404 `ERR_NOT_FOUND` when RLS hides it — never 403, so an invisible row cannot be probed |
| Create a party | `POST /v1/companies/{companyId}/parties` | `accounting.party.manage` | `kind` is one of `customer · vendor · employee · student · dealer`; `code` unique per company |
| Edit a party | `PATCH /v1/companies/{companyId}/parties/{partyId}` | `accounting.party.manage` | `code` and `kind` are **not** editable |
| Archive a party | `POST /v1/companies/{companyId}/parties/{partyId}/archive` | `accounting.party.manage` | there is no DELETE route and no DELETE grant (spec:2049) |
| List document types (to offer a type when the screen opens a document) | `GET /v1/companies/{companyId}/document-types` | `admin.company.manage` | archived types are excluded by default |

`accounting.party.manage` is seeded to **`user`** and computed for `admin` (2A Task 4). A read-only role — an
auditor — holds **no** party code, so a party screen shown to `auditor` has no data to show; if the owner's
workflow needs a read-only party view, that needs a **read** code, and the permission vocabulary is closed
(contracts §3.6.1), so it is an amendment to §3.6.1 and not a plan decision.

## What the screen must NOT expect the API to do

- **No opening balance on create.** A party's balance is the sum of its posted documents. A screen that wants
  an opening balance posts a document (4A's `SALES_INVOICE` or a `JOURNAL`); it is never a column on `party`.
- **No ageing on the party read.** `party_ageing` is 4B's projection and `accounting.ageing` is 4B's report
  code. The party read returns master data only.
- **No credit limit or payment term yet.** `party.credit_limit`, `party.payment_term_id` and
  `party.credit_hold` arrive in **4A**'s migration `0045_alter_party_add_credit_control.sql`. A screen built
  before 4A shows five fields fewer; it does not invent them.
- **No party-scoped document list.** `GET /v1/companies/{companyId}/documents` takes no `partyId` filter at
  2A. Adding one is a query parameter on an existing route — the smallest possible change — and it belongs to
  the slice that ships the screen.
- **No nested writes.** One request writes one party. A screen that saves a party and three addresses in one
  round trip needs a request shape that does not exist and would be an amendment to §4.2.8.

## Keyboard parity, which is not negotiable

spec:2254 requires every operation to be reachable from the keyboard, and both text directions (spec:2253,
§4.10). The list is a grid with `code` as the first column because `code` is what a clerk types; the entry
form's tab order follows `kind → code → nameEn → nameAr → receivableAccountId → payableAccountId → currency
→ taxRegistration → email → phone → address`, which is the declaration order of `CreatePartyBody` and of the
`app.party` DDL. If the owner's screenshots show a different order, **the change is the component's tab
index** — no route, no schema, no column moves.

## What changes if the owner's material contradicts this

| If the screenshots show | Change | Where |
|---|---|---|
| a different field order or grouping | tab order and layout | the screen's component only |
| a read-only party view for a non-`user` role | a new **read** permission code | amend contracts §3.6.1, then a one-line `middleware` change |
| a party-scoped document list | one `filter[partyId][eq]` query parameter | `apps/api/src/routes/accounting/documents.ts`, `DocumentQuery` |
| an opening-balance field on the create form | a document, not a column | the screen calls `POST …/documents` after `POST …/parties` |
| a "merge two parties" action | a new endpoint and an ADR proposal (it rewrites posted history's references) | not in v1 without an ADR — spec:95 |
| fields that are 4A's (`credit_limit`, terms, hold) | nothing here | 4A's migration `0045` and its own screen task |

## Open question this file does not answer

**Which slice ships the party master screen?** The 2A card's *Owner gates* cell says "OD-24 screenshots
(party screen)", but 2A's Delivers block ships no screen; 4A ships "AR/AP screens" and 2C ships "document
list/entry screens". Either 4A's cell is read as including the party master — in which case the OD-24 row
belongs on 4A's card and 2A's cell should say "records the surface; ships no screen" — or a card's Delivers
gains the screen explicitly. The architect decides; this file exists so that whichever way it goes, the
surface is already frozen.
