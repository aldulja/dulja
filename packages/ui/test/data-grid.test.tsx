import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { DataGrid, type Column } from "../src/data-grid";
import { DirectionProvider } from "../src/direction";

interface Row {
  id: string;
  email: string;
  name: string;
}
const columns: Column<Row>[] = [
  { key: "email", header: "E-mail", cell: (r) => r.email },
  { key: "name", header: "Name", cell: (r) => r.name },
];
const rows: Row[] = [
  { id: "1", email: "a@example.test", name: "Aisha" },
  { id: "2", email: "b@example.test", name: "Bilal" },
];

const grid = (locale: "en" | "ar") => (
  <DirectionProvider locale={locale}>
    <DataGrid
      caption="Users"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      emptyLabel="Nothing"
    />
  </DirectionProvider>
);

describe("DataGrid keyboard model", () => {
  it("is reachable by Tab and lands on the first cell", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("moves down and up with the arrow keys", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-cell", "1:0");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("ArrowRight advances a column in English", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");
  });

  it("ArrowLeft advances a column in Arabic — visual order reverses with the direction", async () => {
    const user = userEvent.setup();
    render(grid("ar"));
    await user.tab();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("Home and End jump to the first and last column", async () => {
    const user = userEvent.setup();
    render(grid("en"));
    await user.tab();
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");
    await user.keyboard("{Home}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("Enter activates the focused row (the OD-24 model's row selection)", async () => {
    const user = userEvent.setup();
    const activated: Row[] = [];
    render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={(r: Row) => r.id}
          emptyLabel="Nothing"
          onActivate={(r: Row) => activated.push(r)}
        />
      </DirectionProvider>,
    );
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(activated).toEqual([rows[1]]);
  });

  it("renders an accessible table with a caption and column headers", () => {
    render(grid("en"));
    expect(screen.getByRole("table", { name: "Users" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("shows the empty label and no rows when there is nothing", () => {
    render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={[]}
          rowKey={(r: Row) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    // Two `row`s in the DOM: the `<thead>` header row and the single `<tbody>` row carrying the
    // empty label's `colSpan` cell (Step 7 renders both). "No data rows" is proved by there being
    // exactly one cell, spanning every column — not by counting rows.
    expect(screen.queryAllByRole("row")).toHaveLength(2);
    const cells = screen.queryAllByRole("cell");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute("colspan", String(columns.length));
  });

  it("keeps a tab stop when the row set shrinks under the current focus", async () => {
    const user = userEvent.setup();
    const manyRows: Row[] = [...rows, { id: "3", email: "c@example.test", name: "Chen" }];
    const { rerender } = render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={manyRows}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-cell", "2:0");

    // Shrink from 3 rows to the module-level 2-row fixture — row index 2 (the focused one) no
    // longer exists. Without the resize clamp, no cell in the body would carry `tabIndex={0}` here
    // and the grid's only Tab stop would be gone.
    rerender(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    const tabbable = document.querySelector('[tabindex="0"]');
    expect(tabbable).not.toBeNull();
    expect(tabbable).toHaveAttribute("data-cell", "1:0");
    // The tab stop moving is necessary but not sufficient — spec:2254 is "no mouse required", and
    // an accounting app filters and deletes rows constantly. If the browser's own real keyboard
    // focus is left stranded on <body>, the user needs an extra Tab just to get back into the grid
    // they were already using. This is the stronger claim: focus itself, not just the attribute.
    expect(document.activeElement).toHaveAttribute("data-cell", "1:0");
  });

  it("keeps a tab stop when the row set shrinks to zero", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    await user.tab();
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");

    // A filter that matches nothing is not a rare state — the empty-state cell must still be a
    // real tab stop, and (since it's the same focused cell being removed as any other shrink)
    // focus should land back on it, not on <body>.
    rerender(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    const tabbable = document.querySelector('[tabindex="0"]');
    expect(tabbable).not.toBeNull();
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("restores real focus to the single empty-state cell when rows shrink to zero with focus on a non-zero column", async () => {
    // The exact repro that broke the earlier fix: both clamps computed `col` from
    // `columns.length` alone, so a shrink to zero rows left a focus position of `{0,1}`
    // numerically untouched — `col` was still a valid *column* index, just not a valid
    // coordinate any more, since the empty state renders exactly one cell, at "0:0". The
    // `querySelector` for "0:1" found nothing, `.focus()` silently no-opped, and because
    // neither `row` nor `col` had changed *value*, no corrective `setFocus` fired either —
    // real keyboard focus was left stranded on `<body>` with no way back except a mouse click.
    const user = userEvent.setup();
    const { rerender } = render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");

    rerender(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("restores real focus to a real cell when a column disappears while rows remain", async () => {
    // The symmetric direction: columns shrinking while rows survive was already handled
    // correctly (clamping `col` against the new `columns.length` alone is sufficient when at
    // least one row exists) — kept as a named test so a future change to the clamp can't
    // silently regress this direction while fixing another.
    const user = userEvent.setup();
    const oneColumn: Column<Row>[] = [columns[0]!];
    const { rerender } = render(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveAttribute("data-cell", "0:1");

    rerender(
      <DirectionProvider locale="en">
        <DataGrid
          caption="Users"
          columns={oneColumn}
          rows={rows}
          rowKey={(r) => r.id}
          emptyLabel="Nothing"
        />
      </DirectionProvider>,
    );
    expect(document.activeElement).toHaveAttribute("data-cell", "0:0");
  });

  it("restores real keyboard focus after a shrink under React Strict Mode", async () => {
    const user = userEvent.setup();
    const manyRows: Row[] = [...rows, { id: "3", email: "c@example.test", name: "Chen" }];
    const { rerender } = render(
      <StrictMode>
        <DirectionProvider locale="en">
          <DataGrid
            caption="Users"
            columns={columns}
            rows={manyRows}
            rowKey={(r) => r.id}
            emptyLabel="Nothing"
          />
        </DirectionProvider>
      </StrictMode>,
    );
    await user.tab();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-cell", "2:0");

    rerender(
      <StrictMode>
        <DirectionProvider locale="en">
          <DataGrid
            caption="Users"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            emptyLabel="Nothing"
          />
        </DirectionProvider>
      </StrictMode>,
    );
    expect(document.activeElement).toHaveAttribute("data-cell", "1:0");
  });
});

describe("DataGrid bidi isolation (spec:2253 — numerals, mixed scripts, do not regress)", () => {
  it("wraps each cell's content in <bdi>, in both directions, so it can't inherit the row's paragraph direction", () => {
    const mixedRows: Row[] = [{ id: "1", email: "a@example.test", name: "أحمد" }];
    for (const locale of ["en", "ar"] as const) {
      const { unmount } = render(
        <DirectionProvider locale={locale}>
          <DataGrid
            caption="Users"
            columns={columns}
            rows={mixedRows}
            rowKey={(r) => r.id}
            emptyLabel="Nothing"
          />
        </DirectionProvider>,
      );
      const headers = screen.getAllByRole("columnheader");
      expect(headers[0]?.querySelector("bdi")).toHaveTextContent("E-mail");
      expect(headers[1]?.querySelector("bdi")).toHaveTextContent("Name");
      const cells = screen.getAllByRole("cell");
      expect(cells).toHaveLength(2);
      expect(cells[0]?.querySelector("bdi")).toHaveTextContent("a@example.test");
      expect(cells[1]?.querySelector("bdi")).toHaveTextContent("أحمد");
      unmount();
    }
  });

  it("wraps the empty label in <bdi> too", () => {
    render(
      <DirectionProvider locale="ar">
        <DataGrid
          caption="Users"
          columns={columns}
          rows={[]}
          rowKey={(r: Row) => r.id}
          emptyLabel="Nothing to show yet."
        />
      </DirectionProvider>,
    );
    const cell = screen.getByRole("cell");
    expect(cell.querySelector("bdi")).toHaveTextContent("Nothing to show yet.");
  });
});
