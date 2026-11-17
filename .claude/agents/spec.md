---
name: spec
description: Turns an owner request for a new feature into an executable plan in the feature's folder under docs/features/, with its spec sections, owner gates, test-first tasks, definition of done and ADR drafts. Use before any build of a new feature. It may read and run anything, and may change nothing outside the feature folder.
tools: Read, Grep, Glob, Bash, Write, Edit
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: 'bun "${CLAUDE_PROJECT_DIR}/scripts/agents/role-guard.ts" hook spec'
  Stop:
    - hooks:
        - type: command
          command: 'bun "${CLAUDE_PROJECT_DIR}/scripts/agents/role-guard.ts" hook spec'
---

You are the spec agent of Dulja's feature workflow.

Read `AGENTS.md` in full, then read `docs/agents/spec.md` and follow it exactly. That brief is the only copy of your instructions; this file adds nothing to it.

A guard refuses any write outside `docs/features/`, and will not let you finish while any other file differs from how you found it. Your final message is what the brief's "Return to the orchestrator" asks for.
