import { PERMISSIONS } from "@dulja/contracts";
import { fullRegression } from "../support/api";

fullRegression("LEGACY-078", "Behaviour-governing configuration lives in opaque blobs", {
  "permissions are a version-controlled list, not a bitmask blob": async ({ api, expect }) => {
    const cols = await api.db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'permission' and column_name = 'code'`;
    expect(cols[0]!.data_type).toBe("text");
    expect([...PERMISSIONS].every((p) => /^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(p.code))).toBe(true);
    const blobs = await api.db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'permission' and data_type in ('bytea', 'bit', 'bit varying')`;
    expect(blobs).toEqual([]);
  },

  "posting policies and document types are jsonb — queryable and diffable — never an opaque blob":
    async ({ api, expect }) => {
      // Named columns, not a schema-wide sweep: 8A's `employee_sensitive` envelope (§4.12.5) is legitimately
      // `bytea`, and this block cannot be edited when it lands (contracts §3.7.3). The defect was configuration
      // that GOVERNS BEHAVIOUR living in a blob; these are the two Phase 0 columns that do.
      for (const [table, column] of [
        ["posting_policy", "definition"],
        ["document_type", "options"],
      ] as const) {
        const [col] = await api.db.admin<{ data_type: string }[]>`
        select data_type from information_schema.columns
         where table_schema = 'app' and table_name = ${table} and column_name = ${column}`;
        if (col) expect(col.data_type, `${table}.${column}`).toBe("jsonb");
      }
      const [policy] = await api.db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'posting_policy' and column_name = 'definition'`;
      expect(policy!.data_type).toBe("jsonb"); // this one must exist: migration 0001 creates it
    },

  "the seeded catalogue is exactly the file, so a diff of the file is a diff of behaviour": async ({
    api,
    expect,
  }) => {
    const rows = await api.db.admin<
      { code: string }[]
    >`select code from app.permission order by code`;
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].map((p) => p.code).toSorted());
  },
});

// ─── 2A ──────────────────────────────────────────────────────────────────────────────────────────────────
// contracts §3.7.3: 0B created this file as a `fullRegression`; this slice appends a plain describe using
// `sharedApi()` directly (§4.17.1). `expect` is taken from each test's own context rather than imported at
// module scope, because 0B's cases destructure it and `no-shadow` would refuse the import.
import { describe, it } from "vitest";
import { seedTenantV2 } from "@dulja/db/test";
import { grantAdmin, problemOf, sharedApi } from "../support/api";
import { repoFile } from "../support/regression";

describe("LEGACY-078 Behaviour-governing configuration lives in opaque blobs — 2A", () => {
  const POLICY = {
    version: 1,
    documentType: "CONSIGNMENT_RETURN",
    direction: "inbound",
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
    numbering: { series: "CR", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_RETURN" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  };

  // Each case seeds its own tenant, and that is not tidiness: `sharedApi()`'s Seeds are shared across every
  // regression file and app.document_type is unique (company_id, code), so a type created into `a.company`
  // here would collide with whichever later slice creates the same code there.

  it("a posting rule is schema-validated JSON that round-trips byte-equal — reviewable text, not a blob", async ({
    expect,
  }) => {
    const { api } = await sharedApi();
    const s = await seedTenantV2(api.db, "LEGACY078-2A"); // own tenant: no shared-seed code collision
    await grantAdmin(api, s);
    const base = `/v1/companies/${s.company}/document-types`;
    const created = await api.request({
      method: "POST",
      path: base,
      as: s.human,
      body: { code: "CONSIGNMENT_RETURN", nameEn: "Consignment return", module: "accounting" },
    });
    const { id } = (await created.json()) as { id: string };
    const added = await api.request({
      method: "POST",
      path: `${base}/${id}/policies`,
      as: s.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: POLICY },
    });
    expect(added.status).toBe(201);

    // Round-trip: what comes back out of jsonb is what went in. A blob cannot make this claim, and neither
    // can a schema whose validator lives in client code — which is the legacy shape this defect names.
    const listed = await api.request({
      method: "GET",
      path: `${base}/${id}/policies`,
      as: s.human,
    });
    const { items } = (await listed.json()) as {
      items: { version: number; definition: unknown }[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]!.definition).toEqual(POLICY);

    // And it is queryable in SQL, which is what "diffable and reasonable-about" means at the data layer.
    const [row] = await api.db.admin<{ document_type: string; series: string }[]>`
      select definition->>'documentType' as document_type, definition->'numbering'->>'series' as series
        from app.posting_policy where document_type_id = ${id} and version = 1`;
    expect(row).toEqual({ document_type: "CONSIGNMENT_RETURN", series: "CR" });
  });

  it("an invalid rule is refused at configuration time, naming the JSON path — not accepted and failed at post", async ({
    expect,
  }) => {
    const { api } = await sharedApi();
    const s = await seedTenantV2(api.db, "LEGACY078-2Ab"); // own tenant again, for the same reason
    await grantAdmin(api, s);
    const base = `/v1/companies/${s.company}/document-types`;
    // POLICY_TEST_2 is §4.14's second test-only code (amendment A1). `COST_ADJUSTMENT` would be wrong twice
    // over: §4.14 assigns it to 3B, and creating it in a shared seed would collide with 3B's own regression.
    const created = await api.request({
      method: "POST",
      path: base,
      as: s.human,
      body: { code: "POLICY_TEST_2", nameEn: "Policy test 2", module: "accounting" },
    });
    const { id } = (await created.json()) as { id: string };

    // `inventory: { effect: "issue" }` without `warehouse`/`costing` fails §4.4.1's conditional. The legacy
    // system had nowhere to say this: behaviour lived in a blob and broke at run time, in a trigger branch.
    const res = await api.request({
      method: "POST",
      path: `${base}/${id}/policies`,
      as: s.human,
      body: {
        version: 1,
        effectiveFrom: "2026-01-01",
        definition: { ...POLICY, documentType: "POLICY_TEST_2", inventory: { effect: "issue" } },
      },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_POLICY_INVALID");
    // `errors[]` on an ERR_POLICY_INVALID problem is amendment A10 — §4.2.4's comment reserved the member
    // for ERR_VALIDATION_FAILED, and "naming the JSON path" is this defect's own claim.
    expect(problem.errors!.map((e) => e.path)).toContain("/inventory");

    // Nothing was written: a refused rule leaves no half-configured type behind.
    const listed = await api.request({
      method: "GET",
      path: `${base}/${id}/policies`,
      as: s.human,
    });
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("the schema itself is a version-controlled file with a stable $id, so a change to it is a reviewed diff", ({
    expect,
  }) => {
    // The claim is about the artefact, not the database: the rules that govern posting are a committed JSON
    // Schema (ADR 0022, widened under ADR 0026) plus a committed generated type, both diffable in review. Read
    // as a file rather than imported: the `tests` tsconfig has no resolveJsonModule, and the point is the
    // bytes on disk.
    const schema = JSON.parse(repoFile("packages/domain/posting-policy.schema.json")) as {
      $id: string;
      $schema: string;
      properties: { version: { const: number } };
      additionalProperties: boolean;
    };
    expect(schema.$id).toBe("urn:dulja:posting-policy:1");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.version.const).toBe(1);
    expect(schema.additionalProperties).toBe(false); // §4.3.7: the envelope's members live outside
  });
});

// ─── 8A ──────────────────────────────────────────────────────────────────────────────────────────────────
// Statutory rules are version-controlled data with provenance, refused with a JSON Pointer, and applicability lives
// in a join table rather than a boolean column.
import { validateRateTable } from "@dulja/domain/payroll";
import {
  seedRateTable as table078,
  seedStatutoryScheme as scheme078,
  SYNTH_RATE_TABLE_V1,
} from "@dulja/db/test";
import { sliceRegression } from "../support/regression";

sliceRegression(
  "LEGACY-078",
  "Behaviour-governing configuration lives in opaque blobs",
  "8A",
  "a rate table round-trips through jsonb, is refused with a JSON Pointer, needs its source, and applicability is a join",
  async ({ db, rw, a, withTenant, expect }) => {
    const schemeId = await scheme078(db, a, { code: "LEGACY078" });
    const id = await table078(db, a, { schemeId });
    const [row] = await withTenant(
      rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "legacy-078-8a" },
      (tx) =>
        tx<
          { definition: unknown }[]
        >`select definition from app.statutory_rate_table where id = ${id}`,
    );
    expect(row!.definition).toEqual(JSON.parse(JSON.stringify(SYNTH_RATE_TABLE_V1)));

    // An invalid definition is refused NAMING THE PATH: a band figure as a number, not a decimal string.
    const bad = {
      ...SYNTH_RATE_TABLE_V1,
      table: { bands: [{ from: 0, to: "1000.0000", employee: "10.0000", employer: "20.0000" }] },
    };
    const refused = validateRateTable(bad);
    expect(refused.ok).toBe(false);
    expect(refused.errors.map((e) => e.path)).toContain("/table/bands/0/from");

    // No provenance, no table: `source` is required.
    const { source, ...noSource } = SYNTH_RATE_TABLE_V1;
    expect(source.authority).toBe("Dulja test fixture");
    expect(validateRateTable(noSource).ok).toBe(false);

    // The pack is reviewable text on disk, not a blob in a column — and ships no real table (hazard 1).
    const schemes = JSON.parse(repoFile("packages/db/seed/my/statutory/schemes.json")) as {
      code: string;
    }[];
    expect(schemes.map((s) => s.code).toSorted()).toEqual(["EIS", "EPF", "PCB", "SOCSO"]);
    const components = JSON.parse(
      repoFile("packages/db/seed/my/statutory/pay-components.json"),
    ) as {
      code: string;
      kind: string;
    }[];
    expect(components).toHaveLength(6);
    expect(new Set(components.map((c) => c.kind))).toEqual(new Set(["earning", "deduction"]));

    // Applicability is a JOIN TABLE (spec:2078), not a "subject to X" boolean column.
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'app' and table_name = 'pay_component'`;
    expect(
      cols.map((c) => c.column_name).filter((n) => /^subject_|_epf$|_socso$|_eis$|_pcb$/.test(n)),
    ).toEqual([]);
    const join = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'app' and table_name = 'pay_component_scheme'`;
    expect(join).toHaveLength(1);
  },
);
