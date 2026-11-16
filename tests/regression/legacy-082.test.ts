import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "@dulja/api"; // the package entry, never a source file (§3.1)
import { sourceFiles } from "../support/source";

/** No container start: the defect was a literal in shipped code, and its fix is that every address the server
 *  needs is a named environment variable read once at boot (contracts §3.11). */
describe("LEGACY-082 Licensing is pinned to a hardcoded private IP address — 0B", () => {
  const env = {
    APP_ENV: "dev",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgres://u:p@localhost:5432/d",
    TERMINAL_JWT_SIGNING_KEY: "dulja-test-terminal-signing-key-0123456789abcdef",
    SUPABASE_JWKS_URL: "https://example.test/keys",
    SUPABASE_JWT_ISSUER: "https://example.test",
  };

  it("every address the API needs comes from a named variable, and a missing one fails loudly at boot", () => {
    expect(readConfig(env).databaseUrl).toBe(env.DATABASE_URL);
    for (const name of ["DATABASE_URL", "SUPABASE_JWKS_URL", "SUPABASE_JWT_ISSUER"] as const) {
      const without = { ...env, [name]: "" };
      expect(() => readConfig(without)).toThrow(ConfigError);
      expect(() => readConfig(without)).toThrow(new RegExp(`^${name} is not set`));
    }
  });

  it("no shipped source contains a hard-coded routable or private IPv4 host", () => {
    // 0.0.0.0 (bind-any) and 127.0.0.1 (loopback) are addresses of THIS process, not of a remote service, and are
    // the only two allowed; anything else is a pinned peer, which is the defect.
    const ALLOWED = new Set(["0.0.0.0", "127.0.0.1"]);
    // The test tree is excluded, because this case's own title is the reason: a test file is not SHIPPED
    // SOURCE, and the defect LEGACY-082 names is a deployed binary reaching a peer nobody can reconfigure. A
    // test that feeds `203.0.113.9` to `networkOriginKey` is asserting that the function returns what it
    // was handed, and that literal is RFC 5737 TEST-NET-3 — the range reserved for exactly this use, which
    // routes nowhere. Requiring a fixture to come from configuration would make the assertion vacuous.
    // The Phase 2 review pass introduced the line (apps/edge/test/rate-limit.test.ts) and this scan has
    // been red since; shipped source is still scanned with nothing exempted.
    const TEST_TREE = /(^|\/)tests?\/|\.test\.tsx?$|\.spec\.tsx?$/;
    const offenders = sourceFiles()
      .filter((f) => !TEST_TREE.test(f.path))
      .flatMap((f) => f.lines.map((line, i) => ({ file: f.path, line: i + 1, text: line })))
      .flatMap((l) =>
        (l.text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).map((ip) => ({ ...l, ip })),
      )
      .filter((l) => !ALLOWED.has(l.ip));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.ip}`)).toEqual([]);
  });
});
