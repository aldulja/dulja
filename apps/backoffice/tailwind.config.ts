import { tailwindPreset } from "@dulja/ui/tailwind-preset";
import type { Config } from "tailwindcss";

/**
 * `@dulja/ui` deliberately does not export compiled CSS — every consuming app runs its own Tailwind
 * build. Tailwind only emits a rule for a class it can *see*, so the `packages/ui/src` glob is
 * load-bearing: without it every primitive renders unstyled here while looking correct in Storybook.
 * Loaded by `src/app.css`'s `@config` directive (Tailwind v4 keeps the JS config opt-in).
 */
export default {
  presets: [tailwindPreset],
  content: ["./index.html", "./src/**/*.tsx", "../../packages/ui/src/**/*.tsx"],
} satisfies Config;
