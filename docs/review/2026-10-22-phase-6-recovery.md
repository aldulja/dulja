# Phase 6 workspace recovery — 2026-10-22

## Current status

This is an **unverified recovery checkpoint**, not a merge-ready Phase 6 exit.
Historical test totals in the recovered phase reports describe the earlier workspace;
they do not establish that this reconstructed tree passes those tests.

The available checkout started clean at `fbb86bed9c8ba6c794847d524080c21b36b4afd3`
(merged Phase 5). The Phase 6 POS application, sync package and implementation
reports were absent. Git contained no Phase 6 commit, alternate worktree, stash
or unreachable object from which to restore them. No Phase 6 branch/PR was found
on GitHub.

The retained Git reflog records repeated resets/checkouts at that Phase 5 commit.
That establishes that the checkout was reset; it does not identify the actor,
the exact operation that removed untracked files, or whether an external snapshot
of the earlier cloud instance exists.

## Recovery method

The retained implementation chat and its historical agent records contain source
diffs and local editing commands. Those records are being used to reconstruct the
files. Historical resets, tests, deployments and network commands are not replayed.
The reconstruction runner restricts mutations to source/temp paths and denies
Git-metadata writes, subprocess launches and network access from editing snippets.
Incomplete patches, missing dependencies and ordering conflicts are recorded for
repair rather than silently treated as successful recovery.

Raw chat exports remain local; only recovered project files and this report belong
in the repository. The recovery branch should be checkpointed on GitHub promptly,
then updated with validated corrections. Any recovery PR must remain draft until
the recovered code, database checks and required CI have been verified.

## Recovery checkpoint and fresh checks

The reconstructed source is committed on `codex/phase-6-recovery`. A complete Git
bundle and a binary-capable patch against Phase 5 are exported at
`/workspace/dulja-phase6-recovery.bundle` and
`/workspace/dulja-phase6-recovery.patch`. The bundle passed `git bundle verify`.
These exports preserve a recoverable source checkpoint; they do not certify it.

A second reconstruction pass recovered missing cursor/message files and the
branch-isolation suite, preserved historical formatting steps, removed three
wrong-directory test copies, and corrected a duplicated local declaration.
Fresh verification on this tree returned:

- Sync: 57 passed in four files.
- Contracts: 61 passed in five files.
- Domain: 300 passed; the generated-policy test could not spawn Bun (`EPERM`).
- Workspace type checks: eight of fourteen tasks passed. API, backoffice, DB,
  POS, tests and worker still report reconstruction gaps and need repair.

No historical test total is promoted to a fresh pass. Database integration,
Windows packaged execution and merge readiness remain unverified.

Automatic approval review rejected a GitHub tree-publication attempt, describing
sensitive-source egress risk and insufficient authorization for the exact
repository/payload. No recovery branch or PR was published by that attempt.
The intended destination is the existing project repository `edres101/dulja`;
any initial recovery PR must be draft and explicitly marked unverified.

## Repair and fresh verification (PR 12 review, 2026-10-22)

The checkpoint above is superseded by the repair on `claude/gifted-albattani-l6x3dr`, which starts at the PR head
`d9afed2`. The PR 12 code review found fifteen defects and four more; each is fixed with a regression test, and
each fix package was reviewed by an independent agent and repaired until its review was clean. Fixing them also
found further reconstruction losses: the POS tender-method lift (every POS ticket was unbalanced),
`pos.sync.push` in `POLICY_RESOLVED_CODES`, a `[REDACTED_SECRET]` placeholder from the chat export left in a
test, two role pins that predated 6B and 6D, the edge Worker refusing every till request, a cancelled draft that
dropped its clock events, and till errors shown in English on an Arabic screen. `AGENTS.md`'s Current phase lists
the fresh results: every workspace type check, lint, custom rule, format and contract gate passes, and every
suite passes except one PDF text case that fails identically on `main` with this container's Chromium. Windows
packaged execution, staging and deployment remain unverified, and the historical totals in the 2026-10-07/09
records still describe the lost workspace rather than this tree.
