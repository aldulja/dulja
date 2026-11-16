import type { Config } from "tailwindcss";
import { tailwindPreset } from "./src/tailwind-preset.js";

/**
 * Legacy JS-config entry point, loaded by `src/tailwind.css`'s `@config` directive. Tailwind v4's
 * own config format is CSS-native (`@theme`), but `tailwindPreset` is a plain JS object so the
 * exact same preset can be handed to a consuming app's own Tailwind config (`presets: [tailwindPreset]`)
 * without that app needing to know this package uses Tailwind internally at all. `content` only
 * needs to cover Storybook's own preview — every other consumer supplies its own `content` glob.
 */
export default {
  content: ["./src/**/*.{ts,tsx}", "./.storybook/**/*.{ts,tsx}"],
  presets: [tailwindPreset],
} satisfies Config;
