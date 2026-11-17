import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideBash,
  decideWrite,
  roleFromInput,
  runHook,
  verifyRole,
  type HookInput,
} from "./role-guard";

const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=guard", "-c", "user.email=guard@example.invalid", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

const write = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A throwaway repository with one commit, and a state directory for the hook's baselines. */
function repository(): { root: string; state: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "role-guard-repo-"));
  const state = mkdtempSync(join(tmpdir(), "role-guard-state-"));
  created.push(root, state);
  git(root, "init", "-q");
  write(root, "AGENTS.md", "rules\n");
  write(root, "packages/db/src/post.ts", "export const post = 1;\n");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  return { root, state, base: git(root, "rev-parse", "HEAD") };
}

const pre = (root: string, tool: string, input: Record<string, unknown>): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "session-1",
  cwd: root,
  tool_name: tool,
  tool_input: input,
});
const stop = (root: string): HookInput => ({
  hook_event_name: "SubagentStop",
  session_id: "session-1",
  cwd: root,
});

describe("role-guard — what each role may write", () => {
  it("spec writes its feature folder and nothing else", () => {
    expect(decideWrite("spec", "docs/features/2026-11-17-returns/plan.md").ok).toBe(true);
    expect(decideWrite("spec", "docs/features/2026-11-17-returns/adr/refunds.md").ok).toBe(true);
    for (const path of [
      "packages/db/src/post.ts",
      "packages/db/migrations/0130_add_refund.sql",
      "AGENTS.md",
      "docs/status/current-state.md",
      "docs/adr/0098-refunds.md",
      "docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md",
      ".claude/agents/spec.md",
    ])
      expect(decideWrite("spec", path), path).toMatchObject({ ok: false });
  });

  it("only the orchestrator writes a feature's approval and ledger", () => {
    for (const file of ["approval.md", "ledger.md"]) {
      const path = `docs/features/2026-11-17-returns/${file}`;
      expect(decideWrite("orchestrator", path).ok, path).toBe(true);
      for (const role of ["spec", "build", "review", "fix"] as const)
        expect(decideWrite(role, path), `${role} ${path}`).toMatchObject({ ok: false });
    }
    // A builder reports its tasks; it does not edit the plan it executes.
    expect(decideWrite("build", "docs/features/2026-11-17-returns/plan.md")).toMatchObject({
      ok: false,
    });
  });

  it("review writes findings and throwaway reproductions, never product code", () => {
    expect(decideWrite("review", "docs/features/2026-11-17-returns/findings/r1-db.md").ok).toBe(
      true,
    );
    expect(decideWrite("review", "packages/db/test/refund.repro.test.ts").ok).toBe(true);
    for (const path of [
      "packages/db/src/post.ts",
      "packages/db/test/refund.test.ts",
      "docs/features/2026-11-17-returns/plan.md",
      "AGENTS.md",
      "scripts/agents/role-guard.ts",
    ])
      expect(decideWrite("review", path), path).toMatchObject({ ok: false });
  });

  it("build and fix write product code but not the registers, the status records or the guard", () => {
    for (const role of ["build", "fix"] as const) {
      expect(decideWrite(role, "packages/db/src/post.ts").ok).toBe(true);
      expect(decideWrite(role, "docs/adr/0098-refunds.md").ok).toBe(true);
      for (const path of [
        "AGENTS.md",
        "docs/status/current-state.md",
        "docs/status/phase-history.md",
        ".claude/agents/build.md",
        "scripts/agents/role-guard.ts",
      ])
        expect(decideWrite(role, path), `${role} ${path}`).toMatchObject({ ok: false });
    }
  });

  it("the orchestrator writes documents and AGENTS.md, never product code or the guard", () => {
    expect(decideWrite("orchestrator", "docs/features/2026-11-17-returns/ledger.md").ok).toBe(true);
    expect(decideWrite("orchestrator", "docs/status/current-state.md").ok).toBe(true);
    expect(decideWrite("orchestrator", "AGENTS.md").ok).toBe(true);
    for (const path of [
      "packages/db/src/post.ts",
      "apps/api/src/app.ts",
      ".claude/agents/review.md",
      "scripts/agents/role-guard.ts",
    ])
      expect(decideWrite("orchestrator", path), path).toMatchObject({ ok: false });
  });

  it("a Windows path is judged like its POSIX form", () => {
    expect(decideWrite("spec", "packages\\db\\src\\post.ts")).toMatchObject({ ok: false });
    expect(decideWrite("spec", "docs\\features\\x\\plan.md").ok).toBe(true);
  });
});

describe("role-guard — commands no role runs", () => {
  it("refuses a merge and a push to the default branch", () => {
    for (const command of [
      "gh pr merge 46 --squash",
      "git push origin main",
      "git push -u origin HEAD:main",
      "cd repo && git push origin master",
      "git push origin +feature:main",
    ])
      expect(decideBash(command), command).toMatchObject({ ok: false });
  });

  it("allows ordinary work, including a push to a feature branch", () => {
    for (const command of [
      "git push -u origin claude/returns-build",
      "git commit -m 'fix the main menu'",
      "git fetch origin main && git checkout -B feature origin/main",
      "bun run --cwd packages/db test",
      "gh pr view 46",
    ])
      expect(decideBash(command), command).toEqual({ ok: true });
  });
});

describe("role-guard — verify, the orchestrator's check after an agent returns", () => {
  it("a review that left only findings passes; one that left a reproduction or an edit fails", () => {
    const { root, base } = repository();
    write(root, "docs/features/f/findings/r1.md", "# Findings\n");
    expect(verifyRole("review", { cwd: root, base })).toEqual([]);

    write(root, "packages/db/test/x.repro.test.ts", "throwaway\n");
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    expect(verifyRole("review", { cwd: root, base })).toEqual([
      "packages/db/src/post.ts",
      "packages/db/test/x.repro.test.ts",
    ]);
  });

  it("sees a committed change as well as an uncommitted one", () => {
    const { root, base } = repository();
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "sneak");
    expect(verifyRole("spec", { cwd: root, base })).toEqual(["packages/db/src/post.ts"]);
  });

  it("holds a builder to the files it was given", () => {
    const { root, base } = repository();
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    write(root, "apps/api/src/routes/refund.ts", "export {};\n");
    expect(verifyRole("build", { cwd: root, base })).toEqual([]);
    expect(verifyRole("build", { cwd: root, base, allow: ["packages/db/**"] })).toEqual([
      "apps/api/src/routes/refund.ts",
    ]);
    write(root, "AGENTS.md", "changed\n");
    expect(verifyRole("build", { cwd: root, base, allow: ["**"] })).toEqual(["AGENTS.md"]);
  });
});

describe("role-guard — the hooks", () => {
  it("refuses a write outside the role's paths and lets one inside through", () => {
    const { root, state } = repository();
    const denied = runHook(
      "spec",
      pre(root, "Write", { file_path: join(root, "packages/db/src/post.ts") }),
      { state },
    );
    expect(denied.exit).toBe(2);
    expect(denied.message).toContain("packages/db/src/post.ts");
    expect(
      runHook("spec", pre(root, "Edit", { file_path: join(root, "docs/features/f/plan.md") }), {
        state,
      }).exit,
    ).toBe(0);
  });

  it("does not judge a file outside the repository", () => {
    const { root, state } = repository();
    const outside = join(tmpdir(), "role-guard-scratch.txt");
    expect(runHook("review", pre(root, "Write", { file_path: outside }), { state }).exit).toBe(0);
  });

  it("refuses a merge command for every role", () => {
    const { root, state } = repository();
    const result = runHook("build", pre(root, "Bash", { command: "gh pr merge 46" }), { state });
    expect(result.exit).toBe(2);
  });

  it("will not let a reviewer finish with product code changed through the shell", () => {
    const { root, state } = repository();
    // Dirt that was there before the agent started is not the agent's.
    write(root, "apps/api/src/wip.ts", "someone else's work\n");
    expect(runHook("review", pre(root, "Read", { file_path: "x" }), { state }).exit).toBe(0);

    // The agent changes a product file with a shell command, which no write hook sees.
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    write(root, "docs/features/f/findings/r1.md", "# Findings\n");
    const blocked = runHook("review", stop(root), { state });
    expect(blocked.exit).toBe(2);
    expect(blocked.message).toContain("packages/db/src/post.ts");
    expect(blocked.message).not.toContain("apps/api/src/wip.ts");
    expect(blocked.message).not.toContain("findings/r1.md");

    git(root, "checkout", "--", "packages/db/src/post.ts");
    expect(runHook("review", stop(root), { state }).exit).toBe(0);
  });

  it("starts a fresh baseline for the next agent run in the same session", () => {
    const { root, state } = repository();
    expect(runHook("review", pre(root, "Read", {}), { state }).exit).toBe(0);
    expect(runHook("review", stop(root), { state }).exit).toBe(0);

    // Between two review rounds a fix agent commits product code. Round two must not be blamed for it.
    write(root, "packages/db/src/post.ts", "export const post = 3;\n");
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fix");
    expect(runHook("review", pre(root, "Read", {}), { state }).exit).toBe(0);
    expect(runHook("review", stop(root), { state }).exit).toBe(0);
  });

  it("stops blocking after three refusals, so an agent that cannot repair the tree is not trapped", () => {
    const { root, state } = repository();
    runHook("spec", pre(root, "Read", {}), { state });
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    expect(runHook("spec", stop(root), { state }).exit).toBe(2);
    expect(runHook("spec", stop(root), { state }).exit).toBe(2);
    expect(runHook("spec", stop(root), { state }).exit).toBe(2);
    const released = runHook("spec", stop(root), { state });
    expect(released.exit).toBe(1);
    expect(released.message).toContain("packages/db/src/post.ts");
  });

  it("has no end-of-run check for the roles that write product code or share a tree", () => {
    const { root, state } = repository();
    runHook("build", pre(root, "Read", {}), { state });
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    expect(runHook("build", stop(root), { state }).exit).toBe(0);
    expect(runHook("orchestrator", stop(root), { state }).exit).toBe(0);
  });

  it("reads the role from the hook input, so one hook in settings serves every agent", () => {
    expect(roleFromInput({ agent_type: "review" })).toBe("review");
    expect(roleFromInput({ agent_type: "orchestrator" })).toBe("orchestrator");
    // The main conversation, and any agent that is not one of the five roles, is not this guard's business.
    expect(roleFromInput({})).toBeNull();
    expect(roleFromInput({ agent_type: "Explore" })).toBeNull();
    expect(roleFromInput({ agent_type: "general-purpose" })).toBeNull();
  });

  it("takes its baseline when the subagent starts, before the agent has run anything", () => {
    const { root, state } = repository();
    const agent = { session_id: "session-1", agent_id: "agent-7", cwd: root };
    write(root, "apps/api/src/wip.ts", "someone else's work\n");
    expect(runHook("review", { ...agent, hook_event_name: "SubagentStart" }, { state }).exit).toBe(
      0,
    );

    // A shell edit that no write hook sees, then a tool call that must not move the baseline.
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    runHook(
      "review",
      { ...agent, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      { state },
    );
    const blocked = runHook("review", { ...agent, hook_event_name: "SubagentStop" }, { state });
    expect(blocked.exit).toBe(2);
    expect(blocked.message).toContain("packages/db/src/post.ts");
    expect(blocked.message).not.toContain("apps/api/src/wip.ts");
  });

  it("tells a spec or review agent at once when a shell command changed a file it may not change", () => {
    const { root, state } = repository();
    const agent = { session_id: "session-1", agent_id: "agent-9", cwd: root };
    const after = (role: "spec" | "review" | "build"): HookInput => ({
      ...agent,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "sed -i s/1/2/ packages/db/src/post.ts" },
      agent_type: role,
    });
    runHook("review", { ...agent, hook_event_name: "SubagentStart" }, { state });
    expect(runHook("review", after("review"), { state }).exit).toBe(0);

    // A reproduction is allowed while the review runs; a product file is not.
    write(root, "packages/db/test/x.repro.test.ts", "throwaway\n");
    expect(runHook("review", after("review"), { state }).exit).toBe(0);
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    const told = runHook("review", after("review"), { state });
    expect(told.exit).toBe(2);
    expect(told.message).toContain("packages/db/src/post.ts");
    expect(told.message).not.toContain("x.repro.test.ts");

    git(root, "checkout", "--", "packages/db/src/post.ts");
    expect(runHook("review", after("review"), { state }).exit).toBe(0);

    // A builder's shell may change product code: that is its work.
    write(root, "packages/db/src/post.ts", "export const post = 3;\n");
    expect(runHook("build", after("build"), { state }).exit).toBe(0);
  });
});
