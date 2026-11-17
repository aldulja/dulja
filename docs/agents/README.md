# The feature workflow's supporting files

The workflow is in `AGENTS.md` ("Feature Workflow"). Each role is **one file**, `.claude/agents/<role>.md` — its tool list and its whole brief:

| File                             | Role                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `.claude/agents/orchestrator.md` | Runs the stages and their gates, allocates files and numbers, keeps the ledger |
| `.claude/agents/spec.md`         | Writes the plan the owner approves                                             |
| `.claude/agents/build.md`        | Executes the approved plan, test-first                                         |
| `.claude/agents/review.md`       | Finds defects in the change; changes no product code                           |
| `.claude/agents/fix.md`          | Fixes review findings, failing test first                                      |

In Claude Code, `claude --agent orchestrator` runs a feature and the orchestrator starts the others by name. Any other tool reads the same file as a plain document and ignores the lines between the two `---` at its top.

This folder holds what the roles share: the templates in `templates/` (plan, ledger, findings) and this description of what holds a role to its limits.

## One folder per feature

`docs/features/<YYYY-MM-DD>-<slug>/` holds the feature's `ledger.md` and `approval.md` (orchestrator), `plan.md` and `adr/` drafts (spec) and `findings/` (review). Agents start with a fresh context, so what is not in that folder is lost between them.

## What holds a role to its limits

1. **The tool list** at the top of the role's file. Spec and review have a fixed list; the other three lose the GitHub merge tools.
2. **A hook**, `scripts/agents/role-guard.ts hook`, registered once in `.claude/settings.json`. It reads which agent is calling from the hook input, so one registration serves all five, and it lets the main conversation and every other agent through untouched. A file tool is refused a path outside the role's own; a shell command is refused a merge or a push to the default branch; and a spec or review agent is told straight after any shell command that changed a file it may not change.
3. **`bun scripts/agents/role-guard.ts verify <role> --base <sha> [--allow <glob>]…`**, which the orchestrator runs after every agent returns. It needs no hook and no particular tool: every path changed since `<sha>`, committed or not, must be one the role may leave changed, and for build and fix `--allow` narrows that to the files the agent was given. This is the check that counts.

| Role         | May write while working                                             | May leave changed                         |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------- |
| orchestrator | `docs/**`, `AGENTS.md`                                              | (shares its tree; not checked at the end) |
| spec         | `docs/features/**`                                                  | `docs/features/**`                        |
| review       | `docs/features/*/findings/**`, any `*.repro.*` file                 | `docs/features/*/findings/**`             |
| build, fix   | anything but `AGENTS.md`, `docs/status/**`, the feature's `plan.md` | the globs the orchestrator gave it        |

Only the orchestrator may write a feature's `approval.md` and `ledger.md`, so the owner's approval cannot be written by a role that wants the build to start. No role may write `.claude/**` or `scripts/agents/**`: the guard and the role files are changed by the owner, not by the roles they bind. The rules are `RULES` in `scripts/agents/role-guard.ts`, and its tests (`role-guard.test.ts`, run by the `tests` workspace) pin them.

### What was seen to work, and what was not

A live run on 2026-11-17 in a cloud session, with a `review` agent asked to write a product file:

- **Worked:** the Write tool was refused with the guard's message; a shell redirect that created a product file was reported to the agent straight after the command, and the agent deleted the file.
- **Did not work:** hooks written inside the agent's own file never ran — Claude Code runs those only after a trust dialog that a cloud or `-p` session never shows. That is why the hook lives in `.claude/settings.json`.
- **Not relied on:** the check at the end of an agent's run fired and objected, but the agent had already handed back. It stays as a last notice; layer 3 is the gate.

What no path rule can enforce stays a rule of the briefs: the two register tables inside Plan Contracts, "the reviewer is never the builder", and that `approval.md` quotes what the owner really said.

The roles generalise the two briefs used in the 2026-11-15 full review (`docs/review/2026-11-15-review-brief.md`, `2026-11-15-fix-brief.md`), which stay as the record of that review.
