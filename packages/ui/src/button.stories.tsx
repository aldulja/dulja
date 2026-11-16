import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";

const meta: Meta<typeof Button> = { title: "Primitives/Button", component: Button };
export default meta;

export const Primary: StoryObj<typeof Button> = { args: { variant: "primary", children: "Save" } };
export const Secondary: StoryObj<typeof Button> = {
  args: { variant: "secondary", children: "Cancel" },
};
export const Danger: StoryObj<typeof Button> = {
  args: { variant: "danger", children: "Expire assignment" },
};
