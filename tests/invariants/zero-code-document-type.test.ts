import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  grantCodes,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "@dulja/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `startApi()` lives in `apps/api/test/support/app.ts` (§4.2.12). There is no `tests/support/app.ts`; 0B's
// own `tests/support/api.ts` and `tests/invariants/tenant-isolation.test.ts` import it by exactly this
// relative path, under the named `dependency-rule` allowance §4.17.1 describes, so this file adds no new
// crossing and no new allowance.
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { pdfText } from "../support/pdf";
import { REPO_ROOT, sourceFiles } from "../support/source";
// Same tier, same directory: 3B's helper reopens the months `seedTenant` does not create, which the 3C
// block below needs because its document is dated August (§4.17.1; no new dependency-rule allowance).
import { ensureOpenPeriods } from "./support/post-inventory";
// No `withTenant` import, and that is deliberate: every direct read below is an assertion about a row the
// API has just written, so it uses `api.db.admin`. If a later slice appends a block that needs a tenant
// session, it imports the PRODUCTION three-argument `withTenant(sql, ctx, fn)` from `@dulja/db` (contracts
// §4.2.2; hazard 15 — "root `tests/` use the production one"), never the four-argument test helper of §4.1,
// which belongs to `packages/db/test/harness.ts`.

const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const envelope = JSON.parse(
  readFileSync(join(FIXTURES, "document-types/CONSIGNMENT_RETURN.json"), "utf8"),
) as {
  code: string;
  nameEn: string;
  nameAr: string;
  module: string;
  policyVersion: number;
  effectiveFrom: string;
  policy: unknown;
};
const manifest = JSON.parse(
  readFileSync(join(FIXTURES, "templates/CONSIGNMENT_RETURN.standard.v1.json"), "utf8"),
) as {
  code: string;
  version: number;
  nameEn: string;
  nameAr: string;
  engine: string;
  paper: string;
  labels: { en: Record<string, string>; ar: Record<string, string> };
};
const templateBody = readFileSync(
  join(FIXTURES, "templates/CONSIGNMENT_RETURN.standard.v1.html"),
  "utf8",
);

describe("Part VI test 15 — a new document type is added with ZERO CODE (spec:2433)", () => {
  let api: StartedApi;
  let s: Seed;
  let documentTypeId: string;
  let documentId: string;

  beforeAll(async () => {
    // Its own instance: this suite creates a document type and a series, and §4.17.1's `sharedApi` is
    // shared with every other file in the tier. `fullRegression` is declarative (a record of cases) and is
    // for `tests/regression/`, not for an ordered invariant sequence like this one.
    api = await startApi();
    s = await seedTenantV2(api.db, "Alpha");
    // The six codes the sequence below needs and no others. `1000` and `4000` were created by `seedTenantV2`
    // (§4.1's pinned constants, `s.cash` and `s.sales`); this slice seeds no account (§4.15: 2C seeds none).
    await grantCodes(api.db, s, {
      codes: [
        "admin.company.manage",
        "accounting.journal.create",
        "accounting.journal.post",
        "accounting.document.reverse",
        "accounting.report.read",
        "accounting.ledger.read",
      ],
    });
  }, 240_000);
  afterAll(async () => {
    await api.stop();
  });

  // ── 1. Define it. Three HTTP calls, three files of JSON and HTML, no release. ─────────────────────

  it("creates the document type from the envelope, through the API", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/document-types`,
      as: s.human,
      body: {
        code: envelope.code,
        nameEn: envelope.nameEn,
        nameAr: envelope.nameAr,
        module: envelope.module,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; code: string; module: string };
    expect(body.code).toBe("CONSIGNMENT_RETURN");
    // §4.5.8's download gate reads this column; the envelope sets it, never the default (hazard 34).
    expect(body.module).toBe("accounting");
    documentTypeId = body.id;
  });

  it("creates policy version 1 from the envelope's policy member", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/document-types/${documentTypeId}/policies`,
      as: s.human,
      body: {
        version: envelope.policyVersion,
        effectiveFrom: envelope.effectiveFrom,
        definition: envelope.policy,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { version: number; effectiveFrom: string };
    expect(body).toMatchObject({ version: 1, effectiveFrom: "2026-01-01" });
  });

  it("creates the print template from the manifest and the body", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/print-templates`,
      as: s.human,
      body: {
        documentTypeCode: envelope.code,
        code: manifest.code,
        version: manifest.version,
        nameEn: manifest.nameEn,
        nameAr: manifest.nameAr,
        engine: manifest.engine,
        paper: manifest.paper,
        labels: manifest.labels,
        body: templateBody,
      },
    });
    expect(res.status).toBe(201);
  });

  // ── 2. It numbers. ────────────────────────────────────────────────────────────────────────────────

  it("numbers: the first CONSIGNMENT_RETURN takes CR-1 on issue", async () => {
    // 1A's `CreateDocumentBody` carries `lines` (min 1) and `LineInput` takes `accountId`, never a code — the
    // code→id resolution belongs to the caller, and 2A dropped 1A's `JOURNAL`-only literal on
    // `documentTypeCode`, which is what lets this line name a type no release knows.
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents`,
      as: s.human,
      body: {
        documentTypeCode: "CONSIGNMENT_RETURN",
        effectiveDate: "2026-01-15",
        currency: "MYR",
        branchId: s.hq,
        lines: [
          {
            lineNo: 1,
            accountId: s.sales,
            description: "Goods returned to consignor",
            debit: "90.0000",
          },
          { lineNo: 2, accountId: s.cash, description: "Consignment clearing", credit: "90.0000" },
        ],
      },
    });
    expect(created.status).toBe(201);
    documentId = ((await created.json()) as { id: string }).id;

    const issued = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as: s.human,
      body: { to: "issued" },
    });
    expect(issued.status).toBe(200);
    // `TransitionResult.number` is a `bigint` in TypeScript, so it crosses the wire as a STRING — 1B's
    // `LedgerRowSchema.number` is `z.string().nullable()` for the same reason.
    const body = (await issued.json()) as { number: string; series: string };
    expect(body.number).toBe("1");
    expect(body.series).toBe("CR");

    const [row] = await api.db.admin<{ series: string; number: string }[]>`
      select series, number::text from app.document where id = ${documentId}`;
    expect(row!.series).toBe("CR");
    expect(row!.number).toBe("1");
  });

  // ── 3. It posts. ──────────────────────────────────────────────────────────────────────────────────

  it("posts: two balanced ledger entries, tagged with the policy that produced them", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as: s.human,
      body: { to: "posted" },
    });
    expect(res.status).toBe(200);

    const rows = await api.db.admin<{ debit: string; credit: string; policy: string }[]>`
      select debit::text, credit::text, posting_policy_id as policy
        from app.ledger_entry where document_id = ${documentId} order by line_no`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.debit)).toEqual(["90.0000", "0.0000"]);
    expect(rows.map((r) => r.credit)).toEqual(["0.0000", "90.0000"]);
    // Every entry is pinned to the policy version that produced it (SAH-013).
    expect(new Set(rows.map((r) => r.policy)).size).toBe(1);
  });

  // ── 4. It prints — both directions, from one template row. ────────────────────────────────────────

  it("prints: a PDF in each direction, with that direction's labels and nothing else", async () => {
    const seen: Record<string, string> = {};
    for (const lang of ["en", "ar"] as const) {
      const res = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${documentId}/print`,
        as: s.human,
        body: { lang },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      seen[lang] = (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
    }
    expect(seen["en"]).toContain("Consignment Return");
    expect(seen["en"]).toContain("CR-1");
    expect(seen["en"]).toContain("Debit");
    expect(seen["ar"]).toContain("مرتجع أمانة");
    expect(seen["ar"]).toContain("مدين");
    expect(seen["ar"]).not.toContain("Debit");
    for (const lang of ["en", "ar"] as const) expect(seen[lang]).toContain("90.0000");
  }, 180_000);

  // ── 5. It reports — in 1B's ledger, under 1B's code, with no report code added. ───────────────────

  it("reports: the entries appear in accounting.ledger with the type's own code", async () => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path:
        `/v1/companies/${s.company}/reports/accounting.ledger` +
        `?accountId=${s.sales}&fromDate=2026-01-01&toDate=2026-12-31&limit=50`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        documentTypeCode: string;
        series: string;
        number: string | null;
        debit: { amount: string };
      }[];
    };
    const mine = body.items.filter((i) => i.documentTypeCode === "CONSIGNMENT_RETURN");
    expect(mine).toHaveLength(1);
    // `number` is `z.string().nullable()` in 1B's `LedgerRowSchema` — a bigint on the wire is a string.
    expect(mine[0]).toMatchObject({ series: "CR", number: "1" });
    expect(mine[0]!.debit.amount).toBe("90.0000");
  });

  // ── 6. It reverses — producing its own type, and marking the original. ────────────────────────────

  it("reverses: a second CONSIGNMENT_RETURN with the sides swapped; the original becomes reversed", async () => {
    // 2026-01-20 sits inside 2026-01, the only open period `seedTenant` creates (§4.1).
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/reverse`,
      as: s.human,
      body: { effectiveDate: "2026-01-20", reason: "Consignor rejected the return" },
    });
    // 200, not 201: 2B's `POST …/reverse` declares `200 Reversed` (the committed openapi.json and the 2B
    // plan's Task 8 expectations); the reversing document is a side effect of an action on this resource.
    expect(res.status).toBe(200);
    const { reversalDocumentId } = (await res.json()) as {
      reversalDocumentId: string;
      number: string;
    };

    const [reversal] = await api.db.admin<
      { code: string; series: string; number: string; status: string }[]
    >`
      select dt.code, d.series, d.number::text, d.status
        from app.document d join app.document_type dt on dt.id = d.document_type_id
       where d.id = ${reversalDocumentId}`;
    expect(reversal).toMatchObject({
      code: "CONSIGNMENT_RETURN",
      series: "CR",
      number: "2",
      status: "posted",
    });

    const [original] = await api.db.admin<{ status: string }[]>`
      select status from app.document where id = ${documentId}`;
    expect(original!.status).toBe("reversed");

    // The two documents net to zero on every account — D13's whole point.
    const nets = await api.db.admin<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net
        from app.ledger_entry where document_id in (${documentId}, ${reversalDocumentId})
       group by account_id`;
    expect(nets).toHaveLength(2);
    expect(nets.every((r) => Number(r.net) === 0)).toBe(true);
  });

  it("leaves the CR series gapless — app.series_gaps returns nothing (2B, §4.5.5)", async () => {
    const [doc] = await api.db.admin<{ period: string }[]>`
      select fiscal_period_id as period from app.document where id = ${documentId}`;
    const gaps = await api.db.admin<{ number: string }[]>`
      select number::text from app.series_gaps(${s.company}, 'CR', ${doc!.period})`;
    expect(gaps).toEqual([]);
  });

  // ── 7. ZERO CODE — the clause no earlier slice could assert. ─────────────────────────────────────

  it("mentions the type in no application source file — the literal lives only under tests/", () => {
    // `sourceFiles(roots?)` returns `SourceFile[]` — `{ path, text, lines }`, path repo-relative with forward
    // slashes (0B, tests/support/source.ts) — so this reads `.text`, not the filesystem.
    //
    // Filtered to `**/src/**`: the claim is about APPLICATION code. A slice's own tests may legitimately name
    // the type (2A's zero-code API test does), and `sourceFiles`' walk does not exclude `test/` directories,
    // so an unfiltered sweep would fail on a test and say nothing about whether a release was needed.
    const offenders = sourceFiles(["apps", "packages"])
      .filter((f) => /(^|\/)src\//.test(f.path))
      .filter((f) => f.text.includes("CONSIGNMENT_RETURN"))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  // There is deliberately NO assertion here about `DOCUMENT_STAGE_CODES`. §4.2.7 fixes `apps/api`'s exports
  // as `{ ".": "./src/app.ts", "./routes": "./src/routes/index.ts" }` and states that the `tests` tier
  // imports `@dulja/api` only through those, never a route file (§3.1) — so importing the constant from
  // `apps/api/src/routes/accounting/documents` would fail the `dependency-rule` lint. The claim it was making
  // ("the policy's `approval.post` names a catalogue code, and no new code was needed") is already enforced
  // at build time by the bidirectional `permission-catalogue` lint 2A ships (§3.6.3).

  it("needed no new report code: the type appears under 1B's accounting.ledger, unchanged", () => {
    // 1B ships `ReportCodeSchema` in `packages/contracts/src/accounting/reports.ts` (1B Task 10).
    const reportCodes = readFileSync(
      join(REPO_ROOT, "packages/contracts/src/accounting/reports.ts"),
      "utf8",
    );
    expect(reportCodes).not.toMatch(/consignment/i);
  });

  // ── 8. 3C — the same code gains a STOCK EFFECT as policy version 2, still with zero code. ─────────
  //
  // 2C deferred this half (2c:5202, §4.14's CONSIGNMENT_RETURN row): `accounting.purchase.post` is 3C's
  // code and `validatePolicy` refuses an approval code absent from the catalogue (F-21), while
  // `inventory.effect: "receipt"` needs `app.warehouse`, `app.item` and `app.cost_layer`. All four exist
  // now. This block is nested inside 2C's describe deliberately — it reuses that block's `api`, `s` and
  // `documentTypeId`, and vitest runs a nested describe after the enclosing block's own cases, which is
  // the ordering the "created by the version-1 block" reuse depends on.
  describe("acceptance test 15 — the inventory-bearing shape, added as policy version 2 (3C)", () => {
    let v2DocumentId = "";
    let v2ItemId = "";

    beforeAll(async () => {
      // 3C Task 2's two codes, granted as their own role: `grantCodes` creates one role per call, so this
      // is additive to the six the outer block granted and rewrites none of them.
      await grantCodes(api.db, s, {
        codes: ["accounting.purchase.create", "accounting.purchase.post"],
      });
    }, 60_000);

    it("accepts version 2 with a stock effect, over the API, with zero code", async () => {
      const v2 = JSON.parse(
        readFileSync(join(FIXTURES, "document-types/CONSIGNMENT_RETURN.v2.json"), "utf8"),
      ) as { code: string; policyVersion: number; effectiveFrom: string; policy: unknown };
      const res = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/document-types/${documentTypeId}/policies`,
        as: s.human,
        idempotencyKey: "cr-v2",
        body: {
          version: v2.policyVersion,
          effectiveFrom: v2.effectiveFrom,
          definition: v2.policy,
        },
      });
      expect(res.status).toBe(201);

      // Both versions are live, each on its own side of effectiveFrom (§4.4.1's versioning).
      const versions = await api.request({
        method: "GET",
        path: `/v1/companies/${s.company}/document-types/${documentTypeId}/policies`,
        as: s.human,
      });
      const listed = (await versions.json()) as {
        items: { version: number; effectiveFrom: string }[];
      };
      expect(listed.items.map((i) => [i.version, i.effectiveFrom])).toEqual([
        [1, "2026-01-01"],
        [2, "2026-07-01"],
      ]);
    });

    it("a document dated after effectiveFrom takes stock in, creates a layer and numbers in the same CR series", async () => {
      // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1), and `planMovements` refuses a declared
      // receipt of a lot-tracked item whose line names no lot (ERR_POLICY_REQUIRES_MISSING, a 422).
      const { itemId, baseUnitId } = await seedItem(api.db, s, {
        code: "CR-ITEM",
        trackLots: false,
      });
      const warehouseId = await seedWarehouse(api.db, s, { code: "CR-WH" });
      const partyId = await seedParty(api.db, s, { kind: "vendor", code: "CR-CONSIGNOR" });
      await ensureOpenPeriods(api.db, s, 2026); // August is not one of 0A's three periods
      v2ItemId = itemId;

      const created = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents`,
        as: s.human,
        idempotencyKey: "cr-v2-doc",
        body: {
          documentTypeCode: "CONSIGNMENT_RETURN",
          effectiveDate: "2026-08-05",
          currency: "MYR",
          branchId: s.hq,
          partyId,
          lines: [
            {
              lineNo: 1,
              kind: "item",
              itemId,
              unitId: baseUnitId,
              unitQuantity: "6.000000",
              warehouseId,
              quantity: "6.000000",
              unitPrice: "25.0000",
              amount: "150.0000",
            },
            {
              lineNo: 2,
              kind: "account",
              accountId: s.cash,
              description: "Consignment clearing",
              amount: "150.0000",
            },
          ],
        },
      });
      expect(created.status).toBe(201);
      const { id: v2Id } = (await created.json()) as { id: string };
      v2DocumentId = v2Id;

      // `POST …/documents/{id}/transitions` with `{ to: "posted" }`. There is no `…/post` sub-path, and
      // §4.5.4 makes `to = "posted"` the thing that calls `postDocument`, which issues the draft on the way
      // (post.ts step 7). 2C's own block posts the same way.
      const posted = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${v2Id}/transitions`,
        as: s.human,
        idempotencyKey: "cr-v2-post",
        body: { to: "posted" },
      });
      expect(posted.status).toBe(200);
      // `TransitionResultSchema` (1A) is `{ documentId, status, number, series, fiscalPeriodId,
      // ledgerEntryIds }` — there is no `postingPolicyVersion` member on it, or on any declared schema.
      const body = (await posted.json()) as { status: string; number: string; series: string };
      expect(body).toMatchObject({ status: "posted", series: "CR" });

      // The pin is read where §4.3.2 step 13 writes it: `app.document.posting_policy_id`. Version 2, because
      // the document is dated after July and `resolvePolicy` picks the row effective on `effective_date`.
      const [pinned] = await api.db.admin<{ version: number }[]>`
        select p.version from app.posting_policy p
          join app.document d on d.posting_policy_id = p.id
         where d.id = ${v2Id}`;
      expect(pinned!.version).toBe(2);

      const [layer] = await api.db.admin<{ unit_cost: string; qty_in: string }[]>`
        select l.unit_cost::text as unit_cost, l.qty_in::text as qty_in
          from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
         where m.document_id = ${v2Id}`;
      expect(layer).toEqual({ unit_cost: "25.0000", qty_in: "6.000000" });
      const [onHand] = await api.db.admin<{ quantity: string }[]>`
        select quantity::text as quantity from app.stock_on_hand where item_id = ${itemId}`;
      expect(onHand!.quantity).toBe("6.000000");
    }, 180_000);

    it("and still prints, reports and reverses — the clauses test 15 names, now with stock", async () => {
      expect(v2DocumentId).not.toBe(""); // the previous case posted it

      const pdf = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${v2DocumentId}/print`,
        as: s.human,
        body: { lang: "en" },
      });
      expect(pdf.status).toBe(200);
      expect((await pdfText(new Uint8Array(await pdf.arrayBuffer()))).join(" ")).toContain(
        "Consignment Return",
      );

      const report = await api.request({
        method: "GET",
        as: s.human,
        path:
          `/v1/companies/${s.company}/reports/accounting.ledger` +
          `?accountId=${s.cash}&fromDate=2026-08-01&toDate=2026-08-31&limit=50`,
      });
      expect(report.status).toBe(200);
      const rows = (await report.json()) as { items: { documentId: string }[] };
      expect(rows.items.map((i) => i.documentId)).toContain(v2DocumentId);

      const reversed = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${v2DocumentId}/reverse`,
        as: s.human,
        idempotencyKey: "cr-v2-rev",
        body: { effectiveDate: "2026-08-20", reason: "consignor recalled the return" },
      });
      expect(reversed.status).toBe(200); // 2B's route declares 200 — see the version-1 reversal above
      // The reversal is an ISSUE of the same goods, valued from the copied l.cost (3C Task 8 branch 1) — so
      // stock returns to zero and the layer is fully consumed rather than left half-costed.
      const [onHand] = await api.db.admin<{ quantity: string }[]>`
        select coalesce(sum(h.quantity), 0)::text as quantity
          from app.stock_on_hand h where h.item_id = ${v2ItemId}`;
      expect(onHand!.quantity).toBe("0.000000");
    }, 180_000);

    // There is deliberately NO second zero-code assertion here. The version-1 block's `sourceFiles` sweep
    // above already makes the claim over the whole application tree, and version 2 adds no literal to it —
    // two spellings of one assertion is the duplication §4.17.1 exists to prevent (the task's own
    // instruction: "if 2C's block already has an equivalent zero-code check, call that one").
  });
});
