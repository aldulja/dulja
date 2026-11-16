import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedItem, seedLot, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("attachments on a lot — spec:1067's \"3 (lot link)\", §4.5.8's inventory row", () => {
  let api: StartedApi;
  let s: Seed;
  let itemId: string;
  let lotId: string;
  let reader: string;

  /** A REAL second principal, in 2B's `secondPrincipal` shape (plan0A:837 — the principal insert carries no
   *  `returning`, and the membership goes in the same transaction). A bare `crypto.randomUUID()` cannot be
   *  used: `app.role_assignment.principal_id` has a foreign key to `app.principal`, so `grantCodes` would be
   *  a 23503, and `request({ as })` would sign a token whose subject resolves to no membership. */
  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    // `actorId: s.system` — the tenant's system principal, taken from the `Seed` (§4.1), NOT resolved through
    // `systemContext`: that helper calls `app.resolve_principal`, whose EXECUTE is granted to `app_rw` only
    // (§4.1), and this transaction runs as `app_migrator`. The three-argument PRODUCTION `withTenant` is what
    // `apps/*/test` uses (§4.2.12) where `packages/db/test` uses the four-argument one.
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: `${label}-setup` },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
      },
    );
    // Without this the harness cannot map the new principal id to its `auth_subject`, so `as: reader`
    // would sign a token for a subject that resolves to nobody.
    await api.loadPrincipals();
    return id;
  };

  /** Multipart upload. §4.2.12's harness field is `form?: FormData` (mutually exclusive with `body`), and it
   *  mints a fresh `Idempotency-Key` for every unsafe method itself, so neither is set by hand here. */
  const upload = (fields: Record<string, string>, as: string = s.human) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const part = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form.set("file", new File([part], "cert.pdf", { type: "application/pdf" }));
    return api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/attachments`,
      as,
      form,
    });
  };

  beforeAll(async () => {
    // Its own instance, like 2C's `attachments.test.ts`: an `apps/api` route suite starts the API it drives,
    // and 0B's memoised `sharedApi()` is for the root `tests/` regression files (§4.17.1). `grantAdmin` and
    // `problemOf` are still imported from `tests/support/api` — the same value import 2A, 2B and 2C make
    // from this directory, five levels up, needing no new `dependency-rule` allowance.
    api = await startApi();
    s = await seedTenantV2(api.db, "LotAttach");
    await grantAdmin(api, s);
    // `grantAdmin` grants the five admin codes only, and none of this suite's gates is one of them: the
    // upload gate for a lot is `inventory.item.manage`, the list's company gate is `accounting.ledger.read`
    // and its row-level gate for a lot row is `inventory.item.read` (§4.5.8's lot rule).
    await grantCodes(api.db, s, {
      codes: ["inventory.item.manage", "inventory.item.read", "accounting.ledger.read"],
      roleCode: "lot-clerk",
    });
    ({ itemId } = await seedItem(api.db, s, { code: "CHICKEN-1KG", trackLots: true }));
    lotId = await seedLot(api.db, s, { itemId, code: "B-2026-03", expiresOn: "2026-09-30" });
    reader = await secondPrincipal("lot-reader");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("uploads against a lot and stores the link", async () => {
    const res = await upload({ lotId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; lotId: string; documentId: null };
    expect(body.lotId).toBe(lotId);
    expect(body.documentId).toBeNull();
    expect((body as unknown as { objectKey: string }).objectKey).toBe(`${s.tenant}/${body.id}`);
  });

  it("refuses an upload naming both a document and a lot, and one naming neither", async () => {
    const both = await upload({ lotId, documentId: crypto.randomUUID() });
    expect(both.status).toBe(400);
    expect((await problemOf(both)).code).toBe("ERR_VALIDATION_FAILED");
    const neither = await upload({});
    expect(neither.status).toBe(400);
  });

  it("the download gate for a LOT attachment is inventory.item.read, not the module code", async () => {
    const created = (await (await upload({ lotId })).json()) as { id: string };
    // A principal holding only inventory.stock.read (the `inventory` MODULE row) may not download a lot's
    // certificate: §4.5.8 gives the lot its own rule, and item.read is the narrower catalogue code.
    await grantCodes(api.db, s, {
      codes: ["inventory.stock.read"],
      principalId: reader,
      roleCode: "stock-only",
    });
    const denied = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/attachments/${created.id}/content`,
      as: reader,
    });
    expect(denied.status).toBe(403);
    expect((await problemOf(denied)).code).toBe("ERR_RBAC_FORBIDDEN");
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read"],
      principalId: reader,
      roleCode: "item-read",
    });
    const allowed = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/attachments/${created.id}/content`,
      as: reader,
    });
    expect(allowed.status).toBe(200);
  });

  it("the list omits lot attachments unless includeLots is asked for, and filters by lotId", async () => {
    const withoutLots = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/attachments`,
      as: s.human,
    });
    const plain = (await withoutLots.json()) as { items: { lotId: string | null }[] };
    expect(plain.items.every((a) => a.lotId === null)).toBe(true);
    const withLots = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/attachments?filter[lotId][eq]=${lotId}`,
      as: s.human,
    });
    const items = ((await withLots.json()) as { items: { lotId: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((a) => a.lotId === lotId)).toBe(true);
  });

  it("an inventory-module DOCUMENT's attachment is gated by inventory.stock.read (§4.5.8's new row)", async () => {
    // The module row, as distinct from the lot rule above: document_type.module = 'inventory' resolves to
    // inventory.stock.read. 2C shipped only the accounting row and a default deny; this is 3A's one-line add.
    // The map lives in `middleware/require-attachment-read`; `apps/api` publishes no `./routes/...` subpath.
    const { MODULE_READ_CODE } = await import("../../../src/middleware/require-attachment-read");
    expect(MODULE_READ_CODE.inventory).toBe("inventory.stock.read");
  });
});
