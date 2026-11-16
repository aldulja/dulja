import { readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(rootPath, "infra", "Dockerfile"), "utf8");
const root = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")) as {
  workspaces: string[];
};
function workspaceDirs(patterns: readonly string[]): string[] {
  return patterns
    .flatMap((pattern) => {
      if (!pattern.endsWith("/*")) return [pattern];
      const parent = pattern.slice(0, -2);
      return readdirSync(join(rootPath, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    })
    .toSorted();
}

describe("container manifest", () => {
  it("parses: every line is a comment, an instruction or the continuation of one", () => {
    // A wrapped comment line that lost its `#` is an unknown instruction, and `docker build` stops there.
    const lines = dockerfile.split(/\r?\n/);
    const stray = lines.filter(
      (line, index) =>
        line.trim() !== "" &&
        !/^\s*#/.test(line) &&
        !/^[A-Z]+(\s|$)/.test(line) &&
        !lines[index - 1]?.trimEnd().endsWith("\\"),
    );
    expect(stray).toEqual([]);
  });
  it("copies every workspace manifest", () => {
    for (const workspace of workspaceDirs(root.workspaces))
      expect(dockerfile, workspace).toContain(`COPY ${workspace}/package.json`);
  });
  it("does not ignore copied context paths", () => {
    // Every source of every build-context COPY, by Docker's own matching (dockerIgnored, below).
    const copied = localCopySources(dockerfile);
    expect(copied).toContain("bun.lock");
    for (const source of copied) expect(dockerIgnored(source), source).toBe(false);
  });
});

/** The last stage's text. `FROM` appears only at a stage boundary, so the last one starts the runtime stage. */
const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

/** The build-context sources of the stage's own COPY lines — `--from=` copies come from a stage, not the context. */
function localCopySources(stage: string): string[] {
  return [...stage.matchAll(/^COPY (?!--from=)(.+)$/gm)].flatMap((match) =>
    match[1]!.trim().split(/\s+/).slice(0, -1),
  );
}

/** A path relative to the repository root, with `/` separators whatever the host's are. */
function repoPath(absolute: string): string {
  return relative(rootPath, absolute).replace(/\\/g, "/");
}

function isDirectory(path: string): boolean {
  return statSync(join(rootPath, path), { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Whether the stage puts this repository path at the same path under WORKDIR — a file read relative
 * to its importer is only found if its COPY mirrors the source path, as every one here does. Docker's
 * rule decides the target: a directory source copies its CONTENTS into the destination, trailing
 * slash or not, so `COPY a/dir a/` would put `a/dir/x` at `a/x`; only a file source lands at
 * `destination/<basename>`, when the destination ends in `/` or the line has several sources.
 */
function inImage(path: string, stage: string = runtime): boolean {
  return [...stage.matchAll(/^COPY (?!--from=)(.+)$/gm)].some((match) => {
    const tokens = match[1]!.trim().split(/\s+/);
    const sources = tokens.slice(0, -1);
    const destination = tokens.at(-1)!;
    return sources.some((source) => {
      const target = posix
        .normalize(
          !isDirectory(source) && (destination.endsWith("/") || sources.length > 1)
            ? posix.join(destination, posix.basename(source))
            : destination,
        )
        .replace(/\/$/, "");
      return target === source && (path === source || path.startsWith(`${source}/`));
    });
  });
}

/**
 * `.dockerignore`'s patterns as Docker reads them (moby/patternmatcher's ignorefile.ReadAll): `#` starts
 * a comment only in column 0, before the line is trimmed; a leading `!` marks an exception; each
 * pattern is path-cleaned, so `./a`, `/a` and `a/` all mean `a`.
 */
function dockerIgnorePatterns(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.startsWith("#")) return [];
      let pattern = line.trim();
      if (pattern === "") return [];
      const exception = pattern.startsWith("!");
      if (exception) pattern = pattern.slice(1).trim();
      pattern = posix.normalize(pattern).replace(/(.)\/+$/, "$1");
      if (pattern.length > 1 && pattern.startsWith("/")) pattern = pattern.slice(1);
      return [exception ? `!${pattern}` : pattern];
    });
}

/** The build context's own ignore file — what `docker build` applies to every COPY of this stage. */
const contextIgnore = dockerIgnorePatterns(readFileSync(join(rootPath, ".dockerignore"), "utf8"));

/**
 * One pattern as patternmatcher compiles it: `filepath.Match` plus `**`. `*` and `?` never cross a
 * `/`; `**` followed by `/` spans any number of directories, none included, so `**\/x` also matches
 * a top-level `x`; a trailing `**` matches everything below. Every other character is literal.
 */
function ignoreRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      index += pattern[index + 2] === "/" ? 2 : 1;
      source += index === pattern.length - 1 ? ".*" : "(.*/)?";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "\\" && index + 1 < pattern.length) source += `\\${pattern[++index]}`;
    else if (char === "[" || char === "]") source += char;
    else source += char.replace(/[.+()|{}$^]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

/**
 * Whether `docker build` leaves this context path out (patternmatcher's MatchesOrParentMatches): a
 * pattern matching the path or any directory above it excludes it, the last matching line wins, and an
 * exception re-admits only what an earlier line excluded. A COPY of a directory then omits the file
 * without a word — the build succeeds and the file is simply not in the image — where an excluded
 * single-file source stops the build. So a file the graph reads can be in a copied tree and still absent.
 */
function dockerIgnored(path: string, patterns: readonly string[] = contextIgnore): boolean {
  const parts = path.split("/");
  const candidates = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  let ignored = false;
  for (const line of patterns) {
    const exception = line.startsWith("!");
    if (exception !== ignored) continue;
    const pattern = ignoreRegExp(exception ? line.slice(1) : line);
    if (candidates.some((candidate) => pattern.test(candidate))) ignored = !exception;
  }
  return ignored;
}

/**
 * The module specifiers a source file loads when it runs. `import type` and `export type` are erased
 * and skipped; every other form counts — named, default, namespace and side-effect imports, re-exports
 * and dynamic `import("…")` — including `import { type A } from`, which `verbatimModuleSyntax` keeps
 * as `import {} from`. A type-position `import("x").T` is counted too: declaring it costs nothing.
 */
function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(join(rootPath, file), "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(
    /^[ \t]*(?:import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm,
  ))
    if (!/^\s+type\b/.test(match[1]!)) found.push(match[2]!);
  for (const match of text.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) found.push(match[1]!);
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.push(match[1]!);
  return found;
}

/** The file a relative specifier loads, by the extension-less forms Bun resolves; undefined if none exists. */
function resolveRelative(importer: string, specifier: string): string | undefined {
  const base = posix.join(posix.dirname(importer), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find(
    (candidate) => statSync(join(rootPath, candidate), { throwIfNoEntry: false })?.isFile(),
  );
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

function declaredDependencies(workspace: string): string[] {
  const manifest = JSON.parse(readFileSync(join(rootPath, workspace, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {});
}

/** Every @dulja workspace reachable from these entrypoints' `dependencies` — read, never restated here. */
function workspaceClosure(entrypoints: readonly string[]): Set<string> {
  const found = new Set<string>();
  const visit = (directory: string): void => {
    const manifest = JSON.parse(
      readFileSync(join(rootPath, directory, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@dulja/")) continue;
      const name = dependency.slice("@dulja/".length);
      if (found.has(name)) continue;
      found.add(name);
      visit(`packages/${name}`);
    }
  };
  for (const entrypoint of entrypoints) visit(entrypoint);
  return found;
}

/** The source trees the runtime stage serves: each workspace in the entrypoints' closure, and both entrypoints. */
const shippedTrees = [
  ...[...workspaceClosure(["apps/api", "apps/worker"])].map((name) => `packages/${name}/src`),
  "apps/api/src",
  "apps/worker/src",
];

/** The files the image runs — read from `infra/entrypoint.sh`, so a new or moved entrypoint moves the walk. */
const entrypoints = [
  ...readFileSync(join(rootPath, "infra", "entrypoint.sh"), "utf8").matchAll(/exec bun run (\S+)/g),
].map((match) => match[1]!);

/** `packages/db/src/x.ts` → `packages/db`: the workspace whose manifest installs the file's packages. */
function workspaceOf(file: string): string {
  return file.split("/").slice(0, 2).join("/");
}

/** The file an `@dulja/<name>[/sub]` specifier loads, by that workspace's `exports` map, wildcards included. */
function resolveWorkspace(specifier: string): string | undefined {
  const name = packageName(specifier);
  const manifests = workspaceDirs(root.workspaces).map((directory) => ({
    directory,
    manifest: JSON.parse(readFileSync(join(rootPath, directory, "package.json"), "utf8")) as {
      name?: string;
      exports?: Record<string, string>;
    },
  }));
  const found = manifests.find(({ manifest }) => manifest.name === name);
  if (found === undefined) return undefined;
  const subpath = `.${specifier.slice(name.length)}`;
  for (const [key, target] of Object.entries(found.manifest.exports ?? {})) {
    if (key === subpath) return posix.join(found.directory, target);
    const [prefix, suffix] = key.split("*") as [string, string | undefined];
    if (suffix !== undefined && subpath.startsWith(prefix) && subpath.endsWith(suffix))
      return posix.join(
        found.directory,
        target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length)),
      );
  }
  return undefined;
}

/**
 * The module graph Bun loads from the entrypoints: every file it imports or reads at run time, each
 * with the first file that reaches it, every package specifier with its importer, and every specifier
 * that resolves to no file. Relative and `@dulja/*` specifiers are followed (the latter by the
 * workspace's `exports` map); a JSON file is read, not followed. A `new URL("./x", import.meta.url)`
 * is a path read relative to its file at run time, so it is recorded too. Walking from the entrypoints
 * rather than scanning every copied file keeps the seed CLI's code in packages/db/src — which reads
 * packages/db/seed, deliberately absent — out of a graph that never loads it.
 */
function walkModuleGraph(): {
  reads: Map<string, string>;
  packages: { file: string; specifier: string }[];
  unresolved: string[];
} {
  const reads = new Map<string, string>(entrypoints.map((file) => [file, "infra/entrypoint.sh"]));
  const packages: { file: string; specifier: string }[] = [];
  const unresolved: string[] = [];
  const queue = [...entrypoints];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(join(rootPath, file), "utf8");
    for (const match of text.matchAll(
      /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g,
    )) {
      const path = posix.join(posix.dirname(file), match[1]!).replace(/\/$/, "");
      if (!reads.has(path)) reads.set(path, file);
    }
    for (const specifier of runtimeSpecifiers(file)) {
      if (isBuiltin(specifier) || /^bun(:|$)/.test(specifier)) continue;
      const isRelative = specifier.startsWith(".");
      if (!isRelative) packages.push({ file, specifier });
      if (!isRelative && !specifier.startsWith("@dulja/")) continue;
      const target = isRelative ? resolveRelative(file, specifier) : resolveWorkspace(specifier);
      if (target === undefined)
        unresolved.push(`${specifier} (imported by ${file}) resolves to no file`);
      else if (!reads.has(target)) {
        reads.set(target, file);
        queue.push(target);
      }
    }
  }
  return { reads, packages, unresolved };
}

let moduleGraph: ReturnType<typeof walkModuleGraph> | undefined;

/**
 * Every file the entrypoints' graph loads or reads, each with the first file that reaches it, and
 * those of them the stage does not put at the path they are read from. A relative import outside its
 * own tree — `../permissions`, `../../x.schema.json` — resolves at module load, so one the stage
 * forgets kills the entrypoint before it logs a line, as packages/domain's schema files did under
 * every APP_ENV. The specifiers are read from the sources, never restated, so a future one is caught.
 * A file the stage copies is still missing when `.dockerignore` drops it from the copied tree.
 */
function runtimeReads(
  stage: string,
  ignore: readonly string[] = contextIgnore,
): { reads: Map<string, string>; missing: string[] } {
  moduleGraph ??= walkModuleGraph();
  const reads = new Map(moduleGraph.reads);
  // The registry reads its profiles with readdirSync at boot (registerDefaultTransmitters →
  // availableProfileVersions, then loadProfile for each version), which no import scan can see:
  // the walk records the directory, and every profile in it is named here as well. The directory
  // is taken from profile.ts's own `new URL(…, import.meta.url)`, so moving PROFILE_DIR moves this
  // check.
  const profileSource = "packages/db/src/einvoice/profile.ts";
  expect(reads.has(profileSource), profileSource).toBe(true);
  const profileDir = /PROFILE_DIR = fileURLToPath\(new URL\("([^"]+)", import\.meta\.url\)\)/.exec(
    readFileSync(join(rootPath, profileSource), "utf8"),
  )?.[1];
  expect(profileDir, profileSource).toBeDefined();
  const profiles = repoPath(resolve(rootPath, dirname(profileSource), profileDir!));
  expect(reads.get(profiles), profiles).toBe(profileSource);
  const shipped = readdirSync(join(rootPath, profiles)).filter((name) => name.endsWith(".json"));
  expect(shipped, profiles).toContain("synthetic.v1.json");
  for (const name of shipped) reads.set(`${profiles}/${name}`, profileSource);
  const missing = [...moduleGraph.unresolved];
  for (const [path, reader] of reads)
    if (!inImage(path, stage)) missing.push(`${path} (read by ${reader})`);
    else if (dockerIgnored(path, ignore))
      missing.push(`${path} (read by ${reader}) is excluded by .dockerignore`);
  return { reads, missing };
}

/**
 * Every package the entrypoints' graph imports at run time that the importing file's own workspace
 * does not list under `dependencies`. The deps stage installs with `--production`, which drops
 * devDependencies, and Bun links each workspace's packages beside its own manifest — so a package
 * only a devDependency supplies is absent from the image and the import fails before the entrypoint
 * runs, as `playwright` did for the API. `node:`/`bun:` builtins need no package.
 */
function undeclaredRuntimeImports(dependenciesOf = declaredDependencies): string[] {
  moduleGraph ??= walkModuleGraph();
  const undeclared = new Set<string>();
  for (const { file, specifier } of moduleGraph.packages)
    if (!dependenciesOf(workspaceOf(file)).includes(packageName(specifier)))
      undeclared.add(`${packageName(specifier)} (imported by ${file})`);
  return [...undeclared].toSorted();
}

describe("runtime image", () => {
  it("copies no migration, no role provisioning and no seed pack", () => {
    // `COPY packages ./packages` put packages/db/migrations, packages/db/provision/roles.sql and
    // packages/db/seed/my into the serving image — the DDL and the role map that withholding
    // DATABASE_URL_MIGRATOR from that container (apps/edge/src/container-env.ts) exists to keep it away from.
    const forbidden = [
      "packages/db/migrations",
      "packages/db/provision",
      "packages/db/seed",
      "packages/ui",
    ];
    for (const source of localCopySources(runtime)) {
      for (const path of forbidden)
        expect(source === path || source.startsWith(`${path}/`), `${source} vs ${path}`).toBe(
          false,
        );
      // A whole-workspace copy passes the prefix test above and puts all three back, so name that shape too.
      expect(/^(packages|apps)(\/[^/]+)?$/.test(source), source).toBe(false);
    }
  });

  it("copies the source of every workspace the two entrypoints import, and of no other", () => {
    const needed = workspaceClosure(["apps/api", "apps/worker"]);
    expect(needed.size).toBeGreaterThan(0);
    for (const name of needed) {
      expect(runtime, name).toContain(`COPY packages/${name}/package.json`);
      expect(runtime, name).toContain(`COPY packages/${name}/src`);
    }
    const copied = new Set(
      localCopySources(runtime)
        .map((source) => /^packages\/([^/]+)\//.exec(source)?.[1])
        .filter((name): name is string => name !== undefined),
    );
    expect([...copied].toSorted()).toEqual([...needed].toSorted());
    // §3.11: `packages/contracts/src/index.ts` re-exports ../permissions, which is not under src/.
    expect(runtime).toContain("COPY packages/contracts/permissions.ts");
  });

  it("copies every file the entrypoints load or read, at the path they read it from", () => {
    for (const tree of shippedTrees) expect(localCopySources(runtime), tree).toContain(tree);
    const { reads, missing } = runtimeReads(runtime);
    // The walk reaches the reads that leave src — the permission catalogue, packages/domain's schema
    // files, the e-invoice profiles — and not only the files inside the copied trees.
    const outside = [...reads.keys()].filter(
      (path) => !shippedTrees.some((tree) => path.startsWith(`${tree}/`)),
    );
    expect(outside).toContain("packages/contracts/permissions.ts");
    expect(outside).toContain("packages/db/einvoice-profiles/synthetic.v1.json");
    expect(outside.filter((path) => path.endsWith(".schema.json")).length).toBeGreaterThan(1);
    expect(missing).toEqual([]);
  });

  it("would report a file the entrypoints read that the stage drops", () => {
    // Today's stage copies everything; this proves the check above is not vacuous.
    const withoutPermissions = runtime.replace(
      /^COPY packages\/contracts\/permissions\.ts .*\n/m,
      "",
    );
    expect(withoutPermissions).not.toBe(runtime);
    const { missing } = runtimeReads(withoutPermissions);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^packages\/contracts\/permissions\.ts \(read by \S+\.ts\)$/);
  });

  it("would report a file the entrypoints read that .dockerignore drops from a copied directory", () => {
    // `COPY packages/db/einvoice-profiles …` copies the directory, so an ignore line that matches the
    // profile inside it leaves the build green and staging without a synthetic transmitter.
    const profile = "packages/db/einvoice-profiles/synthetic.v1.json";
    const reason = `${profile} (read by packages/db/src/einvoice/profile.ts) is excluded by .dockerignore`;
    const byName = runtimeReads(runtime, [
      ...contextIgnore,
      "packages/db/einvoice-profiles/*.json",
    ]);
    expect(byName.missing).toEqual([reason]);
    const anyJson = runtimeReads(runtime, [...contextIgnore, "**/*.json"]).missing;
    expect(anyJson).toContain(reason);
    // The same line drops the schema files packages/domain/src imports, and a later exception re-admits all.
    expect(
      anyJson.filter((entry) => /\.schema\.json \(read by /.test(entry)).length,
    ).toBeGreaterThan(1);
    expect(runtimeReads(runtime, [...contextIgnore, "**/*.json", "!packages"]).missing).toEqual([]);
    // A code file in a copied src tree is caught the same way.
    expect(
      runtimeReads(runtime, [...contextIgnore, "packages/contracts/src/*.ts"]).missing,
    ).toContainEqual(
      expect.stringMatching(
        /^packages\/contracts\/src\/index\.ts \(read by \S+\.ts\) is excluded by \.dockerignore$/,
      ),
    );
  });

  it("matches .dockerignore lines as Docker does", () => {
    const ignored = (path: string, ...patterns: string[]): boolean =>
      dockerIgnored(path, dockerIgnorePatterns(patterns.join("\n")));
    // A plain path is anchored at the context root and covers everything beneath it, nothing beside it.
    expect(ignored("dist/a.js", "dist")).toBe(true);
    expect(ignored("packages/db/dist/a.js", "dist")).toBe(false);
    expect(ignored("packages/db/seed/my/x.json", "packages/db/seed/my")).toBe(true);
    expect(ignored("packages/db/seed/mystery/x.json", "packages/db/seed/my")).toBe(false);
    expect(ignored("docs/a.md", "/docs/")).toBe(true);
    // `*` stays inside one directory; `**` spans any number, none included.
    expect(ignored("packages/db/einvoice-profiles/synthetic.v1.json", "packages/db/*/*.json")).toBe(
      true,
    );
    expect(ignored("packages/db/einvoice-profiles/synthetic.v1.json", "packages/*.json")).toBe(
      false,
    );
    expect(ignored("packages/db/einvoice-profiles/synthetic.v1.json", "**/*.json")).toBe(true);
    expect(ignored("package.json", "**/*.json")).toBe(true);
    expect(ignored("node_modules/x/index.js", "**/node_modules")).toBe(true);
    expect(ignored("packages/db/src/x.test.ts", "**/*.test.ts")).toBe(true);
    expect(ignored("packages/db/src/x.ts", "**/*.test.ts")).toBe(false);
    expect(ignored("packages/db/src/x.ts", "packages/**")).toBe(true);
    // A `.` is a dot, not any character.
    expect(ignored("packages/db/src/x_test.ts", "**/*.test.ts")).toBe(false);
    // The last matching line wins; an exception re-admits only what an earlier line excluded.
    expect(
      ignored(
        "packages/db/einvoice-profiles/synthetic.v1.json",
        "**/*.json",
        "!**/synthetic.v1.json",
      ),
    ).toBe(false);
    expect(ignored("a.json", "!a.json", "*.json")).toBe(true);
    // `#` is a comment only in column 0.
    expect(ignored("dist/a.js", "# dist")).toBe(false);
    // What `docker build` (BuildKit, 2026-10-06) kept of a scratch context under these four lines,
    // copying each top-level directory whole: exit 0, and the two .json files silently absent.
    const probe = dockerIgnorePatterns("**/*.json\n!profiles/keep.json\ndist\nseed/my\n");
    const context = [
      "profiles/README.md",
      "profiles/keep.json",
      "profiles/synthetic.v1.json",
      "seed/my/x.sql",
      "seed/mystery/x.sql",
      "sub/dist/a.js",
      "sub/x.json",
    ];
    expect(context.filter((path) => !dockerIgnored(path, probe))).toEqual([
      "profiles/README.md",
      "profiles/keep.json",
      "seed/mystery/x.sql",
      "sub/dist/a.js",
    ]);
    // The real file keeps every file the entrypoints read.
    expect(dockerIgnored("packages/db/src/einvoice/profile.ts")).toBe(false);
    expect(dockerIgnored("packages/db/src/einvoice/registry.test.ts")).toBe(true);
    expect(dockerIgnored("packages/db/migrations/0001_x.sql")).toBe(true);
  });

  it("follows Docker's COPY rule: a directory's contents land in the destination", () => {
    const profile = "packages/db/einvoice-profiles/synthetic.v1.json";
    expect(
      inImage(profile, "COPY packages/db/einvoice-profiles packages/db/einvoice-profiles\n"),
    ).toBe(true);
    expect(
      inImage(profile, "COPY packages/db/einvoice-profiles packages/db/einvoice-profiles/\n"),
    ).toBe(true);
    // Ships the file as packages/db/synthetic.v1.json, where PROFILE_DIR never looks.
    expect(inImage(profile, "COPY packages/db/einvoice-profiles packages/db/\n")).toBe(false);
    const catalogue = "packages/contracts/permissions.ts";
    expect(inImage(catalogue, "COPY packages/contracts/permissions.ts packages/contracts/\n")).toBe(
      true,
    );
    expect(inImage(catalogue, "COPY packages/contracts/permissions.ts packages/\n")).toBe(false);
  });

  it("installs every package the entrypoints import at run time, as a dependency of the importer", () => {
    expect(undeclaredRuntimeImports()).toEqual([]);
  });

  it("would report a runtime import that its workspace does not list under dependencies", () => {
    // Withholding one real dependency of apps/api proves the check above is not vacuous.
    const withoutUuid = (workspace: string): string[] =>
      declaredDependencies(workspace).filter((name) => workspace !== "apps/api" || name !== "uuid");
    const baseline = new Set(undeclaredRuntimeImports());
    const added = undeclaredRuntimeImports(withoutUuid).filter((entry) => !baseline.has(entry));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((entry) => entry.startsWith("uuid (imported by apps/api/src/"))).toBe(true);
  });

  it("pins the base image by digest, identically in every stage", () => {
    const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]!);
    expect(images.length).toBeGreaterThan(1);
    const digests = images.map((image) => /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1]);
    for (const [index, digest] of digests.entries()) expect(digest, images[index]).toBeTruthy();
    expect(new Set(digests).size).toBe(1);
  });
});

/** The runtime stage's RUN instructions, each joined across its `\` continuations. */
function runInstructions(stage: string): string[] {
  return [...stage.replace(/\\\r?\n/g, " ").matchAll(/^RUN (.+)$/gm)].map((match) => match[1]!);
}

describe("runtime image: printing (ADR 0016, OD-20)", () => {
  // Both entrypoints print through Chromium — apps/api's documents (2C) and payslips (8D), apps/worker's report
  // PDFs (7A) — and an Arabic document needs a font with Arabic glyphs. Until 2026-11-15 the image carried neither,
  // so every PDF render in a deployed container failed (ci.yml's `image` job now renders both directions in it).
  const apt = runInstructions(runtime).find((run) => /\bapt-get install\b/.test(run));

  it("installs Debian's chromium, an Arabic-capable Noto font and fontconfig in one minimal apt layer", () => {
    expect(apt, "no apt-get install in the runtime stage").toBeDefined();
    const packages = /apt-get install\s+-y\s+--no-install-recommends\s+([^&;]+)/.exec(apt!)?.[1];
    expect(packages, "apt-get install -y --no-install-recommends <packages>").toBeDefined();
    expect(packages!.trim().split(/\s+/).toSorted()).toEqual([
      "chromium",
      "fontconfig",
      "fonts-noto-core",
    ]);
    expect(apt).toMatch(/^apt-get update\b/);
    expect(apt).toContain("rm -rf /var/lib/apt/lists/*");
  });

  it("names the browser in CHROMIUM_EXECUTABLE_PATH, the variable both engines read", () => {
    expect(runtime).toMatch(/^ENV CHROMIUM_EXECUTABLE_PATH=\/usr\/bin\/chromium$/m);
  });

  it("installs before dropping root, runs as the non-root bun user and adds no sandbox switch of its own", () => {
    // Whether Chromium's sandbox is on is the engines' launch option (apps/api/src/print/engines/chromium.ts,
    // apps/worker/src/reports/engines/chromium.ts) and an owner decision (docs/runbooks/deploy.md, "Runtime
    // image"); the image must not decide it behind their backs, and must not run the browser as root.
    const users = [...runtime.matchAll(/^USER (\S+)$/gm)].map((match) => match[1]);
    expect(users.at(-1)).toBe("bun");
    expect(runtime.indexOf("apt-get install")).toBeLessThan(runtime.lastIndexOf("\nUSER "));
    const instructions = dockerfile
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(instructions).not.toMatch(/no-sandbox/);
  });

  it("installs no apt package in the deps stage, which never reaches the image", () => {
    const deps = dockerfile.slice(0, dockerfile.lastIndexOf("\nFROM "));
    expect(deps).not.toMatch(/apt-get/);
  });
});
