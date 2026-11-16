# 0018 — Catalogue format: flat dotted ICU keys, two files, no fallback

**Status:** accepted · **Date:** 2026-09-05 · **Slice:** 0E · **Spec:** §3.9 Localisation (spec:2061), §3.2.2 i18n row (spec:1131)

## Context
spec:2061 requires every user-facing string to go through i18next with an ICU message, both catalogues
complete before merge, "no empty `msgstr`, no source-language fallbacks in the other language (SAH-085)".
The legacy system shipped 13,778 entries with 122 empty translations and 61 untranslated Arabic strings
reaching English users. The format has to make those two states mechanically detectable.

## Decision
1. Two files, `packages/i18n/catalogues/<locale>.json`, one flat JSON object per locale. No nesting,
   no namespaces: `keySeparator: false`, `nsSeparator: false`.
2. Keys are dotted `<area>.<screen>.<element>` literals; `TranslationKey` is `keyof typeof en`, so an
   unknown key is a TypeScript error.
3. `fallbackLng: false`. A missing Arabic value renders the key, loudly — it never renders English.
4. ICU message syntax for plurals, selects and inline dates.
5. Exactly one exempt key prefix, `app.endonym.*`, which holds each language's name in its own script;
   every other key is subject to the completeness rules of `checkCatalogues` (§Task 3).

## Consequences
- Adding a key means editing both files in the same PR, or `checkCatalogues` fails CI.
- Flat keys make the completeness check a set comparison, not a tree walk.
- No fallback means an incomplete Arabic catalogue is visible in development, not in production.
