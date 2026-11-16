import { csvField, csvText } from "./csv-cell";

/**
 * 8C T6 — spec:2083: "a bank-neutral CSV of the net-pay batch. **Bank-specific formats are out.**"
 *
 * Six columns, chosen because the data already has all six and no authority or bank is named by any of them. RFC 4180
 * quoting with CRLF terminators: a field containing a comma, a quote or a newline is wrapped in double quotes and its
 * own quotes are doubled. Nothing is locale-dependent — `amount` arrives as a fixed-scale string from
 * `Money.toString()` and is never formatted.
 *
 * The file is meant to be opened by an operator before it is uploaded, so a TEXT cell a spreadsheet would read as a
 * formula (OWASP "CSV injection": a leading `=`, `+`, `-`, `@`, tab or CR) is prefixed with `'`, the 7A report-CSV
 * rule. `amount` is exempt: it is a plain decimal literal produced by the service, never operator text.
 */
export const BATCH_CSV_HEADER: readonly string[] = [
  "employee_number",
  "employee_name",
  "bank_account",
  "amount",
  "currency",
  "reference",
];

export interface BatchCsvRow {
  employeeNumber: string;
  employeeName: string;
  /** Masked by the caller, never the raw account — the raw value lives only in `employee_sensitive` (8A). */
  bankAccountMasked: string;
  amount: string;
  currency: string;
  reference: string;
}

const field = csvField;
const text = csvText;

export function payrollBatchCsv(rows: readonly BatchCsvRow[]): string {
  const lines = [BATCH_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        text(r.employeeNumber),
        text(r.employeeName),
        text(r.bankAccountMasked),
        field(r.amount),
        text(r.currency),
        text(r.reference),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
