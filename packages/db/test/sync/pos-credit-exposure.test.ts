import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedParty,
  seedTenantV2,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { PACK_ROOT } from "../ar-ap/_support";

let db: Db;
let s: Seed;
let tenderType: string;
let ordinaryType: string;
const envelope = JSON.parse(
  readFileSync(join(PACK_ROOT, "document-types", "POS_TICKET.json"), "utf8"),
) as { policy: Record<string, unknown> };

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "pos-credit-exposure");
  await seedAccount(db, s, { code: "1200", nameEn: "Receivables", type: "asset" });
  await grantCodes(db, s, { codes: ["accounting.sales.post"] });
  // CREDIT_TEST is fixture-only. Exercise the production POS tender-policy shape without stock prerequisites.
  const policy = {
    ...envelope.policy,
    documentType: "CREDIT_TEST",
    requires: [],
    inventory: { effect: "none" },
    tax: { applies: false },
    numbering: { series: "CRT", assignAt: "issue" },
    dimensions: { required: [] },
    approval: { required: false, approve: null, post: "accounting.sales.post" },
  };
  tenderType = await seedDocumentType(db, s, { code: "CREDIT_TEST", policy });
  ordinaryType = s.docType;
}, 180_000);
afterAll(async () => {
  await db.stop();
});

async function party(code: string, limit: string | null = "100.0000", hold = false) {
  const id = await seedParty(db, s, { kind: "customer", code });
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx`update app.party set credit_limit = ${limit}, credit_hold = ${hold} where id = ${id}`,
  );
  return id;
}

async function draft(partyId: string, gross: string, tender?: string, type = tenderType) {
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: type,
    series: "CRT",
    partyId,
    lines: [
      { kind: "item", amount: gross, quantity: "1.000000", unitPrice: gross },
      ...(tender === undefined
        ? [{ kind: "account" as const, debit: gross }]
        : [{ kind: "tender" as const, amount: tender, customFields: { method: "cash" } }]),
    ],
  });
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx`update app.document_line set total_incl_tax = amount where document_id = ${documentId}`,
  );
  return documentId;
}

function issue(documentId: string) {
  return withTenant(db.rw, s.tenant, s.human, (tx) =>
    issueDocument(
      tx,
      { tenantId: s.tenant, actorId: s.human, requestId: "pos-credit" },
      { documentId },
    ),
  );
}

function exposure(documentId: string, rate = "1.00000000") {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ total: string }[]>`
      select app.document_base_total(${documentId}::uuid, ${rate}::numeric)::text as total`;
    return row!.total;
  });
}

describe("POS credit exposure uses the receivable residual (§4.10.4)", () => {
  it("a fully tendered sale has zero exposure and can issue for a held customer", async () => {
    const id = await draft(await party("HELD", "0.0000", true), "111.0000", "111.0000");
    expect(await exposure(id)).toBe("0.0000");
    await expect(issue(id)).resolves.toMatchObject({ documentId: id });
  });

  it("the zero-value account leg does not double the positive receivable exposure", async () => {
    const id = await draft(await party("ACCOUNT"), "60.0000");
    expect(await exposure(id)).toBe("60.0000");
    await expect(issue(id)).resolves.toMatchObject({ documentId: id });
  });

  it("an account sale is refused on hold or above the customer limit", async () => {
    await expect(
      issue(await draft(await party("HOLD-ACCOUNT", null, true), "1.0000")),
    ).rejects.toThrow(/ERR_CREDIT_HOLD/);
    await expect(issue(await draft(await party("LIMIT-ACCOUNT"), "100.0001"))).rejects.toThrow(
      /ERR_CREDIT_LIMIT_EXCEEDED/,
    );
  });

  it("issued account tickets reserve credit; a paid ticket adds no pending claim", async () => {
    const p = await party("PENDING");
    await issue(await draft(p, "60.0000"));
    await issue(await draft(p, "1000.0000", "1000.0000"));
    await expect(issue(await draft(p, "40.0001"))).rejects.toThrow(/ERR_CREDIT_LIMIT_EXCEEDED/);
  });

  it("concurrent account issues cannot jointly exceed the limit", async () => {
    const p = await party("CONCURRENT");
    const one = await draft(p, "60.0000");
    const two = await draft(p, "60.0000");
    const outcomes = await Promise.allSettled([issue(one), issue(two)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected");
    expect(String(rejected?.reason)).toMatch(/ERR_CREDIT_LIMIT_EXCEEDED/);
  });

  it("rounds each gross and tender line at the exchange rate before subtraction", async () => {
    const id = await draft(await party("FX"), "1.0001", "0.0001");
    expect(await exposure(id, "1.50000000")).toBe("1.5000");
  });

  it("non-tender policies preserve their existing total even with a tender-shaped row", async () => {
    const id = await draft(await party("ORDINARY"), "10.0000", "10.0000", ordinaryType);
    expect(await exposure(id)).toBe("20.0000");
  });
});
