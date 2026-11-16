import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/no-hardcoded-string";

const ROOT = resolve(__dirname, "../..");

// SourceFile (scripts/lint/types.ts) also carries `lines` — the brief this test is drawn from
// predates that field; supply it the same way scripts/lint/source.ts does.
const src = (path: string, text: string) => ({ path, text, lines: text.split("\n") });

/** Absent-directory-tolerant: `packages/ui/src` and `apps/backoffice/src` arrive in Tasks 4 and 5. */
const walk = (dir: string, out: { path: string; text: string }[] = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".ts"))
      out.push(src(full, readFileSync(full, "utf8")));
  }
  return out;
};

describe("no-hardcoded-string", () => {
  it("is registered under its contract name", () => {
    expect(rule.name).toBe("no-hardcoded-string");
  });

  it("flags a bare JSX text node in a component", () => {
    const v = rule.run([
      src("packages/ui/src/button.tsx", `export const B = () => <button>Save changes</button>;`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("flags a human-readable JSX attribute", () => {
    const v = rule.run([
      src(
        "apps/backoffice/src/x.tsx",
        `export const X = () => <input placeholder="Search users" />;`,
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("placeholder");
  });

  it("flags a string literal passed as a JSX child expression", () => {
    const v = rule.run([
      src("apps/backoffice/src/x.tsx", `export const X = () => <span>{"Sign out"}</span>;`),
    ]);
    expect(v).toHaveLength(1);
  });

  it("accepts a translated string", () => {
    const v = rule.run([
      src("apps/backoffice/src/x.tsx", `export const X = () => <span>{t("app.signOut")}</span>;`),
    ]);
    expect(v).toEqual([]);
  });

  it("accepts punctuation, digits and single letters", () => {
    const v = rule.run([
      src("packages/ui/src/x.tsx", `export const X = () => <span aria-hidden="true">·</span>;`),
    ]);
    expect(v).toEqual([]);
  });

  it("accepts an explicitly exempted line", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        `export const X = () => (\n  // i18n-exempt: brand name, never translated\n  <span>Dulja</span>\n);`,
      ),
    ]);
    expect(v).toEqual([]);
  });

  it("scans every line of a multi-line element, not just the first (guards JsxTextAllWhiteSpaces)", () => {
    // The whitespace-only text between `<div>` and its first child is a *different* token kind
    // (JsxTextAllWhiteSpaces) from ordinary JsxText. An earlier draft only matched JsxText and
    // returned out of the children scan the moment it saw that leading whitespace run, silently
    // skipping everything inside every multi-line element — a total defeat of this rule.
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export const X = () => (\n  <div>\n    <span>Save changes</span>\n  </div>\n);",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("flags JSX text containing an apostrophe without corrupting the scan", () => {
    // The whole design rests on driving the scanner's JSX-mode entry point (scanJsxToken) for
    // children text instead of its plain, non-JSX-aware scan(). A plain scan would read the "'" in
    // "Don't" as opening a string literal and misparse everything after it.
    const v = rule.run([
      src("packages/ui/src/x.tsx", `export const X = () => <p>Don't save yet</p>;`),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Don't save yet");
  });

  it("accepts a generic hook call and still flags real JSX right after it (guards VALUE_END)", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        'import { useState } from "react";\n' +
          "export const X = () => {\n" +
          '  const [name] = useState<string>("");\n' +
          "  return <span>Save changes</span>;\n" +
          "};",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("accepts a generic arrow function's type parameters and still flags real JSX right after it", () => {
    // `<T,>(v: T): T => v` reads exactly like a one-segment JSX tag name up to the comma — TSX
    // itself requires this trailing comma (or an `extends` clause) to tell a generic arrow function
    // apart from JSX in expression position, which is exactly the disambiguation this rule must copy.
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "const pick = <T,>(v: T): T => v;\nexport const X = () => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("accepts a bare generic function type alias and still flags real JSX right after it", () => {
    // `type Fn = <T>(x: T) => T` has no trailing comma or `extends` — nothing in the type-parameter
    // list itself disambiguates it from a same-shaped JSX tag (`<Foo>`). Only knowing we're on the
    // right-hand side of a `type X = …` statement (where JSX, a value-expression construct, can
    // never legally appear) tells them apart.
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "type Fn = <T>(x: T) => T;\nexport const X = () => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("flags a bare template-literal JSX child exactly like a string literal", () => {
    // `{`Save changes`}` reads to a user identically to `{"Save changes"}` — leaving it unflagged
    // would be the cheapest possible bypass of the whole rule.
    const v = rule.run([
      src("packages/ui/src/x.tsx", "export const X = () => <span>{`Save changes`}</span>;"),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it('still flags a short word like "OK" — it is genuine user-facing text, not an exemption', () => {
    const v = rule.run([src("packages/ui/src/x.tsx", `export const X = () => <span>OK</span>;`)]);
    expect(v).toHaveLength(1);
  });

  it("accepts Arabic-Indic digits and Arabic punctuation, but still flags real Arabic prose", () => {
    expect(
      rule.run([src("packages/ui/src/x.tsx", "export const X = () => <span>١٢</span>;")]),
    ).toEqual([]);
    expect(
      rule.run([src("packages/ui/src/y.tsx", "export const Y = () => <span>؟</span>;")]),
    ).toEqual([]);
    expect(
      rule.run([src("packages/ui/src/z.tsx", "export const Z = () => <span>مرحبا</span>;")]),
    ).toHaveLength(1);
  });

  it("a `type`-named prop does not disable the rule for the rest of the file", () => {
    // The `inTypeAlias` tracker added to accept `type Fn = <T>(x: T) => T;` (above) must trigger only
    // on a real `type X = …` declaration, never on a property/parameter literally named `type` — the
    // scanner tags both the same way (`type` is a contextual keyword), and `(props: { type: string })`
    // is exactly the shape oxfmt writes for a component prop, with no semicolon before the `}` to
    // clear a looser flag. A version that triggered on the bare keyword (without checking what follows
    // it) got stuck here and silently stopped flagging anything for the rest of the file.
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export const Icon = (props: { type: string }) => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a `type`-named prop that is not the first member still leaves the rule working", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export const Icon = (props: { label: string; type: string }) => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("an interface whose first member is named `type` does not disable JSX scanning later in the file", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "interface Props {\n" +
          "  type: string;\n" +
          "  onClick: () => void;\n" +
          "}\n" +
          "export const Icon = (props: Props) => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a real `type` attribute in JSX itself is unaffected, and a real violation beside it still flags", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export const X = () => (\n" +
          "  <div>\n" +
          '    <input type="text" />\n' +
          "    <span>Save changes</span>\n" +
          "  </div>\n" +
          ");",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a template literal with a substitution does not corrupt the rest of the file", () => {
    // After a substitution's own `}`, the raw scanner position sits on the literal template text
    // right after it. Nothing but reScanTemplateToken tells the scanner that the closing backtick a
    // few characters later ends the template rather than opening a brand new one — without it, that
    // backtick starts a fresh, almost always unterminated template literal that silently swallows
    // every remaining token, JSX included. This has no type alias or JSX attribute involved at all;
    // it is the plainest possible shape of the bug.
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "const g = `Hi ${name}`;\nexport const A = () => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a template literal in a JSX attribute expression does not corrupt a sibling element", () => {
    // `className={`btn ${size}`}` is the single most common template-literal shape in real React
    // code. Without reScanTemplateToken, scanBracedExpression's own brace counter mistakes the
    // substitution's `}` for the attribute's own closing brace, ends the attribute value early, and
    // desyncs everything scanned after it — including the real violation right next to it here.
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export const A = () => <div className={`btn ${size}`}><span>Save changes</span></div>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a template literal type inside a `type X = …` declaration does not corrupt the rest of the file", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export type G = `Hello ${string}`;\nexport const A = () => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a nested template literal does not corrupt the rest of the file", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "const g = `a ${`b ${c}`} d`;\nexport const A = () => <span>Save changes</span>;",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("a template literal attribute leaves the rest of its own element intact", () => {
    const v = rule.run([
      src(
        "packages/ui/src/x.tsx",
        "export const A = () => (\n" +
          "  <div className={`btn ${size}`}>\n" +
          "    <span>Save changes</span>\n" +
          "  </div>\n" +
          ");",
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("Save changes");
  });

  it("ignores stories, tests and files outside the UI trees", () => {
    expect(
      rule.run([src("packages/ui/src/button.stories.tsx", `<button>Save changes</button>;`)]),
    ).toEqual([]);
    expect(
      rule.run([src("apps/backoffice/test/x.test.tsx", `<button>Save changes</button>;`)]),
    ).toEqual([]);
    expect(rule.run([src("apps/api/src/routes/x.ts", `const s = "Save changes";`)])).toEqual([]);
  });

  it("reports zero violations across the shipped UI trees (DoD 0.12)", () => {
    const files = [
      ...walk(join(ROOT, "packages/ui/src")),
      ...walk(join(ROOT, "apps/backoffice/src")),
    ].map((f) => src(f.path.slice(ROOT.length + 1).replaceAll("\\", "/"), f.text));
    expect(rule.run(files)).toEqual([]);
  });
});
