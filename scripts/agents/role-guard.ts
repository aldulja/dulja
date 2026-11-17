/**
 * The feature workflow's role guard (AGENTS.md, "Feature Workflow"; the role briefs are `docs/agents/<role>.md`).
 *
 * One session works a feature's stages in order — orchestrator, spec, build, review, fix — and never hands a
 * stage to a subagent. A brief says what a role must not touch; this file is what holds the session to it
 * while it is in that role.
 *
 *   bun scripts/agents/role-guard.ts enter <role>
 *       Puts the session in a role. It records where the tree stands, and refuses to move on while the role
 *       being left has changed a file it may not leave changed (a review that edited product code, a spec that
 *       touched anything outside its feature folder).
 *
 *   bun scripts/agents/role-guard.ts leave        ends the role, with the same check.
 *   bun scripts/agents/role-guard.ts status       says which role is in force.
 *
 *   bun scripts/agents/role-guard.ts hook
 *       A Claude Code hook, registered once in `.claude/settings.json`. While a role is in force it refuses a
 *       file tool a path outside the role's own, refuses a merge, a push to the default branch and any
 *       subagent, and tells the spec and review roles straight after a shell command that changed a file they
 *       may not change. With no role in force it lets everything through: an ordinary session is not guarded.
 *
 *   bun scripts/agents/role-guard.ts verify <role> --base <sha> [--allow <glob>]...
 *       Every path changed since <sha>, committed or not, must be one the role may leave changed; for build
 *       and fix, `--allow` narrows that to the files the plan names. It needs no hook and no role in force.
 *
 * Paths are repository-relative with forward slashes. Nothing here reads a file's content or runs a test: it
 * answers "which files changed, and was this role allowed to change them" and nothing else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES = ["orchestrator", "spec", "build", "review", "fix"] as const;
export type Role = (typeof ROLES)[number];

interface RoleRule {
  /** Globs the role's file tools may write while it works. */
  readonly write: readonly string[];
  /** Globs that may differ from the tree the role started on when it is left; `null` is "not checked". */
  readonly leave: readonly string[] | null;
  /** Globs refused even when `write` or `leave` admits them. */
  readonly deny: readonly string[];
}

/** The workflow itself — the guard, its hook registration and the briefs. The owner changes these, not a role. */
const GUARD = [".claude/**", "scripts/agents/**", "docs/agents/**"] as const;
/** The orchestrator role's alone (AGENTS.md, "Feature Workflow"). The two register tables inside Plan Contracts
 *  §3.4.1 and §3.9 are that role's too, but a path cannot say which section of a file an edit touches, so that
 *  half stays a rule of the briefs. */
const ORCHESTRATOR_ONLY = ["AGENTS.md", "docs/status/**"] as const;
/** A feature's record of the owner's approval and its ledger. The build brief refuses a plan with no
 *  `approval.md`, so the file is worth something only if the roles that want the build to start cannot write it. */
const FEATURE_RECORD = ["docs/features/*/approval.md", "docs/features/*/ledger.md"] as const;

export const RULES: Readonly<Record<Role, RoleRule>> = {
  orchestrator: { write: ["docs/**", "AGENTS.md"], leave: null, deny: GUARD },
  spec: {
    write: ["docs/features/**"],
    leave: ["docs/features/**"],
    deny: [...GUARD, ...FEATURE_RECORD],
  },
  // A reproduction is written beside the tests it imitates and deleted before the review ends.
  review: {
    write: ["docs/features/*/findings/**", "**/*.repro.*"],
    leave: ["docs/features/*/findings/**"],
    deny: GUARD,
  },
  // Product code is their work, so nothing is checked on leaving; `verify --allow` holds them to the plan's files.
  // They execute the plan and report against it; they do not edit it.
  build: {
    write: ["**"],
    leave: null,
    deny: [...GUARD, ...ORCHESTRATOR_ONLY, ...FEATURE_RECORD, "docs/features/*/plan.md"],
  },
  fix: {
    write: ["**"],
    leave: null,
    deny: [...GUARD, ...ORCHESTRATOR_ONLY, ...FEATURE_RECORD, "docs/features/*/plan.md"],
  },
};

export type Decision = { ok: true } | { ok: false; reason: string };

const normalise = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

/** `**` crosses directories, `*` stays inside one; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export const matches = (path: string, globs: readonly string[]): boolean =>
  globs.some((glob) => globToRegExp(glob).test(normalise(path)));

const admitted = (path: string, allow: readonly string[], deny: readonly string[]): boolean =>
  matches(path, allow) && !matches(path, deny);

/** May this role's file tools write this repository-relative path? */
export function decideWrite(role: Role, path: string): Decision {
  const rule = RULES[role];
  const file = normalise(path);
  if (admitted(file, rule.write, rule.deny)) return { ok: true };
  return {
    ok: false,
    reason:
      `The ${role} role may not write ${file}. It may write: ${rule.write.join(", ")}` +
      (rule.deny.length ? ` — except ${rule.deny.join(", ")}` : "") +
      `. If the stage needs this file, it belongs to another role: finish this stage and enter that one ` +
      `(docs/agents/${role}.md).`,
  };
}

const STATE_FILE = ".claude/role-state.json";
const DEFAULT_BRANCH = /^(?:\+?[^:\s]*:)?(?:refs\/heads\/)?(?:main|master)$/;

/** May a session in a role run this shell command? Merging is the owner's, and so is the default branch. */
export function decideBash(command: string): Decision {
  if (command.includes("role-state.json"))
    return {
      ok: false,
      reason:
        "The role state is changed only by `bun scripts/agents/role-guard.ts enter <role>` and `leave`.",
    };
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (/\bgh\s+pr\s+merge\b/.test(segment))
      return { ok: false, reason: "Merging a pull request is the owner's, never an agent's." };
    const push = /\bgit\b[^\n]*?\bpush\b(.*)$/.exec(segment);
    if (!push) continue;
    const words = (push[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.some((word) => word === "--all" || word === "--mirror" || DEFAULT_BRANCH.test(word)))
      return {
        ok: false,
        reason: "Pushing to the default branch is the owner's. Push to the feature's branch.",
      };
  }
  return { ok: true };
}

const git = (cwd: string, args: readonly string[], input?: string): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
  });

const lines = (text: string): string[] => text.split("\0").filter(Boolean);

/** Every path that differs between `base` and the working tree: committed, staged, unstaged and untracked. */
export function changedSince(cwd: string, base: string): string[] {
  const tracked = lines(git(cwd, ["diff", "--name-only", "--no-renames", "-z", base]));
  const untracked = lines(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].filter((path) => path !== STATE_FILE).toSorted();
}

export interface VerifyOptions {
  cwd: string;
  base: string;
  /** Build and fix only: the files the plan names. Defaults to everything the role may write. */
  allow?: readonly string[];
}

/** The paths changed since `base` that this role was not allowed to leave changed. Empty is a pass. */
export function verifyRole(role: Role, options: VerifyOptions): string[] {
  const rule = RULES[role];
  const allow =
    (role === "build" || role === "fix") && options.allow?.length
      ? options.allow
      : (rule.leave ?? rule.write);
  return changedSince(options.cwd, options.base).filter(
    (path) => !admitted(path, allow, rule.deny),
  );
}

interface State {
  role: Role;
  /** The Claude Code session the role belongs to; `null` until that session's first hook call claims it. */
  session: string | null;
  head: string;
  /** Content hash of every file already dirty when the role was entered: that dirt is not the role's. */
  dirty: Record<string, string>;
}

const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value);

function hashes(root: string, paths: readonly string[]): Record<string, string> {
  const present = paths.filter((path) => existsSync(join(root, path)));
  const out: Record<string, string> = Object.fromEntries(paths.map((path) => [path, "absent"]));
  if (!present.length) return out;
  const hashed = git(root, ["hash-object", "--stdin-paths"], `${present.join("\n")}\n`)
    .split("\n")
    .filter(Boolean);
  present.forEach((path, index) => {
    out[path] = hashed[index] ?? "unreadable";
  });
  return out;
}

function readState(root: string): State | null {
  try {
    const state = JSON.parse(readFileSync(join(root, STATE_FILE), "utf8")) as State;
    return isRole(state.role) ? state : null;
  } catch {
    return null;
  }
}

function writeState(root: string, state: State): void {
  mkdirSync(dirname(join(root, STATE_FILE)), { recursive: true });
  writeFileSync(join(root, STATE_FILE), `${JSON.stringify(state)}\n`);
}

/** What changed since the role was entered, was not already dirty then, and is outside `allow`. */
function outside(root: string, state: State, allow: readonly string[]): string[] {
  const changed = changedSince(root, state.head);
  const now = hashes(root, changed);
  return changed.filter(
    (path) => state.dirty[path] !== now[path] && !admitted(path, allow, RULES[state.role].deny),
  );
}

/** The files the role in force may not leave changed, and has. Empty when it may be left. */
function blockingLeave(root: string, state: State | null): string[] {
  const leave = state ? RULES[state.role].leave : null;
  return state && leave ? outside(root, state, leave) : [];
}

export type RoleChange =
  | { ok: true; role: Role | null; previous: Role | null }
  | { ok: false; role: Role; violations: string[] };

/** Put the session in `role`. Refused while the role being left has changed a file it may not leave changed. */
export function enterRole(root: string, role: Role): RoleChange {
  const previous = readState(root);
  const violations = blockingLeave(root, previous);
  if (previous && violations.length) return { ok: false, role: previous.role, violations };
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  writeState(root, {
    role,
    session: previous?.session ?? null,
    head,
    dirty: hashes(root, changedSince(root, head)),
  });
  return { ok: true, role, previous: previous?.role ?? null };
}

/** End the role in force, with the same check as entering the next one. */
export function leaveRole(root: string): RoleChange {
  const previous = readState(root);
  const violations = blockingLeave(root, previous);
  if (previous && violations.length) return { ok: false, role: previous.role, violations };
  rmSync(join(root, STATE_FILE), { force: true });
  return { ok: true, role: null, previous: previous?.role ?? null };
}

/** The role in force for this session, or `null`. State another session claimed does not bind this one. */
export function currentRole(root: string, session: string | undefined): Role | null {
  const state = readState(root);
  if (!state || (state.session && state.session !== session)) return null;
  return state.role;
}

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface HookResult {
  /** 0 lets the action through; 2 refuses it (or, after a tool ran, reports it) and shows `message` to the agent. */
  exit: 0 | 2;
  message: string;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const MERGE_TOOLS = new Set([
  "mcp__github__merge_pull_request",
  "mcp__github__enable_pr_auto_merge",
]);

const repositoryRoot = (start: string): string | null => {
  try {
    return git(start, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return null;
  }
};

const refuse = (message: string): HookResult => ({ exit: 2, message });

export function runHook(input: HookInput, options: { projectDir?: string } = {}): HookResult {
  const pass: HookResult = { exit: 0, message: "" };
  const root = repositoryRoot(options.projectDir ?? input.cwd ?? process.cwd());
  if (!root) return pass;
  const state = readState(root);
  if (!state) return pass; // No role in force: an ordinary session is not guarded.
  if (!state.session && input.session_id) {
    // `enter` runs as a shell command and cannot know the session; the first hook call after it claims the role.
    state.session = input.session_id;
    writeState(root, state);
  }
  if (state.session && state.session !== input.session_id) return pass; // Another session's role.
  const role = state.role;
  const rule = RULES[role];
  const tool = input.tool_name ?? "";

  if (input.hook_event_name === "PreToolUse") {
    if (tool === "Bash") {
      const decision = decideBash(String(input.tool_input?.["command"] ?? ""));
      return decision.ok ? pass : refuse(decision.reason);
    }
    if (SUBAGENT_TOOLS.has(tool))
      return refuse(
        "The feature workflow runs in this session, one role at a time; it starts no subagent. " +
          "Do the work yourself in the role it belongs to (`bun scripts/agents/role-guard.ts enter <role>`).",
      );
    if (MERGE_TOOLS.has(tool))
      return refuse("Merging a pull request is the owner's, never an agent's.");
    if (FILE_TOOLS.has(tool)) {
      const target = input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"];
      if (typeof target !== "string" || !target) return pass;
      const path = relative(root, resolve(input.cwd ?? root, target));
      // Outside the repository — a scratch file, a temp directory — is not this guard's business.
      if (path.startsWith("..") || isAbsolute(path)) return pass;
      const decision = decideWrite(role, path);
      return decision.ok ? pass : refuse(decision.reason);
    }
    return pass;
  }

  // Straight after a shell command, while it can still be repaired: the file-tool check cannot see a shell edit.
  if (input.hook_event_name === "PostToolUse" && tool === "Bash" && rule.leave) {
    const violations = outside(root, state, rule.write);
    if (!violations.length) return pass;
    return refuse(
      `That command changed files the ${role} role may not change:\n` +
        `${violations.map((path) => `  ${path}`).join("\n")}\n` +
        `Restore each one now (\`git checkout -- <path>\` for a tracked file, delete one you created) ` +
        `before you do anything else. You cannot leave the ${role} role while they differ.`,
    );
  }
  return pass;
}

const describeRule = (role: Role): string => {
  const rule = RULES[role];
  return (
    `  may write:        ${rule.write.join(", ")}\n` +
    `  never:            ${rule.deny.join(", ")}\n` +
    `  may leave changed: ${rule.leave ? rule.leave.join(", ") : "not checked on leaving"}\n` +
    `  brief:            docs/agents/${role}.md — read it now and follow it.\n`
  );
};

function reportChange(change: RoleChange): number {
  if (!change.ok) {
    process.stderr.write(
      `role-guard: still in the ${change.role} role — it may not be left with these files changed:\n` +
        `${change.violations.map((path) => `  ${path}`).join("\n")}\n` +
        `Restore each one (\`git checkout -- <path>\` for a tracked file, delete one you created), ` +
        `then run the command again.\n`,
    );
    return 1;
  }
  const from = change.previous ? `left the ${change.previous} role; ` : "";
  process.stdout.write(
    change.role
      ? `role-guard: ${from}now in the ${change.role} role.\n${describeRule(change.role)}`
      : `role-guard: ${from}no role is in force.\n`,
  );
  return 0;
}

function main(argv: readonly string[]): number {
  const [mode, named, ...rest] = argv;
  const usage = (): number => {
    process.stderr.write(
      "usage: role-guard.ts enter <role>\n" +
        "       role-guard.ts leave\n" +
        "       role-guard.ts status\n" +
        "       role-guard.ts hook                 (hook input on stdin)\n" +
        "       role-guard.ts verify <role> --base <sha> [--allow <glob>]...\n" +
        `roles: ${ROLES.join(", ")}\n`,
    );
    return 64;
  };
  if (mode === "hook") {
    let input: HookInput;
    try {
      input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    } catch {
      process.stderr.write("role-guard: the hook input was not JSON; nothing was checked\n");
      return 1;
    }
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    const result = runHook(input, projectDir ? { projectDir } : {});
    if (result.message) process.stderr.write(`${result.message}\n`);
    return result.exit;
  }
  const root = repositoryRoot(process.cwd());
  if (!root) {
    process.stderr.write("role-guard: not inside a git repository\n");
    return 64;
  }
  if (mode === "enter") return isRole(named) ? reportChange(enterRole(root, named)) : usage();
  if (mode === "leave") return reportChange(leaveRole(root));
  if (mode === "status") {
    const state = readState(root);
    process.stdout.write(
      state
        ? `role-guard: in the ${state.role} role.\n${describeRule(state.role)}`
        : "role-guard: no role is in force.\n",
    );
    return 0;
  }
  if (mode !== "verify" || !isRole(named)) return usage();
  let base: string | undefined;
  const allow: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index + 1];
    if (rest[index] === "--base" && value) base = value;
    if (rest[index] === "--allow" && value) allow.push(value);
  }
  if (!base) {
    process.stderr.write("role-guard: verify needs --base <sha>\n");
    return 64;
  }
  const violations = verifyRole(named, { cwd: root, base, allow });
  if (!violations.length) {
    process.stdout.write(
      `role-guard: ${named} — every change since ${base} is in the role's paths\n`,
    );
    return 0;
  }
  process.stderr.write(
    `role-guard: ${named} — changed since ${base} and outside the role's paths:\n` +
      `${violations.map((path) => `  ${path}`).join("\n")}\n`,
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
