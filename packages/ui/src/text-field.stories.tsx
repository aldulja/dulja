import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextField } from "./text-field";

const meta: Meta<typeof TextField> = { title: "Primitives/TextField", component: TextField };
export default meta;

export const WithHint: StoryObj<typeof TextField> = {
  args: {
    label: "E-mail",
    hint: "The address the invitation is sent to",
    placeholder: "name@example.test",
  },
};
export const WithError: StoryObj<typeof TextField> = {
  args: { label: "E-mail", error: "That address is already a member of this tenant" },
};
