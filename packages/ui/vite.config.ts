import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Exists so Storybook's Vite builder (`@storybook/builder-vite`) picks up the Tailwind plugin
 * automatically — it loads a project's own `vite.config.ts` and merges it with its required
 * settings. Without this file (or an equivalent `viteFinal` in `.storybook/main.ts`), Tailwind's
 * class scanner never runs and every utility class in every primitive resolves to no rule at all.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
