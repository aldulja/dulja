import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalSyncRequest,
  sha256Hex,
  signSyncHeaders,
  SYNC_SIGNATURE_HEADER,
  SYNC_TIMESTAMP_HEADER,
} from "@dulja/sync";
import { sourceFiles } from "../support/source";

/**
 * LEGACY-046 without a container (6B T0 Step 4). `tests/regression/legacy-046.test.ts` pins the one `export function`
 * too, but it runs under `fullRegression`, whose every case awaits the PostgreSQL-backed harness; this file proves
 * the one-spelling claim anywhere `bun run test` runs.
 *
 * There is deliberately no `expect(fromApi).toBe(fromSync)` and no import of the API's middleware: the middleware
 * re-exports `@dulja/sync`'s function, so that identity is a tautology, and the test tier reaches `apps/api` only
 * through `createApp()` and `./routes` (§3.1). The second and third cases make the claim from the source instead.
 */
describe("LEGACY-046 — there is exactly one canonical sync signature string", () => {
  it("is four newline-separated fields, in order, over every shape the two ends send", () => {
    const cases = [
      {
        method: "GET",
        path: "/v1/sync/catalogue",
        timestamp: "2026-01-15T00:00:00.000Z",
        body: sha256Hex(""),
      },
      {
        method: "POST",
        path: "/v1/sync/tickets",
        timestamp: "2026-01-15T13:45:07.123Z",
        body: sha256Hex(JSON.stringify({ a: 1 })),
      },
      {
        method: "POST",
        path: "/v1/sync/enrol",
        timestamp: "1970-01-01T00:00:00.000Z",
        body: sha256Hex("{}"),
      },
      {
        method: "POST",
        path: "/v1/sync/tickets",
        timestamp: "2026-12-31T23:59:59.999Z",
        body: sha256Hex(JSON.stringify({ nested: { deep: [1, 2, 3] } })),
      },
    ];
    // Split rather than composed, so this file is not itself a second spelling for the third case to find. Exactly
    // four fields, in order, means no separator anywhere else and no trailing newline.
    for (const c of cases)
      expect(canonicalSyncRequest(c).split("\n")).toEqual([c.method, c.path, c.timestamp, c.body]);
    // The method is the one normalised field: a lower-case verb signs as the upper-case one the server reads.
    expect(canonicalSyncRequest({ ...cases[1]!, method: "post" })).toBe(
      canonicalSyncRequest(cases[1]!),
    );
  });

  it("the API's terminal middleware imports and re-exports it and declares no body of its own", () => {
    const middleware = sourceFiles(["apps/api/src/middleware"]).find(
      (f) => f.path === "apps/api/src/middleware/terminal-auth.ts",
    );
    expect(middleware).toBeDefined();
    const text = middleware!.text;
    // Either spelling of a re-export: `export { … } from "@dulja/sync"`, or an import from `@dulja/sync`
    // followed by `export { canonicalSyncRequest }` (the middleware also calls it, so it holds the import).
    const reExportsFrom =
      /export\s*\{[^}]*\bcanonicalSyncRequest\b[^}]*\}\s*from\s*["']@dulja\/sync["']/;
    const importsFrom =
      /import\s*\{[^}]*\bcanonicalSyncRequest\b[^}]*\}\s*from\s*["']@dulja\/sync["']/;
    const reExportsLocal = /export\s*\{[^}]*\bcanonicalSyncRequest\b[^}]*\}\s*;/;
    expect(reExportsFrom.test(text) || (importsFrom.test(text) && reExportsLocal.test(text))).toBe(
      true,
    );
    expect(text).not.toMatch(/\bfunction\s+canonicalSyncRequest\b/);
    expect(text).not.toMatch(/\b(?:const|let|var)\s+canonicalSyncRequest\b/);
    expect(text).not.toMatch(/canonicalSyncRequest\s+as\s+\w+/);
  });

  it("no source file outside packages/sync/src/signing.ts composes the string itself", () => {
    // A file that interpolates two fields across a newline in a template literal — or joins fields with a
    // newline — beside a mention of the terminal signature is a second spelling even if it agrees today, and
    // "agrees today" is what LEGACY-046 is. Unlike legacy-046's scan, the first interpolation need not name `method`,
    // and a call such as `at.toISOString()` counts. The one other exemption is signing.ts's own spec, which
    // writes the expected string out independently on purpose: a golden value is not a signer.
    const exempt = new Set(["packages/sync/src/signing.ts", "packages/sync/test/signing.test.ts"]);
    const template = /\$\{\s*[\w.]+(?:\(\))?\s*\}\\n\$\{/;
    const joined = /\.join\(\s*["'`]\\n["'`]\s*\)/;
    const offenders = sourceFiles(["apps", "packages", "tests"])
      .filter((f) => !exempt.has(f.path))
      .filter(
        (f) =>
          (template.test(f.text) || joined.test(f.text)) &&
          /X-Terminal-Signature|SYNC_SIGNATURE_HEADER|terminal[\w ]*signature/i.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
    // And the one file the scan exempts really is the definition.
    expect(
      sourceFiles(["apps", "packages"])
        .filter((f) => /export function canonicalSyncRequest\b/.test(f.text))
        .map((f) => f.path),
    ).toEqual(["packages/sync/src/signing.ts"]);
  });

  it("signSyncHeaders signs the canonical string with a 64-byte Ed25519 signature in base64", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const at = new Date(0);
    const headers = signSyncHeaders(
      { method: "post", path: "/v1/sync/tickets", body: { a: 1 }, terminalId: "t", at },
      (message) => new Uint8Array(sign(null, message, privateKey)),
    );
    const signature = Buffer.from(headers[SYNC_SIGNATURE_HEADER]!, "base64");
    expect(signature).toHaveLength(64);
    expect(headers[SYNC_SIGNATURE_HEADER]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(headers[SYNC_TIMESTAMP_HEADER]).toBe(at.toISOString());
    const canonical = canonicalSyncRequest({
      method: "POST",
      path: "/v1/sync/tickets",
      timestamp: at.toISOString(),
      body: sha256Hex(JSON.stringify({ a: 1 })),
    });
    const key = createPublicKey(publicKey.export({ format: "pem", type: "spki" }));
    expect(verify(null, Buffer.from(canonical), key, signature)).toBe(true);
  });
});
