import clsx from "clsx";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useDirection } from "./direction";

export interface Column<T> {
  key: string;
  /** Already translated by the caller. */
  header: string;
  cell: (row: T) => ReactNode;
  align?: "start" | "end";
}

export interface DataGridProps<T> {
  /** Already translated by the caller. */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  emptyLabel: string;
  /** `Enter` on any cell of a row activates that row — the OD-24 default model's row selection. */
  onActivate?: (row: T) => void;
}

/**
 * The only valid focus coordinate for the current `rows`/`columns` sizes — the single source both
 * `move()` and the resize-clamp effect below clamp through, so they can never disagree. When there
 * are no rows, the grid renders exactly one cell (the empty-state placeholder, always at `{0,0}`,
 * see the `<td data-cell="0:0">` below) regardless of how many columns exist. Clamping `col`
 * against `columns.length` alone — as an earlier version of both call sites did independently —
 * lets a focus position with a non-zero column survive a shrink to zero rows unchanged (the
 * coordinate value doesn't move, so nothing flags it as needing a corrective re-render either),
 * producing a `data-cell` selector the empty state never renders; `.focus()` then silently no-ops
 * and real keyboard focus is left on `<body>`. Forcing `col` to 0 whenever `rowsLength` is 0 closes
 * that gap at its source instead of special-casing the query that reads it back.
 */
function clampFocus(
  row: number,
  col: number,
  rowsLength: number,
  columnsLength: number,
): { row: number; col: number } {
  const clampedRow = Math.min(Math.max(row, 0), Math.max(rowsLength - 1, 0));
  const clampedCol =
    rowsLength === 0 ? 0 : Math.min(Math.max(col, 0), Math.max(columnsLength - 1, 0));
  return { row: clampedRow, col: clampedCol };
}

/**
 * A roving-tabindex grid: one Tab stop for the whole table, arrows inside it (spec:2254 —
 * "no mouse required"). ArrowLeft/ArrowRight are mapped through the ambient direction, so the
 * *visual* next column is always to the reader's advancing side — the clause of acceptance test 23
 * that says "column order" (spec:2441).
 */
export function DataGrid<T>({
  caption,
  columns,
  rows,
  rowKey,
  emptyLabel,
  onActivate,
}: DataGridProps<T>) {
  const { dir } = useDirection();
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const container = useRef<HTMLTableSectionElement>(null);

  // Whether the grid held real DOM focus the instant before `rows`/`columns` last shrank —
  // captured here, during render, rather than in an effect or an onBlur handler. When a shrink
  // removes the very cell that holds focus, the browser reassigns `document.activeElement` to
  // `<body>` as an intrinsic side effect of the DOM node itself being removed, and that happens
  // during React's *commit* phase — before any effect (layout or passive) gets to run. By the
  // time an effect could check "does the container still contain focus", the answer is already
  // lost. This comparison, by contrast, runs during the *render* phase, while the previous
  // commit's DOM — the one that might still hold the about-to-be-removed focused cell — is still
  // fully intact, because React hasn't touched the real DOM for this render yet. It is also the
  // one approach that doesn't depend on whether removing a focused node fires a `blur`/`focusout`
  // event at all (browsers and jsdom disagree on this, and per the current DOM spec they do not);
  // an onFocus/onBlur pair would work only if that firing happens to occur, and even then couldn't
  // reliably tell "focus left because the node was removed" apart from "the user genuinely tabbed
  // or clicked away right as this render happened" — both present identically as "blurred to
  // `<body>`" from the event's own perspective. Comparing counts, not deltas, keeps this correct
  // under Strict Mode's double-invocation of render: the second invocation sees `previousCounts`
  // already updated by the first, so it's a no-op — nothing in the (unchanged) DOM could have
  // produced a different answer anyway.
  //
  // Recorded, not fixed, because nothing in this repo does it today: this capture assumes every
  // render that mutates these refs is committed. A future caller that dispatches a `rows`/`columns`
  // change inside `startTransition`, or that suspends, could have React discard a speculative
  // render after this code already ran and mutated `previousCounts`/`hadFocusBeforeResize` — a
  // later *real* commit could then consume a flag captured against a render that never happened,
  // and steal focus back incorrectly. No screen in Phase 0 wraps a `DataGrid`'s data in a
  // transition, so this is theoretical here — but Tasks 5 and 8 build the screens that use this
  // component, and whoever adds the first filter-with-`useTransition` should see this comment
  // before reaching for one around a `DataGrid`.
  const previousCounts = useRef({ rows: rows.length, columns: columns.length });
  const hadFocusBeforeResize = useRef(false);
  if (
    previousCounts.current.rows !== rows.length ||
    previousCounts.current.columns !== columns.length
  ) {
    hadFocusBeforeResize.current = container.current?.contains(document.activeElement) ?? false;
    previousCounts.current = { rows: rows.length, columns: columns.length };
  }

  // Filtering, deleting or paging can shrink `rows`/`columns` out from under a focus position that
  // was valid a moment ago. Left unclamped, no cell matches `focus` any more, every `tabIndex` in
  // the body is -1, and the grid's only Tab stop silently disappears — the worst failure mode for a
  // surface whose entire justification is "no mouse required" (spec:2254). Clamping here, the
  // instant the counts change, keeps `focus` valid immediately rather than only after the next
  // arrow key (`move` clamps too, but only reacts to its own deltas).
  //
  // The DOM `.focus()` restoration for a genuine shrink-while-focused lives in *this* effect, not
  // the keyboard one below, and reads `focus` directly from the closure rather than through a
  // `setFocus` updater callback — a state updater must stay pure (see the next effect's comment),
  // and the two things this effect does (clamp the value, restore real focus to it) must happen
  // from the exact same computed `{row, col}`, which is easiest to guarantee outside an updater.
  // Restoring unconditionally whenever `hadFocusBeforeResize` is set — not only when the clamped
  // value differs from the old one — matters because shrinking to zero rows clamps `{0,0}` to
  // `{0,0}`: the *value* doesn't change, but the DOM node that value refers to is a completely
  // different element (the empty-state cell, not whatever row 0 used to be), so real focus was
  // still lost and still needs restoring even though `focus` state has nothing to update.
  useLayoutEffect(() => {
    const shouldRestore = hadFocusBeforeResize.current;
    hadFocusBeforeResize.current = false;
    const { row, col } = clampFocus(focus.row, focus.col, rows.length, columns.length);
    if (shouldRestore) {
      container.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus();
    }
    if (row !== focus.row || col !== focus.col) setFocus({ row, col });
  }, [rows.length, columns.length]);

  // The imperative `.focus()` call used to run inside the `setFocus` updater in `move`, below.
  // State updaters must be pure — React 18 Strict Mode double-invokes them specifically to catch
  // side effects like this — so the DOM write lives here instead, keyed on the state it follows.
  // Guarded on the grid already owning focus (not "have we mounted yet"): a roving-tabindex widget
  // only ever moves focus when it already has it, which is true after a real arrow-key press or a
  // resize the effect above just restored focus for, and false on mount or when focus is elsewhere
  // entirely — including under Strict Mode's mount→unmount→remount replay, where a mount-only ref
  // guard would still fire on the second mount and steal focus into the grid unprompted. Left
  // exactly as confirmed correct for the plain keyboard path — the resize case above owns its own
  // restoration now and no longer needs a disjunct here.
  useLayoutEffect(() => {
    if (!container.current?.contains(document.activeElement)) return;
    container.current
      ?.querySelector<HTMLElement>(`[data-cell="${focus.row}:${focus.col}"]`)
      ?.focus();
  }, [focus]);

  const move = useCallback(
    (rowDelta: number, colDelta: number) => {
      setFocus((current) =>
        clampFocus(current.row + rowDelta, current.col + colDelta, rows.length, columns.length),
      );
    },
    [columns.length, rows.length],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    switch (event.key) {
      case "ArrowDown":
        move(1, 0);
        break;
      case "ArrowUp":
        move(-1, 0);
        break;
      case forward:
        move(0, 1);
        break;
      case backward:
        move(0, -1);
        break;
      case "Home":
        move(0, -columns.length);
        break;
      case "End":
        move(0, columns.length);
        break;
      case "Enter": {
        const row = rows[focus.row];
        if (row !== undefined && onActivate !== undefined) onActivate(row);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <table className="w-full border-collapse text-start">
      <caption className="text-start text-text-muted">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={clsx(
                "border-b border-border py-2 text-text",
                column.align === "end" ? "text-end" : "text-start",
              )}
            >
              {/* A header is a caller-supplied string exactly like a cell's — spec:2253 names
                  numerals explicitly and does not exempt column headers from bidi isolation. */}
              <bdi>{column.header}</bdi>
            </th>
          ))}
        </tr>
      </thead>
      <tbody ref={container} onKeyDown={onKeyDown}>
        {rows.length === 0 ? (
          <tr>
            {/* The empty state is still exactly one cell — it must still carry the grid's only tab
                stop (spec:2254 — a filter that matches nothing is not a rare state) and the same
                `data-cell` coordinate the focus-restore effect above already looks for, since the
                resize clamp lands `focus` at {0,0} whenever `rows.length` is 0. */}
            <td
              colSpan={columns.length}
              data-cell="0:0"
              tabIndex={0}
              className="py-6 text-center text-text-muted"
            >
              <bdi>{emptyLabel}</bdi>
            </td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr key={rowKey(row)}>
              {columns.map((column, colIndex) => (
                <td
                  key={column.key}
                  data-cell={`${rowIndex}:${colIndex}`}
                  tabIndex={focus.row === rowIndex && focus.col === colIndex ? 0 : -1}
                  onFocus={() => setFocus({ row: rowIndex, col: colIndex })}
                  className={clsx(
                    "border-b border-border py-2 text-text",
                    column.align === "end" ? "text-end" : "text-start",
                  )}
                >
                  {/* spec:2253 names numerals explicitly; an amount, an invoice code or a mixed-
                      script value must not inherit the row's paragraph direction from its
                      neighbours' neutral characters. `<bdi>` isolates each cell's own content. */}
                  <bdi>{column.cell(row)}</bdi>
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
