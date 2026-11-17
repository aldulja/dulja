# The feature workflow's briefs

The workflow is in `AGENTS.md` ("Feature Workflow"). One session works a feature's stages in order and plays one role at a time; it starts no subagent. Each role has one brief here, and the session reads it when it enters the role.

| Brief             | Role                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `orchestrator.md` | Runs the stages and their gates, allocates the numbers, keeps the ledger       |
| `spec.md`         | Writes the plan the owner approves                                             |
| `build.md`        | Executes the approved plan, test-first                                         |
| `review.md`       | Finds defects in the change; changes no product code                           |
| `fix.md`          | Fixes review findings, failing test first                                      |

`templates/` holds the plan, ledger and findings templates.

## Why one session and no subagents

A subagent starts with nothing: it loads `AGENTS.md` again, reads its brief and re-reads the code the session already has in context. In the live runs of 2026-11-17 a subagent that made three tool calls cost about 30,000 tokens. A feature worked by five of them pays that many times over; one session pays it once.

What that costs is independence: the session that built the code also reviews it. The review brief is written for that, the ledger records it, and when a feature touches money semantics, security, the data model or the sync protocol the session asks the owner whether to have a fresh session — started by the owner on the feature's branch — do the review instead.

## One folder per feature

`docs/features/<YYYY-MM-DD>-<slug>/` holds the feature's `ledger.md` and `approval.md` (orchestrator role), `plan.md` and `adr/` drafts (spec) and `findings/` (review). A new session can resume a feature from that folder alone.

## What holds the session to its role

`scripts/agents/role-guard.ts`, in three ways:

1. **`bun scripts/agents/role-guard.ts enter <role>`** (and `leave`, `status`) puts the session in a role and records where the tree stands. It refuses to move on while the role being left has changed a file it may not leave changed.
2. **A hook**, registered once in `.claude/settings.json`. While a role is in force a file tool is refused a path outside the role's own; a shell command is refused a merge or a push to the default branch; the Agent tool and the GitHub merge tools are refused; and the spec and review roles are told straight after any shell command that changed a file they may not change. With no role in force the hook lets everything through.
3. **`bun scripts/agents/role-guard.ts verify <role> --base <sha> [--allow <glob>]…`**: every path changed since `<sha>`, committed or not, must be one the role may leave changed; for build and fix `--allow` narrows that to the plan's files. It needs no hook and no role in force.

| Role         | May write while in the role                                         | May leave changed                      |
| ------------ | ------------------------------------------------------------------- | -------------------------------------- |
| orchestrator | `docs/**`, `AGENTS.md`                                              | not checked on leaving                 |
| spec         | `docs/features/**`                                                  | `docs/features/**`                     |
| review       | `docs/features/*/findings/**`, any `*.repro.*` file                 | `docs/features/*/findings/**`          |
| build, fix   | anything but `AGENTS.md`, `docs/status/**`, the feature's `plan.md` | not checked on leaving; `verify` holds them to the plan's files |

Only the orchestrator role may write a feature's `approval.md` and `ledger.md`. No role may write `.claude/**`, `scripts/agents/**` or `docs/agents/**`: the workflow is changed by the owner, not by a session working inside it. The rules are `RULES` in `scripts/agents/role-guard.ts`, and its tests (`role-guard.test.ts`, run by the `tests` workspace) pin them.

The role in force is kept in `.claude/role-state.json`, which git ignores. It belongs to the session whose first tool call followed `enter`; another session that finds the file is not bound by it.

## What a guard cannot do

It holds a session to the paths of the role it says it is in. It cannot stop the session from entering a different role — that is how the workflow moves — so it is a guardrail against a stage doing another stage's work, not a wall between two parties. What no path rule can enforce stays a rule of the briefs: the two register tables inside Plan Contracts, that `approval.md` quotes what the owner really said, and that the stages are worked in order.

The briefs generalise the two used in the 2026-11-15 full review (`docs/review/2026-11-15-review-brief.md`, `2026-11-15-fix-brief.md`), which stay as the record of that review.
