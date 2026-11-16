# ADR 0095 — Company-wide guard aggregates under branch isolation

**Status:** PROPOSED — a security widening (five `SECURITY DEFINER` lookups) and a money control (credit
control), so spec:95 requires the owner's approval; as with ADRs 0020 and 0087 it is implemented in the same PR
that found it necessary, and this record says so.
**Date:** 2026-11-15
**Deciders:** owner (pending), architect
**Branch:** `claude/fix-company-wide-guards` — a fix session of the 2026-11-15 full review, not a slice. Number
allocated by the review's orchestrator from the §3.9 tail; **migration 0127** likewise (§3.4.1's tail rule).
**Findings:** DBS-04 (high), DBS-07 = INV-08 (medium), DBS-18 (low) — `docs/review/2026-11-15-full-review.md`.
**Supersedes:** nothing. **Amends:** nothing; it applies the 0068 / 0119 / 0090 definer pattern to four more
questions.

## Context

Five data-layer guards answer a question about a whole company — the party's credit exposure, the quantity
already linked against a source line, whether a party has posted, whether a payment term is pinned — and all
five were `SECURITY INVOKER` reads of `app.document` under the caller's RLS. Since 0068, `app.document` carries
the RESTRICTIVE `branch_isolation` (0119's Form A), which hides every other branch's documents from a principal
whose role is restricted to some branches. For that principal each guard answered over their own branches
only, and failed open:

- **DBS-04, credit control** (0045 `party_open_balance` / `party_credit_exposure`, read by 0061's
  `assert_credit_available`). Limit 1,000, 900 issued at HQ; a clerk restricted to branch BRB issues 900 more
  at BRB — it succeeds, exposure 1,800, and spec:2173/2179's second-principal override is never asked for. A
  branch-restricted POS terminal's on-account sales are measured the same way.
- **DBS-07 = INV-08, over-fulfilment** (0116's guard, its reinstated-claim twin, and `app.document_open_quantity`).
  An order line of 10 at HQ, fulfilled 10 from a draft at BRB by a company-wide user; a principal restricted to
  HQ reads 10 open and links 10 more — 20 against 10, LEGACY-017's control bypassed.
- **DBS-18, the "pinned" guards** (0045 §4a, §4b). A document at another branch did not pin the payment term's
  days or the party's control account. Not reachable through today's routes, which gate company-wide.

## Decisions

**1. One lookup per question, on the 0068 / 0119 / 0090 pattern** (migration 0127). Each is `language plpgsql
stable security definer set search_path = app, pg_temp`, **owned by `app_auth`** (no LOGIN, no BYPASSRLS —
`tenant_isolation` still applies inside), bound explicitly to `app.current_tenant()` and to the company the
caller names, executable by `app_rw` only, never a policy predicate, and returning **one aggregate, never a row**:

| Function | Returns | To whom |
| --- | --- | --- |
| `app.party_company_open_balance(company, party, as_of)` | `numeric` — the party's posted balance in base on its **own** receivable control account (read inside, never supplied), every branch | a live role in `company` |
| `app.party_company_pending_credit(company, party, excluding_document)` | `numeric` — the base total of the party's other issued, unposted, credit-extending documents, every branch | a live role in `company` |
| `app.source_line_linked_quantity(company, source_line, excluding_link)` | `numeric` — the standing quantity linked against the line, 0116's chain rule word for word, every branch | a live role in `company` |
| `app.party_has_posted_document(company, party)` | `boolean` — any posted or reversed document of the party, every branch | a live role in `company` |
| `app.payment_term_is_pinned(company, payment_term)` | `boolean` — any non-draft document naming the term, every branch | a live role in `company` |

"A live role in `company`" is `app.actor_live_in_company(company)`: an unexpired `role_assignment` in that
company, **whatever its branch restriction**, or the tenant's system principal — exactly
`app.actor_in_branch` without its branch clause. Anyone else gets `ERR_NOT_FOUND: company … is not visible`.

**2. The guards keep their names, signatures and errors.** `party_open_balance` and `party_credit_exposure`
stay invoker wrappers (they still read the party under the caller's RLS, and still raise LEGACY-042's
`ERR_POLICY_REQUIRES_MISSING`), so `creditStatus()` and the trigger keep reading the same function and the
credit screen shows the company-wide figure the control compares. The link guard keeps its advisory lock
before the sum (the sum is now the lookup's). The view keeps its columns and `security_invoker`; which lines a
reader sees is unchanged — only the linked quantity on a visible line is company-wide.

**3. `branch_isolation` on `app.document` is scoped `to app_rw, app_migrator`**, its predicate 0119's,
unchanged — the same step 0119 took on `app.warehouse` and 0090 on `compensation_gate`, so `app_auth` can see
every branch inside the lookups. `app_auth` gains column `SELECT`s for exactly what the lookups read
(`document`: id, tenant, company, party, status, effective date, rate, type, reversed document, payment term;
`document_line`: id, tenant, company, document, kind, amount, gross; `ledger_entry`: tenant, document, account,
base debit and credit; `party`: id, tenant, company, receivable account; `posting_policy`: tenant, type,
version, effective date, definition; `document_link`: id, tenant, company, source and target documents, source
line, kind, quantity) and `EXECUTE` on `app.document_claim_stands`. No role that can log in gains anything.

## Consequences

- A branch-restricted principal now learns, through credit control and `creditStatus()`, a party's
  company-wide exposure, and through `document_open_quantity` the company-wide linked quantity of a line they
  can see — aggregates, never another branch's document. That is the widening this ADR asks the owner to
  approve; the alternative (a branch-local exposure) is the defect.
- **Tightening:** the two pinned guards and the credit and link sums now refuse a caller with no live role in
  the company (`ERR_NOT_FOUND`); before 0127 such a caller saw no documents, so the pins passed. Every route
  reaching them already gates on a company code, and jobs run as the system principal.
- The view calls the lookup once per visible line (it was a lateral sum per line before), so its cost is
  unchanged in shape.
- 0127's down restores 0045's and 0116's bodies and 0119's policy exactly.

## Owner questions

1. Is "a live role in the company, whatever its branches" the right audience for the company-wide credit
   exposure and linked quantity, or should the lookups also require a module read code (e.g.
   `accounting.party.read` for the exposure)?
2. Is `ERR_NOT_FOUND` the right refusal for a caller with no live role in the company, or should it be
   `ERR_RBAC_FORBIDDEN`?
