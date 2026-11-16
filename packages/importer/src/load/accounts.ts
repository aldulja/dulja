import type { Sql } from "postgres";
import type { LegacyRow } from "../legacy/types";
import type { AccountMap } from "./account-map";
import { ACCOUNTS_KEY_COLUMNS } from "./parties";
import { flagOf, requireText } from "./scalar";
import { LoadError, type LoadContext, type Loader, type SourceColumn } from "./types";

interface AccountTarget {
  legacyKey: string;
  legacyCode: string;
  code: string;
}

let current: AccountMap | null = null;

/** The run's account map (9B plan N6) — the same run-scoped port shape as `setLoadSource`: `Loader.map(row, refs)` has
 *  no `LoadContext` to carry it. The CLI sets it from `--account-map`; the `admin.import.run` handler (Task 9) sets it
 *  per run and clears it after, so one tenant's map never outlives its run in a worker process. */
export function setAccountMap(map: AccountMap): void {
  current = map;
}

/** Forgets the map, so a run that sets none fails closed instead of inheriting the last one. */
export function clearAccountMap(): void {
  current = null;
}

export function accountMap(): AccountMap {
  if (!current)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      "no account map has been set; pass --account-map <path> (the OWNER's mapping from the legacy chart to Dulja's)",
    );
  return current;
}

/**
 * No amount column (2026-11-15 review, HRP-21). The loader once read `ACCOPENBAL` only to skip — and so never link — an
 * account whose stored balance was NULL; no figure is ever taken from that column (the OPENING_BALANCE amounts come
 * from AccTotals, recomputed by 9A), so the skip only sent that account's real AccTotals balance to `3900` in a one-shot
 * opening. SAH-007 is guarded where an amount IS read: the trial-balance opening refuses a NULL `ACTDEBIT`/`ACTCREDIT`
 * at its row (`moneyOf`), and 9A's `null_poison` report names every NULL legacy amount before any load.
 */
const COLUMNS: readonly SourceColumn[] = [...ACCOUNTS_KEY_COLUMNS];

/**
 * `ACCOUNTS` → `app.account`: links the legacy chart to Dulja's, and creates NOTHING the map did not name. §4.15's codes
 * are seeded by their slices; this loader stamps `legacy_ref` (the ACCCODE) on the account the OWNER's map points at, so
 * the ledger opening (Task 5) and the reconciliation report (Task 10) can both say "legacy 1301 is Dulja 1200". A chart
 * invented from the customer's free-text names would put unregistered codes into a namespace hazard 32 closes; an
 * unmapped legacy account is REPORTED.
 *
 * Source key: the bare **ACCCODE**, not the ACCID — `openingBalanceLoader.map` resolves `AccTotals`' account column,
 * which holds a chart code, through `refs.byLegacyRef("account", <ACCCODE>)` (plan R29). The party loader's `ACC:<ACCID>`
 * keys cannot collide with it. Two legacy codes the map sends to one Dulja account both resolve to it; `legacy_ref`
 * keeps the first.
 */
export const accountLoader: Loader<LegacyRow, AccountTarget> = {
  sourceTable: "ACCOUNTS",
  targetTable: "account",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "ACCCODE", "ACCOUNTS"),

  map(row) {
    const legacyKey = requireText(row, "ACCID", "ACCOUNTS");
    const site = `ACCOUNTS/${legacyKey}`;
    if (flagOf(row, "ACCISCUSTOMER", site) === true || flagOf(row, "ACCISVENDOR", site) === true)
      return { skip: `account ${legacyKey} is a customer or vendor; the party loader takes it` };
    const legacyCode = requireText(row, "ACCCODE", site);
    const entry = accountMap().entries.find((e) => e.legacyCode === legacyCode);
    if (!entry)
      return {
        skip: `legacy account ${legacyCode} is not in the account map; add it with a treatment, or mark it exclude`,
      };
    if (entry.treatment === "exclude")
      return {
        skip: `legacy account ${legacyCode} is mapped exclude; it is reported and not loaded`,
      };
    return { legacyKey, legacyCode, code: entry.code };
  },

  async load(tx: Sql, ctx: LoadContext, rows: AccountTarget[]) {
    const batchIds: string[] = [];
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const [found] = await tx<{ id: string; legacy_ref: string | null; is_group: boolean }[]>`
        select id, legacy_ref, is_group from app.account
         where company_id = ${ctx.companyId} and code = ${row.code} and archived_at is null`;
      if (!found)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `the account map sends legacy ${row.legacyCode} to Dulja account ${row.code}, which company ${ctx.companyId} does not have; seed it (contracts §4.15 names its slice) before the load`,
        );
      if (found.is_group)
        throw new LoadError(
          "ERR_VALIDATION_FAILED",
          `the account map sends legacy ${row.legacyCode} to Dulja account ${row.code}, which is a group account; a balance cannot post to it — map it to a leaf`,
        );
      if (found.legacy_ref === null) {
        await tx`update app.account set legacy_ref = ${row.legacyCode} where id = ${found.id}`;
        inserted += 1;
      } else {
        skipped += 1;
      }
      batchIds.push(found.id);
    }
    return { inserted, skipped, batchIds };
  },
};
