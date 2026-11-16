import { describe, expect, it } from "vitest";
import { htmlEscape, typstEscape } from "../../src/print/escape";
import { TemplateError, renderTemplate } from "../../src/print/mustache";

const model = {
  title: "Cash & <Bank>",
  rtl: false,
  empty: "",
  lines: [
    { lineNo: 1, description: "One" },
    { lineNo: 2, description: "Two" },
  ],
  none: [] as unknown[],
  document: { number: "17", notes: null as string | null },
};

describe("renderTemplate — the deterministic mustache subset", () => {
  it("resolves OWN properties only — a prototype member is 'no path', not 'Object'", () => {
    // (`{{ lines.length }}` is not in this list on purpose: `length` IS an own property of an array.)
    for (const body of [
      "{{ constructor.name }}",
      "{{ title.length }}",
      "{{#if hasOwnProperty}}yes{{/if}}",
      "{{ lines.constructor }}",
    ]) {
      expect(() => renderTemplate(body, model, htmlEscape), body).toThrow(TemplateError);
      expect(() => renderTemplate(body, model, htmlEscape), body).toThrow(/has no path/);
    }
  });

  it("substitutes a path and escapes it", () => {
    expect(renderTemplate("<p>{{ title }}</p>", model, htmlEscape)).toBe(
      "<p>Cash &amp; &lt;Bank&gt;</p>",
    );
  });

  it("renders null and undefined as empty, never as the word 'null'", () => {
    expect(renderTemplate("[{{ document.notes }}]", model, htmlEscape)).toBe("[]");
  });

  it("iterates an array, resolving item paths first and root paths second", () => {
    expect(
      renderTemplate(
        "{{#each lines}}{{ lineNo }}:{{ description }}/{{ document.number }};{{/each}}",
        model,
        htmlEscape,
      ),
    ).toBe("1:One/17;2:Two/17;");
  });

  it("treats an empty array, an empty string and false as falsy in #if", () => {
    expect(renderTemplate("{{#if none}}y{{else}}n{{/if}}", model, htmlEscape)).toBe("n");
    expect(renderTemplate("{{#if empty}}y{{else}}n{{/if}}", model, htmlEscape)).toBe("n");
    expect(renderTemplate("{{#if rtl}}rtl{{else}}ltr{{/if}}", model, htmlEscape)).toBe("ltr");
    expect(renderTemplate("{{#if lines}}some{{else}}none{{/if}}", model, htmlEscape)).toBe("some");
  });

  it("throws on an unknown path rather than rendering a silent blank", () => {
    expect(() => renderTemplate("{{ nope }}", model, htmlEscape)).toThrow(TemplateError);
    expect(() => renderTemplate("{{ document.nope }}", model, htmlEscape)).toThrow(
      /document\.nope/,
    );
  });

  it("throws on an unbalanced block and on an unknown tag", () => {
    expect(() => renderTemplate("{{#each lines}}x", model, htmlEscape)).toThrow(/unclosed #each/);
    expect(() => renderTemplate("{{#while lines}}x{{/while}}", model, htmlEscape)).toThrow(
      TemplateError,
    );
    expect(() => renderTemplate("{{{ title }}}", model, htmlEscape)).toThrow(TemplateError);
  });

  it("is deterministic — the same body and model render byte-identically", () => {
    const body = "{{#each lines}}{{ description }}{{/each}}|{{ title }}";
    expect(renderTemplate(body, model, htmlEscape)).toBe(renderTemplate(body, model, htmlEscape));
  });

  it("escapes for typst as well as for html", () => {
    expect(typstEscape("a #b $c [d]")).toBe("a \\#b \\$c \\[d\\]");
    expect(htmlEscape(`a"b'c`)).toBe("a&quot;b&#39;c");
  });
});
