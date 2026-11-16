import { Money } from "../money/money";
import type { DocumentSnapshot } from "../posting/evaluate";
import type { PrintTemplateMeta } from "./template-source";

export interface PrintModelLine {
  lineNo: number;
  description: string;
  account: string;
  debit: string;
  credit: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface PrintModel {
  lang: "en" | "ar";
  dir: "ltr" | "rtl";
  rtl: boolean;
  labels: Record<string, string>;
  company: { name: string; baseCurrency: string };
  document: {
    typeCode: string;
    typeName: string;
    status: string;
    series: string;
    number: string;
    effectiveDate: string;
    effectiveDateHijri: string;
    currency: string;
    exchangeRate: string;
    partyName: string;
    notes: string;
  };
  lines: PrintModelLine[];
  totals: { debit: string; credit: string; lineCount: number };
}

export interface PrintContext {
  lang: "en" | "ar";
  companyName: string;
  documentTypeNameEn: string;
  documentTypeNameAr: string | null;
  partyName: string | null;
  notes: string | null;
  /** account_id → "1000 · Cash" */
  accountLabels: Record<string, string>;
  labels: PrintTemplateMeta["labels"];
}

/** spec:2039 — "Hijri display is a presentation concern via `Intl`; storage is always Gregorian." */
function hijri(isoDate: string): string {
  return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura-nu-latn", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/**
 * Pure. Every monetary value leaves as `Money.toString()` — a fixed four-decimal string — so no `number`
 * ever holds money (§3.7.5) and nothing stored is recomputed on read (spec:2041). Sums are `Money.add`,
 * never JavaScript addition.
 */
export function buildPrintModel(snapshot: DocumentSnapshot, ctx: PrintContext): PrintModel {
  const { header, lines, company } = snapshot;
  const rtl = ctx.lang === "ar";

  let debitTotal = Money.zero(header.currency);
  let creditTotal = Money.zero(header.currency);
  for (const line of lines) {
    debitTotal = debitTotal.add(line.debit);
    creditTotal = creditTotal.add(line.credit);
  }

  return {
    lang: ctx.lang,
    dir: rtl ? "rtl" : "ltr",
    rtl,
    labels: ctx.labels[ctx.lang],
    company: { name: ctx.companyName, baseCurrency: String(company.baseCurrency) },
    document: {
      typeCode: header.documentTypeCode,
      // An Arabic template with no name_ar prints the English name rather than an empty heading.
      typeName: rtl ? (ctx.documentTypeNameAr ?? ctx.documentTypeNameEn) : ctx.documentTypeNameEn,
      status: header.status,
      series: header.series ?? "",
      number: header.number === null ? "" : String(header.number),
      effectiveDate: header.effectiveDate,
      effectiveDateHijri: hijri(header.effectiveDate),
      currency: String(header.currency),
      exchangeRate: header.exchangeRate.rate,
      partyName: ctx.partyName ?? "",
      notes: ctx.notes ?? "",
    },
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description ?? "",
      account: line.accountId ? (ctx.accountLabels[line.accountId] ?? line.accountId) : "",
      debit: line.debit.toString(),
      credit: line.credit.toString(),
      quantity: line.quantity ? line.quantity.toString() : "",
      unitPrice: line.unitPrice ? line.unitPrice.toString() : "",
      amount: line.amount.toString(),
    })),
    totals: {
      debit: debitTotal.toString(),
      credit: creditTotal.toString(),
      lineCount: lines.length,
    },
  };
}
