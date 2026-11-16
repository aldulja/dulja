// packages/db/test/support/einvoice-stub.ts  (§4.17.1(a), 5B)
//
// A loopback HTTP server that speaks the synthetic profile, plus the two fixture writes every
// e-invoicing test needs. Shared rather than file-local because five test files use it and hazard 9
// forbids five copies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  currency,
  Money,
  Quantity,
  UNIT_RATE,
  type DocumentSnapshot,
  type EInvoiceDocument,
  type EInvoiceProfile,
} from "@dulja/domain";
import { seedDocumentType, type Seed } from "../fixtures";
import { withTenant, type Db } from "../harness";

export const SYNTHETIC_PROFILE_PATH = fileURLToPath(
  new URL("../../einvoice-profiles/synthetic.v1.json", import.meta.url),
);

/** The committed profile, parsed. `startStubServer` overrides `baseUrl` with its own port. */
export function stubProfile(): EInvoiceProfile {
  return JSON.parse(readFileSync(SYNTHETIC_PROFILE_PATH, "utf8")) as EInvoiceProfile;
}

export interface StubReply {
  /** HTTP status; 200 when omitted. */
  status?: number;
  /** The JSON body. `state`/`receiptId`/`reason` at the top level are a shorthand for `json`. */
  json?: Record<string, unknown>;
  state?: string;
  receiptId?: string;
  reason?: string;
  token?: string;
  delayMs?: number;
}

export interface StubScript {
  submit?: StubReply | StubReply[];
  poll?: StubReply | StubReply[];
  cancel?: StubReply | StubReply[];
}

export interface StubCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface StubServer {
  profile: EInvoiceProfile;
  calls: StubCall[];
  /**
   * A `fetch` that aborts after `afterMs`, to prove the transmitter's timeout path without waiting
   * for a real timeout. **It is the ONLY reason a test injects `fetchImpl` at all**: the stub binds a
   * real loopback port, so the platform `fetch` reaches it unaided.
   *
   * There is deliberately no `fetchWithEnv` here. The secret is resolved inside `call()` BEFORE
   * `fetchImpl` is invoked, so a `fetch` wrapper cannot supply it; `createHttpTransmitter`'s and
   * `createSyntheticTransmitter`'s `env` option is the seam, and it mutates no `process.env`.
   */
  abortingFetch(afterMs: number): typeof fetch;
  canonicalOf(doc: EInvoiceDocument): string;
  stop(): Promise<void>;
}

/**
 * Bind an ephemeral port and answer the three synthetic paths from `script`. An entry may be a
 * single reply (repeated) or an array (consumed in order, the last repeating) — the array form is
 * what the poll-then-accept and the retry cases need.
 */
export async function startStubServer(script: StubScript): Promise<StubServer> {
  const calls: StubCall[] = [];
  const cursors: Record<string, number> = { submit: 0, poll: 0, cancel: 0 };

  const replyFor = (name: "submit" | "poll" | "cancel"): StubReply => {
    const entry = script[name];
    if (entry === undefined) return { status: 404, json: { reason: `stub has no ${name} script` } };
    if (!Array.isArray(entry)) return entry;
    const index = Math.min(cursors[name]!, entry.length - 1);
    cursors[name] = cursors[name]! + 1;
    return entry[index]!;
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      const name = path.endsWith("/cancel")
        ? "cancel"
        : req.method === "POST" && path === "/stub/documents"
          ? "submit"
          : "poll";
      calls.push({
        method: req.method ?? "",
        path,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(",") : String(v ?? ""),
          ]),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const reply = replyFor(name);
      const body = reply.json ?? {
        ...(reply.state === undefined ? {} : { state: reply.state }),
        ...(reply.receiptId === undefined ? {} : { receiptId: reply.receiptId }),
        ...(reply.reason === undefined ? {} : { reason: reply.reason }),
        ...(reply.token === undefined ? {} : { token: reply.token }),
      };
      const send = (): void => {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const profile: EInvoiceProfile = { ...stubProfile(), baseUrl: `http://127.0.0.1:${port}` };

  return {
    profile,
    calls,
    abortingFetch(afterMs) {
      return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        // The caller's own signal is replaced, not merged: the transmitter's timer is longer than
        // `afterMs` by construction in the one test that uses this, and the point is to make the
        // abort arrive first. `fetch` rejects with an AbortError, which `call()`'s catch turns into
        // TransientTransmissionError(0, …) — the assertion under test.
        const ac = new AbortController();
        setTimeout(() => ac.abort(), afterMs);
        return await fetch(input, { ...init, signal: ac.signal });
      }) as typeof fetch;
    },
    canonicalOf(doc) {
      return canonicalJson(doc);
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── the two fixture writes, defined ONCE in the repository (hazard 9) ─────────────────────────

/**
 * Turn e-invoicing on for `s.company`. The three columns move together — the DDL's
 * company_einvoice_complete_check requires it — so this is one statement and not three.
 */
export async function enableEinvoice(
  db: Db,
  s: Seed,
  opts: { transmitter?: "synthetic" | "myinvois"; clientId?: string; credentialRef?: string } = {},
): Promise<void> {
  const transmitter = opts.transmitter ?? "synthetic";
  const clientId = opts.clientId ?? "test-client";
  const credentialRef = opts.credentialRef ?? "EINVOICE_CLIENT_SECRET";
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      update app.company
         set einvoice_transmitter    = ${transmitter},
             einvoice_client_id      = ${clientId},
             einvoice_credential_ref = ${credentialRef}
       where id = ${s.company}`;
  });
}

/**
 * Configure a document type whose policy declares `tax.einvoice`. Takes the policy the caller
 * already has — the whole point is that `tests/invariants/support/einvoice.ts` hands it 4A's own
 * shipped envelope, so no test in slice 5B restates a policy 4A owns.
 */
export async function optInDocumentType(
  db: Db,
  s: Seed,
  opts: {
    code: string;
    policy: Record<string, unknown>;
    policyVersion: number;
    module?: "accounting" | "inventory" | "pos" | "hr";
    effectiveFrom?: string;
    einvoice?: boolean;
  },
): Promise<string> {
  const tax = {
    ...((opts.policy.tax as Record<string, unknown> | undefined) ?? { applies: true }),
  };
  tax.einvoice = opts.einvoice ?? true;
  return seedDocumentType(db, s, {
    code: opts.code,
    ...(opts.module === undefined ? {} : { module: opts.module }),
    policy: { ...opts.policy, tax },
    policyVersion: opts.policyVersion,
    ...(opts.effectiveFrom === undefined ? {} : { effectiveFrom: opts.effectiveFrom }),
  });
}

/**
 * A minimal in-memory `DocumentSnapshot` for the pure canonicalise tests. It is NOT a substitute
 * for `loadSnapshot`: Tasks 5, 6 and 10 all post real documents and read real snapshots. This
 * exists so `syntheticCanonicalise` can be tested without a container.
 */
export function snapshotFixture(
  overrides: { lineAmount?: string; notes?: string } = {},
): DocumentSnapshot {
  const myr = currency("MYR");
  const amount = Money.of(overrides.lineAmount ?? "100.0000", myr);
  const zero = Money.zero(myr);
  return {
    header: {
      id: "0192aaaa-0000-7000-8000-000000000001",
      companyId: "0192aaaa-0000-7000-8000-0000000000c0",
      documentTypeCode: "SALES_INVOICE",
      status: "posted",
      series: "INV",
      fiscalPeriodId: "0192aaaa-0000-7000-8000-0000000000f0",
      number: 7n,
      effectiveDate: "2026-01-15",
      partyId: "0192aaaa-0000-7000-8000-0000000000pa".replace("pa", "aa"),
      currency: myr,
      exchangeRate: UNIT_RATE(myr),
      branchId: "0192aaaa-0000-7000-8000-0000000000b0",
      attributedTo: null,
      clientRef: null,
      warehouseId: null,
      toWarehouseId: null,
      taxInclusive: false,
      reversesDocumentId: null,
      customFields: overrides.notes === undefined ? {} : { notes: overrides.notes },
    },
    lines: [
      {
        id: "0192aaaa-0000-7000-8000-0000000000l1".replace("l1", "a1"),
        lineNo: 1,
        kind: "item",
        description: "stub line",
        accountId: null,
        itemId: null,
        quantity: Quantity.of("1.000000"),
        unitPrice: amount,
        discount: zero,
        amount,
        taxCodeId: "0192aaaa-0000-7000-8000-0000000000c1",
        taxAmount: zero,
        totalInclTax: amount,
        debit: zero,
        credit: amount,
        cost: null,
        warehouseId: null,
        toWarehouseId: null,
        lotId: null,
        unitId: null,
        unitQuantity: null,
        countedQuantity: null,
        expectedQuantity: null,
        tenderMethod: null,
        customFields: {},
        dimensions: {},
        payroll: null,
      },
    ],
    company: {
      id: "0192aaaa-0000-7000-8000-0000000000c0",
      baseCurrency: myr,
      fxRoundingAccountId: null,
      costingMethod: "avco",
    },
    party: {
      id: "0192aaaa-0000-7000-8000-0000000000aa",
      kind: "customer",
      receivableAccountId: null,
      payableAccountId: null,
      creditLimit: null,
    },
    refs: {
      accountsByCode: {},
      items: {},
      taxCodes: {},
      components: {},
      schemes: {},
      dimensionTypesByCode: {},
    },
  };
}

const postedGrants = new WeakSet<Seed>();
export async function postedStubDocument(db: Db, s: Seed): Promise<string> {
  const { postDocument, withTenant: prodWithTenant } = await import("../../src");
  const { draftDocument, grantCodes, JOURNAL_POLICY_V1 } = await import("../fixtures");
  if (!postedGrants.has(s)) {
    await grantCodes(db, s, { codes: ["accounting.journal.create", "accounting.journal.post"] });
    await seedDocumentType(db, s, {
      code: "JOURNAL",
      module: "accounting",
      policy: JOURNAL_POLICY_V1,
      policyVersion: 2,
    });
    postedGrants.add(s);
  }
  const documentId = await draftDocument(db, s);
  const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "einvoice-stub-post" };
  await prodWithTenant(db.rw, ctx, async (tx) => {
    await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit)
      values (${s.tenant}, ${s.company}, ${documentId}, 1, 'account', ${s.cash}, 25, 0),
             (${s.tenant}, ${s.company}, ${documentId}, 2, 'account', ${s.sales}, 0, 25)`;
    await postDocument(tx, ctx, { documentId });
  });
  return documentId;
}
