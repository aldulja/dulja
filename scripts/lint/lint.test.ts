import { describe, expect, it } from "vitest";
import type { SourceFile } from "./types";
import { rule as dependencyRule } from "./rules/dependency-rule";
import { rule as errorCodes } from "./rules/error-codes";
import { rule as forbiddenLogFields } from "./rules/forbidden-log-fields";
import { rule as noBareDb } from "./rules/no-bare-db";
import { rule as noNumberMoney } from "./rules/no-number-money";
import { rule as noSqlConcat, staleAllowEntries, UNSAFE_ALLOW } from "./rules/no-sql-concat";

const file = (path: string, text: string): SourceFile => ({ path, text, lines: text.split("\n") });
const payrollUnraised = (files: SourceFile[]) =>
  errorCodes
    .run(files)
    .map((violation) => violation.detail)
    .filter((detail) => detail.startsWith("ERR_PAYROLL_INPUT_MISSING "));

describe("scripts/lint — acceptance test 27", () => {
  it("no-bare-db rejects SQL tags and database methods outside the narrow allow-list", () => {
    const bad = file(
      "apps/api/src/routes/x.ts",
      "const rows = await db`select 1`;\nawait sql`select 2`;\nawait db.begin(fn);\n" +
        "const typed = await sql<{ n: number }[]>`select 3`;\nconst m = await db.admin<{ n: number }[]>`select 4`;",
    );
    expect(noBareDb.run([bad]).map((violation) => violation.line)).toEqual([1, 2, 3, 4, 5]);
    expect(noBareDb.run([file("apps/api/src/routes/y.ts", "await tx`select 1`;")])).toEqual([]);
    expect(
      noBareDb.run([file("apps/api/src/routes/y2.ts", "await tx<{ n: number }[]>`select 1`;")]),
    ).toEqual([]);
    expect(noBareDb.run([file("packages/db/src/with-tenant.ts", "await sql`select 1`;")])).toEqual(
      [],
    );
    expect(
      noBareDb.run([
        file(
          "packages/db/src/lint-schema.ts",
          "await sql<TableRow[]>`select relname from pg_class`;",
        ),
      ]),
    ).toEqual([]);
    expect(noBareDb.run([file("apps/api/test/support/app.ts", "createApp({ db: rw });")])).toEqual(
      [],
    );
  });

  it("no-bare-db learns a handle's name instead of trusting its spelling", () => {
    // The rule knew `db` and `sql` and nothing else, so `const pool = createDb(url)` bought silence for every
    // query the file then ran: the invariant was enforced by spelling. A pool only comes from `createDb` or the
    // driver beneath it, so whatever a file binds one of those to is the handle, whatever it has been called.
    const lines = (path: string, text: string): number[] =>
      noBareDb.run([file(path, text)]).map((violation) => violation.line);

    expect(
      lines(
        "apps/api/src/routes/x.ts",
        "const pool = createDb(url);\nawait pool`select 1`;\nawait pool.begin(fn);",
      ),
    ).toEqual([2, 3]);
    // The message names the handle it matched, because "`db` or `sql`" stopped being the whole list.
    expect(
      noBareDb
        .run([
          file("apps/api/src/routes/x.ts", "const pool = createDb(url);\nawait pool`select 1`;"),
        ])
        .map((violation) => violation.detail),
    ).toEqual(["SQL tagged by `pool`; only a `tx` from withTenant may tag SQL"]);
    // `let migrator; … migrator = createDb(…)` is the shape packages/db/test's seed suites use, and an
    // annotation is the shape most of the tree uses; a scan that only understood `const x = y` would miss both.
    expect(
      lines(
        "packages/db/src/seed/x.ts",
        "let migrator;\nmigrator = createDb(u);\n" +
          "const r = await migrator<{ id: string }[]>`select 1`;",
      ),
    ).toEqual([3]);
    expect(
      lines("apps/api/src/routes/x2.ts", "const pool: Sql = createDb(url);\nawait pool`select 1`;"),
    ).toEqual([2]);
    // packages/db/src/cli.ts builds its pool by calling `postgres()` itself, so `createDb` is not the only door.
    expect(
      lines(
        "packages/db/src/x3.ts",
        "const handle = postgres(url, { max: 1 });\nawait handle`select 1`;",
      ),
    ).toEqual([2]);
    // A longer name starting with a known one escaped: the old pair only matched when a backtick came next.
    expect(
      lines("apps/api/src/routes/w.ts", "const dbPool = createDb(url);\nawait dbPool`select 1`;"),
    ).toEqual([2]);

    // The member half read `db.` alone, so the same bare pool under the other conventional name was invisible.
    expect(lines("apps/api/src/routes/x5.ts", "await sql.begin(fn);")).toEqual([1]);
    // `end()` closes the pool rather than querying through it, and packages/db/src/cli.ts has to call it. The
    // carve-out is on the method, not on the file, so it cannot be widened into an exemption for a whole path.
    expect(lines("packages/db/src/x6.ts", "await sql.end();")).toEqual([]);
    expect(lines("apps/api/src/routes/x7.ts", "await db.end();")).toEqual([]);
    // The exemption must not cover what stands beside it: a line is matched once, so testing the exempt name
    // after the fact let the FIRST call on the line answer for the rest. The pattern refuses `end` and scans on.
    expect(lines("apps/api/src/routes/x8.ts", "await db.end(); await db.query(x);")).toEqual([1]);
    // And it refuses the method, not a prefix of one: `\b` is what keeps `endpoint` a violation.
    expect(lines("packages/db/src/x9.ts", "await sql.endpoint();")).toEqual([1]);

    // Still a deny-list of bare handles, not an allow-list of the name `tx`. Inverting it would have flagged
    // `transaction`, which is what packages/db/src/migrate.ts and packages/db/test call that very value.
    expect(
      lines(
        "apps/api/src/routes/y.ts",
        "const pool = createDb(u);\nawait withTenant(pool, t, a, async (tx) => tx`select 1`);",
      ),
    ).toEqual([]);
    expect(
      lines("packages/db/src/y2.ts", "await transaction`delete from app_meta.schema_migration`;"),
    ).toEqual([]);

    // Learning the names widened an exposure the fixed pair already had: this repository quotes identifiers in
    // backticks in nearly every comment, and a markdown span is prose, which reaches no database.
    expect(
      lines(
        "apps/api/src/routes/z.ts",
        "// `db` is the pool; the shutdown hook closes it.\n" +
          " * `sql` in a continuation line.\n" +
          "/** `db` in a JSDoc opener. */\n" +
          "/* opened here and closed further down, still about `db`",
      ),
    ).toEqual([]);
    // A block comment that closes and leaves code behind it is not prose, and skipping that line would be the
    // silence this rule exists to prevent — the skip is narrower than "the line begins with a comment".
    expect(lines("apps/api/src/routes/z2.ts", "/* set up */ await db`select 1`;")).toEqual([1]);

    // ALLOW and ALLOW_DIR cover a learned handle as they cover `db`, and the scan stays per-file: a pool handed
    // in under a third name, bound nowhere in the file that uses it, is still missed. That is the fix's edge.
    expect(
      lines("packages/db/src/with-tenant.ts", "const pool = createDb(u);\nawait pool`select 1`;"),
    ).toEqual([]);
    expect(
      lines("apps/api/test/support/app.ts", "const rw = createDb(u);\nawait rw`select 1`;"),
    ).toEqual([]);
    expect(lines("apps/api/src/routes/v.ts", "await pool`select 1`;")).toEqual([]);
  });

  it("no-sql-concat rejects non-literal unsafe calls and untagged SQL construction", () => {
    const bad = file(
      "apps/api/src/routes/x.ts",
      'await tx.unsafe("select * from " + table);\n' +
        "const q = `select * from ${t} where id = ${id}`;\n" +
        'const byId = table + " where id = 1";\n' +
        'const insert = "insert into " + table;',
    );
    expect(noSqlConcat.run([bad]).map((violation) => violation.line)).toEqual([1, 2, 3, 4]);
    expect(
      noSqlConcat.run([file("packages/db/src/migrate.ts", "await tx.unsafe(fileContents);")]),
    ).toEqual([]);
    expect(
      noSqlConcat.run([
        file("packages/db/test/harness.ts", 'await admin.unsafe(readFileSync(ROLES_SQL, "utf8"));'),
      ]),
    ).toEqual([]);
    expect(
      noSqlConcat
        .run([file("apps/api/src/routes/x2.ts", 'await tx.unsafe(readFileSync(path, "utf8"));')])
        .map((violation) => violation.line),
    ).toEqual([1]);
    expect(
      noSqlConcat.run([
        file(
          "apps/api/src/routes/y.ts",
          "const [row] = await tx<{ ok: boolean }[]>`select app.actor_has(${code}, ${companyId}) as ok`;",
        ),
      ]),
    ).toEqual([]);
    expect(
      noSqlConcat.run([
        file(
          "apps/api/test/routes/y.test.ts",
          "const [n] = await api.db.admin<{ n: number }[]>`select count(*)::int as n from app.company where id = ${id}`;",
        ),
      ]),
    ).toEqual([]);
    expect(
      noSqlConcat.run([
        file(
          "apps/api/test/routes/z.test.ts",
          "await tx`insert into app.role (id, code) values (${roleId}, ${`r-${code}`})`;",
        ),
      ]),
    ).toEqual([]);
  });

  it("no-sql-concat reads code, not prose and not query strings", () => {
    // Both shapes are in this tree today. The comment above the dimension-value join quotes the predicate that
    // join replaced, and the test proving the gate quotes the route's own URL; neither can reach a database,
    // but each is an untagged template with a substitution and a SQL word, which is all the line matcher saw.
    expect(
      noSqlConcat.run([
        file(
          "apps/api/src/routes/admin/dimension-types.ts",
          "      // The join is the gate's other half: `where id = ${valueId}` alone let a caller cleared for\n" +
            "       * one company rename or archive any value in the tenant.",
        ),
      ]),
    ).toEqual([]);
    expect(
      noSqlConcat.run([
        file(
          "apps/api/test/routes/admin.test.ts",
          "      `/v1/companies/${seed.company}/exchange-rates/lookup?from=MYR&to=MYR&on=2026-01-15`,",
        ),
      ]),
    ).toEqual([]);
    // The narrowing is exactly two characters wide: drop the `//` and the `=` and both lines fail again.
    expect(
      noSqlConcat
        .run([
          file(
            "apps/api/src/routes/x3.ts",
            "const q = `where id = ${valueId}`;\nconst u = `/lookup?from ${currency}`;",
          ),
        ])
        .map((violation) => violation.line),
    ).toEqual([1, 2]);
  });

  it("no-sql-concat rejects an UNSAFE_ALLOW entry that names no file", () => {
    // The list carried `packages/importer/src/reader.ts` through Phase 0, before that file existed: an exemption
    // granted to a file nobody had written yet, and so to whatever was written there one day. 9A T4 has since
    // written it, without `.unsafe(`, so the case uses a path that will never exist.
    const stale = staleAllowEntries(["packages/importer/src/no-such-reader.ts"]);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.file).toBe("scripts/lint/rules/no-sql-concat.ts");
    expect(stale[0]?.detail).toContain("packages/importer/src/no-such-reader.ts");
    expect(staleAllowEntries(UNSAFE_ALLOW)).toEqual([]);
    expect(UNSAFE_ALLOW).not.toContain("packages/importer/src/reader.ts");
  });

  it("no-number-money reads packages/db, where numeric(19,4) becomes TypeScript", () => {
    const money = noNumberMoney.run([
      file("packages/db/src/ledger/service.ts", "interface Row {\n  amount: number;\n}"),
    ]);
    expect(money.map((violation) => violation.line)).toEqual([2]);
    expect(
      noNumberMoney
        .run([file("packages/db/src/rates/rate-for.ts", "const rate: number = 1;")])
        .map((violation) => violation.line),
    ).toEqual([1]);
    // A migration version and a row count are counters, not money — the name test is what keeps them green.
    expect(noNumberMoney.run([file("packages/db/src/migrate.ts", "  version: number;")])).toEqual(
      [],
    );
    expect(
      noNumberMoney.run([file("packages/db/src/audit/verify-chain.ts", "  rows: number;")]),
    ).toEqual([]);
    // `sourceFiles` hands the rules SQL as well, and a `::` cast reaching a `number` column is a TypeScript
    // annotation only to a TypeScript scanner. The same text, one path apart, is the whole point of the exclusion.
    const sqlish = "select total::int as t where number = 1";
    expect(
      noNumberMoney.run([file("packages/db/src/x.ts", sqlish)]).map((violation) => violation.line),
    ).toEqual([1]);
    expect(
      noNumberMoney.run([file("packages/db/migrations/0001_foundations.sql", sqlish)]),
    ).toEqual([]);
    expect(
      noNumberMoney.run([file("packages/db/test/harness.ts", "const amount: number = 1;")]),
    ).toEqual([]);
  });

  it("no-number-money scans a postgres.js template as the parser does, and cannot hang", () => {
    const lines = (text: string): number[] =>
      noNumberMoney
        .run([file("packages/db/src/sync/identity.ts", text)])
        .map((violation) => violation.line);

    // The jsonb operator `#>>` after a `${…}` hung `bun run lint:rules` until it was OOM-killed (exit 137,
    // found repairing PR 12): `scan()` alone read the template's tail as code, and TypeScript 7's scanner
    // returns a `#` that no identifier follows without advancing. A regression hangs here, not fails.
    const jsonb = [
      "const plain = await tx`select x #>> '{a}' from t`;",
      "const rows = await tx<{ amount: string }[]>`",
      "  select v.value #>> '{}' as amount from app.custom_field_value v",
      "   where v.tenant_id = ${tenantId} and v.payload #>> '{price}' = ${price}",
      "     and v.payload #> '{a}' ? ${key} and v.id = any(${[...ids]})`;",
      "const nested = tx`select ${tx`x #>> '{${path}}'`} #>> '{b}', ${{ total: 1 }.total} #- '{c}'`;",
    ].join("\n");
    expect(lines(jsonb)).toEqual([]);
    // Template text after a substitution is text, so an annotation-shaped run of it is not one.
    expect(lines("const q = sql`select ${a} as total: number`;")).toEqual([]);
    // Code after such a template is code again: before the re-scan the scanner stayed out of phase until the
    // next backtick, and `costByLine` in packages/db/src/costing/apply-movements.ts went unread that way.
    expect(lines(`${jsonb}\nconst amount: number = 1;`)).toEqual([7]);
    // Whatever else the scanner may fail to advance over, the guard steps past it rather than looping.
    expect(lines("const a = b # c;\nconst rate: number = 1;")).toEqual([2]);

    // The rule's detections are unchanged: the same lines as before the re-scan, and the names it lets pass.
    const positive = [
      "interface Row {",
      "  amount: number;",
      "  total?: number;",
      '  "grossPay": number;',
      "  debit: string | number;",
      "  version: number;",
      "}",
      "const rate: number = 1;",
      "const prices: Array<number> = [];",
      "function taxFor(code: string): number {",
      "  return 0;",
      "}",
      "const pay = (netPay: number) => netPay;",
      "class Account {",
      "  credit!: number;",
      "  get balance(): number {",
      "    return 0;",
      "  }",
      "}",
      "function costByLine(plan: PostingPlan): Map<number, Money> {}",
    ].join("\n");
    expect(lines(positive)).toEqual([2, 3, 4, 5, 8, 9, 10, 13, 15, 16]);
  });

  it("dependency-rule enforces package tiers and resolved relative-path boundaries", () => {
    expect(
      dependencyRule.run([
        file("packages/domain/src/money/money.ts", 'import { x } from "@dulja/db";'),
      ]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([file("packages/domain/src/bootstrap.ts", 'import "@dulja/db";')]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([
        file("apps/api/src/app.ts", 'import { x } from "../../worker/src/handler";'),
      ]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([
        file(
          "packages/domain/src/posting/evaluate.ts",
          'import { x } from "../../payroll/calculator";',
        ),
      ]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([file("packages/db/src/client.ts", 'import { x } from "@dulja/domain";')]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file("packages/domain/payroll/calculator.ts", 'import { x } from "../src/money/money";'),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file(
          "apps/api/src/middleware/require-permission.ts",
          'import { PERMISSION } from "@dulja/contracts/permissions";',
        ),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file("apps/api/test/support/app.ts", 'import { startDb } from "@dulja/db/test";'),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file("packages/contracts/src/x.ts", 'import { y } from "@dulja/db/test";'),
      ]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([
        file(
          "packages/db/test/permission-catalogue.test.ts",
          'import { PERMISSIONS } from "@dulja/contracts/permissions";',
        ),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file(
          "packages/db/test/other.test.ts",
          'import { PERMISSIONS } from "@dulja/contracts/permissions";',
        ),
      ]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([
        file("apps/api/test/support/app.ts", 'import { createApp } from "../../src/app";'),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file("packages/contracts/src/admin/company.ts", 'import { z } from "../common";'),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file(
          "apps/api/test/routes/admin/x.test.ts",
          'import { grantAdmin } from "../../../../../tests/support/api";',
        ),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file(
          "apps/worker/test/jobs/y.test.ts",
          'import { postJournal } from "../../../../tests/invariants/support/post-journal";',
        ),
      ]),
    ).toEqual([]);
    expect(
      dependencyRule.run([
        file(
          "apps/api/src/routes/x.ts",
          'import { grantAdmin } from "../../../../tests/support/api";',
        ),
      ]),
    ).toHaveLength(1);
    expect(
      dependencyRule.run([
        file("apps/api/test/routes/z.test.ts", 'import { h } from "../../../worker/src/handler";'),
      ]),
    ).toHaveLength(1);
  });

  it("dependency-rule sees wrapped, dynamic and require imports, and ignores comments and strings", () => {
    // Every fixture above is a single-line import, which is how the line-anchored matcher this rule
    // used to carry went unnoticed: `} from "@dulja/db";` — the closing line oxfmt writes for any
    // named import too long for the 100-column print width, whatever its name count, so a routine
    // shape rather than an exotic one — matched nothing at all, and neither did `import(…)` or
    // `require(…)`. Both call sites had the hole: the `@dulja/*` tier check and the relative-escape
    // check that is `apps/desktop`'s only guard.
    const lines = (path: string, text: string): number[] =>
      dependencyRule.run([file(path, text)]).map((violation) => violation.line);

    // The reported line is the specifier's own, not the statement's first line.
    expect(
      lines("packages/domain/src/money/money.ts", 'import {\n  a,\n  b,\n} from "@dulja/db";'),
    ).toEqual([4]);
    expect(lines("packages/domain/src/index.ts", 'export {\n  a,\n} from "@dulja/db";')).toEqual([
      3,
    ]);
    expect(
      lines(
        "apps/desktop/src/main.ts",
        'import {\n  readEnv,\n} from "../../backoffice/src/lib/env";',
      ),
    ).toEqual([3]);
    expect(lines("apps/desktop/src/main.ts", 'const ui = await import("@dulja/ui");')).toEqual([1]);
    expect(lines("apps/desktop/src/main.ts", 'const ui = require("@dulja/ui");')).toEqual([1]);
    expect(
      lines("apps/desktop/src/main.ts", 'const env = require("../../backoffice/src/lib/env");'),
    ).toEqual([1]);
    expect(lines("packages/domain/src/x.ts", 'import type {\n  T,\n} from "@dulja/db";')).toEqual([
      3,
    ]);

    // A specifier a human wrote *about* is not a dependency. The scanner's own trivia skipping and the
    // "what token precedes this string" test are what rule these out — no comment stripping by hand.
    expect(
      lines(
        "packages/domain/src/notes.ts",
        '// import { a } from "@dulja/db";\n' +
          '/* } from "@dulja/db"; */\n' +
          '/** Re-exported by `export { a } from "@dulja/db"` in 0B. */\n' +
          'const specifier = "@dulja/db";\n' +
          "const other = `@dulja/db`;\n" +
          'const map = { from: "@dulja/db" };\n' +
          'const escape = { from: "../../db/src/client" };',
      ),
    ).toEqual([]);

    // A template literal earlier in the file must not swallow the rest of it: without
    // `reScanTemplateToken`, the backtick after a `${…}` substitution opens a fresh, unterminated
    // template that hides every token after it — including the very import forms this fix exists for.
    expect(
      lines(
        "apps/desktop/src/main.ts",
        'const label = `a ${b} c`;\nconst ui = await import("@dulja/ui");',
      ),
    ).toEqual([2]);
  });

  it("forbidden-log-fields rejects secret-shaped structured fields", () => {
    const bad = file(
      "apps/api/src/routes/x.ts",
      'logger.info({ authorization: header }, "request");\nlog.warn({ card_number: number }, "card");',
    );
    expect(forbiddenLogFields.run([bad]).map((violation) => violation.line)).toEqual([1, 2]);
    expect(
      forbiddenLogFields.run([
        file("apps/api/src/routes/y.ts", 'logger.info({ tenant_id: tenant }, "request");'),
      ]),
    ).toEqual([]);
  });

  it("error-codes excises only the registry literal and counts same-file raisers", () => {
    const withSites = [
      file(
        "packages/contracts/src/errors.ts",
        "export const ERRORS = {\n  ERR_NOT_FOUND: {}, ERR_INTERNAL: {}, ERR_RLS_DENIED: {},\n" +
          "} as const satisfies Record<string, ErrorDef>;\n" +
          'export function fromDatabaseError() { return new AppError("ERR_RLS_DENIED", "denied"); }',
      ),
      file("apps/api/src/x.ts", 'throw new AppError("ERR_NOT_FOUND", "missing");'),
    ];
    const missing = errorCodes.run(withSites).map((violation) => violation.detail);
    expect(missing.some((detail) => detail.includes("ERR_INTERNAL"))).toBe(true);
    expect(missing.some((detail) => detail.includes("ERR_NOT_FOUND"))).toBe(false);
    expect(missing.some((detail) => detail.includes("ERR_RLS_DENIED"))).toBe(false);
  });

  it("error-codes reads packages/domain/payroll, which sits outside src/ (contracts round 17, A16)", () => {
    const registry = file(
      "packages/contracts/src/errors.ts",
      "export const ERRORS = {\n  ERR_PAYROLL_INPUT_MISSING: {},\n} as const satisfies Record<string, ErrorDef>;",
    );
    const raiser = file(
      "packages/domain/payroll/calculator.ts",
      'throw new PayrollCalculationError("ERR_PAYROLL_INPUT_MISSING", "detail");',
    );
    expect(payrollUnraised([registry])).toHaveLength(1);
    expect(payrollUnraised([registry, raiser])).toEqual([]);
  });
});
