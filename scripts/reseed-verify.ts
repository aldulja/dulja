// scripts/reseed-verify.ts — the four-line staging check §4.7.2's closing paragraph requires.
// `--tenant <uuid>` runs against DATABASE_URL_MIGRATOR; `--local` starts a container and seeds one tenant,
// which is this slice's definition of done when the owner has not yet provided staging access (hazard 5).
// The imports are RELATIVE, not `@dulja/*`. This repository's `bun install` uses the isolated linker: every
// workspace has its own `node_modules` and the root has only the five build tools, so a file sitting in
// `scripts/` — which is not a workspace — cannot resolve `@dulja/db` from its own directory upwards, and
// `bun ../../scripts/reseed-verify.ts` fails before it reads an argument. Resolution is by the IMPORTING
// file's location, so `--cwd packages/db` does not help. Reaching in by path is legal here: `dependency-rule`
// gives `scripts/**` no tier row (0b:5064), and `tests/support/source.ts` already reaches the other way.
// `Sql` comes from the one place that does not need `postgres` on this side: the transaction `withTenant`
// hands its callback.
import { fileURLToPath } from "node:url";
import { PERMISSIONS } from "../packages/contracts/permissions";
import { createDb, systemContext, withTenant } from "../packages/db/src/index";
import { loadDocumentTypes } from "../packages/db/src/seed/index";
import { seedItem, seedTenantV2, startDb } from "../packages/db/test/index";

type Sql = Parameters<Parameters<typeof withTenant>[2]>[0];

interface Check {
  name: string;
  detail: string;
  ok: boolean;
}

/** Every check is a READ. This script never repairs anything: a non-zero count means "drop and re-seed". */
async function checks(tx: Sql, companyId: string): Promise<Check[]> {
  const [provisional] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from app.inventory_movement m
      left join app.cost_layer l on l.tenant_id = m.tenant_id and l.movement_id = m.id
     where m.company_id = ${companyId} and m.quantity > 0 and l.id is null`;

  const [drift] = await tx<{ n: number }[]>`
    select count(*)::int as n from app.cost_layer l
     where l.company_id = ${companyId} and l.invalidated_at is null
       and l.qty_remaining <> l.qty_in - coalesce((
             select sum(c.quantity) from app.cost_consumption c
              where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null), 0)`;

  const [accounts] = await tx<{ inventory: boolean; cogs: boolean }[]>`
    select exists (select 1 from app.account where company_id = ${companyId} and code = '1300' and archived_at is null) as inventory,
           exists (select 1 from app.account where company_id = ${companyId} and code = '5000' and archived_at is null) as cogs`;

  const [documentType] = await tx<{ series: string; module: string }[]>`
    select t.series, t.module from app.document_type t
     where t.company_id = ${companyId} and t.code = 'COST_ADJUSTMENT' and t.archived_at is null`;

  return [
    {
      name: "provisional-movements",
      ok: provisional!.n === 0,
      detail: `${provisional!.n} rows with a cost_layer-less receipt`,
    },
    {
      name: "cost-layer-invariant",
      ok: drift!.n === 0,
      detail: `${drift!.n} layers where qty_remaining <> qty_in - sum(valid consumptions)`,
    },
    {
      name: "account-codes",
      ok: accounts!.inventory && accounts!.cogs,
      detail: `1300 ${accounts!.inventory ? "ok" : "MISSING"}, 5000 ${accounts!.cogs ? "ok" : "MISSING"}`,
    },
    {
      name: "document-types",
      ok: documentType?.series === "CA" && documentType?.module === "accounting",
      detail: documentType
        ? `COST_ADJUSTMENT ok (series ${documentType.series}, module ${documentType.module})`
        : "COST_ADJUSTMENT MISSING",
    },
  ];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const local = argv.includes("--local");
  const tenantId = argv[argv.indexOf("--tenant") + 1];
  if (!local && (argv.indexOf("--tenant") < 0 || !tenantId)) {
    throw new Error("usage: reseed:verify --tenant <tenant uuid> | reseed:verify --local");
  }

  let failures = 0;
  const report = (rows: Check[]): void => {
    for (const r of rows) {
      // oxlint-disable-next-line no-console -- this script's entire purpose is four lines of output
      console.log(`${`${r.name}:`.padEnd(23)}${r.ok ? "ok — " : "FAILED — "}${r.detail}`);
      if (!r.ok) failures += 1;
    }
  };

  if (local) {
    const db = await startDb();
    try {
      const s = await seedTenantV2(db, "ReseedVerify");
      const ctx = { tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() };
      // The two things a staging re-seed does, done here so the local run checks the same four facts rather
      // than four vacuous ones: 3A's `seedItem` seeds 1300/5000/5900 idempotently, and the document-types
      // sub-pack carries COST_ADJUSTMENT (Task 8). `seedTenantV2` alone seeds 1000/4000 (plan0A:1592-1594).
      await seedItem(db, s, { code: "RESEED-VERIFY" });
      // `loadDocumentTypes` takes a POOL and opens its own `withTenant`: handing it a transaction makes the
      // production `withTenant` raise ERR_TENANT_CONTEXT_NESTED (packages/db/src/with-tenant.ts:48).
      await loadDocumentTypes(
        db.migrator,
        ctx,
        // Resolved from this file, never from `process.cwd()`: the package script runs it with
        // `bun run --cwd packages/db`, and a bare "packages/db/seed/…" would resolve to
        // packages/db/packages/db/seed/… and the loader would raise ENOENT (the same trap 1A records
        // at 1a:5114 for a seed-pack path inside that package).
        fileURLToPath(new URL("../packages/db/seed/my/document-types", import.meta.url)),
        PERMISSIONS.map((p) => p.code),
      );
      report(await withTenant(db.rw, ctx, (tx) => checks(tx, s.company)));
    } finally {
      await db.stop();
    }
  } else {
    const url = process.env["DATABASE_URL_MIGRATOR"];
    if (!url) throw new Error("DATABASE_URL_MIGRATOR is not set (§3.11)");
    const sql = createDb(url);
    try {
      const ctx = await systemContext(sql, tenantId!, crypto.randomUUID());
      const companies = await withTenant(
        sql,
        ctx,
        (tx) => tx<{ id: string; code: string }[]>`
          select id::text as id, code from app.company order by code`,
      );
      for (const c of companies) {
        // oxlint-disable-next-line no-console -- one header per company, then its four lines
        console.log(`company ${c.code}:`);
        report(await withTenant(sql, ctx, (tx) => checks(tx, c.id)));
      }
    } finally {
      await sql.end();
    }
  }

  if (failures > 0) process.exit(1);
}

await main();
