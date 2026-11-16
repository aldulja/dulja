import type { LintRule, LintViolation, SourceFile } from "../types";

const ALLOW = [
  // calls the two SECURITY DEFINER doors that run before a tenant is known — app.resolve_principal for a
  // terminal and app.resolve_enrolment for a one-time code — exactly as with-tenant.ts does
  "packages/db/src/sync/identity.ts",
  "apps/api/src/routes/accounting/einvoice-transmissions.ts",
  "packages/db/src/migrate.ts",
  "packages/db/src/with-tenant.ts",
  "packages/db/src/client.ts",
  "packages/db/src/jobs/enqueue.ts",
  "packages/db/src/jobs/tenants.ts",
  "packages/db/src/lint-schema.ts",
];
const ALLOW_DIR = [/^packages\/db\/test\//, /^apps\/[a-z-]+\/test\//, /^scripts\/lint\//];

/**
 * Kept as defaults because a file that *receives* a handle — `seed(sql, …)`, `up(db, …)` — binds nothing for the
 * scan below to learn from. They are also the conventional names, which is why the rule once had only these two.
 */
const DEFAULT_HANDLES = ["db", "sql"];

/**
 * Hard-coding those two names enforced the invariant by spelling: `const pool = createDb(url)` and the rule fell
 * silent on every query the file then ran. A pool comes from `createDb` (packages/db/src/client.ts) or from the
 * driver it wraps — `packages/db/src/cli.ts` calls `postgres()` straight, so `createDb` is not the sole door — so
 * whatever a file binds one of those to is a bare handle under another name, judged by the rest of this rule
 * unchanged. A bare assignment counts as well as a declaration: `let migrator; … migrator = createDb(…)` is the
 * shape packages/db/test's seed suites use, and the annotation in `const pool: Sql = …` must not hide it either.
 * The scan reads the whole file, comments and string literals included, deliberately: a name learned from prose
 * can only add a violation, never hide one, and it covers the case a handle arrives as a parameter the file never
 * binds — `sp: Sql` in apps/api/src/middleware/idempotency.ts is the only such name in the tree, and it is a
 * savepoint from a transaction, not a pool. Learning from the annotation alone is not open to us: withTenant types
 * its own `tx` as `Sql` too, so that rule would flag the one handle this one exists to require.
 */
const BINDING =
  /(?:^|[^.\w])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*(?:createDb|postgres)\s*\(/g;

/**
 * `end()` closes the pool rather than querying through it, and packages/db/src/cli.ts has to call it. Keyed on the
 * method, never on the file, so it cannot be widened into a path exemption the way no-sql-concat's UNSAFE_ALLOW
 * was. The refusal is spliced into the member pattern rather than tested on the match afterwards because `exec`
 * reports only a line's FIRST member call: post-hoc, `await db.end(); await db.query(x)` would have bought silence
 * for the query standing beside the exempt call, which is the shape of hole this rule exists to close. `\b` keeps
 * it the method and not a prefix of one, so `db.endpoint()` is still a violation.
 */
const LIFECYCLE = ["end"];
const NOT_LIFECYCLE = `(?!(?:${LIFECYCLE.join("|")})\\b)`;

function handlesIn(file: SourceFile): string[] {
  const names = new Set(DEFAULT_HANDLES);
  BINDING.lastIndex = 0;
  for (let match = BINDING.exec(file.text); match !== null; match = BINDING.exec(file.text))
    if (match[1]) names.add(match[1]);
  return [...names];
}

export const rule: LintRule = {
  name: "no-bare-db",
  run(files) {
    const violations: LintViolation[] = [];
    for (const file of files) {
      if (!/^(apps|packages)\//.test(file.path)) continue;
      if (ALLOW.includes(file.path) || ALLOW_DIR.some((directory) => directory.test(file.path)))
        continue;
      if (/^packages\/[a-z-]+\/(?!src\/)/.test(file.path)) continue;
      // `$` is legal in an identifier and an anchor in a pattern, so a handle named with one is escaped rather
      // than left silently unmatchable — the same hole this rule exists to close, by a different route.
      const names = handlesIn(file)
        .map((name) => name.replaceAll("$", "\\$"))
        .join("|");
      const tagged = new RegExp("(^|[^.\\w])(" + names + ")(?:<[^`]*>)?`");
      const member = new RegExp(
        "(^|[^.\\w])(" + names + ")\\." + NOT_LIFECYCLE + "\\w+(?:<[^`]*>)?\\s*[(`]",
      );
      file.lines.forEach((line, index) => {
        // Prose never reaches a database, and this repository quotes identifiers in backticks in nearly every
        // comment — `pool` in a sentence is a markdown span, not a tag. The exposure was latent while the names
        // were a fixed pair nobody wrote about; learning them makes any identifier a candidate. no-sql-concat
        // skips whole-line comments for the same reason, and this adds the `/**` opener its matcher lets through.
        // A block comment counts only when it closes at the end of the line or not at all: `/* … */ await db`…``
        // leaves executable code behind it, and skipping that line would be the very silence this rule prevents.
        // `\s*` sits outside the optional `*/` because `.` matches no carriage return: with it inside, an unclosed
        // `/* …` on a CRLF checkout ends in a character the pattern cannot reach past and is scanned there alone.
        if (/^\s*(\/\/|\*|\/\*(?:(?!\*\/).)*(?:\*\/)?\s*$)/.test(line)) return;
        const tag = tagged.exec(line);
        const call = member.exec(line);
        if (tag)
          violations.push({
            file: file.path,
            line: index + 1,
            rule: this.name,
            detail: `SQL tagged by \`${tag[2]}\`; only a \`tx\` from withTenant may tag SQL`,
          });
        else if (call)
          violations.push({
            file: file.path,
            line: index + 1,
            rule: this.name,
            detail: `a method called on \`${call[2]}\`; open a transaction with withTenant instead`,
          });
      });
    }
    return violations;
  },
};
