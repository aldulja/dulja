import type { Config } from "tailwindcss";

/**
 * Physical directional properties. Every one of them lays out correctly in English and wrongly in
 * Arabic, which is why the whole set is banned in both shipped UI trees. Two files do the scanning —
 * the `packages/ui` one predates the other and stays in its own workspace, which may not import
 * `apps/backoffice` (one file *can* walk both trees: `tests/invariants/lint-rules.test.ts:316-317`):
 *
 * - `packages/ui/test/logical-properties.test.ts` → `packages/ui/src` (the primitives and the grid);
 * - `tests/invariants/logical-properties.test.ts` → `apps/backoffice/src`, `app.css` included (the
 *   screens, which are what §5.0 row 0.12 is actually about).
 *
 * The logical replacement is in the comment on each pattern.
 */
export const PHYSICAL_PROPERTY_PATTERNS: readonly string[] = [
  "\\bm[lr]-", // ml-/mr-      → ms-/me-
  "\\bp[lr]-", // pl-/pr-      → ps-/pe-
  "\\b(left|right)-\\d", // left-0       → start-0/end-0
  "\\btext-(left|right)\\b", // text-left    → text-start/text-end
  "\\bborder-[lr]\\b", // border-l     → border-s/border-e
  "\\brounded-[tb]?[lr]\\b", // rounded-l    → rounded-s/rounded-e
  "\\bfloat-(left|right)\\b",
  "margin-(left|right)\\s*:",
  "padding-(left|right)\\s*:",
  "\\b(left|right)\\s*:\\s*[^;]*;",
  "text-align\\s*:\\s*(left|right)",
];

/**
 * The Tailwind preset every Dulja surface extends. It maps the CSS custom properties of tokens.css
 * onto Tailwind's scales, so a component names `bg-surface`, never a hex value.
 */
export const tailwindPreset = {
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--dulja-font-sans)"],
        mono: ["var(--dulja-font-mono)"],
      },
      colors: {
        surface: "var(--dulja-color-surface)",
        "surface-raised": "var(--dulja-color-surface-raised)",
        border: "var(--dulja-color-border)",
        text: "var(--dulja-color-text)",
        "text-muted": "var(--dulja-color-text-muted)",
        accent: "var(--dulja-color-accent)",
        "accent-text": "var(--dulja-color-accent-text)",
        danger: "var(--dulja-color-danger)",
        "danger-text": "var(--dulja-color-danger-text)",
        success: "var(--dulja-color-success)",
        focus: "var(--dulja-color-focus)",
      },
      spacing: {
        1: "var(--dulja-space-1)",
        2: "var(--dulja-space-2)",
        3: "var(--dulja-space-3)",
        4: "var(--dulja-space-4)",
        6: "var(--dulja-space-6)",
        8: "var(--dulja-space-8)",
      },
      borderRadius: { sm: "var(--dulja-radius-sm)", md: "var(--dulja-radius-md)" },
    },
  },
} satisfies Partial<Config>;

export default tailwindPreset;
