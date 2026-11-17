# Agent role briefs

The briefs for the feature workflow in `AGENTS.md` ("Feature Workflow"): an orchestrator and four roles.

| Brief             | Role                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `orchestrator.md` | Splits the work, allocates files and numbers, keeps the ledger   |
| `spec.md`         | Writes the plan the owner approves                               |
| `build.md`        | Executes the approved plan, test-first                           |
| `review.md`       | Finds defects in the change; read-only                           |
| `fix.md`          | Fixes review findings, failing test first                        |

Every agent reads `AGENTS.md` in full first; it is binding and these briefs add to it, never replace it. The orchestrator's starting message gives each agent the values its brief names (branch, files, numbers, findings).

`.claude/agents/<role>.md` makes each role a Claude Code agent: `claude --agent orchestrator` runs a feature, and the orchestrator starts the others by name. Those files carry only the name, when to use the role, its tool limits and a pointer here. The limits are a guard, not a guarantee — spec has no shell; review has no edit tool but keeps a shell for reproductions, so "change no product code" is still the brief's rule to keep. Any other tool reads the brief directly.

These briefs generalise the two used in the 2026-11-15 full review (`docs/review/2026-11-15-review-brief.md`, `2026-11-15-fix-brief.md`), which stay as the record of that review.
