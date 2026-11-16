import { describe, expect, it } from "vitest";
import { checkCatalogues, type CatalogueViolation } from "../src/completeness";

const rules = (v: CatalogueViolation[]): string[] => [...new Set(v.map((x) => x.rule))].toSorted();

describe("checkCatalogues", () => {
  it("passes the shipped catalogues", () => {
    expect(checkCatalogues()).toEqual([]);
  });

  it("reports a key present in one catalogue and missing from the other", () => {
    const v = checkCatalogues({ en: { "a.b": "Hello", "a.c": "World" }, ar: { "a.b": "مرحبا" } });
    expect(rules(v)).toEqual(["missing_key"]);
    expect(v[0]).toMatchObject({ locale: "ar", key: "a.c", rule: "missing_key" });
  });

  it("reports an empty translation (SAH-085: 122 empty entries shipped)", () => {
    const v = checkCatalogues({ en: { "a.b": "Hello" }, ar: { "a.b": "   " } });
    expect(rules(v)).toEqual(["empty_value"]);
  });

  it("reports trailing whitespace (SAH-085: 232 entries)", () => {
    const v = checkCatalogues({ en: { "a.b": "Hello " }, ar: { "a.b": "مرحبا" } });
    expect(v).toEqual([
      {
        locale: "en",
        key: "a.b",
        rule: "trailing_whitespace",
        detail: 'value is "Hello " — trim it',
      },
    ]);
  });

  it("reports an Arabic value copied verbatim from English (source-language fallback)", () => {
    const v = checkCatalogues({ en: { "a.b": "Sign out" }, ar: { "a.b": "Sign out" } });
    expect(rules(v)).toEqual(["source_language_fallback", "wrong_script"]);
  });

  it("reports Arabic reaching an English value (SAH-085: 61 untranslated strings, two of them dialogs)", () => {
    const v = checkCatalogues({
      en: { "a.b": "هل تريد حفظ التعديلات ؟" },
      ar: { "a.b": "هل تريد حفظ التعديلات ؟" },
    });
    expect(rules(v)).toContain("wrong_script");
    expect(v.some((x) => x.locale === "en" && x.rule === "wrong_script")).toBe(true);
  });

  it('reports a raw component name shipped as UI text (SAH-085: "TBXToolbar3")', () => {
    const v = checkCatalogues({ en: { "a.b": "TBXToolbar3" }, ar: { "a.b": "TBXToolbar3" } });
    expect(rules(v)).toContain("component_name_leak");
  });

  it("reports a digit in Arabic-Indic numerals: every formatted figure is Western (test 23, 2026-10-23)", () => {
    const v = checkCatalogues({
      en: { "a.b": "PIN (4–12 digits)", "a.c": "Percent, from 0 to 100" },
      ar: { "a.b": "الرمز السري (٤–١٢ رقمًا)", "a.c": "نسبة مئوية من ۰ إلى ۱۰۰" },
    });
    expect(v.map((x) => [x.locale, x.key, x.rule])).toEqual([
      ["ar", "a.b", "mixed_numerals"],
      ["ar", "a.c", "mixed_numerals"],
    ]);
    expect(
      checkCatalogues({
        en: { "a.b": "PIN (4–12 digits)" },
        ar: { "a.b": "الرمز السري (4–12 رقمًا)" },
      }),
    ).toEqual([]);
  });

  it("exempts app.endonym.* — each language names itself in its own script", () => {
    const v = checkCatalogues({
      en: { "app.endonym.ar": "العربية", "app.endonym.en": "English" },
      ar: { "app.endonym.ar": "العربية", "app.endonym.en": "English" },
    });
    expect(v).toEqual([]);
  });
});
