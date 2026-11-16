import { accountLoader } from "./accounts";
import { employeeLoader, employeeYtdOpeningLoader } from "./employees";
import { itemLoader } from "./items";
import { lotLoader } from "./lots";
import { openItemLoader } from "./open-items";
import { openingBalanceLoader } from "./opening-balance";
import { openingStockLoader } from "./opening-stock";
import { partyLoader } from "./parties";
import { LoadError, type Loader } from "./types";
import { unitLoader } from "./units";
import { warehouseLoader } from "./warehouses";

/**
 * §4.13.2's `loaders`. Grown one entry per task — Task 4 master data and accounts, Task 5 the ledger opening, Task 6
 * opening stock, Task 7 open items, Task 8 employees — in an order that is itself topological, so `orderLoaders` keeps
 * it. `targetTable` is a loader's identity: the report key, the `only` name, the resolver's lookup.
 *
 * Each loader's `RefResolver` spelling is its `sourceKey`: `unit_of_measure` ← `UNTID`, `warehouse` ← `WARID`,
 * `account` ← `ACCCODE`, `party` ← `ACC:<ACCID>`, `item` ← `MATID`, `lot` ← `BATID` (all bare digits as the source
 * holds them, except the party's prefix). Task 5's `opening_balance` ← `ACTACC` is a whole-table loader (C13): every key
 * it records points at the one `OPENING_BALANCE` document. It depends on `account` alone, so `orderLoaders` readies it
 * with `item` — the array keeps it there, before `lot`, so that it stays its own topological order. Task 6's
 * `opening_stock` ← `BTMID` is the second whole-table loader: it resolves into `item`, `warehouse` and `lot`, so it comes
 * last, and every key it records points at the `OPENING_STOCK` of that row's own position (or its warehouse's). Task 7's
 * `open_item` ← `BILID` is paged (one `OPENING_BALANCE` per open legacy document) and resolves into `party` alone, so
 * `orderLoaders` readies it in `item`'s wave, after the trial-balance opening — which is why the opening is `OB 1` and
 * the open items follow it in the series. Task 8's `employee` ← `EMPID` resolves into nothing (it creates its own
 * party of kind employee), so it is ready in the first wave, after `party`; its `employee_ytd_opening` ← `YTD:<EMPID>`
 * reads the same source table, resolves into `employee`, and is ready in `item`'s wave, after the open items.
 */
export const loaders: Loader<unknown, unknown>[] = [
  unitLoader,
  warehouseLoader,
  accountLoader,
  partyLoader,
  employeeLoader,
  itemLoader,
  openingBalanceLoader,
  openItemLoader,
  employeeYtdOpeningLoader,
  lotLoader,
  openingStockLoader,
] as unknown as Loader<unknown, unknown>[];

/** The target tables whose loaders read the owner's account map (`accountMap()`): the chart links, the trial-balance
 *  opening's treatments and the open items' `ar_control`/`ap_control`. A run that includes one needs `setAccountMap`
 *  first — the CLI's `--account-map`, the job's `import_run.account_map` (9B T9). */
export const ACCOUNT_MAP_TARGETS: readonly string[] = ["account", "opening_balance", "open_item"];

/** The target tables whose loaders seal 8A's sensitive fields (`setKeyRing`): the employee master (9B T8). */
export const SENSITIVE_TARGETS: readonly string[] = ["employee"];

export function loaderFor(targetTable: string): Loader<unknown, unknown> {
  const found = loaders.find((l) => l.targetTable === targetTable);
  if (!found)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `no loader for target table ${targetTable}; registered: ${loaders.map((l) => l.targetTable).join(", ") || "(none)"}`,
    );
  return found;
}

/**
 * Kahn's algorithm over `dependsOn`, stable: among loaders whose dependencies are met, the earlier in `selected` runs
 * first. A dependency outside `selected` is ignored (an `only` run leaves it to the earlier run that loaded it). A
 * cycle raises rather than loops, naming every member left; two loaders with one `targetTable` raise too, because
 * the target is the loader's identity everywhere downstream.
 */
export function orderLoaders(
  selected: readonly Loader<unknown, unknown>[],
): Loader<unknown, unknown>[] {
  const names = new Set<string>();
  for (const loader of selected) {
    if (names.has(loader.targetTable))
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `two loaders target ${loader.targetTable}; a target table has exactly one loader`,
      );
    names.add(loader.targetTable);
  }
  const pending = [...selected];
  const done = new Set<string>();
  const ordered: Loader<unknown, unknown>[] = [];
  while (pending.length > 0) {
    const ready = pending.filter((l) => l.dependsOn.every((d) => !names.has(d) || done.has(d)));
    if (ready.length === 0)
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `loader dependency cycle: ${pending
          .map((l) => l.targetTable)
          .toSorted()
          .join(", ")}`,
      );
    for (const loader of ready) {
      ordered.push(loader);
      done.add(loader.targetTable);
      pending.splice(pending.indexOf(loader), 1);
    }
  }
  return ordered;
}
