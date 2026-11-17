import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repoFile } from "../support/regression";
import { REPO_ROOT, sourceFiles } from "../support/source";

/** A source-only fact: nothing about a developer's machine may be readable from a shipped file. */
describe("LEGACY-087 Hardcoded developer build paths in shipped metadata — 0B", () => {
  it("no shipped source contains an absolute developer path", () => {
    const PATTERNS = [
      /[A-Za-z]:\\\\?(?:Users|Documents|Projects|Dev)\b/i,
      /\/(?:Users|home)\/[a-z0-9._-]+\//i,
      /\/mnt\/[cd]\//i,
    ];
    const offenders = sourceFiles()
      .flatMap((f) => f.lines.map((line, i) => ({ file: f.path, line: i + 1, text: line })))
      .filter((l) => PATTERNS.some((p) => p.test(l.text)));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.text.trim()}`)).toEqual([]);
  });

  it("every path a shipped file resolves is relative to the module or to a named environment variable", () => {
    const pathCall = /(?:^|[^.A-Za-z0-9_$])(join|resolve)\(/;
    const resolvers = sourceFiles().filter((f) => pathCall.test(f.text));
    for (const f of resolvers) {
      // `import.meta.url`, `process.cwd()` or an env value — never a literal root.
      const literalRoots = f.lines.filter((line) =>
        /(?:^|[^.A-Za-z0-9_$])(join|resolve)\(\s*["'`]\//.test(line),
      );
      expect(literalRoots, f.path).toEqual([]);
    }
  });
});

// ── appended by slice 0C ──────────────────────────────────────────────────────────────────────────────
const DEVELOPER_PATH = /([A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[a-z])/;

describe("LEGACY-087 Hardcoded developer build paths in shipped metadata — 0C", () => {
  it("nothing that ships carries a path from the machine that built it", () => {
    for (const file of [
      "infra/Dockerfile",
      "infra/entrypoint.sh",
      "infra/wrangler.jsonc",
      ".github/workflows/deploy-staging.yml",
    ])
      expect(repoFile(file), file).not.toMatch(DEVELOPER_PATH);
  });
  it("the image is built from the repository, not from a developer's tree: every COPY source is repo-relative", () => {
    const sources = [...repoFile("infra/Dockerfile").matchAll(/^COPY (?:--from=\S+ )?(\S+)/gm)].map(
      (match) => match[1]!,
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources)
      expect(source.startsWith("/app") || !source.startsWith("/"), source).toBe(true);
  });
});

// ── appended by slice 0E ──────────────────────────────────────────────────────────────────────────────

/** Every file under `dir`, recursively, as an absolute path. */
const walkFiles = async (dir: string, out: string[] = []): Promise<string[]> => {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await walkFiles(full, out);
    else out.push(full);
  }
  return out;
};

describe("LEGACY-087 Hardcoded developer build paths in shipped metadata — 0E", () => {
  const INSTALLER_DIR = join(REPO_ROOT, "apps/desktop/dist-installer");
  /** The feed electron-builder bakes into the package — and, with no `DULJA_UPDATE_FEED` set on the
   *  machine it is installed on, the one an installed copy actually reads (ADR 0017 decision 5). */
  const SHIPPED_FEED = join(INSTALLER_DIR, "win-unpacked/resources/app-update.yml");
  // Both artefacts, not just the directory: a `dist` that failed part-way leaves `dist-installer/`
  // behind with neither of them in it, and these would then throw ENOENT instead of skipping.
  //
  // Only a full `bun run --cwd apps/desktop dist` writes either file, and no CI job runs both that and
  // this suite. Since CI went Windows-only this file is not merely skipped there, it is never loaded:
  // `ci.yml`'s `checks` job runs a `turbo run test` filtered to seven container-free workspaces, and
  // `@dulja/tests` — which needs a Linux Postgres container a windows-latest runner cannot start — is
  // not among them. Its `desktop` job builds `--dir`, which writes neither file, and runs only
  // `apps/desktop`'s own suites, neither of which reaches `tests/regression/`. `release.yml` writes
  // both files but runs no test step at all. So the two cases below run on a developer's machine after
  // a real `dist` and nowhere else — closing that changes what a release run executes: the owner's
  // call. Line numbers are deliberately not cited here; the last set went stale within two commits.
  const built = existsSync(join(INSTALLER_DIR, "latest.yml")) && existsSync(SHIPPED_FEED);

  /**
   * electron-builder writes two files beside the artefacts that describe the *build*, not the product:
   * `builder-debug.yml` (the NSIS script it generated, naming its own templates and %TEMP%) and
   * `builder-effective-config.yaml`. Neither is inside the installer and neither is published to the
   * update feed, so neither is "shipped metadata" in LEGACY-087's sense. Everything else under
   * `dist-installer/` either goes into `Dulja Back Office Setup <version>.exe` or is published beside it.
   */
  const LOCAL_DIAGNOSTICS = ["builder-debug.yml", "builder-effective-config.yaml"];

  it.runIf(built)(
    "no shipped metadata file carries an absolute path from the build machine",
    async () => {
      const offenders: string[] = [];
      const files = await walkFiles(INSTALLER_DIR);
      // Guard against the vacuous pass: if nothing matched the extension filter, the assertion below
      // would prove nothing at all.
      const inspected = files.filter(
        (file) =>
          /\.(yml|yaml|json|txt)$/i.test(file) &&
          !LOCAL_DIAGNOSTICS.includes(relative(INSTALLER_DIR, file)),
      );
      expect(inspected.length, `no metadata file found under ${INSTALLER_DIR}`).toBeGreaterThan(0);
      // …and against the exclusion above quietly widening to swallow the very files it must not: the
      // published feed and the installed payload both have to still be in what gets read.
      const seen = inspected.map((file) => relative(INSTALLER_DIR, file));
      expect(seen, "latest.yml is not being inspected").toContain("latest.yml");
      expect(
        seen.some((file) => file.startsWith("win-unpacked")),
        "nothing from the installed payload is being inspected",
      ).toBe(true);
      for (const file of inspected) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(/[A-Za-z]:\\[^\s"']{4,}/g))
          offenders.push(`${file}: ${match[0]}`);
        for (const match of text.matchAll(/\/(home|Users)\/[^\s"']{2,}/g))
          offenders.push(`${file}: ${match[0]}`);
      }
      expect(offenders).toEqual([]);
    },
  );

  it.runIf(built)(
    "the update feed is configuration, not a literal in the shipped app",
    async () => {
      const latest = await readFile(join(INSTALLER_DIR, "latest.yml"), "utf8");
      expect(latest).toContain("version:");
      expect(latest).not.toMatch(/[A-Za-z]:\\/);
      // `app-update.yml` is where `${env.DULJA_UPDATE_FEED}` lands (`electron-builder.yml`), and it
      // is read at run time by any install that sets no override — so a value that is not a usable
      // absolute URL is not a cosmetic defect in a file nobody opens, it is a till that can never
      // update. Parsed, therefore, rather than pattern-matched: `\S+` would accept a Windows path.
      const shipped = await readFile(SHIPPED_FEED, "utf8");
      expect(shipped).toContain("provider: generic");
      const url = /^url:\s*(\S+)$/m.exec(shipped)?.[1];
      expect(url, `no url in ${SHIPPED_FEED}:\n${shipped}`).toBeDefined();
      const feed = new URL(url!);
      expect(["http:", "https:"], url).toContain(feed.protocol);
      expect(feed.hostname, url).not.toBe("");
      expect(repoFile("apps/desktop/electron-builder.yml")).toContain("${env.DULJA_UPDATE_FEED}");
    },
  );
});
