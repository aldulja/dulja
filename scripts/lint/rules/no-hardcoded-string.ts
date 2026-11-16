import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import type { LintRule, LintViolation, SourceFile } from "../types"; // 0B's scripts/lint/types.ts

/**
 * DoD 0.12's second clause — "a hard-coded string fails CI" — enforced over the two UI trees named
 * in spec:2061. A literal that reaches JSX text, a human-facing attribute, or a JSX child expression
 * without going through `t("<key>")` is flagged; an `// i18n-exempt: <reason>` comment on the same or
 * preceding line waives a specific, reviewed exception (a brand name, a "·" separator, and so on).
 *
 * This package ships TypeScript 7's native-preview compiler, whose `typescript` entry point is a
 * version stub only — there is no `ts.createSourceFile`/`ts.isJsxText` AST here (see
 * `no-number-money.ts`, which hit the same wall and settled on the token scanner exposed at
 * `typescript/unstable/ast`). Re-confirmed exhaustively (grepped every `.d.ts` this package ships,
 * not just its `exports` map) that no local, synchronous, in-memory parse entry point exists anywhere
 * in it: the only other "parse" surface is `parseNodeHandle` (decodes an internal node-handle string,
 * not source) and the remote client/server API's `parseConfigFile`/`Program.getSourceFile`, under
 * `typescript/unstable/{sync,async}`. That API's own types say what it costs: `ClientSpawnOptions`
 * defaults `tsserverPath` to "the bundled tsgo binary" and talks to it over a spawned process's Unix
 * socket or Windows named pipe (see `dist/api/options.d.ts`, `dist/api/sync/client.d.ts`) — a real
 * parse tree is reachable only by spawning that native binary and driving a JSON-RPC-style protocol
 * to it, and even then only for files a configured `Project` can resolve, not an arbitrary in-memory
 * `{ path, text }` pair the way every fixture in this rule's own test suite is built. So this rule
 * drives the same low-level `Scanner` the real parser drives, calling its JSX-mode and template-mode
 * entry points (`scanJsxToken`, `reScanTemplateToken`, by way of `LanguageVariant.JSX`) at the same
 * points the parser would. That makes it safe against raw JSX text containing apostrophes/quotes
 * ("don't", "it's") that would otherwise be misread as unterminated string literals by a plain,
 * non-JSX-aware token scan, and against a template literal's `${…}` being misread as swallowing the
 * rest of the file (see `skipTemplateLiteral` below) — both cases a real parser would get right by
 * construction, and both cases this scanner-driven approach has to get right by hand instead.
 */

/** The trees a user-facing string may only reach through i18next (spec:2061). */
const UI_TREES = ["packages/ui/src/", "apps/backoffice/src/", "apps/pos/src/renderer/"];
/** Files where a literal is legitimate: stories are documentation, tests are fixtures. */
const IGNORED = /(\.stories\.tsx|\.test\.tsx|\.test\.ts|\.d\.ts)$/;
/** Attributes a human reads. `id`, `className`, `name`, `type`, `role` are not on this list. */
const HUMAN_ATTRIBUTES = new Set([
  "title",
  "placeholder",
  "label",
  "alt",
  "aria-label",
  "aria-description",
  "aria-placeholder",
]);
/**
 * Two or more Latin letters, or two or more Arabic letters, in a row: prose that spec:2061 requires
 * go through i18next — this includes short words like "OK", which genuinely is user-facing text, not
 * an exemption. "·", "—" and "42" pass because punctuation and digits never match; a lone letter
 * doesn't either, since the count requires two. The Arabic range is the letter block U+0621–064A
 * (ء–ي) specifically, not the wider U+0600–06FF Arabic block, which also holds the Arabic-Indic
 * digits (٠–٩) and Arabic punctuation (،  ؟) — those must pass exactly like their Latin counterparts.
 */
const PROSE = /[A-Za-zء-ي]{2,}/;
const EXEMPT_COMMENT = "i18n-exempt";

const inScope = (path: string): boolean =>
  UI_TREES.some((tree) => path.startsWith(tree)) && !IGNORED.test(path) && path.endsWith(".tsx");

/**
 * Tokens after which a `<` is a comparison or a generic type argument (`useState<T>()`, `a < b`),
 * never the start of JSX — i.e. the token stream was in "value" position, not "expression start"
 * position. Everything else (an operator, a keyword, `(`, `,`, `=>`, `return`, start of file, …)
 * defaults to "this `<` may open JSX", which is what a real parser would do from grammar context.
 */
const VALUE_END = new Set<number>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.StringLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.ThisKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);
const looksLikeJsxStart = (previous: number | undefined): boolean =>
  previous === undefined || !VALUE_END.has(previous);

/** Tokens after which a `type` keyword is a fresh statement, not a property/variable named "type"
 *  (`foo.type`, `const type = …`) — `type` is a contextual keyword, so the scanner always reports it
 *  as `TypeKeyword` regardless of grammatical position, and this is how a token-only scan tells them
 *  apart. */
const STATEMENT_START = new Set<number>([
  SyntaxKind.SemicolonToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.ExportKeyword,
  SyntaxKind.DeclareKeyword,
]);

function violationsFor(file: SourceFile): LintViolation[] {
  if (!inScope(file.path)) return [];
  const violations: LintViolation[] = [];
  const scanner = createScanner(true, LanguageVariant.JSX, file.text);

  const lineIndexAt = (offset: number): number =>
    file.text.slice(0, offset).split(/\r?\n/).length - 1;

  const report = (offset: number, detail: string): void => {
    const lineIndex = lineIndexAt(offset);
    // An `// i18n-exempt: <reason>` comment on this line or the one above waives the rule.
    if (
      (file.lines[lineIndex] ?? "").includes(EXEMPT_COMMENT) ||
      (file.lines[lineIndex - 1] ?? "").includes(EXEMPT_COMMENT)
    )
      return;
    violations.push({ file: file.path, line: lineIndex + 1, rule: "no-hardcoded-string", detail });
  };

  // `kind` is only ever mutated by `advance`/`advanceChildren`, both defined right beside it. Every
  // other read below goes through `tok()`, a plain function call, so TypeScript never narrows it to
  // a stale literal across the `while`/`switch` bodies that call those closures in between checks —
  // a `let` read directly in that position would narrow, and then contradict itself once the loop
  // ran the advance closure and looped back to re-test the same (now-stale) narrowed condition.
  let kind: number = scanner.scan();
  const tok = (): number => kind;
  const advance = (): void => {
    kind = scanner.scan();
  };
  const advanceChildren = (): void => {
    kind = scanner.scanJsxToken();
  };

  /**
   * Consumes an entire template literal — `` `plain text` `` (one self-contained token, needing no
   * help) or, once there is at least one `${…}` substitution, `TemplateHead` … `TemplateMiddle`* …
   * `TemplateTail` — starting at whichever of those is the current token. This is not optional: after
   * a substitution's own `}`, the raw scanner position sits on the *literal* template text that
   * continues past it, and plain `scan()` reads that as ordinary code. Nothing tells it that the
   * closing backtick a few characters later ends the template rather than opening a brand new one —
   * without a call to `reScanTemplateToken()` exactly there, that backtick is read as starting a
   * fresh (almost always unterminated) template literal that silently swallows every token for the
   * rest of the file, JSX included. `className={\`btn ${size}\`}` is exactly this shape and is the
   * single most common template-literal use in real React code, so this is handled here once rather
   * than special-cased at every call site. Each substitution's own contents are otherwise left opaque
   * (this rule already leaves the analogous JSX `{…}` expression content unexamined beyond the narrow
   * "sole bare literal" check in `scanBracedExpression` — a template's substitutions are no
   * different), tracking a local brace depth so an object literal or arrow function body inside a
   * substitution isn't mistaken for its closing point, and recursing for a template nested inside one.
   */
  const skipTemplateLiteral = (): void => {
    if (tok() === SyntaxKind.NoSubstitutionTemplateLiteral) {
      advance();
      return;
    }
    advance(); // past TemplateHead — now scanning the first substitution's expression
    for (;;) {
      let depth = 0;
      for (;;) {
        if (
          tok() === SyntaxKind.TemplateHead ||
          tok() === SyntaxKind.NoSubstitutionTemplateLiteral
        ) {
          skipTemplateLiteral(); // a template literal nested inside this substitution
        } else if (tok() === SyntaxKind.OpenBraceToken) {
          depth += 1;
          advance();
        } else if (tok() === SyntaxKind.CloseBraceToken) {
          if (depth === 0) break; // this substitution's own closing brace
          depth -= 1;
          advance();
        } else if (tok() === SyntaxKind.EndOfFile) {
          return; // malformed input; bail rather than loop forever
        } else {
          advance();
        }
      }
      kind = scanner.reScanTemplateToken(false);
      if (tok() === SyntaxKind.TemplateTail) {
        advance();
        return;
      }
      advance(); // past TemplateMiddle — now scanning the next substitution's expression
    }
  };

  /**
   * A `{ … }` region: an attribute value (`isChild` false) or a JSX expression child (`isChild`
   * true). Tracks brace depth so nested object literals/blocks don't end the region early, and
   * recurses into `parseElement` for JSX nested inside the expression (`{cond && <X/>}`). When
   * `isChild` and the region's entire content is one bare string literal or one bare no-substitution
   * template literal (`{`Save changes`}` reads exactly like `{"Save changes"}` — the cheapest possible
   * bypass of the whole rule if left unhandled), that is exactly the `{"Sign out"}` shape spec:2061
   * forbids — everything else inside `{}` is left unexamined, same as the brief's own scope (a
   * translated call, a ternary, a template literal WITH interpolation, a nested element are accepted).
   */
  const scanBracedExpression = (isChild: boolean): void => {
    let depth = 1;
    let topLevelTokens = 0;
    let sole: { text: string; offset: number } | undefined;
    let previous: number | undefined = SyntaxKind.OpenBraceToken;
    advance();
    while (depth > 0 && tok() !== SyntaxKind.EndOfFile) {
      if (tok() === SyntaxKind.TemplateHead) {
        // A substitution's own `}` must never reach the OpenBraceToken/CloseBraceToken counting
        // below — reScanTemplateToken has to run on it first, or the dangling closing backtick that
        // follows starts a fresh, almost always unterminated template that eats the rest of the file.
        skipTemplateLiteral();
        if (depth === 1) {
          topLevelTokens += 1;
          sole = undefined; // a template with a substitution is never a bare literal
        }
        previous = SyntaxKind.TemplateTail;
        continue;
      } else if (tok() === SyntaxKind.OpenBraceToken) {
        depth += 1;
      } else if (tok() === SyntaxKind.CloseBraceToken) {
        depth -= 1;
        if (depth === 0) break;
      } else {
        if (depth === 1) {
          topLevelTokens += 1;
          const isBareLiteral =
            tok() === SyntaxKind.StringLiteral ||
            tok() === SyntaxKind.NoSubstitutionTemplateLiteral;
          sole =
            topLevelTokens === 1 && isChild && isBareLiteral
              ? { text: scanner.getTokenValue(), offset: scanner.getTokenStart() }
              : undefined;
        }
        if (tok() === SyntaxKind.LessThanToken && looksLikeJsxStart(previous)) {
          if (parseElement(false)) {
            previous = SyntaxKind.Identifier; // the finished element is a value from here on
            continue;
          }
          // Not JSX after all (a generic arrow function's type parameters) — `kind` is already
          // sitting on the token right after the mis-tried tag name; fall through to count it below.
        }
      }
      previous = tok();
      advance();
    }
    if (sole && topLevelTokens === 1 && PROSE.test(sole.text))
      report(sole.offset, `JSX child "${sole.text}" is a literal — wrap it in t("<key>")`);
    if (isChild) advanceChildren();
    else advance();
  };

  /** JSX children up to (not including) the matching close tag's own `>`, left current for the caller. */
  const parseChildren = (): void => {
    for (;;) {
      if (tok() === SyntaxKind.JsxText || tok() === SyntaxKind.JsxTextAllWhiteSpaces) {
        const text = scanner.getTokenText();
        if (PROSE.test(text))
          report(
            scanner.getTokenStart(),
            `JSX text "${text.trim()}" is not translated — wrap it in t("<key>")`,
          );
        advance();
      } else if (tok() === SyntaxKind.OpenBraceToken) {
        scanBracedExpression(true);
      } else if (tok() === SyntaxKind.LessThanToken) {
        parseElement(true);
      } else if (tok() === SyntaxKind.LessThanSlashToken) {
        advance(); // consume '</'; a tag name (or nothing, for a fragment close) follows
        while (tok() !== SyntaxKind.GreaterThanToken && tok() !== SyntaxKind.EndOfFile) advance();
        return; // left at the closing tag's '>' for parseElement to resume from
      } else {
        return; // EOF or malformed input; bail rather than loop forever
      }
    }
  };

  /**
   * `<Tag …>children</Tag>` or `<Tag … />`, starting at the opening `<`. `resumeAsChildren` says
   * whether, once this whole element is behind us, the caller is itself still inside JSX children
   * (so the next token must come from `scanJsxToken`) or in ordinary code (`scan`) — the same
   * distinction the real parser makes when it decides how to interpret whatever follows.
   *
   * Returns `false` when the `<…>` turns out not to be JSX after all — a generic type-parameter
   * list reads identically to a one-segment tag name up to that point (`<T,>`, `<T extends U>`,
   * `<T = Default>`), and TSX itself requires exactly this shape (the trailing comma or `extends`)
   * to tell a generic arrow function apart from JSX in expression position. On a `false` return no
   * JSX-mode scanning has happened yet — `kind` is sitting on the disambiguating token (`,`,
   * `extends` or `=`) exactly where ordinary `scan()` already put it — so the caller can fall back to
   * treating it as plain code with no cleanup required.
   */
  function parseElement(resumeAsChildren: boolean): boolean {
    advance(); // consume '<'
    while (tok() === SyntaxKind.Identifier) {
      advance();
      if (tok() === SyntaxKind.DotToken) {
        advance(); // namespaced tag name, e.g. <Foo.Bar> — consume the next identifier segment
        continue;
      }
      break;
    }
    if (
      tok() === SyntaxKind.CommaToken ||
      tok() === SyntaxKind.ExtendsKeyword ||
      tok() === SyntaxKind.EqualsToken
    ) {
      return false; // a generic type-parameter list, not a JSX tag name
    }
    let selfClosing = false;
    for (;;) {
      if (tok() === SyntaxKind.GreaterThanToken) {
        break;
      } else if (tok() === SyntaxKind.SlashToken) {
        advance(); // consume '/'; a GreaterThanToken should follow
        selfClosing = true;
        break;
      } else if (tok() === SyntaxKind.OpenBraceToken) {
        scanBracedExpression(false); // spread attribute: <Foo {...props} />
      } else if (tok() === SyntaxKind.Identifier || tok() === SyntaxKind.PrivateIdentifier) {
        let name = scanner.getTokenValue();
        const nameOffset = scanner.getTokenStart();
        advance();
        while (tok() === SyntaxKind.MinusToken) {
          advance();
          if (tok() !== SyntaxKind.Identifier) break;
          name += `-${scanner.getTokenValue()}`; // aria-label, aria-description, …
          advance();
        }
        if (tok() === SyntaxKind.EqualsToken) {
          advance();
          if (tok() === SyntaxKind.StringLiteral) {
            const value = scanner.getTokenValue();
            if (HUMAN_ATTRIBUTES.has(name) && PROSE.test(value))
              report(
                nameOffset,
                `attribute ${name}="${value}" is not translated — wrap it in t("<key>")`,
              );
            advance();
          } else if (tok() === SyntaxKind.OpenBraceToken) {
            scanBracedExpression(false);
          }
        }
      } else if (tok() === SyntaxKind.EndOfFile) {
        return false; // malformed input; bail rather than loop forever
      } else {
        advance();
      }
    }
    if (!selfClosing) {
      advanceChildren();
      parseChildren(); // returns with the current token at the matching close tag's '>'
    }
    if (resumeAsChildren) advanceChildren();
    else advance();
    return true;
  }

  /**
   * True only when `kind` is a `TypeKeyword` that actually starts a `type X = …` declaration, never
   * for `type` used as a property/parameter name (`(props: { type: string })`) — `type` is a
   * contextual keyword, so the scanner tags both the same way, and the two are told apart only by
   * what follows: a real declaration is always `type` + an Identifier + (`=` or `<`, for `type Fn<T>
   * = …`); a property is `type` + `:`. `lookAhead` peeks those two tokens and restores the scanner
   * to the current `TypeKeyword` afterward regardless of what it finds, so this never consumes
   * anything — the caller still needs its own `advance()` either way.
   */
  const looksLikeTypeAliasStart = (): boolean =>
    scanner.lookAhead(() => {
      if (scanner.scan() !== SyntaxKind.Identifier) return false;
      const afterName = scanner.scan();
      return afterName === SyntaxKind.EqualsToken || afterName === SyntaxKind.LessThanToken;
    });

  let previous: number | undefined;
  // The right-hand side of a `type X = …` (or `export type X = …`) declaration, from the `type`
  // keyword to the statement's own closing `;`. A `<` there can only start a generic type-parameter
  // list (`type Fn = <T>(x: T) => T;`) — JSX is a value-expression construct and can never appear in
  // a type position — but that `<T>` shape (no trailing comma, no `extends`) is indistinguishable at
  // the token level from a same-shaped real tag (`<Foo>`), so `parseElement`'s own bail-out can't
  // catch it; this is tracked separately instead. `typeAliasDepth` counts braces opened since the
  // flag was set, so a `;` that is really a member separator inside a nested type literal
  // (`type P = { a: number; b: string };`) does not clear the flag early — an earlier version
  // cleared on the *first* semicolon regardless of nesting, which (combined with a looser trigger)
  // is exactly how a `type`-named prop upstream of a component left the flag stuck for the rest of
  // the file, silently disabling the whole rule from that point on.
  let inTypeAlias = false;
  let typeAliasDepth = 0;
  while (tok() !== SyntaxKind.EndOfFile) {
    // Checked before everything else below, including `inTypeAlias`: a template literal type
    // (`type G = \`Hello ${string}\`;`) is exactly as vulnerable to the dangling-backtick corruption
    // skipTemplateLiteral guards against as a runtime one, and letting `inTypeAlias`'s own bare brace
    // counting see a substitution's `{`/`}` first would be just as wrong as letting `scanBracedExpression`
    // see one.
    if (tok() === SyntaxKind.TemplateHead || tok() === SyntaxKind.NoSubstitutionTemplateLiteral) {
      skipTemplateLiteral();
      previous = SyntaxKind.TemplateTail; // a template literal is a value from here on
      continue;
    }
    if (inTypeAlias) {
      if (tok() === SyntaxKind.OpenBraceToken) typeAliasDepth += 1;
      else if (tok() === SyntaxKind.CloseBraceToken) typeAliasDepth -= 1;
      else if (tok() === SyntaxKind.SemicolonToken && typeAliasDepth === 0) inTypeAlias = false;
    } else if (
      tok() === SyntaxKind.TypeKeyword &&
      (previous === undefined || STATEMENT_START.has(previous)) &&
      looksLikeTypeAliasStart()
    ) {
      inTypeAlias = true;
      typeAliasDepth = 0;
    } else if (tok() === SyntaxKind.LessThanToken && looksLikeJsxStart(previous)) {
      if (parseElement(false)) {
        previous = SyntaxKind.Identifier; // the finished element is a value from here on
        continue;
      }
      // Not JSX after all — fall through and let the common tail below advance past it normally.
    }
    previous = tok();
    advance();
  }

  return violations;
}

export const rule: LintRule = {
  name: "no-hardcoded-string",
  run(files: SourceFile[]): LintViolation[] {
    return files.flatMap(violationsFor);
  },
};
