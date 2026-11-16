import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "entrypoint.sh");
const shell =
  process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\sh.exe")
    ? "C:\\Program Files\\Git\\bin\\sh.exe"
    : "sh";
function posixPath(path: string): string {
  if (process.platform !== "win32") return path;
  return path
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll("\\", "/");
}
function stubBunDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "dulja-entrypoint-"));
  const stub = join(directory, "bun");
  writeFileSync(stub, '#!/bin/sh\necho "bun $*"\n');
  chmodSync(stub, 0o755);
  return directory;
}
function run(entry: string | undefined) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH:
      process.platform === "win32"
        ? `${posixPath(stubBunDir())}:/usr/bin:/bin`
        : `${stubBunDir()}:${process.env["PATH"] ?? ""}`,
  };
  if (entry === undefined) delete env.DULJA_ENTRYPOINT;
  else env.DULJA_ENTRYPOINT = entry;
  try {
    const out = execFileSync(shell, [posixPath(entrypoint)], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    const failure = error as { status: number | null; stdout?: string; stderr?: string };
    return { code: failure.status, out: failure.stdout ?? "", err: failure.stderr ?? "" };
  }
}

describe("one image entrypoint", () => {
  it("dispatches api", () => expect(run("api").out.trim()).toBe("bun run apps/api/src/index.ts"));
  it("dispatches worker", () =>
    expect(run("worker").out.trim()).toBe("bun run apps/worker/src/index.ts"));
  it("defaults to api", () =>
    expect(run(undefined).out.trim()).toBe("bun run apps/api/src/index.ts"));
  it("rejects unknown classes", () => {
    const result = run("wrker");
    expect(result.code).toBe(2);
    expect(result.err.trim()).toBe("unknown DULJA_ENTRYPOINT 'wrker' — expected api or worker");
  });
});
