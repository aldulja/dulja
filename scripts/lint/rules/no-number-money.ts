import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import type { LintRule, LintViolation, SourceFile } from "../types";

const MONEYISH = /amount|price|cost|debit|credit|total|balance|rate|tax|net|gross/i;
// packages/db is where SQL numeric(19,4) becomes TypeScript — the one place in the tree the conversion
// physically happens — so a service there declaring `{ amount: number }` over a postgres.js row is exactly
// what SAH-008 forbids, and the rule was not reading it.
const IN_SCOPE = [
  /(^|\/)packages\/domain\//,
  /(^|\/)packages\/contracts\//,
  /(^|\/)packages\/db\//,
  /(^|\/)apps\//,
];
// `.sql` joins the list with packages/db: `scripts/lint/source.ts` collects SQL too, and a declared TypeScript
// annotation is the only thing this rule can find — a migration's `number bigint` column and a `::numeric` cast
// are SQL tokens the TypeScript scanner would only ever match by accident. Measured both ways over every SQL
// file in the tree: 0 hits with the exclusion and 0 without, so this buys precision, not silence. It buys
// no coverage of the SQL side, and nothing else does: `packages/db/src/lint-schema.ts` checks tenant_id, RLS,
// stamp/audit/immutable triggers and composite FKs — not column types — so no lint here asserts that a money
// column is numeric(19,4). That is a gap, not a division of labour.
const EXCLUDED = [/(^|\/)test(s)?\//, /(^|\/)__tests__\//, /\.test\.ts$/, /\.d\.ts$/, /\.sql$/];

/** Exceptions are reviewed individually. None are warranted in Phase 0D. */
export const ALLOWED: ReadonlySet<string> = new Set<string>([
  // `packages/db/src/costing/apply-movements.ts`'s `costByLine(plan): Map<number, Money>` — the `number` is
  // the source line number keying the map and every cost in it is `Money`. The rule never read it until
  // `tokensFor` stopped scanning a substitution template's tail as code; it was the one hit that surfaced.
  "costByLine",
  // 8B (contracts round 17, A14). §4.12.1 freezes `SchemeResult.rateTableVersion: number` — a rate TABLE's version
  // number, an integer identity and never a monetary value. MONEYISH matches it on the substring "rate", and the
  // name is consumed by 8C and 8D, so renaming is not open. It is the only entry 8B adds.
  "rateTableVersion",
]);

interface Token {
  kind: SyntaxKind;
  value: string;
  start: number;
}

function inScope(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    IN_SCOPE.some((pattern) => pattern.test(normalized)) &&
    !EXCLUDED.some((pattern) => pattern.test(normalized))
  );
}

// A bare `scan()` reads the text after a substitution's `}` as code; the parser re-scans that `}` as template
// text, and so does this. Reading it as code also hung: TypeScript 7's scanner returns a `#` that no identifier
// follows as a zero-width token without advancing, so `${id} #>> '{a}'` in a postgres.js template never reached
// EndOfFile and `lint:rules` was OOM-killed (exit 137). The progress guard makes any other such token a skip
// over one character instead of a hang.
function tokensFor(text: string): Token[] {
  const scanner = createScanner(true, undefined, text);
  const tokens: Token[] = [];
  // Brace depth inside each open `${…}`, innermost last; a `}` at depth 0 closes the substitution.
  const substitutions: number[] = [];
  let end = 0;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    const depth = substitutions.length - 1;
    if (kind === SyntaxKind.CloseBraceToken && substitutions[depth] === 0) {
      kind = scanner.reScanTemplateToken(true);
      if (kind === SyntaxKind.TemplateTail) substitutions.pop();
    } else if (kind === SyntaxKind.TemplateHead) substitutions.push(0);
    else if (kind === SyntaxKind.OpenBraceToken && depth >= 0) substitutions[depth]! += 1;
    else if (kind === SyntaxKind.CloseBraceToken && depth >= 0) substitutions[depth]! -= 1;
    tokens.push({
      kind,
      value: scanner.getTokenValue(),
      start: scanner.getTokenStart(),
    });
    if (scanner.getTokenEnd() <= end) scanner.resetTokenState(end + 1);
    end = scanner.getTokenEnd();
  }
  return tokens;
}

function isName(token: Token | undefined): token is Token {
  return token?.kind === SyntaxKind.Identifier || token?.kind === SyntaxKind.StringLiteral;
}

function annotationContainsNumber(tokens: readonly Token[], start: number): boolean {
  let nesting = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index]!.kind;
    if (kind === SyntaxKind.NumberKeyword) return true;
    if (
      [SyntaxKind.OpenParenToken, SyntaxKind.OpenBracketToken, SyntaxKind.LessThanToken].includes(
        kind,
      )
    )
      nesting += 1;
    if (
      [
        SyntaxKind.CloseParenToken,
        SyntaxKind.CloseBracketToken,
        SyntaxKind.GreaterThanToken,
      ].includes(kind)
    ) {
      if (nesting === 0) return false;
      nesting -= 1;
    }
    if (
      nesting === 0 &&
      [
        SyntaxKind.SemicolonToken,
        SyntaxKind.CommaToken,
        SyntaxKind.EqualsToken,
        SyntaxKind.OpenBraceToken,
      ].includes(kind)
    )
      return false;
  }
  return false;
}

function nameBeforeColon(tokens: readonly Token[], colon: number): Token | undefined {
  let index = colon - 1;
  while (
    [SyntaxKind.QuestionToken, SyntaxKind.ExclamationToken].includes(
      tokens[index]?.kind ?? SyntaxKind.Unknown,
    )
  )
    index -= 1;
  if (isName(tokens[index])) return tokens[index];
  if (tokens[index]?.kind !== SyntaxKind.CloseParenToken) return undefined;

  let depth = 0;
  for (; index >= 0; index -= 1) {
    const kind = tokens[index]!.kind;
    if (kind === SyntaxKind.CloseParenToken) depth += 1;
    if (kind === SyntaxKind.OpenParenToken && --depth === 0)
      return isName(tokens[index - 1]) ? tokens[index - 1] : undefined;
  }
  return undefined;
}

function violationsFor(file: SourceFile): LintViolation[] {
  if (!inScope(file.path)) return [];
  return tokensFor(file.text).flatMap((token, index, tokens) => {
    if (token.kind !== SyntaxKind.ColonToken || !annotationContainsNumber(tokens, index + 1))
      return [];
    const name = nameBeforeColon(tokens, index);
    if (!name || !MONEYISH.test(name.value) || ALLOWED.has(name.value)) return [];
    return [
      {
        file: file.path,
        line: file.text.slice(0, name.start).split("\n").length,
        rule: "no-number-money",
        detail: `'${name.value}' is typed number — a monetary or rate value must be Money, Quantity, Decimal or string (spec §3.9, SAH-008)`,
      },
    ];
  });
}

/** Source-token-only enforcement of spec §3.9 / SAH-008 declared monetary number annotations. */
export const rule: LintRule = {
  name: "no-number-money",
  run(files: SourceFile[]): LintViolation[] {
    return files.flatMap(violationsFor);
  },
};
