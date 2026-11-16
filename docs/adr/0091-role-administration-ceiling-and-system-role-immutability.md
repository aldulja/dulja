# ADR 0091 — Role administration has a ceiling, and system roles are immutable

**Status:** PROPOSED — a security and data-model change (spec:95). As with ADR 0087 it is implemented in the
same PR that fixes the findings, and this record says so.
**Date:** 2026-11-15
**Deciders:** owner (pending), architect
**Branch:** `claude/fix-system-role-guard` — a fix session of the 2026-11-15 full review, not a slice. Number
allocated by the review's orchestrator, as is **migration 0124**.
**Findings:** API-03 (blocker), API-08, API-09 (`docs/review/findings/api-contracts-edge.md` on
`claude/review-api-contracts-edge`).
**Adjacent, not decided here:** OD-04 (the nine seeded role names). Nothing below names, renames or adds a role.
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

Spec:2152 says the seeded roles "are never renamed or archived; their permissions change only by migration, so a
change is a reviewed diff". Nothing enforced it:

- `/v1/admin/roles` gated every method on `admin.role.manage` in **any** company. `PUT /{roleId}/permissions` and
  `PATCH /{roleId}` never read `is_system`, never asked whether the caller held the codes being granted, and never
  applied R6's pairs. The only database guard, 0001's `forbid_self_grant`, refuses a role the **actor** holds. So a
  principal administering one company could give the seeded `user` role — held in every company —
  `accounting.payment.create`, `.approve`, `.post` and `admin.role.assign` (API-03).
- `POST /v1/companies/{companyId}/role-assignments` inserted any role for any member. Two holders of
  `admin.role.assign` could hand each other `admin` (API-09).
- `POST /v1/admin/users/{userId}/expire`, gated on `admin.user.manage` in any company, expired the user's
  assignments in every company, past each other company's own `admin.role.assign` gate (API-08).

## Decisions

1. **A system role is immutable through the API.** `PATCH` and `PUT …/permissions` on an `is_system` role answer
   **409 `ERR_RBAC_SYSTEM_ROLE`**. The remedy is the one spec:2152 already names: clone it into a custom role.
2. **The data layer says the same (migration 0124).** `app.guard_system_role()`, a BEFORE trigger on `app.role`
   and `app.role_permission`, refuses an `app_rw` session that inserts, updates or deletes a system role, inserts
   a role with `is_system = true`, flips `is_system`, or changes a system role's permission rows. It admits every
   session that is not `app_rw` (the migrator, which runs migrations and `bun run seed`) and an `app_rw` session
   whose actor is the tenant's **system principal** (the seed's roles loader as some tests run it). No request runs
   as the system principal. Assigning a system role is untouched.
3. **Writing a role needs tenant scope.** A role is a tenant-wide row, so `POST`, `PATCH` and `PUT` on
   `/v1/admin/roles` require `admin.role.manage` at **tenant scope**: held company-wide (no branch rows) in every
   company of the tenant that has at least one live role assignment, and in at least one company. The route gate
   stays "any company", which is enough to list roles; the handler asks the rest
   (`missingAtTenantScope`, `packages/db/src/rbac/role-ceiling.ts`).
   _Why "companies with a live assignment" and not "every company":_ `POST /v1/companies` assigns no one, so a
   new company has no administrator and no route can give it one; counting it would lock role administration for
   good the moment a second company is created. A company nobody holds a role in is one a role edit cannot yet
   affect, and the assignment ceiling (5) guards the first assignment made there.
4. **The editor's ceiling.** `PUT …/permissions` may **add** only codes the caller holds at tenant scope (403
   `ERR_RBAC_FORBIDDEN` naming them). Removing is not ceilinged. A code outside the catalogue is still left to the
   foreign key (409 `ERR_CONFLICT_REFERENCE`).
5. **The assigner's ceiling.** Assigning a role, and replacing an assignment's branch rows, require the assigner
   to hold every code of the role at the scope the assignment grants: company-wide when it has no branch rows,
   else at each of its branches (403 `ERR_RBAC_FORBIDDEN`). `missingCeilingForAssignment`.
6. **The till's codes are exempt from both ceilings.** `pos.ticket.sell` and `pos.sync.*` are the codes the seeded
   `admin` deliberately lacks (`ADMIN_EXCLUDED_*`, spec:2146). Without the exemption no administrator could assign
   `cashier` or `branch_manager`, or define a custom till role. `pos_terminal` stays bound to terminals by
   `assert_assignment_kind`.
7. **R6 applies to custom roles.** A `PUT …/permissions` whose resulting set holds both codes of an
   `INCOMPATIBLE_PAIRS` entry answers **409 `ERR_RBAC_INCOMPATIBLE_PAIR`**. Spec:2177 states R6 for the seeded roles
   and enforces it by a CI lint; this extends the same pairs to custom roles at run time. A principal may still
   hold both codes through two roles, as spec:2177 allows; R1 then binds them.
8. **Expiring a user ends only what the caller administers.** `POST /v1/admin/users/{userId}/expire` expires the
   assignments in companies where the caller holds `admin.user.manage` (`app.actor_has(code, company)`, so
   company-wide). A caller holding it in every company therefore still ends all of them, and
   `expiredAssignments` counts only what was ended.

## Day-one administration

The seeded `admin` holds every catalogue code except the till's (spec:2146). Assigned to the owner in the first
company by the seed, it therefore passes every check above: it edits and creates custom roles, adds any code,
assigns every seeded role (`cashier` and `branch_manager` through decision 6) and expires users. What it can no
longer do is edit a seeded role; that was never meant to be possible (spec:2152).

## Consequences

- Two `ERRORS` rows: `ERR_RBAC_SYSTEM_ROLE` and `ERR_RBAC_INCOMPATIBLE_PAIR` (409).
- A multi-company tenant needs its role administrator assigned in every company where people hold roles. Until a
  second company has an administrator, role administration still works (decision 3), but assignments in it need
  someone who holds `admin.role.assign` there — a gap that existed before this ADR (no route assigns the first
  administrator of a new company).

## Owner questions

1. Is "every company with a live assignment" the tenant scope you want, or should a new company's creator be
   assigned `admin` in it automatically (which would let decision 3 become "every company")?
2. Is the till-code exemption (decision 6) acceptable, or should those codes be assignable only by a principal
   holding a dedicated code?
3. Should R6 bind custom roles at all (decision 7)? Spec:2177 states it for the seeded roles only.
4. For API-08 the review offered two shapes: limit the expiry to the caller's companies (chosen), or refuse unless
   the caller holds the code in every company the user has a role in. Confirm the choice.
