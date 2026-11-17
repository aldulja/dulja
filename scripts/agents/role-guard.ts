/**
 * The feature workflow's role guard (AGENTS.md, "Feature Workflow"; briefs in `docs/agents/`).
 *
 * A brief says what a role must not touch; this file is what holds it to that. It is used three ways:
 *
 *   bun scripts/agents/role-guard.ts hook <role>
 *       A Claude Code hook (`.claude/agents/<role>.md`). Before a file tool runs it refuses a path outside the
 *       role's own; before a shell command it refuses a merge or a push to the default branch; and when a spec
 *       or review agent tries to finish it refuses while the tree differs from where the agent started in any
 *       file the role may not leave changed — which is what catches an edit made through the shell.
 *
 *   bun scripts/agents/role-guard.ts verify <role> --base <sha> [--allow <glob>]...
 *       The orchestrator's check after an agent returns, and the one that holds whatever tool ran the agent:
 *       every path changed since <sha>, committed or not, must be one the role may leave changed. For build
 *       and fix, `--allow` narrows that to the files the agent was given.
 *
 * Paths are repository-relative with forward slashes. Nothing here reads a file's content or runs a test: it
 * answers "which files changed, and was this role allowed to change them" and nothing else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES = ["orchestrator", "spec", "build", "review", "fix"] as const;
export type Role = (typeof ROLES)[number];

interface RoleRule {
  /** Globs the role's file tools may write while it works. */
  readonly write: readonly string[];
  /** Globs that may differ from the starting tree when the role finishes; `null` is "not checked at the end". */
  readonly leave: readonly string[] | null;
  /** Globs refused even when `write` or `leave` admits them. */
  readonly deny: readonly string[];
}

/** The guard and the agent definitions: no role edits what holds the roles in place. The owner changes these. */
const GUARD = [".claude/**", "scripts/agents/**"] as const;
/** The orchestrator's alone (AGENTS.md, "Feature Workflow"). The two register tables inside Plan Contracts
 *  §3.4.1 and §3.9 are the orchestrator's too, but a path cannot say which section of a file an edit touches,
 *  so that half stays a rule of the briefs. */
const ORCHESTRATOR_ONLY = ["AGENTS.md", "docs/status/**"] as const;
/** A feature's record of the owner's approval and its ledger. A builder refuses a plan with no `approval.md`,
 *  so the file is worth something only if the roles that want the build to start cannot write it. */
const FEATURE_RECORD = ["docs/features/*/approval.md", "docs/features/*/ledger.md"] as const;

export const RULES: Readonly<Record<Role, RoleRule>> = {
  // Shares its tree with the agents it starts, so the end of its turn proves nothing about its own edits.
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
  // Product code is their work. The tree they leave is checked by `verify --allow`, not by the stop hook:
  // which files are theirs is the orchestrator's allocation, different for every task.
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
      `. If the work needs this file, tell the orchestrator (docs/agents/${role}.md).`,
  };
}

const DEFAULT_BRANCH = /^(?:\+?[^:\s]*:)?(?:refs\/heads\/)?(?:main|master)$/;

/** May any role run this shell command? Merging is the owner's, and so is the default branch. */
export function decideBash(command: string): Decision {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (/\bgh\s+pr\s+merge\b/.test(segment))
      return { ok: false, reason: "Merging a pull request is the owner's, never an agent's." };
    const push = /\bgit\b[^\n]*?\bpush\b(.*)$/.exec(segment);
    if (!push) continue;
    const words = (push[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.some((word) => word === "--all" || word === "--mirror" || DEFAULT_BRANCH.test(word)))
      return {
        ok: false,
        reason:
          "Pushing to the default branch is the owner's. Push to the branch the orchestrator gave you.",
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
  return [...new Set([...tracked, ...untracked])].toSorted();
}

export interface VerifyOptions {
  cwd: string;
  base: string;
  /** Build and fix only: the files the orchestrator gave the agent. Defaults to everything the role may write. */
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

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface HookResult {
  /** 0 lets the action through, 2 refuses it and shows `message` to the agent, 1 is a warning that refuses nothing. */
  exit: 0 | 1 | 2;
  message: string;
}

interface Baseline {
  head: string;
  /** Content hash of every file already dirty when the agent started: that dirt is not the agent's. */
  dirty: Record<string, string>;
  blocks: number;
}

const MAX_BLOCKS = 3;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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

const stateFile = (state: string, id: string, role: Role): string =>
  join(state, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}-${role}.json`);

function readBaseline(file: string): Baseline | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

export interface HookOptions {
  /** Where baselines are kept between hook calls. Defaults to a directory under the system temp directory. */
  state?: string;
  /** The repository; defaults to `CLAUDE_PROJECT_DIR`, then the hook's `cwd`. */
  projectDir?: string;
}

export function runHook(role: Role, input: HookInput, options: HookOptions = {}): HookResult {
  const pass: HookResult = { exit: 0, message: "" };
  const start = options.projectDir ?? input.cwd ?? process.cwd();
  let root: string;
  try {
    root = git(start, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return pass; // Not a repository: there is nothing to guard.
  }
  const state = options.state ?? join(tmpdir(), "dulja-role-guard");
  const rule = RULES[role];
  // A hook inside a subagent may or may not carry `agent_id`; the session id is the fallback on both sides.
  const ids = [input.agent_id, input.session_id, "unknown"].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const files = ids.map((id) => stateFile(state, id, role));
  const existing = files.find((file) => existsSync(file));

  if (input.hook_event_name === "PreToolUse") {
    if (rule.leave && !existing) {
      const head = git(root, ["rev-parse", "HEAD"]).trim();
      const baseline: Baseline = {
        head,
        dirty: hashes(root, changedSince(root, head)),
        blocks: 0,
      };
      mkdirSync(state, { recursive: true });
      writeFileSync(files[0] ?? stateFile(state, "unknown", role), JSON.stringify(baseline));
    }
    const tool = input.tool_name ?? "";
    if (tool === "Bash") {
      const decision = decideBash(String(input.tool_input?.["command"] ?? ""));
      return decision.ok ? pass : { exit: 2, message: decision.reason };
    }
    if (FILE_TOOLS.has(tool)) {
      const target = input.tool_input?.["file_path"] ?? input.tool_input?.["notebook_path"];
      if (typeof target !== "string" || !target) return pass;
      const path = relative(root, resolve(input.cwd ?? root, target));
      // Outside the repository — a scratch file, a temp directory — is not this guard's business.
      if (path.startsWith("..") || isAbsolute(path)) return pass;
      const decision = decideWrite(role, path);
      return decision.ok ? pass : { exit: 2, message: decision.reason };
    }
    return pass;
  }

  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    if (!rule.leave || !existing) return pass;
    const baseline = readBaseline(existing);
    if (!baseline) return pass;
    const changed = changedSince(root, baseline.head);
    const now = hashes(root, changed);
    const violations = changed.filter(
      (path) => baseline.dirty[path] !== now[path] && !admitted(path, rule.leave ?? [], rule.deny),
    );
    if (!violations.length) {
      rmSync(existing, { force: true });
      return pass;
    }
    const list = violations.map((path) => `  ${path}`).join("\n");
    if (baseline.blocks >= MAX_BLOCKS) {
      rmSync(existing, { force: true });
      return {
        exit: 1,
        message:
          `role-guard: the ${role} agent finished with files changed that it may not change:\n${list}\n` +
          `The orchestrator's \`role-guard.ts verify ${role}\` will refuse this tree.`,
      };
    }
    writeFileSync(existing, JSON.stringify({ ...baseline, blocks: baseline.blocks + 1 }));
    return {
      exit: 2,
      message:
        `The ${role} role may not finish with these files changed:\n${list}\n` +
        `It may leave changed only: ${rule.leave.join(", ")}. Restore each file to how you found it ` +
        `(\`git checkout -- <path>\` for a tracked file, delete one you created), then finish. ` +
        `If one of these changes is needed, say so in your final message instead of keeping it.`,
    };
  }
  return pass;
}

const isRole = (value: string | undefined): value is Role =>
  (ROLES as readonly string[]).includes(value ?? "");

function main(argv: readonly string[]): number {
  const [mode, role, ...rest] = argv;
  if (!isRole(role) || (mode !== "hook" && mode !== "verify")) {
    process.stderr.write(
      "usage: role-guard.ts hook <role>   (hook input on stdin)\n" +
        "       role-guard.ts verify <role> --base <sha> [--allow <glob>]...\n" +
        `roles: ${ROLES.join(", ")}\n`,
    );
    return 64;
  }
  if (mode === "hook") {
    let input: HookInput;
    try {
      input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    } catch {
      process.stderr.write("role-guard: the hook input was not JSON; nothing was checked\n");
      return 1;
    }
    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    const result = runHook(role, input, projectDir ? { projectDir } : {});
    if (result.message) process.stderr.write(`${result.message}\n`);
    return result.exit;
  }
  let base: string | undefined;
  const allow: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index + 1];
    if (rest[index] === "--base" && value) base = value;
    if (rest[index] === "--allow" && value) allow.push(value);
  }
  if (!base) {
    process.stderr.write(
      "role-guard: verify needs --base <sha>, the commit the agent started from\n",
    );
    return 64;
  }
  const violations = verifyRole(role, { cwd: process.cwd(), base, allow });
  if (!violations.length) {
    process.stdout.write(
      `role-guard: ${role} — every change since ${base} is in the role's paths\n`,
    );
    return 0;
  }
  process.stderr.write(
    `role-guard: ${role} — changed since ${base} and outside the role's paths:\n` +
      `${violations.map((path) => `  ${path}`).join("\n")}\n`,
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
