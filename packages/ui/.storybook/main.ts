import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
  // The cheapest automated check available for a package whose spec bullet is WCAG 2.2 AA
  // (spec:2252) — it runs axe-core against every story and surfaces violations in the panel.
  addons: ["@storybook/addon-a11y"],
};
export default config;
