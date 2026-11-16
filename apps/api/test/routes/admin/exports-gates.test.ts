import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_TABLES, NEVER_EXPORTED, getExportJob, runExport } from "@dulja/db";
import { grantCodes, withTenant } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import {
  branchActor,
  staffFixture,
  type StaffFixture,
} from "../../../../../tests/invariants/support/staff";
import { startApi, type StartedApi } from "../../support/app";

/** Every gate the registry declares, so a principal holding them all receives every registered table. */
const ALL_GATES = [...new Set(EXPORT_TABLES.flatMap((t) => (t.gate === null ? [] : [t.gate])))];

/**
 * Part VI tests 32 and 36, their export clauses (spec:2450, 2454; 7C Task 10). 32: sensitive fields have no
 * side channel through any export — no `NEVER_EXPORTED` column or value reaches an archive, and a gated table
 * the requester cannot hold is absent AND named. 36: a principal narrowed to one branch cannot export at all,
 * because the export is company-wide or refused.
 */
describe("Part VI tests 32 and 36 — the export is a covered side channel", () => {
  let api: StartedApi;
  let f: StaffFixture;
  let exporter: string; // admin.data.export + accounting.ledger.read (and 6A's codes), company-wide
  let everything: string; // admin.data.export + every registry gate, company-wide
  let branchManager: string; // admin.data.export, but assigned WITH a branch row
  let narrowGates: string; // admin.data.export company-wide, hr.employee.read narrowed to branch A

  beforeAll(async () => {
    api = await startApi();
    f = await staffFixture(api, "export-gates");
    exporter = f.seed.human;
    await grantCodes(api.db, f.seed, {
      codes: ["admin.data.export", "accounting.ledger.read"],
      principalId: exporter,
      roleCode: "exp-wide",
    });
    // 6C's `branchActor` creates a principal, its membership and a grant NARROWED to one branch in one call —
    // the assignment shape test 36 is about. `branchId: null` grants company-wide.
    branchManager = await branchActor(
      api.db,
      f.seed,
      f.branchA,
      ["admin.data.export"],
      "exp-branch",
    );
    everything = await branchActor(
      api.db,
      f.seed,
      null,
      ["admin.data.export", ...ALL_GATES],
      "exp-all",
    );
    narrowGates = await branchActor(api.db, f.seed, null, ["admin.data.export"], "exp-narrow");
    await grantCodes(api.db, f.seed, {
      codes: ["hr.employee.read"],
      principalId: narrowGates,
      branchIds: [f.branchA],
      roleCode: "exp-narrow-hr",
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => {
    await api.stop();
  });

  const post = (as: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${f.seed.company}/exports`,
      body: { format: "both" },
      as,
    });
  const requestAs = async (as: string): Promise<string> => {
    const res = await post(as);
    expect(res.status).toBe(202);
    return ((await res.json()) as { exportJobId: string }).exportJobId;
  };

  /** Runs the queued export inline, as the system principal, and unpacks it into { path -> utf-8 text }. */
  async function archiveOf(exportJobId: string): Promise<Map<string, string>> {
    const job = (await withTenant(api.db.rw, f.seed.tenant, f.seed.system, (tx) =>
      getExportJob(tx, exportJobId),
    ))!;
    const { bytes } = await runExport(
      (fn) => withTenant(api.db.rw, f.seed.tenant, f.seed.system, fn),
      api.objectStore,
      { job, tenantId: f.seed.tenant, generatedAt: "2026-02-01T00:00:00Z" },
    );
    const tar = gunzipSync(Buffer.from(bytes));
    const out = new Map<string, string>();
    for (let at = 0; at + 512 <= tar.length;) {
      const name = tar
        .subarray(at, at + 100)
        .toString("utf8")
        .replace(/\0.*$/s, "");
      if (name === "") break;
      const size = parseInt(
        tar
          .subarray(at + 124, at + 135)
          .toString("ascii")
          .trim(),
        8,
      );
      out.set(name, tar.subarray(at + 512, at + 512 + size).toString("utf8"));
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  }

  // ── test 36's export clause ───────────────────────────────────────────────────────────────────────────
  it("a branch-narrowed principal cannot export at all — company-wide or refused (ADR 0070)", async () => {
    const res = await post(branchManager);
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a table gate held only at one branch does not admit the table: the gate is resolved company-wide", async () => {
    const manifest = JSON.parse(
      (await archiveOf(await requestAs(narrowGates))).get("manifest.json")!,
    ) as { excluded: { table: string; gate: string }[]; tables: { name: string }[] };
    expect(manifest.excluded).toContainEqual({ table: "employee", gate: "hr.employee.read" });
    expect(manifest.tables.map((t) => t.name)).not.toContain("employee");
  });

  it("the same principal, granted company-wide, succeeds — so the refusal was the SCOPE, not the code", async () => {
    await grantCodes(api.db, f.seed, {
      codes: ["admin.data.export"],
      principalId: branchManager,
      roleCode: "exp-branch-wide",
    });
    await api.loadPrincipals();
    expect((await post(branchManager)).status).toBe(202);
  });

  // ── test 32's export clause ───────────────────────────────────────────────────────────────────────────
  it("no NEVER_EXPORTED column, and no value of one, reaches the fullest archive the company can produce", async () => {
    const files = await archiveOf(await requestAs(everything));
    const schema = JSON.parse(files.get("schema.json")!) as {
      tables: { name: string; columns: { name: string }[]; omitted: string[] }[];
    };
    const manifest = JSON.parse(files.get("manifest.json")!) as { excluded: unknown[] };
    expect(manifest.excluded).toEqual([]); // every gate is held, so every registered table is here
    for (const table of schema.tables) {
      const pinned = NEVER_EXPORTED[table.name] ?? [];
      for (const forbidden of pinned) {
        expect(
          table.columns.map((c) => c.name),
          `${table.name}.${forbidden}`,
        ).not.toContain(forbidden);
        expect(table.omitted, `${table.name}.${forbidden}`).toContain(forbidden);
      }
      const csvHeader = files.get(`tables/${table.name}.csv`)!.split("\n")[0]!.split(",");
      for (const forbidden of pinned) expect(csvHeader, table.name).not.toContain(forbidden);
    }
    // A pinned table has no file at all.
    for (const [name, columns] of Object.entries(NEVER_EXPORTED)) {
      if (!columns.includes("*")) continue;
      expect(
        [...files.keys()].filter((p) => p.startsWith(`tables/${name}.`)),
        name,
      ).toEqual([]);
    }
    // And the secrets themselves are absent from the BYTES, not merely from the headers: every live value of
    // a pinned text or bytea column this fixture holds (an Argon2id PIN hash, a till's public key, a
    // principal's identity-provider subject, an attachment's store key) is searched for in every file.
    const everyFile = [...files.values()].join("\n");
    let searched = 0;
    for (const [table, column] of [
      ["pos_cashier", "pin_hash"],
      ["pos_terminal", "device_public_key"],
      ["principal", "auth_subject"],
      ["company", "einvoice_client_id"],
      ["company", "einvoice_credential_ref"],
      ["attachment", "object_key"],
      ["report_run", "object_key"],
    ] as const) {
      const sql = api.db.admin;
      const [{ data_type: type } = { data_type: "missing" }] = await sql<{ data_type: string }[]>`
        select data_type from information_schema.columns
         where table_schema = 'app' and table_name = ${table} and column_name = ${column}`;
      expect(type, `${table}.${column}`).not.toBe("missing");
      const value =
        type === "bytea" ? sql`encode(${sql(column)}, 'hex')` : sql`${sql(column)}::text`;
      const values = await sql<{ v: string }[]>`
        select distinct ${value} as v from ${sql(`app.${table}`)} where ${sql(column)} is not null`;
      for (const { v } of values) {
        searched += 1;
        expect(everyFile.includes(v), `${table}.${column}`).toBe(false);
      }
    }
    expect(searched).toBeGreaterThan(0); // the fixture really holds PIN hashes, keys and subjects
  });

  it("a gated table the requester cannot hold is absent AND named — the shape 8A plugs into", async () => {
    const files = await archiveOf(await requestAs(exporter));
    const manifest = JSON.parse(files.get("manifest.json")!) as {
      excluded: { table: string; gate: string }[];
      tables: { name: string }[];
    };
    // `exporter` holds neither admin.audit_log.read nor hr.employee.read (6A's fixture gives it the posting
    // and tax codes, so the tax tables are its to export).
    expect(manifest.excluded.map((e) => e.table)).toEqual(
      expect.arrayContaining(["audit_log", "document_event", "employee", "pos_cashier"]),
    );
    // Each exclusion is a gate the requester really does not hold company-wide, and each included gated table
    // one it does — asked through the same predicate, in the tenant.
    const holds = (gate: string) =>
      withTenant(api.db.rw, f.seed.tenant, f.seed.system, async (tx) => {
        const [row] = await tx<{ ok: boolean }[]>`
          select app.principal_has(${exporter}::uuid, ${gate}, ${f.seed.company}::uuid, null) as ok`;
        return row!.ok;
      });
    for (const { table, gate } of manifest.excluded)
      expect(await holds(gate), `${table} (${gate})`).toBe(false);
    const includedGates = EXPORT_TABLES.filter(
      (t) => t.gate !== null && manifest.tables.some((m) => m.name === t.name),
    );
    expect(includedGates.length).toBeGreaterThan(0);
    for (const table of includedGates)
      expect(await holds(table.gate!), `${table.name} (${table.gate})`).toBe(true);
    expect(manifest.tables.map((t) => t.name)).not.toContain("audit_log");
    expect([...files.keys()]).not.toContain("tables/audit_log.csv");
    expect([...files.keys()]).not.toContain("tables/pos_cashier.csv");
    // Every table in the registry is either included or excluded — never silently missing from both, and
    // never in both.
    const included = manifest.tables.map((t) => t.name);
    const excluded = manifest.excluded.map((e) => e.table);
    expect(included.filter((name) => excluded.includes(name))).toEqual([]);
    expect([...included, ...excluded].toSorted()).toEqual(
      EXPORT_TABLES.map((t) => t.name).toSorted(),
    );
  });

  it("schema.json's omission list never hides a gated column behind a name change", async () => {
    const files = await archiveOf(await requestAs(everything));
    const schema = JSON.parse(files.get("schema.json")!) as {
      tables: { name: string; columns: { name: string }[]; omitted: string[] }[];
    };
    // `omitted` is documentation, not a hiding place: every omitted name is a real column, and every real
    // column is either exported or omitted.
    for (const table of schema.tables) {
      const live = await api.db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table.name}`;
      const names = live.map((r) => r.column_name).toSorted();
      for (const omitted of table.omitted)
        expect(names, `${table.name}.${omitted}`).toContain(omitted);
      expect(
        [...table.columns.map((c) => c.name), ...table.omitted].toSorted(),
        table.name,
      ).toEqual(names);
    }
  });
});
