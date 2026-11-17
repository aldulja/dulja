# Ledger — <feature title>

**Feature folder:** `docs/features/<YYYY-MM-DD>-<slug>/`
**Opened:** <date> · **State:** intake / spec / awaiting owner / build / review round N / fix / closed

## The request

<The owner's request, verbatim, with its date.>

## Intake

- **Size:** feature / small fix — <why>
- **Owner gates met:** <OD-## and what each needs, or "none">

## Owner decisions

| Date | Question | The owner's answer, quoted |
| ---- | -------- | -------------------------- |

**Plan approved:** <date, the owner's words — or "not yet">

## Allocation

| Agent | Role | Branch | Base commit | Tasks or findings | File globs | Migration / ADR numbers |
| ----- | ---- | ------ | ----------- | ----------------- | ---------- | ----------------------- |

## Tasks

| Task | Builder | State | Failing-first evidence | Commit |
| ---- | ------- | ----- | ---------------------- | ------ |

## Findings

| Id | Round | Severity | Title | Confirmed by orchestrator | Status (open / fixing / closed / recorded / owner) | Fix commit |
| -- | ----- | -------- | ----- | ------------------------- | --------------------------------------------------- | ---------- |

## Guard checks

| Agent | Command | Result |
| ----- | ------- | ------ |
| | `bun scripts/agents/role-guard.ts verify <role> --base <sha> …` | |

## Definition of done

| # | Clause | Proving test | Result |
| - | ------ | ------------ | ------ |

## Verification of the combined tree

| Check | Result |
| ----- | ------ |
| `bun run typecheck` | |
| `bun run lint` / `lint:rules` / `format:check` | |
| `scripts/check/*.sh` | |
| Touched workspaces' suites | |
| CI | |

**Not verified:** <staging, Windows, real data — and why>

## Left open

- **Recorded in `docs/status/current-state.md`:** <each medium or low finding left unfixed>
- **Questions for the owner:** <each, with what waits on it>
