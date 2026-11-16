import Decimal from "decimal.js";
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import type { ReconciliationReport } from "./index";
import { hasColumns } from "./probe";

/** spec:2332 verbatim, with where its decision lives. The report carries it and proposes no treatment. */
export const SUSPENSE_QUESTION = [
  "Expect unbalanced vouchers. Nothing prevented them (SAH-003). Detect them, quantify them, and agree a",
  "treatment (suspense account) with the customer *before* migrating. (spec:2332, §5.1 #2; the decision is",
  "OD-25 and belongs to 9B's cut-over task — this report is its input.)",
].join(" ");

const LINE_COLUMNS = ["SITE", "ID", "ACCOUNT", "DEBIT", "CREDIT"];
const HEADER_COLUMNS = ["SITE", "ID", "DATE"];

interface Bucket {
  debit: Decimal;
  credit: Decimal;
  lines: number;
  accounts: Set<string>;
}

function amount(value: LegacyRow[string] | undefined): Decimal {
  return new Decimal(value === null || value === undefined || value === "" ? "0" : String(value));
}

function voucherKey(row: LegacyRow): string {
  return [String(row.SITE ?? ""), String(row.ID ?? "")].join("|");
}

/** Numeric-aware, so voucher `1|10` follows `1|9` the way the legacy keys (integers) order. */
const byKey = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * §5.1 #2. One pass over VouItems to bucket by voucher, one over Vouchers to date them. The imbalance is
 * `debit − credit` and is signed, so a report that is read as a total tells the owner which side a suspense
 * account would land on. A voucher whose header is missing is still reported, undated — the orphan report
 * (Task 9) is where the missing header is a finding. Nothing here proposes a treatment: that is OD-25, and
 * contracts hazard 7 forbids this plan deciding it.
 */
export async function unbalancedVouchers(reader: LegacyReader): Promise<ReconciliationReport> {
  if (!(await hasColumns(reader, "VOUITEMS", LINE_COLUMNS))) {
    return {
      kind: "unbalanced_vouchers",
      rows: [],
      summary: {
        status: "source_absent",
        question: SUSPENSE_QUESTION,
        note: "VOUITEMS does not declare SITE, ID, ACCOUNT, DEBIT and CREDIT in this database; nothing was compared.",
      },
    };
  }

  const buckets = new Map<string, Bucket>();
  for await (const batch of reader.read<LegacyRow>("VOUITEMS", {
    columns: LINE_COLUMNS,
    batch: READ_BATCH,
  })) {
    for (const row of batch) {
      const k = voucherKey(row);
      const bucket = buckets.get(k) ?? {
        debit: new Decimal(0),
        credit: new Decimal(0),
        lines: 0,
        accounts: new Set<string>(),
      };
      bucket.debit = bucket.debit.plus(amount(row.DEBIT));
      bucket.credit = bucket.credit.plus(amount(row.CREDIT));
      bucket.lines += 1;
      if (row.ACCOUNT !== null && row.ACCOUNT !== undefined)
        bucket.accounts.add(String(row.ACCOUNT));
      buckets.set(k, bucket);
    }
  }

  const dates = new Map<string, string>();
  if (await hasColumns(reader, "VOUCHERS", HEADER_COLUMNS)) {
    for await (const batch of reader.read<LegacyRow>("VOUCHERS", {
      columns: HEADER_COLUMNS,
      batch: READ_BATCH,
    })) {
      for (const row of batch) dates.set(voucherKey(row), String(row.DATE ?? ""));
    }
  }

  const rows: Record<string, unknown>[] = [];
  let absolute = new Decimal(0);
  let net = new Decimal(0);
  let largestKey = "";
  let largest = new Decimal(0);
  const dated: string[] = [];

  for (const [voucher, bucket] of [...buckets].toSorted(([a], [b]) => byKey(a, b))) {
    const imbalance = bucket.debit.minus(bucket.credit);
    if (imbalance.isZero()) continue;
    absolute = absolute.plus(imbalance.abs());
    net = net.plus(imbalance);
    if (imbalance.abs().greaterThan(largest.abs())) {
      largest = imbalance;
      largestKey = voucher;
    }
    const date = dates.get(voucher) ?? "";
    if (date !== "") dated.push(date);
    rows.push({
      voucher,
      date,
      lines: bucket.lines,
      debit: bucket.debit.toFixed(4),
      credit: bucket.credit.toFixed(4),
      imbalance: imbalance.toFixed(4),
      accounts: [...bucket.accounts].toSorted(byKey).join(","),
    });
  }

  const sortedDates = dated.toSorted();
  return {
    kind: "unbalanced_vouchers",
    rows,
    summary: {
      status: "compared",
      vouchers: String(buckets.size),
      unbalanced: String(rows.length),
      absoluteImbalance: absolute.toFixed(4),
      netImbalance: net.toFixed(4),
      largest: rows.length === 0 ? "none" : [largestKey, largest.toFixed(4)].join(" "),
      dateRange:
        sortedDates.length === 0 ? "unknown" : [sortedDates[0], sortedDates.at(-1)].join(".."),
      question: SUSPENSE_QUESTION,
    },
  };
}
