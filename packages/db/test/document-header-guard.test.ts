// packages/db/test/document-header-guard.test.ts — code review 3, R10: app.document's header is frozen once the
// document leaves draft (migration 0117). spec:574 (SAH-041) "issued financial documents are immutable";
// spec:501, 2223 (SAH-031) "the whole document aggregate (header + lines + projections)"; spec:2049 "Financial
// rows: never — reversal only"; spec:2173 the data layer is the control. 0113 froze the lines; this is the
// header. Every case runs as `app_rw` inside `withTenant`, the role every route and job writes through, so a
// refusal here is a refusal for every path. Each red case is accepted on 381bb34, where nothing guarded it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { down, listApplied, up } from "../src/migrate";
import {
  issueDocument,
  postDocument,
  reverseDocument,
  transitionDocument,
  voidDocument,
} from "../src/posting";
import { withTenant, type TenantContext } from "../src/with-tenant";
import {
  draftTypedDocument,
  grantCodes,
  MIGRATIONS_DIR,
  seedCurrency,
  seedTenantV2,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "./index";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../tests/invariants/support/ar-ap";
import { secondPrincipal } from "../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;
let checker: string;
let otherBranch: string;

const ctxOf = async (actorId: string): Promise<TenantContext> => ({
  tenantId: s.tenant,
  actorId,
  requestId: await uuidv7(db.admin),
});

/** ONE production transaction as `actor` (the maker, `s.human`, by default). */
const as = async <T>(
  fn: (tx: Sql, c: TenantContext) => Promise<T>,
  actor: string = s.human,
): Promise<T> => {
  const c = await ctxOf(actor);
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};

/** A POSTED SALES_INVOICE of 100.0000 on one account line to 4000, through the generic insert → issue → post. */
const postedSale = async (): Promise<string> => {
  const { documentId } = await postFromPack(db, s, {
    code: "SALES_INVOICE",
    effectiveDate: "2026-01-10",
    partyId: f.partyIds.customer,
    lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "100.0000" }],
  });
  return documentId;
};

/** A DRAFT of `code` for `amount`, with the derived total and the rate provenance a drafting service writes. */
const drafted = async (
  code: "SALES_INVOICE" | "PAYMENT",
  amount: string,
): Promise<{ documentId: string; lineId: string }> => {
  const sale = code === "SALES_INVOICE";
  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: f.documentTypeIds[code]!,
    series: sale ? "INV" : "PAY-OUT",
    effectiveDate: "2026-01-12",
    partyId: sale ? f.partyIds.customer : f.partyIds.vendor,
    lines: [{ kind: "account", accountId: f.accountIds[sale ? "4000" : "1100"]!, amount }],
  });
  await as(async (tx) => {
    await tx`update app.document_line set total_incl_tax = ${amount} where id = ${lineIds[0]!}`;
    await tx`update app.document set rate_source = 'unit' where id = ${documentId}`;
  });
  return { documentId, lineId: lineIds[0]! };
};

/** The whole header row, as the audit trigger images it. */
const headerOf = async (documentId: string): Promise<unknown> => {
  const [row] = await db.admin<{ h: unknown }[]>`
    select to_jsonb(d) as h from app.document d where d.id = ${documentId}`;
  return row!.h;
};

const ledgerOf = (documentId: string) =>
  db.admin<{ code: string; debit: string; credit: string }[]>`
    select a.code, e.debit::text as debit, e.credit::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId}
     order by a.code`;

/** Every header tamper worth naming, each a statement that satisfies every constraint on the table, so on the
 *  parent it is simply accepted. `other` is another document of the same company, for the reference. */
type Tamper = { column: string; run: (tx: Sql, id: string, other: string) => Promise<unknown> };
const TAMPERS: readonly Tamper[] = [
  {
    column: "effective_date",
    run: (tx, id) =>
      tx`update app.document set effective_date = effective_date + 1 where id = ${id}`,
  },
  {
    column: "exchange_rate",
    run: (tx, id) => tx`update app.document set exchange_rate = exchange_rate + 3 where id = ${id}`,
  },
  {
    column: "party_id",
    run: (tx, id) =>
      tx`update app.document set party_id = case when party_id = ${f.partyIds.vendor}::uuid then ${f.partyIds.customer}::uuid else ${f.partyIds.vendor}::uuid end where id = ${id}`,
  },
  {
    column: "branch_id",
    run: (tx, id) => tx`update app.document set branch_id = ${otherBranch} where id = ${id}`,
  },
  {
    column: "currency",
    run: (tx, id) => tx`update app.document set currency = 'USD' where id = ${id}`,
  },
  {
    column: "series",
    run: (tx, id) => tx`update app.document set series = 'TAMPER' where id = ${id}`,
  },
  {
    column: "number",
    run: (tx, id) => tx`update app.document set number = 987654 where id = ${id}`,
  },
  {
    column: "fiscal_period_id",
    run: (tx, id) =>
      tx`update app.document set fiscal_period_id = ${s.closedPeriod} where id = ${id}`,
  },
  {
    column: "document_type_id",
    run: (tx, id) =>
      tx`update app.document set document_type_id = case when document_type_id = ${f.documentTypeIds["PAYMENT"]!}::uuid then ${f.documentTypeIds["RECEIPT"]!}::uuid else ${f.documentTypeIds["PAYMENT"]!}::uuid end where id = ${id}`,
  },
  {
    column: "rate_source",
    run: (tx, id) => tx`update app.document set rate_source = 'manual:tamper' where id = ${id}`,
  },
  {
    column: "reverses_document_id",
    run: (tx, id, other) =>
      tx`update app.document set reverses_document_id = ${other} where id = ${id}`,
  },
  {
    column: "payment_term_id",
    run: (tx, id) =>
      tx`update app.document set payment_term_id = case when payment_term_id is null then ${f.termId}::uuid end where id = ${id}`,
  },
  {
    column: "notes",
    run: (tx, id) => tx`update app.document set notes = 'tampered' where id = ${id}`,
  },
];

/** Runs every tamper against `documentId` (at `status`), each in its own transaction, and proves each refused
 *  with the column named — then that not one byte of the header moved. */
const expectFrozen = async (documentId: string, status: string, other: string): Promise<void> => {
  const before = await headerOf(documentId);
  for (const tamper of TAMPERS) {
    await expect(
      as((tx) => tamper.run(tx, documentId, other)),
      tamper.column,
    ).rejects.toThrow(
      new RegExp(
        `ERR_DOC_NOT_DRAFT: document .* is ${status}; its header cannot be changed \\(${tamper.column}\\)`,
      ),
    );
  }
  expect(await headerOf(documentId)).toEqual(before);
};

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "header-guard");
  f = await arApFixture(db, s);
  await seedCurrency(db, s, { code: "USD" });
  checker = await secondPrincipal(db, s, "header-guard-checker");
  await grantCodes(db, s, {
    codes: ["accounting.payment.approve", "accounting.payment.post"],
    principalId: checker,
    roleCode: "header-guard-checker",
  });
  otherBranch = await as(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en)
      values (${s.tenant}, ${s.branchType}, 'HG-BR2', 'Second branch') returning id`;
    return row!.id;
  });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("R10 — a document's header is frozen once it leaves draft (0117, SAH-041, SAH-031)", () => {
  it("a POSTED invoice's header cannot be rewritten, column by column, and its ledger stands", async () => {
    const documentId = await postedSale();
    const other = await postedSale();
    const ledger = await ledgerOf(documentId);
    await expectFrozen(documentId, "posted", other);
    // The columns only postDocument writes are frozen too once it has written them: the pin, the sequence,
    // the posting stamp. Re-pinning is SAH-013 by another route — reverseDocument reads this pin.
    const [pin] = await db.admin<{ id: string }[]>`
      select p.id from app.posting_policy p
       where p.document_type_id = ${f.documentTypeIds["PAYMENT"]!} limit 1`;
    for (const [column, run] of [
      [
        "posting_policy_id",
        (tx: Sql) =>
          tx`update app.document set posting_policy_id = ${pin!.id} where id = ${documentId}`,
      ],
      [
        "posting_seq",
        (tx: Sql) => tx`update app.document set posting_seq = 987654321 where id = ${documentId}`,
      ],
      [
        "posted_at",
        (tx: Sql) =>
          tx`update app.document set posted_at = posted_at - interval '1 day' where id = ${documentId}`,
      ],
    ] as const) {
      await expect(as(run), column).rejects.toThrow(
        new RegExp(
          `ERR_DOC_NOT_DRAFT: document .* is posted; its header cannot be changed \\(${column}\\)`,
        ),
      );
    }
    // Two columns at once are both named.
    await expect(
      as(
        (tx) => tx`
          update app.document set effective_date = '2026-01-21', party_id = ${f.partyIds.vendor}
           where id = ${documentId}`,
      ),
    ).rejects.toThrow(/its header cannot be changed \(effective_date, party_id\)/);
    expect(await ledgerOf(documentId)).toEqual(ledger);
  });

  it("an ISSUED, not yet posted, document's header cannot be rewritten either", async () => {
    const { documentId } = await drafted("SALES_INVOICE", "40.0000");
    const other = await postedSale();
    await as((tx, c) => issueDocument(tx, c, { documentId }));
    await expectFrozen(documentId, "issued", other);
    // posting_seq is still NULL at issued, and step 8 may draw it — but only draw it: a value supplied by hand
    // would re-order the document in the cost replay's (effective_date, posting_seq) order.
    await expect(
      as((tx) => tx`update app.document set posting_seq = 12345 where id = ${documentId}`),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is issued; posting_seq is drawn from app.posting_seq by the posting service/,
    );
    // …and it still posts, through the two writers the guard admits at issued (step 8 and step 13).
    await as((tx, c) => postDocument(tx, c, { documentId }));
    const [row] = await db.admin<
      { status: string; seq: boolean; pinned: boolean; posted: boolean }[]
    >`
      select status::text as status, posting_seq is not null as seq, posting_policy_id is not null as pinned,
             posted_at is not null and posted_by is not null as posted
        from app.document where id = ${documentId}`;
    expect(row).toEqual({ status: "posted", seq: true, pinned: true, posted: true });
  });

  it("maker ≠ checker holds: the maker cannot re-date or re-address an APPROVED payment, and the post books what was approved", async () => {
    const { documentId } = await drafted("PAYMENT", "300.0000");
    const other = await postedSale();
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "submitted" }));
    await expectFrozen(documentId, "submitted", other);
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "approved" }), checker);
    await expectFrozen(documentId, "approved", other);
    // Not even on the issue edge itself: the numbering columns are admitted there, a re-date is not.
    await expect(
      as(
        (tx) =>
          tx`update app.document set status = 'issued', effective_date = '2026-01-25' where id = ${documentId}`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is approved; its header cannot be changed \(effective_date\)/,
    );

    await as(async (tx, c) => {
      await issueDocument(tx, c, { documentId });
      await postDocument(tx, c, { documentId });
    }, checker);
    const [head] = await db.admin<{ effective_date: string; party_id: string }[]>`
      select effective_date::text as effective_date, party_id from app.document where id = ${documentId}`;
    expect(head).toEqual({ effective_date: "2026-01-12", party_id: f.partyIds.vendor });
    expect(await ledgerOf(documentId)).toEqual([
      { code: "1100", debit: "0.0000", credit: "300.0000" },
      { code: "2100", debit: "300.0000", credit: "0.0000" },
    ]);
  });

  it("a REVERSED and a VOID document are frozen for good", async () => {
    const other = await postedSale();
    const reversed = await postedSale();
    const { reversalDocumentId } = await as((tx, c) =>
      reverseDocument(tx, c, {
        documentId: reversed,
        effectiveDate: "2026-01-11",
        reason: "header-guard",
      }),
    );
    await expectFrozen(reversed, "reversed", other);
    await expectFrozen(reversalDocumentId, "posted", other);

    const { documentId: voided } = await drafted("SALES_INVOICE", "12.0000");
    await as(async (tx, c) => {
      await issueDocument(tx, c, { documentId: voided });
      await voidDocument(tx, c, { documentId: voided, reason: "header-guard" });
    });
    await expectFrozen(voided, "void", other);
  });

  // The posting fields are the posting service's alone, and NULL until it writes them. A draft was free, so
  // `update … set posting_seq = 7` on a draft and then postDocument — whose step 8 is
  // `coalesce(posting_seq, nextval('app.posting_seq'))` — posted the document at a hand-chosen place in the
  // cost replay's (effective_date, posting_seq) order; an INSERT could carry the same value from birth.
  it("a draft carries no posting fields — not by UPDATE, not on the issue edge, not from its INSERT — and postDocument draws its own", async () => {
    const { documentId } = await drafted("SALES_INVOICE", "25.0000");
    const before = await headerOf(documentId);
    for (const [column, run] of [
      [
        "posting_seq",
        (tx: Sql) => tx`update app.document set posting_seq = 7 where id = ${documentId}`,
      ],
      [
        "posting_seq",
        (tx: Sql) =>
          tx`update app.document set posting_seq = nextval('app.posting_seq') where id = ${documentId}`,
      ],
      [
        "posted_at",
        (tx: Sql) => tx`update app.document set posted_at = now() where id = ${documentId}`,
      ],
      [
        "posted_by",
        (tx: Sql) => tx`update app.document set posted_by = ${s.human} where id = ${documentId}`,
      ],
      [
        "posting_seq",
        (tx: Sql) =>
          tx`update app.document set status = 'issued', posting_seq = 7 where id = ${documentId}`,
      ],
    ] as const) {
      await expect(as(run), column).rejects.toThrow(
        new RegExp(
          `ERR_DOC_STATUS_ILLEGAL: document .* is draft; ${column} is written by the posting service when it posts`,
        ),
      );
    }
    expect(await headerOf(documentId)).toEqual(before);

    const born = (column: "posting_seq" | "posted_at" | "posted_by") =>
      as(
        (tx) => tx`
          insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency,
                                    branch_id, posting_seq, posted_at, posted_by)
          values (${s.tenant}, ${s.company}, ${f.documentTypeIds["SALES_INVOICE"]!}, 'INV', '2026-01-12', 'MYR',
                  ${s.hq}, ${column === "posting_seq" ? "7" : null}, ${column === "posted_at" ? new Date() : null},
                  ${column === "posted_by" ? s.human : null})`,
      );
    for (const column of ["posting_seq", "posted_at", "posted_by"] as const) {
      await expect(born(column), column).rejects.toThrow(
        new RegExp(
          `ERR_DOC_STATUS_ILLEGAL: document .* is draft; ${column} is written by the posting service when it posts`,
        ),
      );
    }

    // postDocument still draws the sequence itself, after every draw before it.
    const [drawn] = await as(
      (tx) => tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`,
    );
    await as((tx, c) => postDocument(tx, c, { documentId }));
    const [row] = await db.admin<{ status: string; seq: string; by: string }[]>`
      select status::text as status, posting_seq::text as seq, posted_by::text as by
        from app.document where id = ${documentId}`;
    expect(row!.status).toBe("posted");
    expect(row!.by).toBe(s.human);
    expect(BigInt(row!.seq)).toBeGreaterThan(BigInt(drawn!.n));
  });

  it("a status-only change still reaches 0022's matrix, which answers for it", async () => {
    const documentId = await postedSale();
    await expect(
      as((tx) => tx`update app.document set status = 'draft' where id = ${documentId}`),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: posted → draft is not a legal transition/);
  });

  it("control: a draft's header stays editable, and the backward edge (approved → draft) makes it editable again", async () => {
    const { documentId } = await drafted("PAYMENT", "50.0000");
    await as(
      (tx) =>
        tx`update app.document set effective_date = '2026-01-13', notes = 'draft note' where id = ${documentId}`,
    );
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "submitted" }));
    await as((tx, c) => transitionDocument(tx, c, { documentId, to: "approved" }), checker);
    await as((tx, c) =>
      transitionDocument(tx, c, { documentId, to: "draft", reason: "re-key the date" }),
    );
    await as(
      (tx) => tx`update app.document set effective_date = '2026-01-14' where id = ${documentId}`,
    );
    const [head] = await db.admin<{ status: string; effective_date: string; notes: string }[]>`
      select status::text as status, effective_date::text as effective_date, notes
        from app.document where id = ${documentId}`;
    expect(head).toEqual({ status: "draft", effective_date: "2026-01-14", notes: "draft note" });
  });
});

describe("0117 is reversible", () => {
  it("down to 0116 drops the trigger and its function; up restores both", async () => {
    const surface = async () => {
      const [row] = await db.admin<{ triggers: number; functions: number }[]>`
        select (select count(*)::int from pg_trigger
                 where tgrelid = 'app.document'::regclass and tgname = 'document_header_frozen_after_draft') as triggers,
               (select count(*)::int from pg_proc
                 where pronamespace = 'app'::regnamespace and proname = 'document_header_frozen_after_draft') as functions`;
      return row!;
    };
    const applied = await listApplied(db.migrator);
    expect(applied).toContain(117);
    const tail = applied.filter((version) => version > 116);
    expect(await surface()).toEqual({ triggers: 1, functions: 1 });
    const rolledBack = await down(db.migrator, MIGRATIONS_DIR, 116);
    expect(rolledBack).toEqual(tail.toReversed());
    expect(await surface()).toEqual({ triggers: 0, functions: 0 });
    expect(await up(db.migrator, MIGRATIONS_DIR)).toEqual(tail);
    expect(await surface()).toEqual({ triggers: 1, functions: 1 });
  });
});
