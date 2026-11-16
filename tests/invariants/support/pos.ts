import { runLoaders } from "@dulja/db/seed";
// tests/invariants/support/pos.ts (§4.17.1, registered by Task 0 amendment 15)
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { seedEmployee, seedCashier, seedShift, type Seed } from "@dulja/db/test";
import type { StartedApi } from "../../../apps/api/test/support/app";

export const POS_PACK_ROOT = fileURLToPath(
  new URL("../../../packages/db/seed/my/", import.meta.url),
);

export interface EnrolledTerminal {
  terminalId: string;
  /** The terminal's `app.principal.id` — the ACTING principal for every ticket it syncs (LEGACY-044). It is on
   *  this object because `withTenant`'s `actorId` is a principal id, and passing `terminalId` there sets
   *  `app.actor_id` to a uuid that is not a principal: `document.created_by`'s FK then fails at the header
   *  insert, before the dedup read ever runs, and the failure names a constraint instead of the mistake. */
  principalId: string;
  companyId: string;
  branchId: string;
  privateKey: KeyObject;
  code: string;
}

/** Enrols a terminal through the REAL two-route flow, so every test that signs a request is signing for a
 *  terminal the server created the way production creates one. `as` must hold `admin.terminal.manage`. */
export async function enrolTerminal(
  api: StartedApi,
  s: Seed,
  opts: { as: string; code?: string; branchId?: string },
): Promise<EnrolledTerminal> {
  await runLoaders(
    api.db.rw,
    {
      config: {} as never,
      tenantId: s.tenant,
      companyId: s.company,
      systemPrincipalId: s.system,
      packRoot: POS_PACK_ROOT,
    },
    ["roles"],
    "pos-roles",
  );
  const code = opts.code ?? "T1";
  const issued = await api.request({
    method: "POST",
    path: "/v1/admin/terminals/enrolments",
    as: opts.as,
    body: {
      companyId: s.company,
      branchId: opts.branchId ?? s.hq,
      name: `Till ${code}`,
      terminalCode: code,
    },
  });
  if (issued.status !== 201)
    throw new Error(`enrolment issue failed: ${issued.status} ${await issued.text()}`);
  const { code: secret } = (await issued.json()) as { code: string };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const res = await api.request({
    method: "POST",
    path: "/v1/sync/enrol",
    body: {
      code: secret,
      devicePublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
  });
  if (res.status !== 201)
    throw new Error(`enrolment redeem failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { terminalId: string; companyId: string; branchId: string };
  // `EnrolResultSchema` deliberately does not carry the principal id — a till has no use for it — so the
  // fixture reads it back on the admin connection, which is where a test is allowed to look.
  const [row] = await api.db.admin<{ principal_id: string }[]>`
    select principal_id from app.pos_terminal where id = ${body.terminalId}`;
  return { ...body, principalId: row!.principal_id, privateKey, code };
}

// tests/invariants/support/pos.ts — appended to Task 6's file.
import { sign as edSign } from "node:crypto";
import { serializeSyncBody, signSyncHeaders } from "@dulja/sync";
import type { ApiRequest } from "../../../apps/api/test/support/app";

/**
 * The three signature headers for one request, from the terminal's own private key.
 *
 * `syncRequest` normalizes JSON once before signing and handing it to the harness. Bigint revisions remain
 * exact decimal strings, and the harness sends the same JSON that the shared signer hashes.
 *
 * The **path only**, never the query string: `terminalAuth` signs `new URL(c.req.url).pathname`, so a caller
 * passes `"/v1/sync/catalogue"` even when it requests `"/v1/sync/catalogue?limit=1"`.
 */
export function signSyncRequest(
  t: EnrolledTerminal,
  req: { method: string; path: string; body?: unknown; at?: Date },
): Record<string, string> {
  return signSyncHeaders(
    {
      method: req.method,
      path: req.path,
      ...(req.body === undefined ? {} : { body: req.body }),
      at: req.at ?? new Date(),
      terminalId: t.terminalId,
    },
    (message) => edSign(null, message, t.privateKey),
  );
}

/**
 * A signed `/v1/sync/*` call. `path` may carry a query string; the signature covers only the pathname, which
 * is `terminalAuth`'s own rule (a cursor is not a secret, and a till that retried with a different `limit`
 * would otherwise have to re-sign).
 *
 * `idempotencyKey` is threaded straight through to `ApiRequest`, including `null` — the harness reads `null`
 * as "send NO header", which is how Task 12 exercises `ERR_IDEMPOTENCY_KEY_MISSING` on a terminal route.
 */
export async function syncRequest(
  api: StartedApi,
  t: EnrolledTerminal,
  req: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const pathname = req.path.split("?")[0]!;
  const wireBody = req.body === undefined ? undefined : JSON.parse(serializeSyncBody(req.body));
  const signed = signSyncRequest(t, { method: req.method, path: pathname, body: wireBody });
  const input: ApiRequest = {
    method: req.method,
    path: req.path,
    // The SAME object signSyncRequest hashed. Do not rebuild it, and do not pass a pre-stringified copy: the
    // harness stringifies `body` itself, and two stringifications of one object are equal while a string and
    // an object are not.
    ...(wireBody === undefined ? {} : { body: wireBody }),
    ...(req.idempotencyKey === undefined ? {} : { idempotencyKey: req.idempotencyKey }),
    headers: { ...signed, ...req.headers },
  };
  return api.request(input);
}

// tests/invariants/support/pos.ts — appended to Task 6's file.
export interface PosFixture {
  shiftId: string;
  s: Seed;
  api: StartedApi;
  terminal: EnrolledTerminal;
  /** SKU → { itemId, baseUnitId }; three items, all `track_lots: false`, all stocked. */
  items: Record<string, { itemId: string; baseUnitId: string }>;
  warehouseId: string;
  /** account code → id, for every code POS_TICKET's policy or its assertions name. */
  accounts: Record<string, string>;
  /** document type code → id: POS_TICKET and POS_EQUIV_INVOICE. */
  types: Record<string, string>;
  /** 5A's four pack codes → `tax_code.id`. */
  taxCodes: Record<string, string>;
  /** The same four → their `rate`, READ from `app.tax_code` and never restated: hazard 1 forbids a rate
   *  literal in a plan or a fixture, synthetic or not, and `buildTicket` needs one to price a line. */
  taxRates: Record<string, string>;
  /** The same four → the two figures a tax-INCLUSIVE line needs, so that `buildTicket` restates neither the
   *  rate nor the rounding rule: `divisor` is `(1 + rate)::text` computed by **Postgres**, whose numeric is
   *  exact and needs no decimal library in a fixture, and `roundingMode` is the CODE's own — LEGACY-019's finding
   *  is that the mode belongs to the code and not to the engine, and 5A's inclusive branch honours it. */
  taxInclusive: Record<string, { divisor: string; roundingMode: RoundingMode }>;
  cashierId: string;
  supervisorId: string;
}

/** `buildTicket`'s options, a NAMED interface and not an inline object type. It is named for two reasons:
 *  6C, 6D and 7C all call `buildTicket` and one of them will want to widen it, and a body written as
 *  `opts: Parameters<typeof buildTicket>[1]` would be a declaration whose parameter list refers to its own
 *  `typeof` — a circular self-reference the compiler cannot resolve. §4.17.1 registers the name. */
export interface BuildTicketOptions {
  clientRef?: string;
  kind?: "sale" | "return";
  sku?: string;
  quantity?: string;
  unitPrice?: string;
  tender?: TicketTender["method"];
  cashierPrincipalId?: string;
  events?: TicketEvent[];
  customerId?: string | null;
  newCustomer?: NewCustomer | null;
  returnsClientRef?: string | null;
  discount?: string;
  lines?: { sku?: string; quantity?: string; unitPrice?: string; discount?: string }[];
  shiftId?: string;
  /** Customer-account sale; no tender is collected. */
  accountSale?: boolean;
}

// tests/invariants/support/pos.ts — appended.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currency, Money, Quantity, type RoundingMode } from "@dulja/domain";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedUnit,
  seedWarehouse,
  withTenant,
} from "@dulja/db/test";
import { withTenant as prodWithTenant } from "@dulja/db";
import { chartOfAccountsLoader } from "@dulja/db/seed";
import {
  ensureOpenPeriods,
  postInventoryDocument,
  recordingJobs,
  secondPrincipal,
  STOCK_RECEIPT_COST_POLICY,
} from "./post-inventory";
import { taxFixture } from "./tax";
import type { NewCustomer, Ticket, TicketEvent, TicketTender } from "@dulja/sync";

/**
 * A uuidv7 minted **at the till, offline, with no database** — which is exactly the fact spec:1302 relies on
 * when it makes `client_ref` the idempotency key. `@dulja/db/test`'s `uuidv7(sql)` is a round trip and
 * `buildTicket` is synchronous, so this is the synchronous half; §4.1 is immovable and that helper is not
 * widened. **Never `crypto.randomUUID()`**, which is a v4 — spec:2037 admits v7 and not v4, and §4.10.1 fixes
 * `batchId` and `clientRef` as v7s, so a suite minting v4s would assert the protocol with values it refuses.
 *
 * Layout, RFC 9562: 48-bit big-endian millisecond timestamp, version nibble `7`, RFC 4122 variant `10`, and
 * 74 random bits. It is **not monotonic within one millisecond** — two ids minted in the same tick sort
 * arbitrarily against each other. That is harmless for test identifiers, which are only ever compared for
 * equality; 6B's till, whose outbox is ordered, mints its own and does not copy this.
 */
export function uuidv7Sync(): string {
  const b = new Uint8Array(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  crypto.getRandomValues(b.subarray(6));
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One shift for every ticket in a suite, so no test has to invent one. `document.shift_id` is 0061's column
 *  and carries no FK, so at 6A this id references nothing; **6D's amendment A6 inserts the `app.shift` row at
 *  exactly this id**, which is why it is exported and registered (§4.17.1) rather than file-local. */
export const SHARED_SHIFT_ID = uuidv7Sync();

/** The SYNTH standard-rated output code's rate, taken from 5A's own pack and never restated as a number here:
 *  hazard 1 forbids a statutory figure, and a second copy of even a synthetic one is hazard 9. */
const SYNTH_OUT_STD = "SYN-OUT-STD";

/** The seed company's currency (plan0A:1563, pinned in §4.1 as `HQ` / `MYR`). **`Seed` has no `currency`
 *  member** — its thirteen members are listed in this plan's header fact (1) and the list is frozen — so the
 *  fixture names the company's currency once, here, and every `Money` in this file is built with it. It is a
 *  currency code and not a rate: hazard 1 is about statutory FIGURES, and `MYR` is the seed's own constant. */
const MYR = currency("MYR");

export async function posFixture(api: StartedApi, name: string): Promise<PosFixture> {
  // 1. The whole tax half, from 5A's helper: the seeded company, the SYNTH-MY-v1 regime, its four codes, the
  //    twelve accounts, a customer and open periods for 2026. This slice re-seeds none of it (hazard 33).
  const tax = await taxFixture(api.db, name);
  const s = tax.s;
  // `buildTicket` stamps `soldAt` with the run's own clock, so the run's year is opened as well as 2026; a day
  // either side covers the company's +08:00 offset across New Year.
  const day = 86_400_000;
  const years = new Set([
    2026,
    ...[-day, day].map((ms) => new Date(Date.now() + ms).getUTCFullYear()),
  ]);
  for (const year of years) await ensureOpenPeriods(api.db, s, year);

  // 2. The three accounts POS_TICKET's tender rules resolve by code that 5A's map does not carry. They come
  //    from THIS slice's chart file through the real loader — never a seedAccount literal in a fixture, which
  //    would make the fixture and `bun run seed` two sources for one code (hazard 32).
  await prodWithTenant(
    api.db.rw,
    { tenantId: s.tenant, actorId: s.system, requestId: `pos-${name}` },
    (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: { tenantId: s.tenant } as never,
        tenantId: s.tenant,
        companyId: s.company,
        systemPrincipalId: s.system,
        packRoot: POS_PACK_ROOT,
      }),
  );
  const accounts: Record<string, string> = { ...tax.accounts };
  const rows = await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ code: string; id: string }[]>`
    select code, id from app.account where company_id = ${s.company} and code in ('1110','1120','2200')`,
  );
  for (const r of rows) accounts[r.code] = r.id;

  // 3. A warehouse, one unit, three items — all `trackLots: false`, so no test needs a lot id, and all three
  //    wired to 0C's revenue/inventory/COGS accounts so the policy's `item.*_account` refs resolve.
  const warehouseId = await seedWarehouse(api.db, s, { code: "WH-POS" });
  const baseUnitId = await seedUnit(api.db, s, { code: "EA" });
  const items: PosFixture["items"] = {};
  for (const sku of ["SKU-A", "SKU-B", "SKU-C"]) {
    const it = await seedItem(api.db, s, {
      code: sku,
      trackLots: false,
      baseUnitId,
      accounts: {
        revenueAccountId: accounts["4000"]!,
        inventoryAccountId: accounts["1300"]!,
        cogsAccountId: accounts["5000"]!,
      },
    });
    items[sku] = { itemId: it.itemId, baseUnitId: it.baseUnitId };
  }

  // 4. Both document types, READ OFF DISK. §4.14's rule is that a seeded type's shape lives in one place, so
  //    a test that restated the policy would be asserting against its own copy. POS_EQUIV_INVOICE is that
  //    same object with exactly three members changed and `requires` reduced — the difference between the two
  //    documents acceptance test 22 compares is type, series, acting principal and write path, and NOTHING
  //    else, which is what makes an identical multiset mean "one posting service".
  const posEnvelope = JSON.parse(
    readFileSync(join(POS_PACK_ROOT, "document-types", "POS_TICKET.json"), "utf8"),
  ) as { policy: Record<string, unknown> };
  const equivPolicy = {
    ...posEnvelope.policy,
    documentType: "POS_EQUIV_INVOICE",
    numbering: { series: "PEI", assignAt: "issue" },
    approval: { required: false, approve: null, post: "accounting.sales.post" },
    requires: ["warehouse"],
  };
  const types: Record<string, string> = {
    POS_TICKET: await seedDocumentType(api.db, s, {
      code: "POS_TICKET",
      module: "pos",
      policy: posEnvelope.policy,
    }),
    POS_EQUIV_INVOICE: await seedDocumentType(api.db, s, {
      code: "POS_EQUIV_INVOICE",
      module: "accounting",
      policy: equivPolicy,
    }),
  };

  // 5. Opening stock through the REAL posting service, so every cost layer is a real layer (hazard 22 — no
  //    test in this system inserts a cost_layer). 3A's registered stock-receipt test type is what
  //    postInventoryDocument drafts, and 200 of each SKU is enough for every case in Phase 6 except the
  //    deliberate stock-out one, which asks for 999999.
  const stockReceiptTypeId = await seedDocumentType(api.db, s, {
    code: "STOCK_RECEIPT_TEST",
    module: "inventory",
    policy: STOCK_RECEIPT_COST_POLICY,
  });
  for (const sku of ["SKU-A", "SKU-B", "SKU-C"]) {
    await postInventoryDocument(api.db, s, {
      documentTypeId: stockReceiptTypeId,
      warehouseId,
      jobs: recordingJobs(),
      lines: [
        {
          itemId: items[sku]!.itemId,
          warehouseId,
          unitId: baseUnitId,
          quantity: "200.000000",
          unitPrice: "30.0000",
        },
      ],
    });
  }

  // 6. The cashier/supervisor pair acceptance test 37 needs, each granted at the branch and NOT company-wide,
  //    because `app.principal_has` is branch-aware and a company-wide grant would make every branch test pass
  //    for the wrong reason. The supervisor deliberately does NOT hold `pos.ticket.sell`: the override guard
  //    refuses a second principal that is the document's own cashier, and a supervisor who could also sell
  //    would let a test accidentally satisfy both roles with one principal.
  const cashierId = s.human;
  const supervisorId = await secondPrincipal(api.db, s, "POS supervisor");
  await grantCodes(api.db, s, {
    principalId: cashierId,
    roleCode: "pos-cashier",
    branchIds: [s.hq],
    codes: [
      "pos.ticket.sell",
      "pos.shift.own",
      "pos.ticket.discount",
      "pos.ticket.return",
      "pos.customer.create",
      "pos.attendance.clock",
    ],
  });
  await grantCodes(api.db, s, {
    principalId: supervisorId,
    roleCode: "pos-supervisor",
    branchIds: [s.hq],
    codes: [
      "pos.ticket.override",
      "pos.ticket.return_blind",
      "pos.ticket.void",
      "pos.needs_attention.resolve",
    ],
  });
  // The human who issues the enrolment needs the admin code; it is a THIRD authority and not the cashier's.
  await grantCodes(api.db, s, { codes: ["admin.terminal.manage"] });

  // 7. The four codes' rates, read back, plus the two figures the inclusive extraction needs. `buildTicket`
  //    prices a line with one of them and this is the only place a rate enters the fixture — hazard 1 forbids
  //    the literal even for SYNTH-MY-v1. `(1 + rate)` is computed by Postgres because its numeric is exact and
  //    a test-support file has no business doing decimal arithmetic on a rate.
  const rateRows = await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx<{ code: string; rate: string; divisor: string; rounding_mode: RoundingMode }[]>`
      select code, rate::text as rate, (1 + rate)::text as divisor, rounding_mode
        from app.tax_code where id = any(${Object.values(tax.codes)})`,
  );
  const taxRates: Record<string, string> = {};
  const taxInclusive: PosFixture["taxInclusive"] = {};
  for (const r of rateRows) {
    taxRates[r.code] = r.rate;
    taxInclusive[r.code] = { divisor: r.divisor, roundingMode: r.rounding_mode };
  }

  const cashierEmployee = await seedEmployee(api.db, s, { employeeNumber: `${name}-CASHIER` });
  await seedCashier(api.db, s, {
    employeeId: cashierEmployee,
    branchId: s.hq,
    principalId: cashierId,
  });
  const supervisorEmployee = await seedEmployee(api.db, s, {
    employeeNumber: `${name}-SUPERVISOR`,
  });
  await seedCashier(api.db, s, {
    employeeId: supervisorEmployee,
    branchId: s.hq,
    principalId: supervisorId,
  });
  const terminal = await enrolTerminal(api, s, { as: s.human, code: "KL01" });
  const shiftId = await seedShift(api.db, s, {
    terminalId: terminal.terminalId,
    cashierPrincipalId: cashierId,
  });
  return {
    s,
    api,
    terminal,
    shiftId,
    items,
    warehouseId,
    accounts,
    types,
    taxCodes: tax.codes,
    taxRates,
    taxInclusive,
    cashierId,
    supervisorId,
  };
}

/**
 * One `Ticket` over the fixture. Every money value is a string produced by `Money`, never by JavaScript
 * arithmetic (spec:2041 and the `no-number-money` lint): `50.0000 × 2` is exact here and is not exact as a
 * `number` for every price a shop uses.
 *
 * **A return negates in ONE place.** `quantity`, `total`, `taxAmount`, `discount` and the tender's `amount`
 * all flip together, because a test that negated three of the five would produce a ticket whose tenders do
 * not sum to its lines — and `applyBatch` would refuse it for the wrong reason, in a case written to assert
 * something else. `unitPrice` does NOT flip: a price is a price, and §4.4.2's A9 says direction is carried by
 * the quantity's sign and by `effect`/`side`, never by a magnitude.
 */
export function buildTicket(f: PosFixture, opts: BuildTicketOptions = {}): Ticket {
  const kind = opts.kind ?? "sale";
  const specs = opts.lines ?? [
    { sku: opts.sku, quantity: opts.quantity, unitPrice: opts.unitPrice, discount: opts.discount },
  ];
  const lines = specs.map((spec, i) => {
    const sku = spec.sku ?? "SKU-A";
    const magnitude = Quantity.of(spec.quantity ?? "1.000000");
    const qty = kind === "return" ? magnitude.negate() : magnitude;
    const unitPrice = Money.of(spec.unitPrice ?? "50.0000", MYR);
    const discountMagnitude = Money.of(spec.discount ?? "0.0000", MYR);
    const discount = kind === "return" ? discountMagnitude.negate() : discountMagnitude;
    const gross = unitPrice.multiply(qty.toString(), "HALF_AWAY_FROM_ZERO").subtract(discount);
    const inclusive = f.taxInclusive[SYNTH_OUT_STD]!;
    const base = gross.divide(inclusive.divisor, inclusive.roundingMode);
    return {
      lineNo: i + 1,
      itemId: f.items[sku]!.itemId,
      lotId: null,
      quantity: qty.toString(),
      unitId: f.items[sku]!.baseUnitId,
      unitPrice: { amount: unitPrice.toString(), currency: MYR },
      discount: { amount: discount.toString(), currency: MYR },
      taxCodeId: f.taxCodes[SYNTH_OUT_STD]!,
      taxAmount: { amount: gross.subtract(base).toString(), currency: MYR },
      total: { amount: gross.toString(), currency: MYR },
    };
  });
  const gross = lines.reduce(
    (sum, line) => sum.add(Money.of(line.total.amount, MYR)),
    Money.zero(MYR),
  );
  const tenderMethod: TicketTender["method"] = opts.tender ?? "cash";

  return {
    clientRef: opts.clientRef ?? uuidv7Sync(),
    shiftId: opts.shiftId ?? f.shiftId,
    cashierPrincipalId: opts.cashierPrincipalId ?? f.cashierId,
    customerId: opts.customerId ?? null,
    newCustomer: opts.newCustomer ?? null,
    kind,
    returnsClientRef: opts.returnsClientRef ?? null,
    currency: MYR,
    soldAt: new Date().toISOString(),
    lines,
    tenders: opts.accountSale
      ? []
      : [
          {
            tenderNo: 1,
            method: tenderMethod,
            amount: { amount: gross.toString(), currency: MYR },
            reference: null,
          },
        ],
    events: opts.events ?? [],
    attendance: [],
    catalogueRevision: 0n,
  };
}

import {
  CATALOGUE_STREAMS,
  type SyncStore,
  type Stream,
  type Change,
  type OutboxRow,
  type BatchResult,
} from "@dulja/sync";

/** The packages/sync copy is the specification of the port; this copy is what 6B’s SQLite store is compared against. */
export class MemorySyncStore implements SyncStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly cursors = new Map<string, bigint>();
  readonly outbox: OutboxRow[] = [];
  applied = 0;
  async getCursor(stream: Stream): Promise<bigint> {
    return this.cursors.get(stream) ?? 0n;
  }
  async applyChanges(changes: Change[]): Promise<void> {
    if (changes.length === 0) return;
    let high = 0n;
    for (const ch of changes) {
      const key = `${ch.stream}:${ch.id}`;
      if (ch.op === "delete") this.rows.delete(key);
      else this.rows.set(key, ch.row as Record<string, unknown>);
      if (ch.revision > high) high = ch.revision;
      this.applied += 1;
    }
    // ⚠️ EVERY stream, not only the streams this page carried (Task 0 amendment 23c). A page is ordered by
    // revision ACROSS all streams, so a page ending at revision `high` has delivered everything <= high for
    // every stream — including the streams that had nothing. Advancing only the touched ones would leave
    // `cashier` and `branch_pos_policy` at 0n on every till until 6C ships, and `pullAll`'s minimum-across-
    // streams cursor would therefore be 0n for ever: every pull would re-fetch the whole catalogue and no
    // resume would exist. Nothing would fail; the till would just be permanently slow and permanently at
    // page one. This line is the contract 6B's SQLite store is measured against.
    for (const st of CATALOGUE_STREAMS) this.cursors.set(st, high);
  }
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    return this.outbox.filter((r) => r.ackedAt === null).slice(0, limit);
  }
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const refs = {
      ticket: new Set(
        result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ),
      shift: new Set(result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref)),
      till_event: new Set(
        result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ),
      cash_event: new Set(
        (result.cashEventResults ?? []).filter((r) => r.status !== "rejected").map((r) => r.ref),
      ),
    };
    for (const row of this.outbox)
      if (ids.includes(row.id) && refs[row.kind].has(row.ref))
        row.ackedAt = new Date().toISOString();
  }
}
