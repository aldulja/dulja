import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentRole,
  decideBash,
  decideWrite,
  enterRole,
  leaveRole,
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

const commit = (root: string, message: string): string => {
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

/** A throwaway repository with one commit. The role state is ignored by git there, as it is in this one. */
function repository(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "role-guard-repo-"));
  created.push(root);
  git(root, "init", "-q");
  write(root, ".gitignore", ".claude/*\n!.claude/settings.json\n");
  write(root, "AGENTS.md", "rules\n");
  write(root, "packages/db/src/post.ts", "export const post = 1;\n");
  return { root, base: commit(root, "base") };
}

const SESSION = "session-1";
const before = (root: string, tool: string, input: Record<string, unknown>): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: SESSION,
  cwd: root,
  tool_name: tool,
  tool_input: input,
});
const afterShell = (root: string): HookInput => ({
  hook_event_name: "PostToolUse",
  session_id: SESSION,
  cwd: root,
  tool_name: "Bash",
  tool_input: { command: "sed -i s/1/2/ packages/db/src/post.ts" },
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
      "docs/agents/spec.md",
      ".claude/settings.json",
    ])
      expect(decideWrite("spec", path), path).toMatchObject({ ok: false });
  });

  it("only the orchestrator role writes a feature's approval and ledger", () => {
    for (const file of ["approval.md", "ledger.md"]) {
      const path = `docs/features/2026-11-17-returns/${file}`;
      expect(decideWrite("orchestrator", path).ok, path).toBe(true);
      for (const role of ["spec", "build", "review", "fix"] as const)
        expect(decideWrite(role, path), `${role} ${path}`).toMatchObject({ ok: false });
    }
    // The build stage executes the plan; it does not edit it.
    expect(decideWrite("build", "docs/features/2026-11-17-returns/plan.md")).toMatchObject({
      ok: false,
    });
  });

  it("review writes findings and throwaway reproductions, never product code", () => {
    expect(decideWrite("review", "docs/features/2026-11-17-returns/findings/r1.md").ok).toBe(true);
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

  it("build and fix write product code but not the registers, the status records or the workflow itself", () => {
    for (const role of ["build", "fix"] as const) {
      expect(decideWrite(role, "packages/db/src/post.ts").ok).toBe(true);
      expect(decideWrite(role, "docs/adr/0098-refunds.md").ok).toBe(true);
      for (const path of [
        "AGENTS.md",
        "docs/status/current-state.md",
        "docs/status/phase-history.md",
        "docs/agents/build.md",
        ".claude/settings.json",
        "scripts/agents/role-guard.ts",
      ])
        expect(decideWrite(role, path), `${role} ${path}`).toMatchObject({ ok: false });
    }
  });

  it("the orchestrator role writes documents and AGENTS.md, never product code or the workflow itself", () => {
    expect(decideWrite("orchestrator", "docs/features/2026-11-17-returns/ledger.md").ok).toBe(true);
    expect(decideWrite("orchestrator", "docs/status/current-state.md").ok).toBe(true);
    expect(decideWrite("orchestrator", "AGENTS.md").ok).toBe(true);
    for (const path of [
      "packages/db/src/post.ts",
      "apps/api/src/app.ts",
      "docs/agents/review.md",
      ".claude/settings.json",
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

  it("refuses a command that reaches for the role state instead of enter and leave", () => {
    expect(decideBash("rm .claude/role-state.json")).toMatchObject({ ok: false });
    expect(decideBash("echo '{}' > .claude/role-state.json")).toMatchObject({ ok: false });
  });

  it("allows ordinary work, including a push to a feature branch and a change of role", () => {
    for (const command of [
      "git push -u origin claude/returns-build",
      "git commit -m 'fix the main menu'",
      "git fetch origin main && git checkout -B feature origin/main",
      "bun run --cwd packages/db test",
      "gh pr view 46",
      "bun scripts/agents/role-guard.ts enter review",
      "bun scripts/agents/role-guard.ts leave",
    ])
      expect(decideBash(command), command).toEqual({ ok: true });
  });
});

describe("role-guard — entering and leaving a role in one session", () => {
  it("no role is in force until one is entered, and a session without one is not guarded", () => {
    const { root } = repository();
    expect(currentRole(root, SESSION)).toBeNull();
    expect(
      runHook(before(root, "Write", { file_path: join(root, "packages/db/src/post.ts") })).exit,
    ).toBe(0);
    expect(runHook(before(root, "Bash", { command: "gh pr merge 1" })).exit).toBe(0);
    expect(runHook(before(root, "Agent", { subagent_type: "general-purpose" })).exit).toBe(0);
  });

  it("the entered role decides what the file tools may write", () => {
    const { root } = repository();
    expect(enterRole(root, "spec")).toMatchObject({ ok: true });
    const denied = runHook(
      before(root, "Write", { file_path: join(root, "packages/db/src/post.ts") }),
    );
    expect(denied.exit).toBe(2);
    expect(denied.message).toContain("packages/db/src/post.ts");
    expect(
      runHook(before(root, "Edit", { file_path: join(root, "docs/features/f/plan.md") })).exit,
    ).toBe(0);

    expect(enterRole(root, "build")).toMatchObject({ ok: true });
    expect(
      runHook(before(root, "Write", { file_path: join(root, "packages/db/src/post.ts") })).exit,
    ).toBe(0);
    expect(runHook(before(root, "Write", { file_path: join(root, "AGENTS.md") })).exit).toBe(2);
  });

  it("does not judge a file outside the repository", () => {
    const { root } = repository();
    enterRole(root, "review");
    const outside = join(tmpdir(), "role-guard-scratch.txt");
    expect(runHook(before(root, "Write", { file_path: outside })).exit).toBe(0);
  });

  it("while a role is in force, refuses a merge, the merge tools and any subagent", () => {
    const { root } = repository();
    enterRole(root, "build");
    expect(runHook(before(root, "Bash", { command: "gh pr merge 46" })).exit).toBe(2);
    expect(runHook(before(root, "mcp__github__merge_pull_request", { pullNumber: 46 })).exit).toBe(
      2,
    );
    expect(runHook(before(root, "mcp__github__enable_pr_auto_merge", {})).exit).toBe(2);
    const agent = runHook(before(root, "Agent", { subagent_type: "general-purpose" }));
    expect(agent.exit).toBe(2);
    expect(agent.message).toContain("subagent");
    expect(runHook(before(root, "Task", { subagent_type: "Explore" })).exit).toBe(2);
  });

  it("tells the spec and review roles at once when a shell command changed a file they may not change", () => {
    const { root } = repository();
    // Dirt that was there before the role was entered is not the role's.
    write(root, "apps/api/src/wip.ts", "someone else's work\n");
    enterRole(root, "review");
    expect(runHook(afterShell(root)).exit).toBe(0);

    // A reproduction is allowed while the review runs; a product file is not.
    write(root, "packages/db/test/x.repro.test.ts", "throwaway\n");
    expect(runHook(afterShell(root)).exit).toBe(0);
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    const told = runHook(afterShell(root));
    expect(told.exit).toBe(2);
    expect(told.message).toContain("packages/db/src/post.ts");
    expect(told.message).not.toContain("x.repro.test.ts");
    expect(told.message).not.toContain("apps/api/src/wip.ts");

    git(root, "checkout", "--", "packages/db/src/post.ts");
    expect(runHook(afterShell(root)).exit).toBe(0);
  });

  it("a builder's shell may change product code: that is its work", () => {
    const { root } = repository();
    enterRole(root, "build");
    write(root, "packages/db/src/post.ts", "export const post = 3;\n");
    expect(runHook(afterShell(root)).exit).toBe(0);
  });

  it("will not leave the review role, or enter the next one, with product code or a reproduction left changed", () => {
    const { root } = repository();
    enterRole(root, "review");
    write(root, "docs/features/f/findings/r1.md", "# Findings\n");
    write(root, "packages/db/test/x.repro.test.ts", "throwaway\n");
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");

    const next = enterRole(root, "fix");
    expect(next).toMatchObject({ ok: false });
    expect(next.ok ? [] : next.violations).toEqual([
      "packages/db/src/post.ts",
      "packages/db/test/x.repro.test.ts",
    ]);
    expect(currentRole(root, SESSION)).toBe("review");
    expect(leaveRole(root)).toMatchObject({ ok: false });

    git(root, "checkout", "--", "packages/db/src/post.ts");
    rmSync(join(root, "packages/db/test/x.repro.test.ts"));
    expect(enterRole(root, "fix")).toMatchObject({ ok: true });
    expect(currentRole(root, SESSION)).toBe("fix");
  });

  it("sees a commit made inside the spec role as well as an uncommitted change", () => {
    const { root } = repository();
    enterRole(root, "spec");
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    commit(root, "sneak");
    const next = enterRole(root, "build");
    expect(next.ok ? [] : next.violations).toEqual(["packages/db/src/post.ts"]);
  });

  it("leaving ends the guard, and the next role starts from a fresh baseline", () => {
    const { root } = repository();
    enterRole(root, "build");
    write(root, "packages/db/src/post.ts", "export const post = 2;\n");
    commit(root, "build");
    // The build's commit is behind the review's baseline, so the review is not blamed for it.
    expect(enterRole(root, "review")).toMatchObject({ ok: true });
    expect(runHook(afterShell(root)).exit).toBe(0);
    expect(leaveRole(root)).toMatchObject({ ok: true });
    expect(currentRole(root, SESSION)).toBeNull();
    expect(existsSync(join(root, ".claude/role-state.json"))).toBe(false);
    expect(runHook(before(root, "Write", { file_path: join(root, "AGENTS.md") })).exit).toBe(0);
  });

  it("a role entered in one session does not bind another session that finds the state left behind", () => {
    const { root } = repository();
    enterRole(root, "review");
    // The first hook call after `enter` claims the role for its session.
    expect(
      runHook(before(root, "Write", { file_path: join(root, "packages/db/src/post.ts") })).exit,
    ).toBe(2);
    const stranger: HookInput = {
      ...before(root, "Write", { file_path: join(root, "packages/db/src/post.ts") }),
      session_id: "session-2",
    };
    expect(runHook(stranger).exit).toBe(0);
    expect(currentRole(root, "session-2")).toBeNull();
    expect(currentRole(root, SESSION)).toBe("review");
  });
});

describe("role-guard — verify, a check of what changed since a commit", () => {
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

  it("holds a build to the files the plan names", () => {
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
