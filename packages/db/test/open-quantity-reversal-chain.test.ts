// packages/db/test/open-quantity-reversal-chain.test.ts — code review 3, R9 (migration 0116). A fulfilment's
// claim on its source line is released while its REVERSAL CHAIN nets, not merely while it reads 'reversed'.
// 0037's app.document_open_quantity and the over-fulfilment guard released a reversed return outright, so once
// the return's reversal was itself reversed (depth 2 — 0048's "an ordinary live document of its kind") the
// receipt showed all ten units open while three were out with the vendor, and a second return was linked
// against the three already taken (LEGACY-017). reverseDocument's guard follows the chain since code review 2
// (F1); this is the data layer's half. A claim that comes back by a status flip — reversing R1 after a second
// return took the released quantity — is bounded too, in either order of a race, and so is one brought back by
// a draft that joins the chain. The rollback case proves 0116.down.sql restores 0037's view and 0110's guard
// verbatim.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureOpenPeriods, recordingJobs } from "../../../tests/invariants/support/post-inventory";
import {
  issueDocument,
  linkFulfilment,
  postDocument,
  reverseDocument,
  voidDocument,
  type JobClient,
} from "../src/index";
import { down, listApplied, up } from "../src/migrate";
import { chartOfAccountsLoader } from "../src/seed/chart-of-accounts";
import { documentTypesLoader, type SubPack } from "../src/seed/index";
import {
  draftTypedDocument,
  grantCodes,
  MIGRATIONS_DIR,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "./index";

const PACK_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "seed", "my");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-0000000000a9",
});

const loaderCtx = (seed: Seed, only: readonly SubPack[]) => ({
  config: {
    tenantId: seed.tenant,
    only,
    packRoot: PACK_ROOT,
    appEnv: "dev" as const,
    tenantName: "r9",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "r9 HQ",
    baseCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: 1,
    fiscalYear: 2026,
  },
  tenantId: seed.tenant,
  companyId: seed.company,
  systemPrincipalId: seed.system,
  packRoot: PACK_ROOT,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "R9");
  await grantCodes(db, s, {
    codes: [
      "accounting.purchase.create",
      "accounting.purchase.post",
      "inventory.receipt.create",
      "inventory.receipt.post",
    ],
  });
  // chart-of-accounts before document-types and before `seedParty` (the vendor's 2100 resolves from it).
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])),
  );
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])),
  );
  partyId = await seedParty(db, s, { kind: "vendor", code: "R9-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "R9-WH" });
  await ensureOpenPeriods(db, s, 2026);
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}

const reverse = (documentId: string, effectiveDate: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    reverseDocument(tx, ctx(s), { documentId, effectiveDate, reason: "R9", jobs: recordingJobs() }),
  );

/** One item's receipts and returns against GR1, the receipt every return in a case is linked to. */
async function scenario(code: string, olderStock = false) {
  const { itemId, baseUnitId } = await seedItem(db, s, { code, trackLots: false });
  const line = (quantity: string, amount: string) => ({
    kind: "item" as const,
    itemId,
    unitId: baseUnitId,
    warehouseId,
    quantity,
    unitPrice: "12.0000",
    amount,
  });
  const receive = async (quantity: string, amount: string) => {
    const doc = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("GOODS_RECEIPT"),
      series: "GRN",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-01",
      lines: [line(quantity, amount)],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: doc.documentId, jobs: recordingJobs() }),
    );
    return doc;
  };
  const draftReturn = (quantity: string, amount: string) =>
    typeId("PURCHASE_RETURN").then((documentTypeId) =>
      draftTypedDocument(db, s, {
        documentTypeId,
        series: "PR",
        partyId,
        warehouseId,
        effectiveDate: "2026-06-10",
        lines: [line(quantity, amount)],
      }),
    );
  // GR1 is the receipt the returns are against; GR2 keeps stock positive throughout, so no negative-stock
  // refusal can stand in for the guard's.
  if (olderStock) await receive("5.000000", "60.0000");
  const gr1 = await receive("10.000000", "120.0000");
  if (!olderStock) await receive("5.000000", "60.0000");
  const linkIn = (tx: Sql, ret: { documentId: string; lineIds: string[] }, quantity: string) =>
    linkFulfilment(tx, ctx(s), {
      sourceDocumentId: gr1.documentId,
      targetDocumentId: ret.documentId,
      linkKind: "returns",
      lines: [{ sourceLineId: gr1.lineIds[0]!, targetLineId: ret.lineIds[0]!, quantity }],
    });
  const linkReturn = (ret: { documentId: string; lineIds: string[] }, quantity: string) =>
    withTenant(db.rw, s.tenant, s.human, (tx) => linkIn(tx, ret, quantity));
  const post = (documentId: string) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );
  const state = async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ open: string; linked: string; on_hand: string }[]>`
        select (select open_quantity::text from app.document_open_quantity
                 where document_line_id = ${gr1.lineIds[0]!}) as open,
               (select linked_quantity::text from app.document_open_quantity
                 where document_line_id = ${gr1.lineIds[0]!}) as linked,
               (select coalesce(sum(quantity), 0)::numeric(19,6)::text from app.stock_on_hand
                 where company_id = ${s.company} and item_id = ${itemId}) as on_hand`,
    );
    return row;
  };
  const status = async (documentId: string) => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string }[]>`
        select status::text as status from app.document where id = ${documentId}`,
    );
    return row?.status;
  };
  return { gr1, draftReturn, linkIn, linkReturn, post, state, status };
}

/**
 * The first return (3, linked and posted) and its reversal R1 (depth 1), which nets it: GR1's claim is
 * released and all ten units read open again. What a case does next decides whether reversing R1 — which
 * reinstates the return's three — still fits in GR1's ten.
 */
async function returnedAndNetted(code: string, olderStock = false) {
  const sc = await scenario(code, olderStock);
  const first = await sc.draftReturn("3.000000", "36.0000");
  await sc.linkReturn(first, "3.000000");
  await sc.post(first.documentId);
  const r1 = await reverse(first.documentId, "2026-06-11");
  expect(await sc.state()).toEqual({ open: "10.000000", linked: "0.000000", on_hand: "15.000000" });
  return { ...sc, first, r1 };
}

/**
 * Resolves once some backend is waiting on an advisory lock — B, queued behind A. Which key B waits on depends
 * on the order: the source line's `document_link:` key, or the audit chain's `tenant-serial:` key (0010),
 * which every audited write takes. The second does NOT close the race by itself: a link reads its sum under
 * the line's key BEFORE its audited insert, so it read R1 as still posted while the reversal was uncommitted.
 */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_locks where not granted and locktype = 'advisory'`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second transaction never waited on the first");
}

/**
 * Run `a` in one transaction and hold it open; start `b` in another; once B waits on a lock A holds, commit
 * A. Returns B's outcome, its error message when it raised one.
 */
async function overlap(
  a: (tx: Sql) => Promise<unknown>,
  b: (tx: Sql) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let ran!: () => void;
  let release!: () => void;
  const aRan = new Promise<void>((resolve) => (ran = resolve));
  const aReleased = new Promise<void>((resolve) => (release = resolve));
  const first = withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await a(tx);
    ran();
    await aReleased;
  });
  await aRan;
  const second = withTenant(db.rw, s.tenant, s.human, (tx) => b(tx)).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, message: String(error) }),
  );
  try {
    await someoneWaits();
  } finally {
    release();
  }
  await first;
  return second;
}

/** A promise's outcome as data: `{ ok: true }`, or `{ ok: false }` and its error's message. */
const outcomeOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ ok: true as const, message: "" }),
    (error: unknown) => ({ ok: false as const, message: String(error) }),
  );

const OVER = /ERR_DOC_LINK_OVER_FULFILLED/;

describe("R9 — open quantity follows the fulfilment's reversal chain (0116)", () => {
  it("GR1 10 → PR 3 → reverse PR → reverse the reversal: GR1 shows 7 open and a return of 8 is refused", async () => {
    const { draftReturn, linkReturn, post, state } = await scenario("R9-ITEM");
    const ret = await draftReturn("3.000000", "36.0000");
    await linkReturn(ret, "3.000000");
    await post(ret.documentId);
    expect(await state()).toEqual({ open: "7.000000", linked: "3.000000", on_hand: "12.000000" });

    // R1 (depth 1) nets the return: its three units come back and GR1's claim is released, as under 0037.
    const r1 = await reverse(ret.documentId, "2026-06-11");
    expect(await state()).toEqual({ open: "10.000000", linked: "0.000000", on_hand: "15.000000" });

    // R2 (depth 2) reinstates the return — the three units go back to the vendor while the return itself
    // still reads 'reversed'. The claim stands again.
    const r2 = await reverse(r1.reversalDocumentId, "2026-06-12");
    expect(await state()).toEqual({ open: "7.000000", linked: "3.000000", on_hand: "12.000000" });
    const [chain] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ ret: string; r2: string; depth: number; stands: boolean }[]>`
        select (select status::text from app.document where id = ${ret.documentId}) as ret,
               (select status::text from app.document where id = ${r2.reversalDocumentId}) as r2,
               app.document_reversal_depth(${r2.reversalDocumentId}) as depth,
               app.document_claim_stands(${ret.documentId}) as stands`,
    );
    expect(chain).toEqual({ ret: "reversed", r2: "posted", depth: 2, stands: true });

    // A second return of 8 against GR1 would return units R2 already took: the guard refuses it.
    const second = await draftReturn("8.000000", "96.0000");
    await expect(linkReturn(second, "8.000000")).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* has 7\.000000 open of 10\.000000 ordered; 8\.000000 requested/,
    );

    // R3 (depth 3) nets the chain again: the claim is released and the same return of 8 now links.
    await reverse(r2.reversalDocumentId, "2026-06-13");
    expect(await state()).toEqual({ open: "10.000000", linked: "0.000000", on_hand: "15.000000" });
    await linkReturn(second, "8.000000");
    expect(await state()).toEqual({ open: "2.000000", linked: "8.000000", on_hand: "15.000000" });
  });

  // The other order of the same two steps. The link guard fires only on app.document_link, so once a second
  // return had taken the released quantity, reversing R1 brought the first return's three back on top of it
  // with nothing to check the bound: GR1 read 11 returned against 10 received, open −1.
  it("link first, then reinstate: reversing R1 after a return of 8 took the released quantity is refused", async () => {
    const sc = await returnedAndNetted("R9-LINK-FIRST");
    const second = await sc.draftReturn("8.000000", "96.0000");
    await sc.linkReturn(second, "8.000000");
    await sc.post(second.documentId);
    expect(await sc.state()).toEqual({ open: "2.000000", linked: "8.000000", on_hand: "7.000000" });

    await expect(reverse(sc.r1.reversalDocumentId, "2026-06-12")).rejects.toThrow(
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* would carry 11\.000000 linked against 10\.000000 ordered/,
    );
    // The refusal rolled the whole reversal back: R1 is still posted and GR1 is as it was.
    expect(await sc.status(sc.r1.reversalDocumentId)).toBe("posted");
    expect(await sc.state()).toEqual({ open: "2.000000", linked: "8.000000", on_hand: "7.000000" });

    // The remedy: net the later return first. Its eight are released, and R1's reversal then fits.
    await reverse(second.documentId, "2026-06-12");
    expect(await sc.state()).toEqual({
      open: "10.000000",
      linked: "0.000000",
      on_hand: "15.000000",
    });
    await reverse(sc.r1.reversalDocumentId, "2026-06-13");
    expect(await sc.state()).toEqual({
      open: "7.000000",
      linked: "3.000000",
      on_hand: "12.000000",
    });
  });

  it("a reinstatement that still fits is admitted, and one that exactly fills the line is too", async () => {
    const sc = await returnedAndNetted("R9-FITS");
    const second = await sc.draftReturn("7.000000", "84.0000");
    await sc.linkReturn(second, "7.000000");
    await sc.post(second.documentId);
    await reverse(sc.r1.reversalDocumentId, "2026-06-12");
    expect(await sc.state()).toEqual({
      open: "0.000000",
      linked: "10.000000",
      on_hand: "5.000000",
    });
  });

  // LEGACY-017's concurrency face, both ways round. Each side takes the source line's advisory lock before it
  // reads, so whichever commits second sees the other's work and refuses.
  it("a link racing the reinstating reversal: the reversal waits for the link, then refuses", async () => {
    const sc = await returnedAndNetted("R9-RACE-LINK");
    const second = await sc.draftReturn("8.000000", "96.0000");
    const outcome = await overlap(
      (tx) => sc.linkIn(tx, second, "8.000000"),
      (tx) =>
        reverseDocument(tx, ctx(s), {
          documentId: sc.r1.reversalDocumentId,
          effectiveDate: "2026-06-12",
          reason: "R9 race",
          jobs: recordingJobs(),
        }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.message).toMatch(OVER);
    expect(await sc.status(sc.r1.reversalDocumentId)).toBe("posted");
    expect(await sc.state()).toEqual({
      open: "2.000000",
      linked: "8.000000",
      on_hand: "15.000000",
    });
  });

  it("the reinstating reversal racing a link: the link waits for the reversal, then refuses", async () => {
    const sc = await returnedAndNetted("R9-RACE-REVERSE");
    const second = await sc.draftReturn("8.000000", "96.0000");
    const outcome = await overlap(
      (tx) =>
        reverseDocument(tx, ctx(s), {
          documentId: sc.r1.reversalDocumentId,
          effectiveDate: "2026-06-12",
          reason: "R9 race",
          jobs: recordingJobs(),
        }),
      (tx) => sc.linkIn(tx, second, "8.000000"),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.message).toMatch(OVER);
    expect(await sc.status(sc.r1.reversalDocumentId)).toBe("reversed");
    expect(await sc.state()).toEqual({
      open: "7.000000",
      linked: "3.000000",
      on_hand: "12.000000",
    });
  });

  // Lock order. Every other writer of a link takes the source line's key before its first audited write — the
  // link guard fires BEFORE the INSERT its audit row follows, and convertToInvoice and creditNoteFrom lock their
  // lines up front — and the audit chain's per-tenant key (0010) after. A reinstating reversal that took the
  // line's key only in the flip trigger held the tenant's key from its mirror's insert on and then waited for
  // the line's, while a link held the line's and waited for the tenant's: a deadlock. The reversal is paused in
  // postDocument's step 14 (the job client), after the mirror's audited writes and before the flip.
  it("a reinstating reversal paused before its flip and a link on the same line queue, and never deadlock", async () => {
    const sc = await returnedAndNetted("R9-LOCK-ORDER");
    const second = await sc.draftReturn("2.000000", "24.0000");
    let paused!: () => void;
    let resume!: () => void;
    const atJob = new Promise<void>((resolve) => (paused = resolve));
    const go = new Promise<void>((resolve) => (resume = resolve));
    const gated: JobClient = {
      async enqueue() {
        paused();
        await go;
        return "gated";
      },
    };
    const reversal = outcomeOf(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        reverseDocument(tx, ctx(s), {
          documentId: sc.r1.reversalDocumentId,
          effectiveDate: "2026-06-12",
          reason: "R9 lock order",
          jobs: gated,
        }),
      ),
    );
    await atJob;
    const link = outcomeOf(
      withTenant(db.rw, s.tenant, s.human, (tx) => sc.linkIn(tx, second, "2.000000")),
    );
    try {
      await someoneWaits();
    } finally {
      resume();
    }
    expect(await Promise.all([reversal, link])).toEqual([
      { ok: true, message: "" },
      { ok: true, message: "" },
    ]);
    // The reinstated three and the new two both stand: 5 of GR1's 10.
    expect(await sc.state()).toEqual({
      open: "5.000000",
      linked: "5.000000",
      on_hand: "12.000000",
    });
  });

  // A claim also comes back when a live document JOINS the chain under a reversed member. No service does
  // that — reverseDocument points its mirror at a posted document, creditNoteFrom at a posted invoice — but
  // app_rw may INSERT a draft, or re-point a draft's reverses_document_id, at any document of its company. A
  // draft under R1 (itself reversed, depth 1) sits at depth 2 of the first return's chain and is live, so the
  // return's three stand again on top of the eight a later return took.
  it("a draft that joins a netted chain at even depth is refused when the reinstated claim no longer fits", async () => {
    const sc = await returnedAndNetted("R9-JOIN");
    const r2 = await reverse(sc.r1.reversalDocumentId, "2026-06-12"); // the return stands again (depth 2)
    await reverse(r2.reversalDocumentId, "2026-06-13"); // R3 nets it once more (depth 3)
    expect(await sc.state()).toEqual({
      open: "10.000000",
      linked: "0.000000",
      on_hand: "15.000000",
    });
    const second = await sc.draftReturn("8.000000", "96.0000");
    await sc.linkReturn(second, "8.000000");
    await sc.post(second.documentId);
    expect(await sc.state()).toEqual({ open: "2.000000", linked: "8.000000", on_hand: "7.000000" });

    const returnType = await typeId("PURCHASE_RETURN");
    const draftUnder = (reversesDocumentId: string | null) =>
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ id: string }[]>`
          insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                                    branch_id, party_id, warehouse_id, reverses_document_id)
          values (${s.tenant}, ${s.company}, ${returnType}, 'PR', '2026-06-14', 'MYR', ${s.hq}, ${partyId},
                  ${warehouseId}, ${reversesDocumentId})
          returning id::text as id`,
      );
    const INTO_R1 =
      /ERR_DOC_LINK_OVER_FULFILLED: source line .* would carry 11\.000000 linked against 10\.000000 ordered/;
    await expect(draftUnder(sc.r1.reversalDocumentId)).rejects.toThrow(INTO_R1);

    // Re-pointing a draft born outside the chain is the same join.
    const [stray] = await draftUnder(null);
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`
          update app.document set reverses_document_id = ${sc.r1.reversalDocumentId} where id = ${stray!.id}`,
      ),
    ).rejects.toThrow(INTO_R1);

    // A draft that joins at ODD depth (under the first return itself) nets nothing and is admitted.
    await draftUnder(sc.first.documentId);
    expect(await sc.state()).toEqual({ open: "2.000000", linked: "8.000000", on_hand: "7.000000" });
  });

  // Code review 4, item 4. A new link has a second bound besides the quantity: its source must be issued or
  // posted (0110's link guard). A claim brought back by a reversal met only the quantity bound. So: return 3
  // against GR1 and net it (R1); fully reverse GR1, which reverseDocument admits because the return's chain
  // nets; then reverse R1. On 04cf7ef that was admitted — the return's claim stood again against a receipt the
  // ledger no longer holds, the three units went back to the vendor a second time (on hand 5 → 2) and AP was
  // debited twice for them — and the view hid it, because it drops a reversed source's lines. A reinstated
  // `returns` claim is now refused against a reversed or void source. `converts_to` is not asked: a posted
  // invoice may stand against a reversed delivery by design.
  const onHandOf = async (itemCode: string) => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ on_hand: string }[]>`
        select coalesce(sum(h.quantity), 0)::numeric(19,6)::text as on_hand
          from app.stock_on_hand h join app.item i on i.id = h.item_id
         where h.company_id = ${s.company} and i.code = ${itemCode}`,
    );
    return row!.on_hand;
  };
  const REINSTATED_AGAINST =
    /ERR_DOC_STATUS_ILLEGAL: .* reinstates the returns claim of document .* against source document .*, which is (reversed|void)/;

  it("a return's claim is not reinstated against a receipt reversed since it was netted (code review 4)", async () => {
    // Consume older stock under FIFO, so the linked receipt meets the approved untouched-source rule.
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`update app.company set costing_method = 'fifo' where id = ${s.company}`,
    );
    const sc = await returnedAndNetted("R9-SOURCE-REVERSED", true);
    await reverse(sc.gr1.documentId, "2026-06-12");
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`update app.company set costing_method = 'avco' where id = ${s.company}`,
    );
    expect(await sc.status(sc.gr1.documentId)).toBe("reversed");
    expect(await onHandOf("R9-SOURCE-REVERSED")).toBe("5.000000");

    await expect(reverse(sc.r1.reversalDocumentId, "2026-06-13")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .* reinstates the returns claim of document .* against source document .*, which is reversed/,
    );
    // Rolled back whole: R1 still nets the return, and the three units never left again.
    expect(await sc.status(sc.r1.reversalDocumentId)).toBe("posted");
    expect(await sc.status(sc.first.documentId)).toBe("reversed");
    expect(await onHandOf("R9-SOURCE-REVERSED")).toBe("5.000000");
    const [stands] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ stands: boolean }[]>`
        select app.document_claim_stands(${sc.first.documentId}) as stands`,
    );
    expect(stands).toEqual({ stands: false });
  });

  it("nor against a receipt voided since, whether a reversal or a draft joining the chain reinstates it (code review 4)", async () => {
    // The void half. The link guard admits an ISSUED source, so the return is linked against a receipt that
    // was issued and never posted. Its chain is walked to depth 3 (netted) while the receipt still stands —
    // R2's reinstatement is admitted then — and the receipt is voided. Reinstating the return again, by
    // reversing R3 (depth 4) or by a draft app_rw hangs under R1 (depth 2, 0116 §4's INSERT trigger), is
    // refused.
    const { itemId, baseUnitId } = await seedItem(db, s, {
      code: "R9-SOURCE-VOID",
      trackLots: false,
    });
    const line = (quantity: string, amount: string) => ({
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      warehouseId,
      quantity,
      unitPrice: "12.0000",
      amount,
    });
    const receiptType = await typeId("GOODS_RECEIPT");
    const returnType = await typeId("PURCHASE_RETURN");
    // Stock for the return to issue from, posted; the receipt it is linked against is only issued.
    const stock = await draftTypedDocument(db, s, {
      documentTypeId: receiptType,
      series: "GRN",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-01",
      lines: [line("5.000000", "60.0000")],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: stock.documentId, jobs: recordingJobs() }),
    );
    const issued = await draftTypedDocument(db, s, {
      documentTypeId: receiptType,
      series: "GRN",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-01",
      lines: [line("10.000000", "120.0000")],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctx(s), { documentId: issued.documentId }),
    );
    const ret = await draftTypedDocument(db, s, {
      documentTypeId: returnType,
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-10",
      lines: [line("3.000000", "36.0000")],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await linkFulfilment(tx, ctx(s), {
        sourceDocumentId: issued.documentId,
        targetDocumentId: ret.documentId,
        linkKind: "returns",
        lines: [
          { sourceLineId: issued.lineIds[0]!, targetLineId: ret.lineIds[0]!, quantity: "3.000000" },
        ],
      });
      await postDocument(tx, ctx(s), { documentId: ret.documentId, jobs: recordingJobs() });
    });
    const r1 = await reverse(ret.documentId, "2026-06-11");
    const r2 = await reverse(r1.reversalDocumentId, "2026-06-12"); // the receipt stands: admitted
    const r3 = await reverse(r2.reversalDocumentId, "2026-06-13"); // nets the return again
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      voidDocument(tx, ctx(s), { documentId: issued.documentId, reason: "code review 4" }),
    );
    expect(await onHandOf("R9-SOURCE-VOID")).toBe("5.000000");

    await expect(reverse(r3.reversalDocumentId, "2026-06-14")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: .* reinstates the returns claim of document .* against source document .*, which is void/,
    );
    expect(await onHandOf("R9-SOURCE-VOID")).toBe("5.000000");
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`
          insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                                    branch_id, party_id, warehouse_id, reverses_document_id)
          values (${s.tenant}, ${s.company}, ${returnType}, 'PR', '2026-06-14', 'MYR', ${s.hq}, ${partyId},
                  ${warehouseId}, ${r1.reversalDocumentId})`,
      ),
    ).rejects.toThrow(REINSTATED_AGAINST);
  });

  it("an invisible document holds no claim, and a live one (a draft) always does", async () => {
    const doc = await draftTypedDocument(db, s, {
      documentTypeId: await typeId("PURCHASE_RETURN"),
      series: "PR",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-20",
      lines: [],
    });
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ unknown: boolean; draft: boolean }[]>`
        select app.document_claim_stands('00000000-0000-7000-8000-000000000000') as unknown,
               app.document_claim_stands(${doc.documentId}) as draft`,
    );
    expect(row).toEqual({ unknown: false, draft: true });
    // Another tenant's session cannot see the draft, so it holds nothing there (RLS, security invoker).
    const other = await seedTenantV2(db, "R9-other");
    const [foreign] = await withTenant(
      db.rw,
      other.tenant,
      other.human,
      (tx) =>
        tx<{ stands: boolean }[]>`select app.document_claim_stands(${doc.documentId}) as stands`,
    );
    expect(foreign).toEqual({ stands: false });
  });
});

/** The body between the first `$$` pair after `marker` in a migration file. */
const bodyAfter = (file: string, marker: string): string => {
  const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const from = text.indexOf(marker);
  expect(from, `${marker} in ${file}`).toBeGreaterThanOrEqual(0);
  const open = text.indexOf("$$", from) + 2;
  return text.slice(open, text.indexOf("$$", open));
};

/** 0037's view query, verbatim from the file: from `create view … as` to the end of its statement. */
const viewQuery0037 = (): string => {
  const text = readFileSync(join(MIGRATIONS_DIR, "0037_create_document_link.sql"), "utf8");
  const head = "create view app.document_open_quantity with (security_invoker = true) as";
  const from = text.indexOf(head);
  expect(from).toBeGreaterThanOrEqual(0);
  return text.slice(from + head.length, text.indexOf(";", from));
};

describe("0116 is reversible: its down restores 0037's view and 0110's guard verbatim", () => {
  it("down to 0115 → the old definitions, byte for byte; up again → the chain rule", async () => {
    const surface = async () => {
      const [row] = await db.admin<
        {
          viewdef: string;
          reloptions: string[] | null;
          guard: string;
          helper: number;
          reinstate: number;
        }[]
      >`
        select pg_get_viewdef('app.document_open_quantity'::regclass) as viewdef,
               (select reloptions from pg_class where oid = 'app.document_open_quantity'::regclass) as reloptions,
               (select prosrc from pg_proc
                 where pronamespace = 'app'::regnamespace
                   and proname = 'assert_document_link_within_open_quantity') as guard,
               (select count(*)::int from pg_proc
                 where pronamespace = 'app'::regnamespace and proname = 'document_claim_stands') as helper,
               (select count(*)::int from pg_trigger
                 where tgrelid = 'app.document'::regclass
                   and tgname in ('document_reinstated_claim_within_open_quantity',
                                  'document_reinstated_claim_on_insert_within_open_quantity'))
             + (select count(*)::int from pg_proc
                 where pronamespace = 'app'::regnamespace
                   and proname in ('assert_reinstated_claim_within_open_quantity',
                                   'document_chain_ancestors')) as reinstate`;
      const grants = await db.admin<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
         where grantee = 'app_rw' and table_schema = 'app' and table_name = 'document_open_quantity'
         order by 1`;
      return { ...row!, grants: grants.map((g) => g.privilege_type) };
    };

    const applied = await listApplied(db.migrator);
    expect(applied).toContain(116);
    const latest = await surface();
    expect(latest.helper).toBe(1);
    expect(latest.reinstate).toBe(4);
    // 0127 (ADR 0095) moved the sum, and 0116's chain rule with it, into the company-wide lookup that both the
    // view and the guard call; the rule itself is read in the lookup's body.
    expect(latest.viewdef).toContain("source_line_linked_quantity");
    expect(latest.guard).toContain(
      "app.source_line_linked_quantity(new.company_id, new.source_line_id, new.id)",
    );
    const [lookup] = await db.admin<{ src: string }[]>`
      select prosrc as src from pg_proc
       where pronamespace = 'app'::regnamespace and proname = 'source_line_linked_quantity'`;
    expect(lookup!.src).toContain("app.document_claim_stands(t.id)");

    const rolledBack = await down(db.migrator, MIGRATIONS_DIR, 115);
    expect(rolledBack).toContain(116);
    const at115 = await surface();

    // The expected view text is what Postgres deparses 0037's own query to, built in a throwaway temp view.
    const expectedViewdef = await db.admin.begin(async (tx) => {
      await tx.unsafe(
        `create temp view oq_0037 with (security_invoker = true) as ${viewQuery0037()}`,
      );
      const [v] = await tx<{ def: string }[]>`select pg_get_viewdef('oq_0037'::regclass) as def`;
      await tx.unsafe("drop view oq_0037");
      return v!.def;
    });
    expect(at115).toEqual({
      viewdef: expectedViewdef,
      reloptions: ["security_invoker=true"],
      guard: bodyAfter(
        "0110_bind_document_link_documents_to_company.sql",
        "create or replace function app.assert_document_link_within_open_quantity()",
      ),
      helper: 0,
      reinstate: 0,
      grants: ["SELECT"],
    });

    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(rolledBack.toReversed());
    expect(await surface()).toEqual(latest);
    expect(latest.reloptions).toEqual(["security_invoker=true"]);
    expect(latest.grants).toEqual(["SELECT"]);
  });
});
