// tests/invariants/support/einvoice.ts — the lines this task ADDS to Task 7's import block
import {
  createTaxReturn,
  generateTaxReturn, // 5A's returns.ts, through @dulja/db's barrel
  pollTransmission,
  submitTransmission, // 5B Task 5 — the same two calls the job makes
} from "@dulja/db";
import { uuidv7 } from "@dulja/db/test"; // §4.1: uuidv7(sql: Sql): Promise<string>
import { recordingJobs } from "./post-inventory"; // 3B, §4.17.1
// and `postFromPack` joins the EXISTING `./ar-ap` import line, beside PACK_DIR and arApFixture:
//   import { PACK_DIR, arApFixture, postFromPack, type ArApFixture, type DocumentTypeEnvelope } from "./ar-ap";

// tests/invariants/support/einvoice.ts  (§4.17.1(b), 5B, contracts amendment 10)
//
// Composes 4B's arApFixture with the two writes defined once in
// packages/db/test/support/einvoice-stub.ts, and opts 4A's OWN SALES_INVOICE envelope in at
// policyVersion + 1. No test in slice 5B restates a policy 4A owns.

import { readFileSync } from "node:fs";
import { listTransmissions, withTenant, type EinvoiceTransmissionRow } from "@dulja/db";
import { seedAccount, seedTaxCode, type Db, type Seed } from "@dulja/db/test";
import { enableEinvoice, optInDocumentType } from "@dulja/db/test/einvoice-stub";
// 4B amendment 9 names it `PACK_DIR` and NOT `PACK_ROOT`: an ABSOLUTE directory with a trailing
// separator. (4A's `PACK_ROOT`, in `packages/db/test/ar-ap/_support.ts`, is the RELATIVE "seed/my"
// that `readPackFile` takes as its first argument; the two are not interchangeable, and Task 0's
// gate greps for `export const PACK_DIR` so a mix-up is a MISSING line rather than an ENOENT.)
import {
  PACK_DIR,
  arApFixture,
  postFromPack,
  type ArApFixture,
  type DocumentTypeEnvelope,
} from "./ar-ap";

export const OPTED_IN_TYPE_CODE = "SALES_INVOICE";

// tests/invariants/support/einvoice.ts — three members appended by 5B Task 8
export interface EinvoiceFixture {
  transmissionOf(documentId: string): Promise<EinvoiceTransmissionRow | null>;
  optedInTypeId: string;
  taxCodeId: string;
  regimeId: string;
  arAp: ArApFixture;
  /** Posts one SALES_INVOICE of the opted-in type on the enabled company and returns both ids.
   *  Every route case needs a fresh row, because the state machine is one-way. */
  postOptedInDocument(): Promise<{ documentId: string; transmissionId: string }>;
  /** Drives a `pending` row to `accepted` through `submitTransmission` + `pollTransmission` — the
   *  same two calls the job makes, so a route test never reimplements the state machine. */
  driveToAccepted(transmissionId: string): Promise<void>;
  /** One `generated` and one `draft` tax return on the same company, for the filing cases. */
  twoTaxReturns(): Promise<{ taxReturnId: string; draftReturnId: string }>;
}

export async function einvoiceFixture(db: Db, s: Seed): Promise<EinvoiceFixture> {
  const arAp = await arApFixture(db, s);
  await enableEinvoice(db, s);

  const envelope = JSON.parse(
    readFileSync(`${PACK_DIR}document-types/${OPTED_IN_TYPE_CODE}.json`, "utf8"),
  ) as DocumentTypeEnvelope;

  const optedInTypeId = await optInDocumentType(db, s, {
    code: envelope.code,
    module: envelope.module as "accounting" | "inventory" | "hr" | "pos",
    policy: envelope.policy as Record<string, unknown>,
    policyVersion: envelope.policyVersion + 1,
    effectiveFrom: envelope.effectiveFrom,
    einvoice: true,
  });

  const taxCtx = { tenantId: s.tenant, actorId: s.human, requestId: "einvoice-tax-seed" };
  for (const a of [
    { code: "2300", nameEn: "Output tax payable", type: "liability" },
    { code: "1350", nameEn: "Input tax receivable", type: "asset" },
  ] as const) {
    const [exists] = await withTenant(
      db.rw,
      taxCtx,
      (tx) =>
        tx<
          { id: string }[]
        >`select id from app.account where company_id = ${s.company} and code = ${a.code}`,
    );
    if (!exists) await seedAccount(db, s, a);
  }
  const [existing] = await withTenant(
    db.rw,
    taxCtx,
    (tx) => tx<{ taxCodeId: string; regimeId: string }[]>`
    select id as "taxCodeId", regime_id as "regimeId" from app.tax_code where company_id = ${s.company} and code = 'SYN-OUT-STD'`,
  );
  const { taxCodeId, regimeId } = existing ?? (await seedTaxCode(db, s, {}));

  // A NAMED FUNCTION, not a method on the returned literal, because Task 8 appends
  // `postOptedInDocument`, which calls it. Inside an object literal a bare `transmissionOf(...)` is
  // an unbound reference and throws at run time; `this.transmissionOf(...)` would work but breaks the
  // moment a caller destructures the fixture. One function, referenced by both.
  async function transmissionOf(documentId: string): Promise<EinvoiceTransmissionRow | null> {
    const rows = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-7000-8000-000000000000" },
      (tx) => listTransmissions(tx, { companyId: s.company, limit: 200 }),
    );
    return rows.find((r) => r.documentId === documentId) ?? null;
  }

  return {
    arAp,
    optedInTypeId,
    taxCodeId,
    regimeId,
    transmissionOf,
    // the three bodies, appended inside einvoiceFixture's returned object
    async postOptedInDocument() {
      // `postFromPack`'s options are 4B's (`code`, not `typeCode`) with 5A amendment A13a's
      // `computeTax`; its `lines` are 3C's `DraftLine`, which carries `accountId` (never an
      // `accountCode`) and gained `taxCodeId` in 5A's Task 3. `ArApFixture` exposes its parties as
      // `partyIds.customer` and its accounts as `accountIds`, keyed by ACCOUNT CODE (4B).
      const { documentId } = await postFromPack(db, s, {
        code: OPTED_IN_TYPE_CODE,
        effectiveDate: "2026-01-15",
        partyId: arAp.partyIds.customer,
        computeTax: true,
        lines: [
          {
            lineNo: 1,
            kind: "account",
            accountId: arAp.accountIds["4000"]!,
            amount: "1000.0000",
            taxCodeId,
          },
        ],
        // 3B's recording client, so step 14's enqueue is observable and, more to the point, so the
        // post does NOT push `einvoice_enqueue_skipped` onto its warnings (amendment 3).
        jobs: recordingJobs(),
      });
      const row = await transmissionOf(documentId);
      if (row === null) {
        throw new Error(
          `einvoiceFixture: no transmission row for ${documentId} — the three gates did not all hold`,
        );
      }
      return { documentId, transmissionId: row.id };
    },
    async driveToAccepted(transmissionId: string) {
      // §4.1: `uuidv7(sql: Sql): Promise<string>` — the frozen Plan 0A helper, awaited, never called
      // with no argument. These are the two calls the job makes, in the job's order, so a route test
      // never reimplements the state machine.
      const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
      await submitTransmission(db.rw, ctx, { transmissionId });
      await pollTransmission(db.rw, ctx, { transmissionId });
    },
    async twoTaxReturns() {
      const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
      return withTenant(db.rw, ctx, async (tx) => {
        const gen = await createTaxReturn(tx, ctx, {
          companyId: s.company,
          regimeId,
          periodStart: "2026-01-01",
          periodEnd: "2026-03-31",
        });
        await generateTaxReturn(tx, ctx, gen.id);
        const draft = await createTaxReturn(tx, ctx, {
          companyId: s.company,
          regimeId,
          periodStart: "2026-04-01",
          periodEnd: "2026-06-30",
        });
        return { taxReturnId: gen.id, draftReturnId: draft.id };
      });
    },
  };
}
