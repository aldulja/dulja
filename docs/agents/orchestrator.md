# Orchestrator role

You run one feature from the owner's request to a change the owner can merge, **in this session**. You work every stage yourself, one role at a time. You start no subagent for any of it — not for a role, not to search, not to review; the guard refuses the Agent tool while a role is in force.

In this role you coordinate and write documents only. The guard refuses your file tools any path outside `docs/` and `AGENTS.md`.

## Moving between roles

```bash
bun scripts/agents/role-guard.ts enter <role>
```

Run it at the start of every stage, then read `docs/agents/<role>.md` and follow it. `enter` refuses to move on while the role you are leaving has changed a file it may not leave changed. Commit at the end of every stage, so each role starts from a clean tree. When the feature closes, run `bun scripts/agents/role-guard.ts leave`.

## The feature folder

Everything about the feature lives in `docs/features/<YYYY-MM-DD>-<slug>/`:

| File                  | Written in role | Template                            |
| --------------------- | --------------- | ----------------------------------- |
| `ledger.md`           | orchestrator    | `docs/agents/templates/ledger.md`   |
| `approval.md`         | orchestrator    | the owner's approval, quoted        |
| `plan.md`             | spec            | `docs/agents/templates/plan.md`     |
| `adr/<slug>.md`       | spec (draft)    | the ADR format in `docs/adr/`       |
| `findings/r<N>.md`    | review          | `docs/agents/templates/findings.md` |

The ledger is the feature's memory. A long session is summarised as it grows and a later session starts from nothing, so update the ledger at every gate: a new session must be able to resume from the feature folder alone.

## Stages and gates

Do not start a stage until the gate before it is recorded in the ledger.

### 1. Intake — orchestrator

1. Read the headings of `docs/status/current-state.md` the request touches.
2. **Size it.** A small fix — one workspace, no migration, no ADR, no route, permission or contract change, no screen — needs no workflow: work it test-first and check your own diff. Anything else, or anything you are unsure of, is a feature.
3. **Check the owner gates.** If the request cannot be built without an open `OD-##`, tell the owner which gate and what it needs, and stop.
4. Create the feature folder and the ledger, with the owner's request quoted in full.

**Gate:** the ledger states the request, the size decision and the gates met.

### 2. Spec — `enter spec`

Write the plan (`docs/agents/spec.md`).

**Gate:** `plan.md` follows the template with no section empty; every decision touching money semantics, security, the data model or the sync protocol has an ADR draft; every question for the owner is listed.

### 3. Owner approval — `enter orchestrator`

Give the owner the plan, the ADR drafts and the questions, in one message, and end your turn. Do not build while you wait.

- The owner approves: write `approval.md` — the date, the plan's commit, and the owner's words quoted — and record each answer in the ledger. Only this role can write that file, and only quoting the owner.
- The owner changes the scope, or an answer changes the design: back to stage 2.
- A question stays open: mark the tasks that depend on it blocked in the ledger; they are not built.

**Gate:** `approval.md` exists and quotes the owner. No build without it.

### 4. Allocate — orchestrator

Amend Plan Contracts §3.4.1 and §3.9 with the migration and ADR numbers the plan takes — never a number a slice has marked _reserved_. Move each approved ADR draft to `docs/adr/NNNN-<slug>.md`, status _Proposed_ unless the owner accepted it. Record the numbers and the base commit in the ledger.

**Gate:** the registers are committed and the ledger has the numbers and the base commit.

### 5. Build — `enter build`

Execute the plan (`docs/agents/build.md`). Then, back in the orchestrator role, tick each task in the ledger with its failing-first evidence and run:

```bash
bun scripts/agents/role-guard.ts verify build --base <base commit> --allow 'docs/features/**' --allow '<each glob the plan names>'
```

A file outside the plan's is a defect of the build: either the plan is amended (see "Going backwards") or the change is removed.

**Gate:** every task is ticked with its evidence; the recorded checks are green or the failures explained; the work is committed and pushed; the verify passes. Record the head commit.

### 6. Review — `enter review`

Review the change (`docs/agents/review.md`), round N, into `findings/r<N>.md`.

You wrote this code, so this review is not independent, and the ledger says so. **If the plan has an ADR draft** — the change touches money semantics, security, the data model or the sync protocol — ask the owner before this stage whether to review here or in a fresh session (see "An independent review"). Otherwise review here.

**Gate:** the findings file exists and says what could not be checked; every finding is in the ledger with its severity and a status.

### 7. Fix — `enter fix`

Fix every blocker and high finding, and each medium or low worth fixing now (`docs/agents/fix.md`). Then return to stage 6 for the next round: it covers the fix diff and re-checks every finding the round closed.

**Three rounds is the limit.** If a blocker or high finding is still open after the third review, stop and give the owner the ledger, what keeps failing, and the choices.

**Gate:** no blocker or high finding is open.

### 8. Close — `enter orchestrator`

1. Check the whole tree: `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`, every `scripts/check/*.sh`, the touched workspaces' suites, and CI when it runs.
2. Fill the ledger's definition-of-done table: each clause of the plan, the test that proves it, the result. A clause with no passing test is not done.
3. Record every medium or low finding left unfixed, and every new owner question, under its heading in `docs/status/current-state.md`. Update `AGENTS.md`'s short form only if it changed.
4. Run `bun scripts/agents/role-guard.ts leave`.
5. Report to the owner: what was built, the definition-of-done table, what was **not** verified (staging, Windows, real data), whether the review was independent, the open questions, and the branch. Open a pull request only if the owner asked for one. The owner merges.

## An independent review

A review by the session that wrote the code misses what that session already believes. When the owner wants an independent one, they start a **new session** on the feature's branch and tell it to review the feature. That session runs `enter review`, reads `docs/agents/review.md` and the feature folder, writes `findings/r<N>.md`, commits, pushes, and stops. This session then pulls and goes on to stage 7. It is a second session, started by the owner — never a subagent started by you.

## Going backwards

- **The plan is wrong or silent:** stop that task, `enter spec`, amend the plan and add a line to its change log. If the amendment changes the scope, an owner gate, or money semantics, security, the data model or the sync protocol, the owner approves again before the build resumes; otherwise record it and resume.
- **A new owner question appears:** the tasks that depend on it stop; everything else continues. Batch questions — one message to the owner.
- **The session is running long:** finish the current stage, bring the ledger up to date, commit and push, and tell the owner a new session can resume from the feature folder.

## Never

- Start a subagent, or hand a stage to one.
- Merge, approve a pull request, or push to the default branch.
- Decide an `OD-##`, a `⚠️`, or an ADR question on the owner's behalf — or write an approval the owner did not give.
- Skip a stage because the feature looks simple, or report it done without the checks in stage 8.
