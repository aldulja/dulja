import { describe, expect, it } from "vitest";
import { ObjectKeyError, objectKeyFor } from "@dulja/db";
import { sourceFiles } from "../support/source";

describe("SAH-038 Path traversal to arbitrary file write on the database server — 2C", () => {
  it("the only key derivation takes two uuids and refuses everything else", () => {
    const tenant = "01927f3a-0000-7000-8000-000000000001";
    // the exact payload of spec:545 — `..\..\..\Windows\Temp\evil.dll`
    expect(() => objectKeyFor(tenant, "..\\..\\..\\Windows\\Temp\\evil.dll")).toThrow(
      ObjectKeyError,
    );
    expect(() => objectKeyFor("..\\..\\..\\Windows\\Temp", tenant)).toThrow(ObjectKeyError);
  });

  it("no source file outside object-store.ts composes an object key", () => {
    const offenders = sourceFiles(["apps", "packages"])
      .filter((f) => !f.path.endsWith("packages/db/src/attachment/object-store.ts"))
      .flatMap((f) =>
        f.lines
          .map((line, i) => ({ line, n: i + 1, path: f.path }))
          .filter(({ line }) =>
            /object_?[Kk]ey\s*[:=]\s*(`|['"]).*\$\{|object_?[Kk]ey\s*[:=].*\+/.test(line),
          ),
      );
    expect(offenders.map((o) => `${o.path}:${o.n}`)).toEqual([]);
  });

  it("no source file passes a request-supplied name into a filesystem path", () => {
    const offenders = sourceFiles(["apps", "packages"]).flatMap((f) =>
      f.lines
        .map((line, i) => ({ line, n: i + 1, path: f.path }))
        .filter(({ line }) =>
          /\b(join|resolve)\([^)]*\b(fileName|filename|file_name|req\.|body\.)/.test(line),
        ),
    );
    expect(offenders.map((o) => `${o.path}:${o.n}`)).toEqual([]);
  });
});
