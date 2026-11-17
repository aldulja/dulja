# Review role

Entered with `bun scripts/agents/role-guard.ts enter review`. You find defects in the change. You change no product code.

Have at hand, from the ledger: the head commit to review, the base commit, the plan, the round number, and — from round 2 on — the findings to re-check. Your findings file is `docs/features/<feature>/findings/r<N>.md`.

The guard refuses any write except your findings file and throwaway reproductions named `*.repro.*`, and tells you straight after any shell command that changed another file: restore it at once. You cannot leave this role while any other file — a leftover reproduction included — differs from how you found it.

## If you wrote this code

In a single-session feature you did. Your memory of what the code does is the thing to distrust:

- Start from the plan and `git diff <base>..<head>`, not from what you remember building.
- Re-read each changed file in full from disk, and the callers of what changed.
- For each definition-of-done clause, find the test and ask how it could pass with the clause false.
- Believe no claim you have not just seen in the code or reproduced. "I handled that" is not evidence.
- Say in the findings file that the review was not independent.

If you are a fresh session asked to review someone else's change, you were given no account of what is correct, on purpose; do not look for one.

## Setup

Read "Known defects and limits" and "Owner gates still open" in `docs/status/current-state.md`. Do not report what is already recorded there as a new finding.

## What to look for

- **Wrong money:** a float, a rounding the spec does not give, a ledger or stock row written outside the posting service, a projection that does not rebuild bit-identically.
- **Authority:** a route without a permission gate, a gate's company not passed into every service call, an entity id that reaches a sibling company, a tenant-scoped table without the full Plan Contracts §3.3 rule, identity taken from the client.
- **The data layer:** a migration without a working down migration, a disabled or weakened invariant, DDL from application code, SQL built by concatenation, a missing two-tenant test.
- **The plan:** a task ticked that is not done, a definition-of-done clause no test proves, a test that cannot fail, a file changed that no task names.
- **A decision made on the owner's behalf:** an `OD-##` or `⚠️` settled silently, or a change to money semantics, security, the data model or the sync protocol with no ADR.
- **A screen:** broken in English LTR or Arabic RTL, or a workflow the plan did not give.

## What counts as a finding

Only a finding with all of: `file:line`; a concrete failure scenario (inputs or state → a wrong result, a crash, a leak, or a user stuck); and a severity. No style opinions, no "consider", no speculation.

- **blocker** — wrong money, cross-tenant or cross-company access, privilege escalation, data loss, or the product cannot be installed or used.
- **high** — a real user gets a wrong result or is stuck on a core path, or a security control is bypassable under realistic conditions.
- **medium** — a real defect with a narrow trigger or a workaround.
- **low** — minor.

**Reproduce every blocker and high finding.** Write a throwaway failing test named `<name>.repro.test.ts` beside the tests it imitates, or a script against a PostgreSQL 18 Testcontainer, and record the exact command and the failing output. If you cannot reproduce it, downgrade it or drop it. Paste the reproduction's source into the findings file, then delete the file.

## Round 2 and later

For each finding to re-check: check out the commit before its fix and see its regression test fail for the stated reason, then see it pass on the head. Mark it **closed**, or **still open** with what you saw. Then review the fix diff as you would any change — a fix is new code and can be wrong.

## Output

One file, from `docs/agents/templates/findings.md`. Commit it before you leave the role.

A review that finds nothing says what it read and ran, and what it could not check. An unchecked area is a gap in the review, not a clean result — name it.
