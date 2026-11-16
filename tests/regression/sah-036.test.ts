import { describe, expect, it } from "vitest";
import { isCommentLine, rule as noSqlConcat } from "../../scripts/lint/rules/no-sql-concat";
import { fullRegression, problemOf } from "../support/api";
import { sourceFiles } from "../support/source";

describe("SAH-036 Six procedures accept a raw SQL predicate as a parameter — 0B (source)", () => {
  it("no shipped source builds SQL by concatenation or hands `.unsafe` a non-literal (acceptance test 27)", () => {
    const violations = noSqlConcat.run(sourceFiles());
    expect(violations.map((v) => `${v.file}:${v.line} ${v.detail}`)).toEqual([]);
  });

  it("`sql.unsafe` appears only in the homes contracts §3.3 allows, plus Plan 0A's roles.sql loader", () => {
    // This case greps `f.text` directly instead of going through the rule, so it needs two narrowings the
    // FIRST case does not. (a) `sourceFiles(["apps", "packages"])`, NOT the default
    // `["apps", "packages", "scripts"]`: `no-sql-concat` opens with
    // `if (!/^(apps|packages)\//.test(f.path)) continue;`, so those two roots are the tree the rule polices and
    // the only tree the "where does `.unsafe(` live" question is about — and under the default root list
    // `scripts/lint/rules/no-sql-concat.ts` is itself reported, because it names `.unsafe(` in its own violation
    // message and in its allow-list comments. The file that DEFINES the check is not a caller of it.
    // (b) `.test.tsx?$` is excluded: `scripts/lint/lint.test.ts` carries `await tx.unsafe("select * from " +
    // table)` as a FIXTURE, and `packages/db/test/roles.test.ts` (plan0A:553) is a real but allow-listed caller.
    const callers = sourceFiles(["apps", "packages"])
      // (c) whole-line comments are stripped before the grep. This case asks WHERE `.unsafe(` LIVES, and
      // the file's own prose already draws that line — "The file that DEFINES the check is not a caller of
      // it." A comment that names `.unsafe(` in order to say it is deliberately NOT used is the same case:
      // `apps/api/src/routes/accounting/parties.ts:66` reads "no `tx.unsafe(COLUMNS)`: contracts §3.3 gives
      // `sql.unsafe` exactly three homes and none of them is in this file" — the opposite of a violation.
      // The predicate is the rule's own `isCommentLine`, imported rather than re-spelled, so this case and
      // the FIRST case cannot disagree about what a comment is. Code before a trailing `//` is still scanned.
      .filter(
        (f) =>
          !/\.test\.tsx?$/.test(f.path) &&
          f.text
            .split("\n")
            .filter((line) => !isCommentLine(line))
            .some((line) => /\.unsafe\(/.test(line)),
      )
      .map((f) => f.path)
      .toSorted();
    // A SUBSET check, for two reasons. packages/importer/src/reader.ts is 9A's and does not exist yet. And the
    // fourth entry is Plan 0A's `packages/db/test/harness.ts`, which applies `packages/db/roles.sql` with
    // `admin.unsafe(readFileSync(ROLES_SQL, "utf8"))` (plan0A:476) — a checked-in .sql file read from disk, the
    // same case as migrate.ts — and which survives the `.test.tsx?$` filter above because it is not a test file.
    // `packages/db/test/roles.test.ts` makes the identical call (plan0A:553) and the filter removes it. Both are
    // on `no-sql-concat`'s UNSAFE_ALLOW (Task 12), and this list must agree with that one or the two checks
    // contradict each other. Contracts §3.3's "exactly three places" predates Plan 0A's harness and is owed the
    // amendment. Plan 0A is immovable, so the allow-lists move, not the harness.
    for (const c of callers) {
      expect([
        "packages/db/src/migrate.ts",
        "packages/db/src/jobs/enqueue.ts",
        "packages/importer/src/reader.ts",
        "packages/db/test/harness.ts",
      ]).toContain(c);
    }
  });
});

fullRegression("SAH-036", "Six procedures accept a raw SQL predicate as a parameter", {
  "no endpoint accepts a predicate: an undeclared filter key is stripped, never spliced": async ({
    api,
    a,
    expect: assertion,
  }) => {
    const res = await api.request({
      method: "GET",
      as: a.human,
      path: `/v1/admin/audit-log?limit=5&where=${encodeURIComponent("1=1 or tenant_id is not null")}&filter=${encodeURIComponent("true")}`,
    });
    assertion(res.status).toBe(200);
    const body = (await res.json()) as { items: { tableName: string }[] };
    assertion(Array.isArray(body.items)).toBe(true);
  },

  "a declared filter is a parameter: SQL metacharacters in it match nothing and destroy nothing":
    async ({ api, a, expect: assertion }) => {
      const res = await api.request({
        method: "GET",
        as: a.human,
        path: `/v1/admin/audit-log?tableName=${encodeURIComponent("company'; drop table app.company; --")}`,
      });
      assertion(res.status).toBe(200);
      assertion(((await res.json()) as { items: unknown[] }).items).toEqual([]);
      const [still] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'app' and table_name = 'company'`;
      assertion(still!.n).toBe(1);
    },

  "a value outside the declared enum is a validation problem, and no name reaches SQL": async ({
    api,
    a,
    expect: assertion,
  }) => {
    const res = await api.request({
      method: "GET",
      path: "/v1/admin/audit-log?action=drop",
      as: a.human,
    });
    assertion(res.status).toBe(400);
    assertion((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  },
});
