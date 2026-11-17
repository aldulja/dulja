# Agent role briefs

The briefs for the feature workflow in `AGENTS.md` ("Feature Workflow"): an orchestrator and four roles.

| Brief             | Role                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `orchestrator.md` | Runs the stages and their gates, allocates files and numbers, keeps the ledger |
| `spec.md`         | Writes the plan the owner approves                                      |
| `build.md`        | Executes the approved plan, test-first                                  |
| `review.md`       | Finds defects in the change; changes no product code                    |
| `fix.md`          | Fixes review findings, failing test first                               |

Every agent reads `AGENTS.md` in full first; it is binding and these briefs add to it, never replace it. Each brief says what the agent's starting message must give it; an agent that is not given it asks before it works.

## One folder per feature

`docs/features/<YYYY-MM-DD>-<slug>/` holds the feature's `ledger.md` and `approval.md` (orchestrator), `plan.md` and `adr/` drafts (spec) and `findings/` (review). The templates are in `templates/`. Agents start with a fresh context, so what is not in that folder is lost between them.

## What holds a role to its limits

Three layers, weakest to strongest:

1. **The tool list** in `.claude/agents/<role>.md`. Spec and review have a fixed list; the other three lose the GitHub merge tools.
2. **Hooks** in the same file, running `scripts/agents/role-guard.ts hook <role>`: a file tool is refused a path outside the role's own; a shell command is refused a merge or a push to the default branch; and a spec or review agent cannot finish while the tree differs from where it started in any file it may not leave changed — which catches an edit made through the shell. Claude Code runs these hooks only in a folder the user has trusted, and not in a `-p` session.
3. **`bun scripts/agents/role-guard.ts verify <role> --base <sha> [--allow <glob>]…`**, which the orchestrator runs after every agent returns. It needs no hook and no particular tool: every path changed since `<sha>`, committed or not, must be one the role may leave changed, and for build and fix `--allow` narrows that to the files the agent was given. This is the check that counts.

| Role         | May write while working                                   | May leave changed                      |
| ------------ | --------------------------------------------------------- | -------------------------------------- |
| orchestrator | `docs/**`, `AGENTS.md`                                    | (shares its tree; not checked at the end) |
| spec         | `docs/features/**`                                        | `docs/features/**`                     |
| review       | `docs/features/*/findings/**`, any `*.repro.*` file       | `docs/features/*/findings/**`          |
| build, fix   | anything but `AGENTS.md`, `docs/status/**`, the feature's `plan.md` | the globs the orchestrator gave it |

Only the orchestrator may write a feature's `approval.md` and `ledger.md`, so the owner's approval cannot be written by a role that wants the build to start. No role may write `.claude/**` or `scripts/agents/**`: the guard and the agent definitions are changed by the owner, not by the roles they bind. The rules are `RULES` in `scripts/agents/role-guard.ts`, and its tests (`role-guard.test.ts`, run by the `tests` workspace) pin them.

What no path rule can enforce stays a rule of the briefs: the two register tables inside Plan Contracts, "the reviewer is never the builder", and that `approval.md` quotes what the owner really said.

## Claude Code and other tools

`.claude/agents/<role>.md` registers each role with Claude Code: `claude --agent orchestrator` runs a feature, and the orchestrator starts the others by name. Those files carry only the name, when to use the role, the tool list, the hooks and a pointer here — never instructions of their own. Any other tool reads the brief directly and is held by layer 3.

These briefs generalise the two used in the 2026-11-15 full review (`docs/review/2026-11-15-review-brief.md`, `2026-11-15-fix-brief.md`), which stay as the record of that review.
