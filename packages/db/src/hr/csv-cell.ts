/**
 * 8C — the two cell writers every HR CSV in this package shares (the T6 payroll batch file, the T7 statutory
 * schedule), so the quoting and the formula-injection rule are written once.
 *
 * RFC 4180 quoting: a field containing a comma, a quote or a newline is wrapped in double quotes and its own quotes
 * are doubled. A TEXT cell a spreadsheet would read as a formula (OWASP "CSV injection": a leading `=`, `+`, `-`,
 * `@`, tab or CR) is prefixed with `'` first — the 7A report-CSV rule. A figure the service itself produced as a
 * fixed-scale decimal string (an amount, a share) goes through `csvField` only: it is never operator text, and a
 * prefix would corrupt a negative figure.
 */
const NEEDS_QUOTE = /[",\r\n]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export const csvField = (value: string): string =>
  NEEDS_QUOTE.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const csvText = (value: string): string =>
  csvField(FORMULA_LEAD.test(value) ? `'${value}` : value);
