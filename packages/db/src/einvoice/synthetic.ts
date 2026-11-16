// packages/db/src/einvoice/synthetic.ts
//
// The CI and `bun run dev` transmitter. It describes NO authority: its canonical shape is a
// deliberately generic projection of DocumentSnapshot, its QR payload is a hash, and its profile
// points at loopback. Its whole purpose is that slice 5B's transmission log, retry, reconciliation,
// route module and step-14 gate are all exercised before OD-15 lands.
//
// It is NOT registered when appEnv === "production" (registry.ts), and submission fails closed there: a fake acceptance on a real company is worse than no transmission.

import { createHash } from "node:crypto";
import {
  canonicalJson,
  type DocumentSnapshot,
  type EInvoiceDocument,
  type EInvoiceProfile,
} from "@dulja/domain";
import { createHttpTransmitter, type RegisteredTransmitter } from "./http-transmitter";
import { loadProfile } from "./profile";

export const SYNTHETIC_PROFILE_CODE = "synthetic";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A generic canonical projection. Every amount is taken STRAIGHT from the snapshot's `Money` via
 * `toJSON()` — nothing is re-derived, re-rounded or converted (Global Constraint 4, SAH-019), which
 * is also what makes `sah-020`'s "regime pinned on submission" true: the payload is a function of
 * stored line figures, so a later `tax_code` version cannot change it.
 */
export function syntheticCanonicalise(doc: DocumentSnapshot): EInvoiceDocument {
  const lines = doc.lines.map((line) => ({
    lineNo: line.lineNo,
    kind: line.kind,
    description: line.description,
    quantity: line.quantity?.toJSON() ?? null,
    unitPrice: line.unitPrice?.toJSON() ?? null,
    discount: line.discount.toJSON(),
    amount: line.amount.toJSON(),
    taxCodeId: line.taxCodeId,
    taxAmount: line.taxAmount.toJSON(),
    totalInclTax: line.totalInclTax.toJSON(),
  }));

  const body = {
    documentId: doc.header.id,
    number: doc.header.number === null ? "" : doc.header.number.toString(),
    issuedAt: doc.header.effectiveDate,
    series: doc.header.series,
    documentTypeCode: doc.header.documentTypeCode,
    currency: doc.header.currency,
    exchangeRate: doc.header.exchangeRate.rate,
    taxInclusive: doc.header.taxInclusive,
    supplier: { companyId: doc.company.id, baseCurrency: doc.company.baseCurrency },
    buyer: doc.party === null ? null : { partyId: doc.party.id, kind: doc.party.kind },
    lines,
    totals: {
      lineCount: lines.length,
      // Summed through Money, never through Number (Global Constraint 4). A document with no lines
      // cannot reach here — §4.3.2 step 3 raises ERR_DOC_NO_LINES first — so lines[0] is present.
      net: doc.lines
        .reduce((sum, l) => sum.add(l.amount), doc.lines[0]!.amount.subtract(doc.lines[0]!.amount))
        .toJSON(),
      tax: doc.lines
        .reduce(
          (sum, l) => sum.add(l.taxAmount),
          doc.lines[0]!.taxAmount.subtract(doc.lines[0]!.taxAmount),
        )
        .toJSON(),
      gross: doc.lines
        .reduce(
          (sum, l) => sum.add(l.totalInclTax),
          doc.lines[0]!.totalInclTax.subtract(doc.lines[0]!.totalInclTax),
        )
        .toJSON(),
    },
  };

  // The hash is over the payload WITHOUT the hash field, then the field is added — otherwise the
  // digest would depend on itself. `canonicalJson` is what makes it reproducible (test 26).
  return { ...body, hash: sha256Hex(canonicalJson(body)) } as unknown as EInvoiceDocument;
}

/** A stable, obviously synthetic QR payload: the document hash and the receipt id, nothing else. */
export function syntheticQrPayload(doc: EInvoiceDocument, receipt: { externalId: string }): string {
  return `dulja-synthetic:${doc.hash}:${sha256Hex(receipt.externalId)}`;
}

export function createSyntheticTransmitter(
  opts: {
    profile?: EInvoiceProfile;
    fetchImpl?: typeof fetch;
    /** Forwarded to `createHttpTransmitter`, which forwards it to `readSecret`. Omitted in both
     *  entrypoints, so production reads `process.env`; every test passes its own object. */
    env?: Record<string, string | undefined>;
    /** Where `loadProfile` looks when no `profile` is given. Defaults to PROFILE_DIR; tests only. */
    profileDir?: string;
  } = {},
): RegisteredTransmitter {
  return createHttpTransmitter({
    profile: opts.profile ?? loadProfile(SYNTHETIC_PROFILE_CODE, undefined, opts.profileDir),
    canonicalise: syntheticCanonicalise,
    qrPayload: syntheticQrPayload,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
}
