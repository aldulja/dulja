import { hashPin } from "../src/staff/pin";
import { fileURLToPath } from "node:url";
import { runLoaders } from "../src/seed";
import { parsePolicy, type PostingPolicy } from "@dulja/domain";
import { createItem } from "../src/inventory/items";
import {
  createPriceList,
  replacePriceListLines,
  type PriceListLineInput,
} from "../src/inventory/prices";
import { type Db, uuidv7, withTenant } from "./harness";
import { exportObjectKeyFor } from "../src/export/store";

export interface Seed {
  tenant: string;
  system: string;
  human: string;
  company: string;
  period: string;
  closedPeriod: string;
  lockedPeriod: string;
  cash: string;
  sales: string;
  docType: string;
  policy: string;
  branchType: string;
  hq: string;
}

/** A complete minimal tenant with its initial company, accounting structure, and JOURNAL policy. */
export async function seedTenant(db: Db, name: string): Promise<Seed> {
  const id = () => uuidv7(db.admin);
  const seed: Seed = {
    tenant: await id(),
    system: await id(),
    human: await id(),
    company: await id(),
    period: await id(),
    closedPeriod: await id(),
    lockedPeriod: await id(),
    cash: await id(),
    sales: await id(),
    docType: await id(),
    policy: await id(),
    branchType: await id(),
    hq: await id(),
  };
  await withTenant(db.migrator, seed.tenant, seed.system, async (tx) => {
    await tx`insert into app.tenant (id, name) values (${seed.tenant}, ${name})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${seed.system}, 'system', ${`system:${seed.tenant}`}, 'system')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${seed.tenant}, ${seed.system})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${seed.human}, 'human', ${`human:${seed.tenant}`}, ${`${name} owner`})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${seed.tenant}, ${seed.human})`;
    // Before the company, because 0008 made company.base_currency a foreign key: a base currency is
    // policy the tenant must already hold, not a free-text label on the company row. Every helper below
    // and every suite that seeds an extra company reuses this 'MYR', so only a test needing a *second*
    // currency calls seedCurrency.
    await tx`insert into app.currency (tenant_id, code, name_en) values (${seed.tenant}, 'MYR', 'MYR')`;
    await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${seed.company}, ${seed.tenant}, 'HQ', ${`${name} HQ`}, 'MYR')`;
    await tx`insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status) values
      (${seed.period}, ${seed.tenant}, ${seed.company}, '2026-01-01', '2026-01-31', 'open'),
      (${seed.closedPeriod}, ${seed.tenant}, ${seed.company}, '2026-02-01', '2026-02-28', 'closed'),
      (${seed.lockedPeriod}, ${seed.tenant}, ${seed.company}, '2026-03-01', '2026-03-31', 'locked')`;
    await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type) values
      (${seed.cash}, ${seed.tenant}, ${seed.company}, '1000', 'Cash', 'asset'),
      (${seed.sales}, ${seed.tenant}, ${seed.company}, '4000', 'Sales', 'income')`;
    await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${seed.branchType}, ${seed.tenant}, ${seed.company}, 'BRANCH', 'Branch')`;
    await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values (${seed.hq}, ${seed.tenant}, ${seed.branchType}, 'HQ', 'Head office')`;
    await tx`insert into app.document_type (id, tenant_id, company_id, code, name_en) values (${seed.docType}, ${seed.tenant}, ${seed.company}, 'JOURNAL', 'Journal')`;
    await tx`insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
      values (${seed.policy}, ${seed.tenant}, ${seed.docType}, 1, '2026-01-01', ${JSON.stringify({ version: 1, documentType: "JOURNAL", direction: "none", lines: [] })}::text::jsonb)`;
  });
  return seed;
}

/** Inserts a draft document. The posting service assigns numbers at issue, never this helper. */
export async function draftDocument(
  db: Db,
  seed: Seed,
  options: { effectiveDate?: string; periodId?: string; clientRef?: string } = {},
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) => tx`
    insert into app.document (id, tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id, effective_date, currency, client_ref, branch_id)
    values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, ${seed.policy}, 'JV', ${options.periodId ?? seed.period}, ${options.effectiveDate ?? "2026-01-15"}, 'MYR', ${options.clientRef ?? null}, ${seed.hq})`,
  );
  return id;
}

export async function seedCurrency(
  db: Db,
  seed: Seed,
  opts: { code: string; minorUnit?: number },
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) =>
      tx`insert into app.currency (id, tenant_id, code, name_en, minor_units) values (${id}, ${seed.tenant}, ${opts.code}, ${opts.code}, ${opts.minorUnit ?? 2})`,
  );
  return id;
}

export async function seedRate(
  db: Db,
  seed: Seed,
  opts: { from: string; to: string; on: string; rate: string; source?: string },
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) =>
      tx`insert into app.exchange_rate (id, tenant_id, company_id, from_currency, to_currency, rate, effective_from, source) values (${id}, ${seed.tenant}, ${seed.company}, ${opts.from}, ${opts.to}, ${opts.rate}, ${opts.on}, ${opts.source ?? `manual:${seed.human}`})`,
  );
  return id;
}

export async function seedBranch(
  db: Db,
  seed: Seed,
  opts: { code?: string; nameEn?: string } = {},
): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) => tx`
      insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
      values (${id}, ${seed.tenant}, ${seed.branchType}, ${opts.code ?? "BR2"},
              ${opts.nameEn ?? "Second branch"})`,
  );
  return id;
}

/** contracts §4.3.7 — the `policy` member of the JOURNAL envelope, NOT the envelope. The document-types seed
 *  file carries the same object and a test asserts the two are identical. */
export const JOURNAL_POLICY_V1: PostingPolicy = {
  version: 1,
  documentType: "JOURNAL",
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "JV", assignAt: "issue" },
  reversal: { allowed: true, producesType: "JOURNAL" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

/** The one way any test creates a §4.15 account. Idempotent on (company_id, code) so a helper that seeds a
 *  code seedTenant already created returns that row's id rather than colliding. */
export async function seedAccount(
  db: Db,
  seed: Seed,
  opts: {
    code: string;
    nameEn: string;
    type: "asset" | "liability" | "equity" | "income" | "expense";
    parentCode?: string;
    currency?: string;
    isGroup?: boolean;
  },
): Promise<string> {
  const id = await uuidv7(db.admin);
  return withTenant(db.rw, seed.tenant, seed.human, async (tx) => {
    const parent = opts.parentCode
      ? ((
          await tx<{ id: string }[]>`
            select id from app.account where company_id = ${seed.company} and code = ${opts.parentCode}`
        )[0]?.id ?? null)
      : null;
    await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type, parent_id, is_group, currency)
             values (${id}, ${seed.tenant}, ${seed.company}, ${opts.code}, ${opts.nameEn}, ${opts.type}::app.account_type,
                     ${parent}, ${opts.isGroup ?? false}, ${opts.currency ?? null})
             on conflict (company_id, code) do nothing`;
    const [row] = await tx<{ id: string }[]>`
      select id from app.account where company_id = ${seed.company} and code = ${opts.code}`;
    return row!.id;
  });
}

/** Inserts JOURNAL_POLICY_V1 as posting_policy.version = 2 for the seeded JOURNAL type, effective 2026-01-01
 *  — matching the seed pack's policyVersion and effectiveFrom (contracts §4.3.7) so the fixture and the pack
 *  agree. 0A's version 1 row is left exactly as it is. */
export async function seedJournalPolicy(db: Db, seed: Seed): Promise<void> {
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) => tx`
    insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
    values (${id}, ${seed.tenant}, ${seed.docType}, 2, '2026-01-01', ${JSON.stringify(JOURNAL_POLICY_V1)}::text::jsonb)
    on conflict (document_type_id, version) do update
       set definition = excluded.definition, effective_from = excluded.effective_from`,
  );
}

/** seedTenant plus everything a posting test needs: the 5920 FX-rounding account wired to the company, and
 *  the JOURNAL policy v1. Seed keeps its 0A shape — a test that needs the FX account's id reads
 *  `company.fx_rounding_account_id` or calls seedAccount(db, s, { code: "5920", … }) again. */
export async function seedTenantV2(db: Db, name: string): Promise<Seed> {
  const seed = await seedTenant(db, name);
  const fx = await seedAccount(db, seed, {
    code: "5920",
    nameEn: "FX rounding",
    type: "expense",
  });
  await withTenant(
    db.rw,
    seed.tenant,
    seed.human,
    (tx) => tx`update app.company set fx_rounding_account_id = ${fx} where id = ${seed.company}`,
  );
  await seedJournalPolicy(db, seed);
  return seed;
}

export interface SeedPartyOptions {
  kind?: "customer" | "vendor" | "employee" | "student" | "dealer";
  code?: string;
  nameEn?: string;
  receivableAccountId?: string;
  payableAccountId?: string;
}

/** contracts §4.17 — 2A's helper. Defaults to a customer wired to the §4.15 control accounts 1200/2100,
 *  which 0C's seed pack owns; a unit-test tenant has no pack, so the fixture creates them once through
 *  1A's seedAccount and reuses them afterwards. Returns the party id. */
export async function seedParty(db: Db, s: Seed, opts: SeedPartyOptions = {}): Promise<string> {
  const control = async (
    code: string,
    nameEn: string,
    type: "asset" | "liability",
  ): Promise<string> => {
    const [found] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<
          { id: string }[]
        >`select id from app.account where company_id = ${s.company} and code = ${code}`,
    );
    return found ? found.id : seedAccount(db, s, { code, nameEn, type });
  };
  const id = await uuidv7(db.admin);
  const receivable =
    opts.receivableAccountId ?? (await control("1200", "Trade receivables", "asset"));
  const payable = opts.payableAccountId ?? (await control("2100", "Trade payables", "liability"));
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`
    insert into app.party (id, tenant_id, company_id, kind, code, name_en, receivable_account_id, payable_account_id)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.kind ?? "customer"}, ${opts.code ?? "P-0001"},
            ${opts.nameEn ?? "Alpha customer"}, ${receivable}, ${payable})`,
  );
  return id;
}

export interface SeedDocumentTypeOptions {
  code: string;
  module?: "accounting" | "inventory" | "hr" | "pos";
  policy: unknown;
  policyVersion?: number;
  effectiveFrom?: string;
}

/** contracts §4.17 — 2A's helper; 2C, 3C, 3D, 4A, 6A and 8B all configure a type through this one helper.
 *  The options are the §4.3.7 envelope's members. The policy is parsed against the schema BEFORE the insert:
 *  a fixture that seeds an invalid policy would make every later test lie. Returns the document_type id;
 *  calling it again with the same `code` adds another policy version to the existing type. */
export async function seedDocumentType(
  db: Db,
  s: Seed,
  opts: SeedDocumentTypeOptions,
): Promise<string> {
  parsePolicy(opts.policy);
  const typeId = await uuidv7(db.admin);
  const policyId = await uuidv7(db.admin);
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document_type (id, tenant_id, company_id, code, name_en, module)
      values (${typeId}, ${s.tenant}, ${s.company}, ${opts.code}, ${opts.code}, ${opts.module ?? "accounting"})
      on conflict (company_id, code) do nothing`;
    const [row] = await tx<{ id: string }[]>`
      select id from app.document_type where company_id = ${s.company} and code = ${opts.code}`;
    await tx`
      insert into app.posting_policy (id, tenant_id, document_type_id, version, effective_from, definition)
      values (${policyId}, ${s.tenant}, ${row!.id}, ${opts.policyVersion ?? 1},
              ${opts.effectiveFrom ?? "2026-01-01"}, ${JSON.stringify(opts.policy)}::text::jsonb)
      on conflict (document_type_id, version) do update
        set definition = excluded.definition, effective_from = excluded.effective_from`;
    return row!.id;
  });
}

/**
 * Grants `codes` to a principal through a real role → role_permission → role_assignment chain, acting as the
 * tenant's SYSTEM principal: `app.forbid_self_grant` refuses a principal granting to itself and
 * `app.assert_assignment_kind` refuses a non-terminal role on a terminal. Returns the role id.
 *
 * `seedTenant` deliberately grants `s.human` nothing (contracts §4.1), so from slice 2B — when the BEFORE
 * UPDATE OF status trigger began calling `app.actor_has` — every test that approves, posts or voids a document
 * must grant first. This is the ONE way to do it at the database tier; route tests use 0B's `grantAdmin`
 * (contracts §4.17.1) for the five admin codes and this helper for anything narrower.
 *
 * `branchIds` adds `role_assignment_branch` rows, which restrict the assignment to those BRANCH dimension
 * values: with rows present, `app.actor_has(code, company, null)` is FALSE (spec:2166, SAH-042).
 *
 * `opts` is optional and every member of it is optional, so `grantCodes(db, s)` is legal and **grants
 * nothing**: it creates a role with zero `role_permission` rows and assigns it, which is the documented
 * behaviour and not a bug — a caller who wants a grant must pass `codes`.
 */
export async function grantCodes(
  db: Db,
  s: Seed,
  opts: {
    codes?: readonly string[];
    principalId?: string;
    roleCode?: string;
    branchIds?: readonly string[];
  } = {},
): Promise<string> {
  const roleId = await uuidv7(db.admin);
  const principalId = opts.principalId ?? s.human;
  // The random tail, not the head: a UUIDv7's first eight hex digits are the millisecond clock's top
  // 32 bits, so two roles made within about a minute shared a code and hit role_tenant_id_code_key.
  const roleCode = opts.roleCode ?? `grant-${roleId.slice(-12)}`;
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.role (id, tenant_id, code, name_en)
             values (${roleId}, ${s.tenant}, ${roleCode}, ${`Granted role ${roleCode}`})`;
    for (const code of opts.codes ?? []) {
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${s.tenant}, ${roleId}, ${code})`;
    }
    await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
             values (${s.tenant}, ${principalId}, ${roleId}, ${s.company})`;
    for (const branchId of opts.branchIds ?? []) {
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${s.tenant}, ${principalId}, ${roleId}, ${s.company}, ${branchId})`;
    }
  });
  return roleId;
}

/**
 * contracts §4.17 — 3A's helpers. `seedItem` returns BOTH ids because every document line needs the
 * item and its base unit, and a caller that had to fetch the unit separately would either duplicate
 * the query in twenty files or reach for `db.admin`.
 *
 * The three §4.15 codes `seedTenant` does not ship (1300, 5000, 5900) are created here on first use,
 * so a test can call `seedItem(db, s)` on a bare seed and get a fully-accounted product.
 */
export async function seedUnit(
  db: Db,
  s: Seed,
  opts: { code?: string; nameEn?: string } = {},
): Promise<string> {
  const code = opts.code ?? "PCS";
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
    values (${s.tenant}, ${s.company}, ${code}, ${opts.nameEn ?? code})
    on conflict (company_id, code) do update set name_en = excluded.name_en
    returning id`,
  );
  return row!.id;
}

/** The three §4.15 codes `seedTenant` does not ship. Created through `seedAccount` — §4.17 calls it "the one
 *  way any test creates a §4.15 account", and 1A's helper is idempotent on `(company_id, code)` and returns
 *  the existing row's id, so a caller that already seeded `1300` itself (Task 9's `beforeAll` does) is not a
 *  23505. A raw `insert … on conflict do nothing` here would be a second way to create an account and would
 *  skip whatever `parentCode`/`currency` handling that helper performs. */
const ITEM_DEFAULT_ACCOUNTS: readonly {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}[] = [
  { code: "1300", nameEn: "Inventory control", type: "asset" },
  { code: "5000", nameEn: "Cost of goods sold", type: "expense" },
  { code: "5900", nameEn: "Other operating expense", type: "expense" },
];

export async function seedItem(
  db: Db,
  s: Seed,
  opts: {
    code?: string;
    kind?: "product" | "service" | "asset";
    trackLots?: boolean;
    baseUnitId?: string;
    accounts?: {
      revenueAccountId?: string | null;
      inventoryAccountId?: string | null;
      cogsAccountId?: string | null;
      expenseAccountId?: string | null;
    };
  } = {},
): Promise<{ itemId: string; baseUnitId: string }> {
  const baseUnitId = opts.baseUnitId ?? (await seedUnit(db, s));
  const code = opts.code ?? "ITEM-1";
  const kind = opts.kind ?? "product";
  // Hoisted OUT of the withTenant below: `seedAccount` takes `db` and opens its own transaction, so calling
  // it inside one would nest (§4.2.2 forbids nesting outright for the production seam).
  for (const a of ITEM_DEFAULT_ACCOUNTS) {
    await seedAccount(db, s, { code: a.code, nameEn: a.nameEn, type: a.type });
  }
  const itemId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const row = await createItem(
      tx,
      { tenantId: s.tenant, actorId: s.human, requestId: `seed-item-${code}` },
      {
        companyId: s.company,
        code,
        nameEn: code,
        kind,
        baseUnitId,
        // `exactOptionalPropertyTypes` is on, so an absent option is omitted rather than passed as
        // `undefined` — `NewItem` declares both as optional, not as "optional or explicitly undefined".
        ...(opts.trackLots === undefined ? {} : { trackLots: opts.trackLots }),
        ...(opts.accounts === undefined ? {} : { accounts: opts.accounts }),
      },
    );
    return row.id;
  });
  return { itemId, baseUnitId };
}

/** contracts §4.17 — 3A's helpers. `kind` defaults to 'stock'; pass 'in_transit' for 3D's transfers.
 *  `branchId` defaults to the seed's head-office BRANCH value, so a bare call needs no argument. */
export async function seedWarehouse(
  db: Db,
  s: Seed,
  opts: { code?: string; kind?: "stock" | "in_transit"; branchId?: string } = {},
): Promise<string> {
  const code = opts.code ?? "WH-1";
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    insert into app.warehouse (tenant_id, company_id, code, name_en, kind, branch_id)
    values (${s.tenant}, ${s.company}, ${code}, ${code}, ${opts.kind ?? "stock"}, ${opts.branchId ?? s.hq})
    on conflict (company_id, code) do update set name_en = excluded.name_en
    returning id`,
  );
  return row!.id;
}

/** A REAL lot. The sentinel is created by trigger with the item and is reached through `sentinelLotId`. */
export async function seedLot(
  db: Db,
  s: Seed,
  opts: { itemId: string; code?: string; expiresOn?: string },
): Promise<string> {
  const code = opts.code ?? "LOT-1";
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    insert into app.lot (tenant_id, company_id, item_id, code, expires_on)
    values (${s.tenant}, ${s.company}, ${opts.itemId}, ${code}, ${opts.expiresOn ?? null})
    on conflict (item_id, code) do update set expires_on = excluded.expires_on
    returning id`,
  );
  return row!.id;
}

/**
 * §4.17's 3A row. Creates a price list and, when `lines` is given, its lines. 6A's catalogue-sync tests use it.
 * Defaults: code "RETAIL", currency "MYR", no branch (every branch), no window (always valid), no lines.
 */
export async function seedPriceList(
  db: Db,
  s: Seed,
  opts?: {
    code?: string;
    currency?: string;
    branchId?: string;
    lines?: readonly PriceListLineInput[];
  },
): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const list = await createPriceList(tx, {
      companyId: s.company,
      code: opts?.code ?? "RETAIL",
      nameEn: opts?.code ?? "Retail",
      currency: opts?.currency ?? "MYR",
      branchId: opts?.branchId ?? null,
    });
    if (opts?.lines?.length) await replacePriceListLines(tx, list.id, opts.lines);
    return list.id;
  });
}

/** One line as accepted by `draftTypedDocument`. Every money and quantity value is a STRING (no-number-money, §3.7.5). */
export interface DraftLine {
  kind: "account" | "item" | "tax" | "text" | "tender" | "payroll";
  lineNo?: number;
  description?: string;
  accountId?: string;
  itemId?: string;
  taxCodeId?: string;
  warehouseId?: string;
  lotId?: string;
  unitId?: string;
  quantity?: string;
  unitQuantity?: string;
  unitPrice?: string;
  discount?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  dimensions?: Record<string, string>;
  customFields?: Record<string, unknown>;
}

export interface DraftTypedDocumentOptions {
  documentTypeId: string;
  series: string;
  effectiveDate?: string;
  currency?: string;
  exchangeRate?: string;
  partyId?: string;
  warehouseId?: string;
  toWarehouseId?: string;
  branchId?: string;
  clientRef?: string;
  lines: readonly DraftLine[];
}

/**
 * contracts §4.17 — 3C's helper. Drafts a document of ANY configured type with any lines, and returns the
 * header id and the line ids in `line_no` order. `draftDocument` (Plan 0A) is JOURNAL-only — it hard-codes
 * `s.docType` and series `'JV'` — and every slice from 3C on configures its own types. The number stays
 * null: numbering happens at issue, in the posting service, never here (§4.3.6).
 *
 * `posting_policy_id` is deliberately NOT written. 1A's `draftDocument` writes `s.policy` because a JOURNAL
 * draft in Plan 0A's fixture predates the pin rule, but §4.3.2 step 13 is what pins the policy at post and
 * §4.3.1's `reverseDocument` reads that pin — writing a guess here would give an unposted draft a pin it
 * did not earn. `exchange_rate` defaults to "1.00000000" rather than being omitted, so the FX cases of
 * 3C Tasks 9 and 12 differ from the default in exactly one visible parameter.
 */
export async function draftTypedDocument(
  db: Db,
  s: Seed,
  opts: DraftTypedDocumentOptions,
): Promise<{ documentId: string; lineIds: string[] }> {
  const documentId = await uuidv7(db.admin);
  const lineIds: string[] = [];
  for (let i = 0; i < opts.lines.length; i += 1) lineIds.push(await uuidv7(db.admin));

  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document
        (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date,
         currency, exchange_rate, party_id, warehouse_id, to_warehouse_id, branch_id, client_ref)
      values (${documentId}, ${s.tenant}, ${s.company}, ${opts.documentTypeId}, ${opts.series},
              ${s.period}, ${opts.effectiveDate ?? "2026-01-15"},
              ${opts.currency ?? "MYR"}, ${opts.exchangeRate ?? "1.00000000"},
              ${opts.partyId ?? null}, ${opts.warehouseId ?? null}, ${opts.toWarehouseId ?? null},
              ${opts.branchId ?? s.hq}, ${opts.clientRef ?? null})`;
    for (let i = 0; i < opts.lines.length; i += 1) {
      const l = opts.lines[i]!;
      await tx`
        insert into app.document_line
          (id, tenant_id, company_id, document_id, line_no, kind, description, account_id, item_id,
           tax_code_id, warehouse_id, lot_id, unit_id, quantity, unit_quantity, unit_price, discount, amount,
           debit, credit, dimensions, custom_fields)
        values (${lineIds[i]!}, ${s.tenant}, ${s.company}, ${documentId}, ${l.lineNo ?? i + 1},
                ${l.kind}, ${l.description ?? null}, ${l.accountId ?? null}, ${l.itemId ?? null},
                ${l.taxCodeId ?? null}, ${l.warehouseId ?? null}, ${l.lotId ?? null}, ${l.unitId ?? null},
                ${l.quantity ?? null}, ${l.unitQuantity ?? null}, ${l.unitPrice ?? null},
                ${l.discount ?? "0"}, ${l.amount ?? "0"}, ${l.debit ?? "0"}, ${l.credit ?? "0"},
                ${JSON.stringify(l.dimensions ?? {})}::text::jsonb, ${JSON.stringify(l.customFields ?? {})}::text::jsonb)`;
    }
  });
  return { documentId, lineIds };
}

/** §4.17, slice 4A. A `payment_term` for the seed's company, inserted as `s.human`. Defaults to NET30. */
export async function seedPaymentTerm(
  db: Db,
  s: Seed,
  opts?: { code?: string; dueDays?: number },
): Promise<string> {
  const code = opts?.code ?? "NET30";
  const dueDays = opts?.dueDays ?? 30;
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.payment_term (tenant_id, company_id, code, name_en, due_days)
      values (${s.tenant}, ${s.company}, ${code}, ${`Net ${dueDays} days`}, ${dueDays})
      returning id`;
    return row!.id;
  });
}

/**
 * §4.17's one 5A row. Creates the SYNTH-MY-v1 regime on the FIRST call for this seed's company and reuses it
 * afterwards, so a test that wants two codes in one regime writes two plain calls. Pass `regimeId` for the
 * second regime the wrong-regime cases need.
 *
 * The rate defaults to `0.11000000` and the code to `SYN-OUT-STD`: **no published Malaysian figure or code
 * name appears in any fixture** (hazard 1, §2.6's card). Accounts are looked up by the §4.15 codes `2300`
 * and `1350` and left null when the test has not seeded them — `tax_code_account_for_kind_check` then
 * refuses an `output`/`input` code, which is the intended, loud failure.
 */
export async function seedTaxCode(
  db: Db,
  s: Seed,
  opts?: {
    code?: string;
    rate?: string;
    kind?: "output" | "input" | "exempt" | "zero" | "out_of_scope";
    regimeId?: string;
  },
): Promise<{ taxCodeId: string; regimeId: string }> {
  const kind = opts?.kind ?? "output";
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    let regimeId = opts?.regimeId;
    if (!regimeId) {
      const [existing] = await tx<{ id: string }[]>`
        select id from app.tax_regime where company_id = ${s.company} and code = 'SYNTH-MY-v1' and version = 1`;
      if (existing) regimeId = existing.id;
      else {
        const [made] = await tx<{ id: string }[]>`
          insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                      name_en, name_ar, source)
          values (${s.tenant}, ${s.company}, 'SYNTH-MY-v1', 'MY', 1, '2026-01-01',
                  'Synthetic test regime', 'نظام اختباري', 'SYNTHETIC-TEST-v1 — not a published figure (OD-15)')
          returning id`;
        regimeId = made!.id;
      }
    }
    const [acct] = await tx<{ output_id: string | null; input_id: string | null }[]>`
      select max(id::text) filter (where code = '2300') as output_id,
             max(id::text) filter (where code = '1350') as input_id
        from app.account where company_id = ${s.company}`;
    const [row] = await tx<{ id: string }[]>`
      insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, rate, kind, rounding_mode,
                                output_account_id, input_account_id, effective_from)
      values (${s.tenant}, ${s.company}, ${regimeId}, ${opts?.code ?? "SYN-OUT-STD"},
              ${opts?.code ?? "SYN-OUT-STD"}, ${opts?.rate ?? "0.11000000"}, ${kind}, 'HALF_AWAY_FROM_ZERO',
              ${kind === "output" ? (acct?.output_id ?? null) : null},
              ${kind === "input" ? (acct?.input_id ?? null) : null},
              '2026-01-01')
      returning id`;
    return { taxCodeId: row!.id, regimeId };
  });
}

// packages/db/test/fixtures.ts — additively, at the end of the file (§4.1, hazard 9).
import { createTerminal } from "../src/sync/enrolment";

/** contracts §4.17 — 6A's helper. The terminal principal is returned because every signed request needs it,
 *  and because `grantCodes({ principalId })` is how a test narrows what the terminal may do. Goes through
 *  production's `createTerminal`, so a fixture terminal satisfies R8 exactly as a redeemed one does. */
export async function seedTerminal(
  db: Db,
  s: Seed,
  opts: { code?: string; branchId?: string; devicePublicKey?: Buffer } = {},
): Promise<{ terminalId: string; principalId: string }> {
  await runLoaders(
    db.rw,
    {
      config: {} as never,
      tenantId: s.tenant,
      companyId: s.company,
      systemPrincipalId: s.system,
      packRoot: fileURLToPath(new URL("../seed/my/", import.meta.url)),
    },
    ["roles"],
    "terminal-fixture-roles",
  );
  const code = opts.code ?? "T1";
  return withTenant(db.rw, s.tenant, s.system, async (tx) => {
    const t = await createTerminal(tx, {
      companyId: s.company,
      branchId: opts.branchId ?? s.hq,
      name: `Till ${code}`,
      code,
      devicePublicKey: opts.devicePublicKey ?? Buffer.alloc(44),
    });
    return { terminalId: t.terminalId, principalId: t.principalId };
  });
}

/**
 * A minimal employee and the `party` of kind 'employee' it extends (§4.6.2; spec:2075, 2097).
 * Owned by 6C / 8A — whichever executes first commits it; the other extends its options additively.
 * `principalId` is left null unless given: only staff who log in or sell have one.
 *
 * **It inserts as `db.migrator` / `s.system`, and that is amendment A15, not a style choice.**
 * `app.employee` carries Form A′ of the RESTRICTIVE `branch_isolation` family from migration 0068
 * (§4.5.6): `app.actor_in_branch(company_id, home_branch_id)`, which is true only for a `kind = 'system'`
 * principal or one holding a live `app.role_assignment` in the company. `seedTenant` grants `s.human`
 * nothing (§4.1, pinned), and a policy declared with `using` and no `with check` is applied AS the
 * `with check` on INSERT — so an `s.human` insert here fails with
 * `new row violates row-level security policy for table "employee"` the moment Task 5 lands.
 * 6D's `seedShift` is written the same way for the same reason (6D amendment A17).
 */
export async function seedEmployee(
  db: Db,
  s: Seed,
  opts: {
    employeeNumber?: string;
    homeBranchId?: string;
    principalId?: string;
    hiredOn?: string;
  } = {},
): Promise<string> {
  const employeeNumber = opts.employeeNumber ?? `E-${(await uuidv7(db.admin)).slice(-8)}`;
  const partyId = await seedParty(db, s, { kind: "employee", code: `EMP-${employeeNumber}` });
  const id = await uuidv7(db.admin);
  await withTenant(
    db.migrator,
    s.tenant,
    s.system,
    (tx) => tx`
    insert into app.employee (id, tenant_id, company_id, party_id, employee_number, home_branch_id, principal_id, hired_on)
    values (${id}, ${s.tenant}, ${s.company}, ${partyId}, ${employeeNumber},
            ${opts.homeBranchId ?? s.hq}, ${opts.principalId ?? null}, ${opts.hiredOn ?? "2026-01-01"})`,
  );
  return id;
}

/**
 * A cashier: a human principal with a membership, a `pos_cashier` row with a real Argon2id hash, and —
 * when `permissions` is given — a branch-restricted role assignment through 2B's `grantCodes`, which is
 * what makes `app.principal_has(principal, code, company, branch)` answer true (§4.5.3).
 * Returns the principal id, which is the row's primary key.
 */
export async function seedCashier(
  db: Db,
  s: Seed,
  opts: {
    employeeId: string;
    branchId: string;
    pin?: string;
    permissions?: readonly string[];
    principalId?: string;
  },
): Promise<string> {
  const principalId = opts.principalId ?? (await uuidv7(db.admin));
  const phc = await hashPin(opts.pin ?? "1234");
  if (!opts.principalId)
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${principalId}, 'human', ${"sub-cashier-" + principalId}, 'Cashier')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
    });
  await withTenant(
    db.migrator,
    s.tenant,
    s.system,
    (tx) => tx`
    insert into app.pos_cashier (principal_id, tenant_id, company_id, employee_id, branch_id, pin_hash)
    values (${principalId}, ${s.tenant}, ${s.company}, ${opts.employeeId}, ${opts.branchId}, ${phc})`,
  );
  if (opts.permissions && opts.permissions.length > 0) {
    await grantCodes(db, s, {
      codes: opts.permissions,
      principalId,
      roleCode: `cashier-${principalId.slice(-8)}`,
      branchIds: [opts.branchId],
    });
  }
  await withTenant(
    db.migrator,
    s.tenant,
    s.system,
    (tx) => tx`select app.refresh_pos_cashier(${principalId})`,
  );
  return principalId;
}

/**
 * One `branch_pos_policy` row. Every unspecified limit keeps the migration's CLOSED default.
 *
 * `limits` carries **every one of §4.6.4's eleven settable columns**, including the two nullable ones
 * (`maxCashInDrawer`, `requireCustomerOver`) — the same key set as `BranchPosPolicyInput` minus its
 * required `branchId`, which this helper takes as its own option. It is spelled out rather than imported
 * from `../src/staff/branch-pos-policy`, because that module is written in Step 6 and this file is run
 * green in Step 4; the two shapes are asserted equal by `typecheck` at the route layer, which passes a
 * `BranchPosPolicyInput` into the same columns.
 *
 * **It inserts as `db.migrator` / `s.system` — amendment A15.** `app.branch_pos_policy` carries Form A of
 * the RESTRICTIVE `branch_isolation` family from migration 0068, `app.actor_in_branch` is true only for a
 * `kind = 'system'` principal or one with a live `app.role_assignment`, `seedTenant` grants `s.human`
 * nothing, and a `using`-only policy is applied AS the `with check` on INSERT.
 */
export async function seedBranchPosPolicy(
  db: Db,
  s: Seed,
  opts: {
    branchId?: string;
    limits?: {
      maxLineDiscountPct?: string;
      maxTicketDiscountPct?: string;
      maxVoidAmount?: string;
      maxPriceOverridePct?: string;
      blindReturnAllowed?: boolean;
      maxBlindReturnAmount?: string;
      maxCashInDrawer?: string | null;
      requireCustomerOver?: string | null;
      roundingIncrement?: string;
      paidOutAllowed?: boolean;
      maxPaidOutAmount?: string;
    };
  } = {},
): Promise<string> {
  const id = await uuidv7(db.admin);
  const l = opts.limits ?? {};
  await withTenant(
    db.migrator,
    s.tenant,
    s.system,
    (tx) => tx`
    insert into app.branch_pos_policy
      (id, tenant_id, company_id, branch_id, max_line_discount_pct, max_ticket_discount_pct, max_void_amount,
       max_price_override_pct, blind_return_allowed, max_blind_return_amount, max_cash_in_drawer,
       require_customer_over, rounding_increment, paid_out_allowed, max_paid_out_amount)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.branchId ?? s.hq},
            ${l.maxLineDiscountPct ?? "0.000000"}, ${l.maxTicketDiscountPct ?? "0.000000"}, ${l.maxVoidAmount ?? "0.0000"},
            ${l.maxPriceOverridePct ?? "0.000000"}, ${l.blindReturnAllowed ?? false}, ${l.maxBlindReturnAmount ?? "0.0000"},
            ${l.maxCashInDrawer ?? null}, ${l.requireCustomerOver ?? null},
            ${l.roundingIncrement ?? "0.0500"}, ${l.paidOutAllowed ?? false}, ${l.maxPaidOutAmount ?? "0.0000"})`,
  );
  return id;
}

/**
 * An OPEN shift, in the uniform (db, s, opts?) shape §4.17 fixes. Returns the shift id — the uuidv7 a till
 * would have minted when the drawer was counted in, so a test may pass it as `Ticket.shiftId` directly.
 *
 * There is deliberately no `closeShift` fixture: closing derives `expected_cash` from the ledger and posts a
 * document, and a fixture that wrote those columns by hand would let a test pass against arithmetic the
 * production path never ran. Closing goes through `applyBatch` (§4.17's note on this row).
 */
export async function seedShift(
  db: Db,
  s: Seed,
  opts: {
    terminalId: string;
    cashierPrincipalId: string;
    openingFloat?: string;
    currency?: string;
    branchId?: string;
    shiftId?: string;
  },
): Promise<string> {
  const id = opts.shiftId ?? (await uuidv7(db.admin));
  // `db.migrator` + `s.system`, NOT `db.rw` + `s.human` — the one deviation from §4.17's preamble, recorded
  // as amendment A17 and forced by the table's own policy. `app.shift` carries Form A's RESTRICTIVE
  // `branch_isolation`, `app.actor_in_branch` (6C) is true only for a `kind = 'system'` principal or one
  // with a live `app.role_assignment` in the company, and `seedTenant` grants `s.human` nothing (§4.1,
  // pinned). A policy declared with `using` alone is applied as `with check` on INSERT too, so an
  // `s.human` insert here fails with `new row violates row-level security policy for table "shift"` —
  // in `beforeAll`, before any assertion of the test that called it. 6C's `seedCashier` writes its
  // `app.principal` half exactly this way (6C Task 2 Step 8) and this is the same reason.
  await withTenant(
    db.migrator,
    s.tenant,
    s.system,
    (tx) => tx`
    insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id,
                           opened_principal_id, opened_at, opening_float, currency)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.branchId ?? s.hq}, ${opts.terminalId},
            ${opts.cashierPrincipalId}, now(), ${opts.openingFloat ?? "0.0000"}, ${opts.currency ?? "MYR"})
    on conflict (id) do nothing`,
  );
  return id;
}

/**
 * contracts §4.17's one row for slice 7A. `isCore` defaults to true because the clone-and-edit tests need a
 * core row to clone; a tenant's own definition is what cloning produces, not what a fixture seeds.
 */
export interface SeedReportDefinitionOptions {
  code: string;
  definition: unknown;
  /** The ROW version (`app.report_definition.version`, default 1) — never `ReportDefinition.version`, which
   *  is §4.11.1's frozen FORMAT version. The two are different numbers, so the option is never `version`. */
  definitionVersion?: number;
  isCore?: boolean;
  clonedFrom?: string | null;
}

/**
 * Inserts one `app.report_definition` row in the seed's company and returns its id. The definition goes in as
 * `::text::jsonb`, the tree's convention (`seed/document-types.ts`): a bare `::jsonb` parameter is serialised
 * by postgres.js as JSON a second time, so the column held a jsonb STRING and `loadRunDefinition` handed the
 * render job text, not an object (found by 7A Task 11).
 */
export async function seedReportDefinition(
  db: Db,
  s: Seed,
  opts: SeedReportDefinitionOptions,
): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.report_definition (tenant_id, company_id, code, version, definition, is_core, cloned_from)
      values (${s.tenant}, ${s.company}, ${opts.code}, ${opts.definitionVersion ?? 1},
              ${JSON.stringify(opts.definition)}::text::jsonb, ${opts.isCore ?? true}, ${opts.clonedFrom ?? null})
      returning id`;
    return row!.id;
  });
}

/**
 * contracts §4.17's one 7C row (amendment A13). Inserts on `db.rw` inside the 4-argument test `withTenant`,
 * as every fixture does; `requested_by` is stamped, so the row's requester is `s.human`. A `done` row gets a
 * placeholder artefact and a `failed` row a reason, because migration 0078's outcome CHECK refuses either
 * status without them — the fixture writes a row the production path could have written, never a looser one.
 */
export interface SeedExportJobOptions {
  format?: "csv" | "json" | "both";
  status?: "queued" | "running" | "done" | "failed";
  readableModules?: readonly string[];
  lotAttachments?: boolean;
  includeAttachments?: boolean;
  /** The requesting principal (`app.stamp_actor` fills `requested_by` from the session actor). Defaults to `s.human`;
   *  the Phase 8 review's test-32 case asks as a principal without `hr.payroll.read`. */
  requestedBy?: string;
}

export async function seedExportJob(
  db: Db,
  s: Seed,
  opts: SeedExportJobOptions = {},
): Promise<string> {
  const id = await uuidv7(db.admin);
  const status = opts.status ?? "queued";
  const done = status === "done";
  const finished = status === "done" || status === "failed";
  await withTenant(
    db.rw,
    s.tenant,
    opts.requestedBy ?? s.human,
    (tx) => tx`
    insert into app.export_job
      (id, tenant_id, company_id, format, status, readable_modules, lot_attachments, include_attachments,
       started_at, finished_at, object_key, sha256, error)
    values (${id}, ${s.tenant}, ${s.company}, ${opts.format ?? "both"}, ${status},
            ${[...(opts.readableModules ?? ["accounting"])]}::text[],
            ${opts.lotAttachments ?? false}, ${opts.includeAttachments ?? true},
            ${status === "queued" ? null : new Date()}, ${finished ? new Date() : null},
            ${done ? exportObjectKeyFor(s.tenant, id, 1) : null},
            ${done ? Buffer.alloc(32) : null},
            ${status === "failed" ? "seeded failure" : null})`,
  );
  return id;
}

/**
 * One row of the pay-component catalogue (§4.6.1; spec:2078-2079). §4.17's 8A row. `kind` is TWO-valued; an
 * employer contribution is a scheme's employer share, never a component. The payable account is left null: 8B
 * seeds the payroll accounts and sets them (§4.12.2, amendment A2).
 */
export async function seedPayComponent(
  db: Db,
  s: Seed,
  opts: {
    code?: string;
    kind?: "earning" | "deduction";
    expenseAccountId?: string;
    quantityBased?: boolean;
  } = {},
): Promise<string> {
  const code = opts.code ?? `PC-${(await uuidv7(db.admin)).slice(-8)}`;
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`
    insert into app.pay_component (id, tenant_id, company_id, code, name_en, kind, expense_account_id, quantity_based)
    values (${id}, ${s.tenant}, ${s.company}, ${code}, ${code}, ${opts.kind ?? "earning"},
            ${opts.expenseAccountId ?? null}, ${opts.quantityBased ?? false})`,
  );
  return id;
}

/**
 * §4.12.4's synthetic table, verbatim. Amendment A5 makes this the ONE home of a fixture's rate figures: §4.17's
 * `seedRateTable` row says its `definition` defaults to "SYNTHETIC-TEST-v1", and §4.12.4 puts the FILE
 * (packages/db/seed/test/statutory/SYNTH/v1.json) in 8B — a fixture default cannot depend on a file a later slice
 * writes. `scheme` is "SYNTH": §4.12.3's pattern ^[A-Z][A-Z0-9_]{1,15}$ admits no hyphen and no lower case.
 * The numbers are INVENTED for tests and are a rate of no authority anywhere (spec:2080, hazard 1). Its type is
 * inferred and never names `RateTable` — packages/db's test tier does not import `@dulja/domain/payroll` for a const.
 */
export const SYNTH_RATE_TABLE_V1 = {
  schema_version: 1,
  scheme: "SYNTH",
  version: 1,
  kind: "banded_contribution",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md §4.12.4",
    url: "https://dulja.invalid/test-fixture/synth/v1",
    retrieved_on: "2026-01-01",
    notes: "Invented numbers for tests. Not a rate of any authority anywhere.",
  },
  verification: {
    verified_by: "Dulja test fixture",
    verified_on: "2026-01-01",
    method: "synthetic_test",
  },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  required_profile_fields: [],
  table: {
    bands: [
      { from: "0.0000", to: "1000.0000", employee: "10.0000", employer: "20.0000" },
      { from: "1000.0000", to: "5000.0000", employee: "50.0000", employer: "100.0000" },
      { from: "5000.0000", to: null, employee: "250.0000", employer: "500.0000" },
    ],
  },
} as const;

/** §4.17's 8A row. The account columns stay null: 8B's payroll chart seed sets them (amendment A2). */
export async function seedStatutoryScheme(
  db: Db,
  s: Seed,
  opts: { code?: string; payableAccountId?: string; employerExpenseAccountId?: string } = {},
): Promise<string> {
  const code = opts.code ?? "SYNTH";
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`
    insert into app.statutory_scheme (id, tenant_id, company_id, code, name_en, payable_account_id, employer_expense_account_id)
    values (${id}, ${s.tenant}, ${s.company}, ${code}, ${`${code} (synthetic)`},
            ${opts.payableAccountId ?? null}, ${opts.employerExpenseAccountId ?? null})`,
  );
  return id;
}

/** §4.17's 8A row. Loads as `s.human` and, when `verified`, verifies as `s.system` — two different principals by
 *  construction, so the verifier trigger's `verified_by <> loaded_by` rule passes. `effective_from` and
 *  `effective_to` are read from `definition` when it carries them (the synthetic default opens 2026-01-01). */
export async function seedRateTable(
  db: Db,
  s: Seed,
  opts: { schemeId: string; version?: number; definition?: unknown; verified?: boolean },
): Promise<string> {
  const definition = (opts.definition ?? SYNTH_RATE_TABLE_V1) as {
    effective_from?: string;
    effective_to?: string | null;
  };
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`
    insert into app.statutory_rate_table (id, tenant_id, scheme_id, version, effective_from, effective_to, definition, source)
    select ${id}, ${s.tenant}, sc.id, ${opts.version ?? 1}::int,
           ${definition.effective_from ?? "2026-01-01"}::date, ${definition.effective_to ?? null}::date,
           ${tx.json(definition as never)}, 'Dulja test fixture / synthetic'
      from app.statutory_scheme sc where sc.id = ${opts.schemeId}::uuid`,
  );
  if (opts.verified === true) {
    await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx`
      update app.statutory_rate_table set verified_at = now(), verified_by = app.current_actor() where id = ${id}::uuid`,
    );
  }
  return id;
}

/**
 * §4.17's one 8B row (contracts round 17, A6): a DRAFT payroll run — the `document`, its `payroll_run` extension,
 * and one zero-amount `payroll` line per employee so a test has line ids to attach `payroll_line` rows to.
 * `payDate`, `branchId` and `effectiveDate` are the additive options A6 records.
 *
 * It deliberately does NOT calculate: approval and posting go through the real state machine and the real run
 * service (8B Task 10). A fixture that computed figures would give the golden tests a second source of truth,
 * which is SAH-009 in a test suite. The fiscal period is the one covering the effective date (January's, the
 * seed's own, when no other covers it). Returns the DOCUMENT id — `payroll_run` is keyed on it.
 */
export async function seedPayrollRun(
  db: Db,
  s: Seed,
  opts: {
    periodStart: string;
    periodEnd: string;
    employeeIds: readonly string[];
    kind?: "regular" | "supplementary" | "final";
    payDate?: string;
    branchId?: string;
    effectiveDate?: string;
  },
): Promise<string> {
  const documentId = await uuidv7(db.admin);
  const [type] = await db.admin<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = 'PAYROLL'`;
  if (!type) {
    throw new Error(
      "seedPayrollRun: document type PAYROLL is not configured for this company — seed it first (8B Task 4)",
    );
  }
  const effectiveDate = opts.effectiveDate ?? opts.periodEnd;
  const payDate = opts.payDate ?? opts.periodEnd;
  const [period] = await db.admin<{ id: string }[]>`
    select id from app.fiscal_period
     where company_id = ${s.company} and ${effectiveDate}::date between starts_on and ends_on`;
  const lineIds: string[] = [];
  for (let i = 0; i < opts.employeeIds.length; i += 1) lineIds.push(await uuidv7(db.admin));

  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    await tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                effective_date, currency, exchange_rate, branch_id)
      values (${documentId}, ${s.tenant}, ${s.company}, ${type.id}, 'PAY', ${period?.id ?? s.period},
              ${effectiveDate}, 'MYR', '1.00000000', ${opts.branchId ?? s.hq})`;
    await tx`
      insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date)
      values (${documentId}, ${s.tenant}, ${s.company}, ${opts.kind ?? "regular"},
              ${opts.periodStart}, ${opts.periodEnd}, ${payDate})`;
    for (let i = 0; i < opts.employeeIds.length; i += 1) {
      await tx`
        insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount, dimensions)
        values (${lineIds[i]!}, ${s.tenant}, ${s.company}, ${documentId}, ${i + 1}, 'payroll', '0', '{}'::jsonb)`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${lineIds[i]!}, ${s.tenant}, ${s.company}, ${opts.employeeIds[i]!}, '0.0000')`;
    }
  });
  return documentId;
}

/**
 * 9B (contracts §4.17, round 20 C5). One `import_batch` row, so a test can assert what a loader skips without running
 * a loader. `source_hash` is the all-zero sha256 shape (the DDL's CHECK is `^[0-9a-f]{64}$`); `loaded_by` is stamped
 * with the seed's human. Returns the row id.
 */
export async function seedImportBatch(
  db: Db,
  s: Seed,
  opts: {
    sourceTable: string;
    sourceKey: string;
    targetTable: string;
    targetId: string;
    runId?: string;
  },
): Promise<string> {
  const id = await uuidv7(db.admin);
  const runId = opts.runId ?? (await uuidv7(db.admin));
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx`insert into app.import_batch (id, tenant_id, company_id, source_table, source_key,
                                       target_table, target_id, source_hash, run_id)
         values (${id}, ${s.tenant}, ${s.company}, ${opts.sourceTable}, ${opts.sourceKey},
                 ${opts.targetTable}, ${opts.targetId}, ${"0".repeat(64)}, ${runId})`,
  );
  return id;
}
