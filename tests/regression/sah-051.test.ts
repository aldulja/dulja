import { seedShift } from "@dulja/db/test";
import { grantCodes, draftDocument, seedTenantV2, uuidv7 } from "@dulja/db/test";
import { sliceRegression, thinRegression } from "../support/regression";
import { issueDocument, voidDocument, transitionDocument } from "@dulja/db";

thinRegression(
  "SAH-051",
  "Document numbering races on first use, has no uniqueness constraint, and cannot be gapless",
  "packages/db/test/documents.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-051" };
    const first = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    const second = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });

    await withTenant(
      rw,
      ctx,
      (tx) =>
        tx`update app.document set number = 90001, fiscal_period_id = ${a.period} where id = ${first}`,
    );
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) =>
          tx`update app.document set number = 90001, fiscal_period_id = ${a.period} where id = ${second}`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i); // unique (company_id, series, fiscal_period_id, number)

    // And the gap is explainable rather than mysterious: a number issued and never posted has a row of its own.
    const [voidTable] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'app' and table_name = 'document_number_void'`;
    expect(voidTable!.n).toBe(1);
  },
);

sliceRegression(
  "SAH-051",
  "Numbering races, no uniqueness, cannot be gapless",
  "1A",
  "a voided number is recorded, and the same (series, period, number) can never be issued twice",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "SAH051-1A");
    await grantCodes(db, seed);
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "sah051" };
    const doc = await uuidv7(db.admin);
    await withTenant(
      rw,
      ctx,
      (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`,
    );
    const issued = await withTenant(rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: doc }));
    await withTenant(rw, ctx, (tx) =>
      voidDocument(tx, ctx, { documentId: doc, reason: "misprint" }),
    );
    const [voided] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_number_void
       where company_id = ${seed.company} and series = ${issued.series}
         and number = ${issued.number.toString()}::bigint`,
    );
    expect(voided!.n).toBe(1);

    const other = await uuidv7(db.admin);
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, number, effective_date, currency, branch_id)
        values (${other}, ${seed.tenant}, ${seed.company}, ${seed.docType}, ${issued.series}, ${issued.fiscalPeriodId},
                ${issued.number.toString()}::bigint, '2026-01-15', 'MYR', ${seed.hq})`,
      ),
    ).rejects.toThrow(/document_company_id_series_fiscal_period_id_number_key/);
  },
);

// ─── 2B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file; a later slice appends and never edits the block above.
sliceRegression(
  "SAH-051",
  "Document numbering races on first use, has no uniqueness constraint, and cannot be gapless",
  "2B",
  "a void is a recorded number, a client cannot supply one, and series_gaps proves the sequence",
  async ({ db, rw, withTenant, expect }) => {
    const s = await seedTenantV2(db, "SAH051-2B");
    await grantCodes(db, s);
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah051" };
    const make = async (): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${s.tenant}, ${s.company}, ${s.docType}, 'JV', '2026-01-15', 'MYR', ${s.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${s.tenant}, ${s.company}, ${id}, 1, ${s.cash}, 1.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${s.tenant}, ${s.company}, ${id}, 2, ${s.sales}, 1.0000)`;
      });
      return id;
    };
    const first = await make();
    const second = await make();
    await withTenant(rw, ctx, (tx) =>
      transitionDocument(tx, ctx, { documentId: first, to: "issued" }),
    );
    await withTenant(rw, ctx, (tx) =>
      transitionDocument(tx, ctx, { documentId: second, to: "issued" }),
    );
    await grantCodes(db, s, { codes: ["accounting.journal.post"], roleCode: "sah051-post" });
    await withTenant(rw, ctx, (tx) =>
      voidDocument(tx, ctx, { documentId: second, reason: "misprint" }),
    );
    // The legacy left an unrecoverable gap with no record of what occupied it. Here the record exists — that
    // is the `voided` assertion below, and it is what SAH-051 lacked — and the series is still whole, which
    // is the assertion immediately after. The second does not prove the first: `voidDocument` updates only
    // `status` and leaves `document.number` in place, so number 2 is still excluded by series_gaps' document
    // predicate. The void row's own effect on series_gaps is isolated in the `VOIDONLY` case of
    // packages/db/test/document-delete.test.ts.
    const gaps = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ number: string }[]>`
        select number::text as number from app.series_gaps(${s.company}, 'JV', ${s.period})`,
    );
    expect(gaps).toEqual([]);
    const [voided] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ number: string; reason: string }[]>`
        select number::text as number, reason from app.document_number_void
         where company_id = ${s.company} and series = 'JV' and fiscal_period_id = ${s.period}`,
    );
    expect(voided).toEqual({ number: "2", reason: "misprint" });
    // and a client-supplied number cannot survive: the number is assigned at ISSUE and the pair is unique.
    // The impostor claims the whole key the issued document holds. `make()` drafts with no
    // `fiscal_period_id` (issue assigns it), and the unique key is (company_id, series, fiscal_period_id,
    // number) — so a bare `set number = 1` on that draft collided with nothing: NULLs are distinct in a
    // unique constraint. numbering-gapless's clause 2 drafts its impostor inside the period for this reason.
    const third = await make();
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) =>
          tx`update app.document set fiscal_period_id = ${s.period}, number = 1 where id = ${third}`,
      ),
    ).rejects.toThrow(/duplicate key value/);
  },
);

import { fullRegression as posSeriesRegression } from "../support/api";
import {
  buildTicket,
  enrolTerminal,
  posFixture,
  syncRequest,
  uuidv7Sync,
} from "../invariants/support/pos";
posSeriesRegression("SAH-051", "Independent gapless till series — 6A", {
  "two terminals start at one in distinct series and retries spend no number": async ({
    api,
    expect,
  }) => {
    const f = await posFixture(api, "SAH051 POS");
    const second = await enrolTerminal(api, f.s, { as: f.cashierId, code: "KL02" });
    const secondShift = await seedShift(api.db, f.s, {
      terminalId: second.terminalId,
      cashierPrincipalId: f.cashierId,
    });
    const inputs = [f.terminal, second].map((terminal, index) => ({
      terminal,
      batch: {
        terminalId: terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [buildTicket(f, { shiftId: index === 0 ? f.shiftId : secondShift })],
        shifts: [],
        tillEvents: [],
      },
    }));
    const responses = await Promise.all(
      inputs.map(({ terminal, batch }) =>
        syncRequest(api, terminal, { method: "POST", path: "/v1/sync/tickets", body: batch }),
      ),
    );
    for (const res of responses)
      expect(((await res.json()) as { results: { status: string }[] }).results[0]!.status).toBe(
        "accepted",
      );
    const rows = await api.db.admin<
      { series: string; number: string }[]
    >`select series,number::text from app.document where company_id=${f.s.company} and terminal_id is not null order by series`;
    expect(rows).toEqual([
      { series: "POS-KL01", number: "1" },
      { series: "POS-KL02", number: "1" },
    ]);
    for (const { terminal, batch } of inputs) {
      const res = await syncRequest(api, terminal, {
        method: "POST",
        path: "/v1/sync/tickets",
        body: batch,
      });
      expect(((await res.json()) as { results: { status: string }[] }).results[0]!.status).toBe(
        "duplicate",
      );
    }
    expect(
      await api.db.admin<
        { series: string; number: string }[]
      >`select series,number::text from app.document where company_id=${f.s.company} and terminal_id is not null order by series`,
    ).toEqual(rows);
  },
});

// Public ticket references are minted offline by the shipped main-process implementation.
import { describe, it, expect } from "vitest";
import { tillUuidv7 } from "../../apps/pos/src/main/ticket";
import { sourceFiles } from "../support/source";
/** Source without its comments, so a docstring that names a forbidden call does not convict its file. */
const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:"'`])\/\/.*$/gm, "$1");
describe("SAH-051 — offline POS public identifiers — 6B", () => {
  it("tillUuidv7 is the only public-id source in apps/pos; local row ids stay in store.ts and authority.ts", () => {
    // spec:2037: the till mints each ticket's uuidv7 itself. A server-assigned id would need the network at the
    // moment of sale, and a shared or sequential counter is SAH-051 itself. `SourceFile.path` is repo-relative.
    const files = sourceFiles(["apps/pos/src"]);
    // Code, not prose: ticket.ts's own docstring explains why `crypto.randomUUID()` is wrong here, so comments
    // are stripped before the call is looked for, and the import is matched as an import.
    const importsRandomUuid =
      /import\s*\{[^}]*\brandomUUID\b[^}]*\}\s*from\s*["'](?:node:)?crypto["']/;
    expect(
      files
        .filter(
          (s) =>
            importsRandomUuid.test(s.text) ||
            /\brandomUUID\s*\(|\buuidv4\b|\bnextval\b|counter\s*\+\+|\+\+\s*counter/.test(
              withoutComments(s.text),
            ),
        )
        .map((s) => s.path),
    ).toEqual([]);
    // Local bookkeeping row ids — the outbox row and the attendance clock-event row — use the uuid package's
    // v7, never a public identifier. The list is exhaustive on purpose: a third importer is a second id source.
    const uuidImporters = files.filter((s) => /from\s*["']uuid["']/.test(s.text));
    expect(uuidImporters.map((s) => s.path).toSorted()).toEqual([
      "apps/pos/src/main/authority.ts",
      "apps/pos/src/main/store.ts",
    ]);
    for (const s of uuidImporters)
      expect(s.text, s.path).toMatch(/import\s*\{\s*v7 as uuidv7\s*\}\s*from\s*["']uuid["']/);
    expect(
      files.filter((s) => /export function tillUuidv7\b/.test(s.text)).map((s) => s.path),
    ).toEqual(["apps/pos/src/main/ticket.ts"]);
  });
  it("mints 5000 distinct version-7 references without a server counter", () => {
    const ids = Array.from({ length: 5000 }, () => tillUuidv7());
    expect(new Set(ids).size).toBe(5000);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(
      tillUuidv7(new Date("2026-01-01T00:00:00Z")) < tillUuidv7(new Date("2026-12-31T23:59:59Z")),
    ).toBe(true);
  });
});

// ─── 9B ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: appended; no block above is edited. spec:2333 (§5.1 #8): the legacy number is preserved as a
// historical STRING in legacy_ref (migration 0101), and document.number stays the gapless bigint the series owns.
sliceRegression(
  "SAH-051",
  "Document numbering races on first use, has no uniqueness constraint, and cannot be gapless",
  "9B",
  "a legacy number is kept as a string in legacy_ref, duplicates included, and never reaches document.number",
  // `expect` is the module-scope import the 6B block above brought in; destructuring it again would shadow it.
  async ({ db, rw, a, withTenant }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-051-9b" };
    const types = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name in ('legacy_ref', 'number')
       order by column_name`;
    expect(types).toEqual([
      { column_name: "legacy_ref", data_type: "text" },
      { column_name: "number", data_type: "bigint" },
    ]);
    // The legacy numbering had duplicates (SAH-051), so the index that serves a lookup by it is never unique.
    const [index] = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and indexname = 'document_legacy_ref_idx'`;
    expect(index!.indexdef).not.toContain("UNIQUE");

    // Two drafts carrying the same legacy number — one no bigint could hold — both land, and neither is numbered.
    const first = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    const second = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await withTenant(rw, ctx, async (tx) => {
      await tx`update app.document set legacy_ref = 'INV/0042-A' where id in (${first}, ${second})`;
    });
    const rows = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ legacy_ref: string; number: string | null }[]>`
        select legacy_ref, number::text as number from app.document where id in (${first}, ${second})`,
    );
    expect(rows).toEqual([
      { legacy_ref: "INV/0042-A", number: null },
      { legacy_ref: "INV/0042-A", number: null },
    ]);
  },
);

// 9B Task 7 — the behaviour, through the whole registered load (`loadFromCorpus`, contracts §4.17.1). The committed
// cut-over corpus holds two open legacy documents that SHARE the printed number `INV/2025/0417` — SAH-051's own fact;
// both load, each keeps the string in legacy_ref, and each gets its own gapless OB number from the posting service.
// Its own tenant on 0B's memoised API: the load goes INTO the fixture, because the query below reads it.
import { cutOverFixture, loadFromCorpus } from "../invariants/support/cut-over";

sliceRegression(
  "SAH-051",
  "Document numbering races on first use, has no uniqueness constraint, and cannot be gapless",
  "9B",
  "two legacy documents that share a number both load, each with its own gapless OB number",
  async ({ withTenant }) => {
    const f = await cutOverFixture("sah-051-9b");
    await loadFromCorpus(f, "cut-over");
    const rows = await withTenant(
      f.api.db.rw,
      f.ctx,
      (tx) => tx<{ legacy_ref: string; series: string; number: string }[]>`
        select d.legacy_ref, d.series, d.number::text as number from app.document d
         where d.company_id = ${f.ctx.companyId} and d.legacy_ref = 'INV/2025/0417'
         order by d.number::bigint`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.series)).toEqual(["OB", "OB"]);
    expect(new Set(rows.map((r) => r.number)).size).toBe(2);
    // No `api.stop()`: `cutOverFixture` uses the memoised `sharedApi()` (§4.17.1, §3.7.5).
  },
);
