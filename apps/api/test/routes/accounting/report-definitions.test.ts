import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { createJobClient, JOB_NAMES, rowsForDefinition, type JobClient } from "@dulja/db";
import { intlFormatters, parseReportDefinition, renderCsv, renderReport } from "@dulja/domain";
import {
  grantCodes,
  installBoss,
  seedReportDefinition,
  seedTenantV2,
  stopBoss,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/** The core `accounting.trial_balance` definition, as the seed pack applies it (Task 14). */
const CORE = {
  version: 1,
  code: "accounting.trial_balance",
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: {
    source: "account_balance",
    filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
  },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
    { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

/** A real pg-boss behind the API's job client: startApi's stub refuses `reporting.render`, and the DoD's
 *  "run it" is a real `POST …/runs` whose job commits with the run. */
function bossBackedJobs() {
  const state: { real?: JobClient } = {};
  const jobs: JobClient = {
    enqueue: (tx, name, job, options) => {
      if (!state.real) throw new Error("pg-boss is not installed yet");
      return state.real.enqueue(tx, name, job, options);
    },
  };
  return { state, jobs };
}

interface DefinitionDto {
  id: string;
  companyId: string;
  code: string;
  version: number;
  isCore: boolean;
  clonedFrom: string | null;
  archivedAt: string | null;
  definition: Record<string, unknown> & { columns: unknown[] };
}

describe("/v1/companies/{companyId}/report-definitions — 7A Task 13", () => {
  let api: StartedApi;
  let boss: Awaited<ReturnType<typeof installBoss>> | undefined;
  const { state, jobs } = bossBackedJobs();
  let s: Seed;
  let other: Seed;
  let definitionId: string;
  let reader: string;

  beforeAll(async () => {
    api = await startApi({ jobs });
    boss = await installBoss(api.db, JOB_NAMES);
    state.real = createJobClient(boss);
    s = await seedTenantV2(api.db, "defs-api");
    other = await seedTenantV2(api.db, "defs-api-other");
    definitionId = await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance",
      definition: CORE,
      isCore: true,
    });
    await grantCodes(api.db, s, {
      codes: ["admin.company.manage", "accounting.report.read", "accounting.report.export"],
    });
    await grantCodes(api.db, other, { codes: ["admin.company.manage"] });
    // A second human who may READ reports but not MANAGE definitions — the 403 case. `app.principal`
    // carries no tenant_id and `seedTenantV2` mints one human, so the row goes in as the tenant's system
    // principal; `grantCodes` then gives it the narrow code under a distinct role code.
    reader = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${reader}, 'human', ${`sub:${reader}`}, 'Reader')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${reader})`;
    });
    await grantCodes(api.db, s, {
      codes: ["accounting.report.read"],
      principalId: reader,
      roleCode: "READER",
    });
    await api.loadPrincipals();
  }, 240_000);
  afterAll(async () => {
    if (boss) await stopBoss(boss);
    await api.stop();
  });

  const path = (suffix = "", seed?: Seed) =>
    `/v1/companies/${(seed ?? s).company}/report-definitions${suffix}`;
  const coreRowText = async (id: string) =>
    (
      await api.db.admin<{ row: string }[]>`
        select to_jsonb(d)::text as row from app.report_definition d where d.id = ${id}`
    )[0]!.row;

  it("A USER CLONES AND EDITS A REPORT WITHOUT A RELEASE — the Phase 7 DoD clause (spec:2293)", async () => {
    // 1. a core definition, as the seed pack would have applied it
    const core = await api.request({
      method: "GET",
      path: path("?filter[code][eq]=accounting.trial_balance"),
      as: s.human,
    });
    expect(core.status).toBe(200);
    const coreRow = ((await core.json()) as { items: DefinitionDto[] }).items[0]!;
    expect(coreRow.id).toBe(definitionId);
    expect(coreRow.isCore).toBe(true);
    const coreBefore = JSON.stringify(coreRow.definition);
    const coreRowBefore = await coreRowText(coreRow.id);

    // 2. clone it — no release, no migration, no deploy
    const cloned = await api.request({
      method: "POST",
      path: path(`/${coreRow.id}/clone`),
      body: { overrides: { nameEn: "My trial balance", nameAr: "ميزاني" } },
      as: s.human,
    });
    expect(cloned.status).toBe(201);
    const clone = (await cloned.json()) as DefinitionDto;
    expect(clone.version).toBe(coreRow.version + 1);
    expect(clone.isCore).toBe(false);
    expect(clone.clonedFrom).toBe(coreRow.id);
    expect(clone.definition["nameEn"]).toBe("My trial balance");

    // 3. EDIT the clone's columns — drop one, add two, group and total them
    const edited = await api.request({
      method: "PUT",
      path: path(`/${clone.id}`),
      body: {
        definition: {
          ...clone.definition,
          columns: [
            {
              field: "account_type",
              labelEn: "Type",
              labelAr: "النوع",
              format: "text",
              align: "start",
            },
            {
              field: "base_debit",
              labelEn: "Debit",
              labelAr: "مدين",
              format: "money",
              align: "end",
            },
            {
              field: "base_credit",
              labelEn: "Credit",
              labelAr: "دائن",
              format: "money",
              align: "end",
            },
          ],
          groups: [{ field: "account_type", subtotal: true }],
          totals: [
            { field: "base_debit", fn: "sum" },
            { field: "base_credit", fn: "sum" },
          ],
          sort: [{ field: "account_type", dir: "asc" }],
        },
      },
      as: s.human,
    });
    expect(edited.status).toBe(200);
    const editedRow = (await edited.json()) as DefinitionDto;
    expect(editedRow.version).toBe(clone.version);
    expect((editedRow.definition.columns as { field: string }[]).map((col) => col.field)).toEqual([
      "account_type",
      "base_debit",
      "base_credit",
    ]);

    // 4. RUN the edited clone: a plain run resolves {code} to the highest live version, which is the clone
    const run = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" },
      as: s.human,
    });
    expect(run.status).toBe(202);
    const runId = ((await run.json()) as { runId: string }).runId;
    const runRow = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/report-runs/${runId}`,
      as: s.human,
    });
    expect(runRow.status).toBe(200);
    expect(((await runRow.json()) as { reportDefinitionId: string }).reportDefinitionId).toBe(
      clone.id,
    );
    // …and what the worker renders for that run is the EDITED layout: the one row provider every run path
    // goes through, then the pure layout — the clone's three columns, not the core's two.
    const stored = await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ definition: unknown }[]>`
        select d.definition from app.report_run r join app.report_definition d on d.id = r.report_definition_id
         where r.id = ${runId}`;
      const definition = parseReportDefinition(row!.definition);
      const rows = await rowsForDefinition(tx, definition, {
        companyId: s.company,
        parameters: { fiscalPeriodId: s.period },
      });
      return { definition, rows };
    });
    expect(stored.definition.columns.map((col) => col.labelEn)).toEqual([
      "Type",
      "Debit",
      "Credit",
    ]);
    const csv = renderCsv(
      renderReport(stored.definition, stored.rows, {
        format: "csv",
        lang: "en",
        formatters: intlFormatters("en"),
      }),
    );
    expect(csv.split(/\r?\n/)[0]).toContain("Type");
    expect(csv.split(/\r?\n/)[0]).not.toContain("Code");

    // 5. the core row is byte-unchanged — through the API and in the table — and refuses an in-place edit
    const after = await api.request({ method: "GET", path: path(`/${coreRow.id}`), as: s.human });
    expect(JSON.stringify(((await after.json()) as { definition: unknown }).definition)).toBe(
      coreBefore,
    );
    const refused = await problemOf(
      await api.request({
        method: "PUT",
        path: path(`/${coreRow.id}`),
        body: { definition: { ...coreRow.definition, nameEn: "No" } },
        as: s.human,
      }),
    );
    expect(refused.code).toBe("ERR_VALIDATION_FAILED");
    expect(refused.detail).toContain("is a core definition; clone it");
    expect(await coreRowText(coreRow.id)).toBe(coreRowBefore);
  });

  it("a reader may LIST and GET but not create, clone, edit or archive — admin.company.manage gates the writes", async () => {
    expect((await api.request({ method: "GET", path: path(), as: reader })).status).toBe(200);
    expect(
      (await api.request({ method: "GET", path: path(`/${definitionId}`), as: reader })).status,
    ).toBe(200);

    const denials = [
      await api.request({
        method: "POST",
        path: path(),
        body: { definition: { ...CORE, code: "accounting.my_report" } },
        as: reader,
      }),
      await api.request({
        method: "POST",
        path: path(`/${definitionId}/clone`),
        body: { overrides: { nameEn: "Mine", nameAr: "لي" } },
        as: reader,
      }),
      await api.request({
        method: "PUT",
        path: path(`/${definitionId}`),
        body: { definition: CORE },
        as: reader,
      }),
      await api.request({ method: "POST", path: path(`/${definitionId}/archive`), as: reader }),
    ];
    for (const res of denials) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
    }
  });

  it("a clone cannot widen data access: the dataset's gate, the code's source and the writer's own codes (7 review)", async () => {
    // The review's scenario: an `admin.company.manage` holder clones the auditor's report. s.human holds the
    // manage code and accounting.report.read, but NOT admin.audit_log.read — so it may not author a report over
    // the audit trail at all, re-gated or not.
    const audit = await seedReportDefinition(api.db, s, {
      code: "accounting.audit_log",
      definition: {
        ...CORE,
        code: "accounting.audit_log",
        nameEn: "Audit log",
        nameAr: "سجل التدقيق",
        permission: "admin.audit_log.read",
        parameters: [],
        dataset: { source: "audit_log", filters: [] },
        columns: [
          { field: "seq", labelEn: "Seq", labelAr: "التسلسل", format: "text", align: "start" },
        ],
      },
    });
    const regated = await problemOf(
      await api.request({
        method: "POST",
        path: path(`/${audit}/clone`),
        body: { overrides: { permission: "accounting.report.read" } },
        as: s.human,
      }),
    );
    expect(regated.status).toBe(400);
    expect(regated.code).toBe("ERR_VALIDATION_FAILED");
    expect(
      (regated as Problem & { errors: { path: string }[] }).errors.map((e) => e.path),
    ).toContain("/permission");
    const unheld = await problemOf(
      await api.request({
        method: "POST",
        path: path(`/${audit}/clone`),
        body: { overrides: { nameEn: "Mine" } },
        as: s.human,
      }),
    );
    expect(unheld.status).toBe(403);
    expect(unheld.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(unheld.detail).toContain("admin.audit_log.read");
    // A clone of the trial balance may not leave `account_balance`, even for a code the dataset admits.
    const moved = await problemOf(
      await api.request({
        method: "POST",
        path: path(`/${definitionId}/clone`),
        body: {
          overrides: {
            dataset: { source: "ledger_entry", filters: [] },
            parameters: [],
            columns: [
              {
                field: "account_code",
                labelEn: "Code",
                labelAr: "الرمز",
                format: "text",
                align: "start",
              },
            ],
          },
        },
        as: s.human,
      }),
    );
    expect(moved.status).toBe(400);
    expect((moved as Problem & { errors: { path: string }[] }).errors.map((e) => e.path)).toContain(
      "/dataset/source",
    );
  });

  it("an invalid definition is ERR_VALIDATION_FAILED with a JSON Pointer for every fault", async () => {
    // A schema fault: Ajv's pointer, relative to the definition.
    const schema = await problemOf(
      await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: { definition: { ...CORE, code: "accounting.bad_report", nameAr: "" } },
      }),
    );
    expect(schema.code).toBe("ERR_VALIDATION_FAILED");
    expect((schema.errors ?? []).map((e) => e.path)).toContain("/nameAr");

    // A schema-valid definition with two closed-set faults: both are reported at once, not one per trip.
    const sets = await problemOf(
      await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: {
          definition: {
            ...CORE,
            code: "accounting.bad_report",
            permission: "accounting.no_such.code",
            dataset: { source: "not_a_dataset", filters: [] },
          },
        },
      }),
    );
    expect(sets.code).toBe("ERR_VALIDATION_FAILED");
    const pointers = sets.errors ?? [];
    expect(pointers.map((e) => e.path)).toEqual(
      expect.arrayContaining(["/dataset/source", "/permission"]),
    );
    expect(pointers.find((e) => e.path === "/dataset/source")!.message).toContain("not_a_dataset");
  });

  it("a column, group, total or sort field the dataset does not have is refused at SAVE time", async () => {
    const bad = await problemOf(
      await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: {
          definition: {
            ...CORE,
            code: "accounting.typo_report",
            columns: [
              {
                field: "acount_code",
                labelEn: "Code",
                labelAr: "الرمز",
                format: "text",
                align: "start",
              },
            ],
          },
        },
      }),
    );
    expect(bad.code).toBe("ERR_VALIDATION_FAILED");
    expect(bad.detail).toContain("acount_code");
    expect(bad.detail).toContain("account_balance");
  });

  it("a clone may not change its code, and a body or query outside the contract is a 400", async () => {
    const renamed = await problemOf(
      await api.request({
        method: "POST",
        path: path(`/${definitionId}/clone`),
        body: { overrides: { code: "accounting.renamed_report" } },
        as: s.human,
      }),
    );
    expect(renamed.code).toBe("ERR_VALIDATION_FAILED");
    expect((renamed.errors ?? []).map((e) => e.path)).toContain("/code");

    const extra = await api.request({
      method: "POST",
      path: path(),
      body: { definition: CORE, isCore: true },
      as: s.human,
    });
    expect(extra.status).toBe(400);
    const filter = await api.request({
      method: "GET",
      path: path("?filter[is_core][eq]=true"),
      as: s.human,
    });
    expect(filter.status).toBe(400);
  });

  it("a created definition is never core, and takes the code's next version", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { definition: { ...CORE, code: "accounting.own_report", nameEn: "Own" } },
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as DefinitionDto;
    expect(row).toMatchObject({
      isCore: false,
      version: 1,
      clonedFrom: null,
      companyId: s.company,
    });
  });

  it("an archived definition disappears from the list, still GETs by id, and refuses a run", async () => {
    const created = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { definition: { ...CORE, code: "accounting.scratch_report", nameEn: "Scratch" } },
    });
    expect(created.status).toBe(201);
    const scratch = (await created.json()) as { id: string };

    expect(
      (await api.request({ method: "POST", path: path(`/${scratch.id}/archive`), as: s.human }))
        .status,
    ).toBe(204);

    const listed = await api.request({
      method: "GET",
      path: path("?filter[code][eq]=accounting.scratch_report"),
      as: s.human,
    });
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
    const archived = await api.request({
      method: "GET",
      path: path("?filter[code][eq]=accounting.scratch_report&filter[archived][eq]=true"),
      as: s.human,
    });
    expect(((await archived.json()) as { items: unknown[] }).items).toHaveLength(1);
    // Archived, never deleted (spec:2049): the row stays addressable, which keeps an old report_run's
    // `report_definition_id` resolvable.
    const still = await api.request({ method: "GET", path: path(`/${scratch.id}`), as: s.human });
    expect(still.status).toBe(200);
    expect(((await still.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();

    const refused = await problemOf(
      await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/reports/accounting.scratch_report/runs`,
        body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" },
        as: s.human,
      }),
    );
    expect(refused.code).toBe("ERR_NOT_FOUND");
    expect(refused.detail).toContain("accounting.scratch_report");
  });

  it("pages the list on (code, version) through next_cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api.request({
        method: "GET",
        path: path(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`),
        as: s.human,
      });
      const body = (await res.json()) as { items: DefinitionDto[]; next_cursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      cursor = body.next_cursor;
    } while (cursor !== null);
    const all = (await (
      await api.request({ method: "GET", path: path(), as: s.human })
    ).json()) as {
      items: DefinitionDto[];
    };
    expect(seen).toEqual(all.items.map((i) => i.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("another company's id in the path is a 404, never this company's row", async () => {
    // `other` administers its own company; it names s's definition under its own company id.
    const res = await api.request({
      method: "POST",
      path: path(`/${definitionId}/clone`, other),
      body: {},
      as: other.human,
    });
    expect(res.status).toBe(404);
    const get = await api.request({
      method: "GET",
      path: path(`/${definitionId}`, other),
      as: other.human,
    });
    expect(get.status).toBe(404);
  });

  it("all four unsafe routes require Idempotency-Key", async () => {
    const cases: { method: "POST" | "PUT"; path: string; body?: unknown }[] = [
      {
        method: "POST",
        path: path(),
        body: { definition: { ...CORE, code: "accounting.k_report" } },
      },
      {
        method: "POST",
        path: path(`/${definitionId}/clone`),
        body: { overrides: { nameEn: "K", nameAr: "ك" } },
      },
      { method: "PUT", path: path(`/${definitionId}`), body: { definition: CORE } },
      { method: "POST", path: path(`/${definitionId}/archive`) },
    ];
    for (const c of cases) {
      const res = await api.request({ ...c, as: s.human, idempotencyKey: null });
      expect(((await res.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });
});
