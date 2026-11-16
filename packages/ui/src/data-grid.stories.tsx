import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataGrid, type Column, type DataGridProps } from "./data-grid";

interface Row {
  id: string;
  email: string;
  roles: string;
}
const columns: Column<Row>[] = [
  { key: "email", header: "E-mail", cell: (r) => r.email },
  { key: "roles", header: "Roles", cell: (r) => r.roles, align: "end" },
];

const meta: Meta<typeof DataGrid<Row>> = { title: "Primitives/DataGrid", component: DataGrid<Row> };
export default meta;

export const TwoRows: StoryObj<typeof DataGrid<Row>> = {
  args: {
    caption: "Users and roles",
    columns,
    rows: [
      { id: "1", email: "aisha@example.test", roles: "admin" },
      { id: "2", email: "bilal@example.test", roles: "accountant, auditor" },
    ],
    rowKey: (r: Row) => r.id,
    emptyLabel: "Nothing to show yet.",
  },
};

export const Empty: StoryObj<typeof DataGrid<Row>> = {
  // `exactOptionalPropertyTypes` rejects the brief's `as StoryObj<...>["args"]` cast here — that
  // type is `Partial<DataGridProps<Row>> | undefined` (args is itself optional on StoryObj), and an
  // explicit `| undefined` in the source type is not assignable to this object's non-optional `args`
  // field even though the runtime value is never undefined. Casting to the plain `Partial<...>`
  // target type keeps the same values without introducing that stray `undefined`.
  args: { ...TwoRows.args, rows: [] } as Partial<DataGridProps<Row>>,
};
