import { describe, expect, it } from "vitest";
import {
  TEMPLATE_FRONT_MATTER,
  TemplateSourceError,
  composeTemplateSource,
  parseTemplateSource,
} from "../../src/print/template-source";

const META = { labels: { en: { total: "Total" }, ar: { total: "الإجمالي" } } };
const BODY = "<h1>{{ document.typeName }}</h1>\n<p>{{ labels.total }}</p>\n";

describe("print_template.source — front matter plus body (ADR 0032)", () => {
  it("round-trips", () => {
    const source = composeTemplateSource(META, BODY);
    expect(source.startsWith(`${TEMPLATE_FRONT_MATTER}\n`)).toBe(true);
    const parsed = parseTemplateSource(source);
    expect(parsed.meta).toEqual(META);
    expect(parsed.body).toBe(BODY);
  });

  it("keeps the body byte-exact, including a `---` line inside it", () => {
    const body = "a\n---\nb\n";
    expect(parseTemplateSource(composeTemplateSource(META, body)).body).toBe(body);
  });

  it("refuses a source with no front matter, naming what was expected", () => {
    expect(() => parseTemplateSource("<h1>hi</h1>")).toThrow(TemplateSourceError);
    expect(() => parseTemplateSource("<h1>hi</h1>")).toThrow(/---dulja-template-v1/);
  });

  it("refuses front matter that is not JSON, or that lacks both label catalogues", () => {
    expect(() => parseTemplateSource(`${TEMPLATE_FRONT_MATTER}\nnot json\n---\nx`)).toThrow(
      TemplateSourceError,
    );
    expect(() =>
      parseTemplateSource(`${TEMPLATE_FRONT_MATTER}\n{"labels":{"en":{}}}\n---\nx`),
    ).toThrow(/labels\.ar/);
  });
});
