import type { Meta, StoryObj } from "@storybook/react-vite";
import { Select } from "./select";

const meta: Meta<typeof Select> = { title: "Primitives/Select", component: Select };
export default meta;

export const Default: StoryObj<typeof Select> = {
  args: {
    label: "Role",
    options: [
      { value: "admin", label: "Administrator" },
      { value: "accountant", label: "Accountant" },
      { value: "auditor", label: "Auditor" },
    ],
  },
};
