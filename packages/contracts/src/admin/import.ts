import { z } from "zod";
import { CursorSchema, DateSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

/**
 * Slice 9B Task 9 — the cut-over load's wire shapes (spec:2206 "bulk endpoints for import/export with async job
 * semantics and a status resource"; contracts §4.2.7 as amended by round 20's C2, C4 and C17). The vocabularies are
 * `app.import_run`'s CHECKs (migration 0103), so a value outside them is a 400 here and never a 23514 there.
 */
export const ImportRunStatusSchema = z.enum(["queued", "running", "done", "failed"]);

/** A target table, as `Loader.targetTable` spells it and `import_batch.target_table`'s CHECK admits. */
const TargetTableSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/**
 * The OWNER's legacy → Dulja chart mapping (9B plan N6; `@dulja/importer`'s `AccountMap`), in the shape
 * `packages/importer/test/fixtures/account-map.json` documents. The wire checks its SHAPE; what only the whole map
 * can say — a code whose first digit disagrees with its type, a legacy code listed twice, one AR and one AP control —
 * is `assertAccountMap`'s, run by the job before it opens the legacy source, so a bad map fails the run before any row
 * is read (`ERR_VALIDATION_FAILED` on the run's status).
 */
export const AccountMapEntrySchema = z
  .object({
    legacyCode: z.string().min(1).max(64),
    code: z.string().regex(/^[1-5][0-9]{3}$/),
    nameEn: z.string().min(1).max(200),
    nameAr: z.string().max(200).nullable().default(null),
    type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    treatment: z.enum(["balance", "ar_control", "ap_control", "inventory_control", "exclude"]),
    note: z.string().max(1000).nullable().default(null),
  })
  .strict();

export const AccountMapSchema = z
  .object({
    /** The 9A scope artefact the map was built from, so a reviewer can trace it. */
    generatedFrom: z.string().min(1).max(500),
    entries: z.array(AccountMapEntrySchema).min(1).max(20_000),
  })
  .strict();

export const StartImportBody = z
  .object({
    /** The accounting date every imported document carries. Entered by the operator; never derived (spec:2039). */
    cutOverDate: DateSchema,
    /** Read and map everything, write nothing (ADR 0084 decision 5). */
    dryRun: z.boolean().default(false),
    /** Target tables to load, e.g. `["item", "lot"]` — the resume switch (round 20 C14). Ordered by the loader graph
     *  regardless of the order given; a name no loader targets fails the run. */
    only: z.array(TargetTableSchema).min(1).max(64).optional(),
    /** Required whenever the run includes `account`, `opening_balance` or `open_item` — the loaders that read it. */
    accountMap: AccountMapSchema.optional(),
  })
  .strict();

export const ImportAcceptedSchema = z.object({
  runId: UuidSchema,
  /** The pg-boss job id. */
  jobId: z.string().min(1),
  /** `/v1/jobs/<jobId>` — spec:2206's status resource (round 20 C2). The run's own record is
   *  `/v1/companies/<companyId>/imports/<runId>`, which the job status names in `output.resourceUrl`. */
  statusUrl: z.string().min(1),
});

const LoaderCountsSchema = z.object({
  inserted: z.number().int(),
  skipped: z.number().int(),
  conflicts: z.number().int(),
});

export const ImportRunSchema = z.object({
  runId: UuidSchema,
  companyId: UuidSchema,
  requestedBy: UuidSchema,
  cutOverDate: DateSchema,
  dryRun: z.boolean(),
  only: z.array(z.string()).nullable(),
  /** Whether the request carried an account map. The map itself is the operator's input and is not echoed. */
  hasAccountMap: z.boolean(),
  status: ImportRunStatusSchema,
  /** Rows the run COMMITTED, per target table — `app.import_batch` read back (`batchCounts`). Empty for a dry run,
   *  which records nothing. */
  perTargetTable: z.array(z.object({ targetTable: z.string(), rows: z.number().int() })),
  /** `runLoad`'s per-loader counts once `done` — for a dry run, the rows that MAPPED (ADR 0084 decision 5). */
  perLoader: z.record(z.string(), LoaderCountsSchema).nullable(),
  /** Rows in the run's skip register once `done`. The register itself (`skips.csv`) is an artefact of the run. */
  skips: z.number().int().nullable(),
  artefacts: z.number().int().nullable(),
  /** `ERR_<CODE>: detail`, once `failed`. */
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type ImportRunDto = z.infer<typeof ImportRunSchema>;

/** Literal `filter[…]` keys — §4.2.8 Layer 2's default, `strict` as 7C's export list is. */
export const ImportRunQuery = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    "filter[status][eq]": ImportRunStatusSchema.optional(),
  })
  .strict();

export const ImportRunList = ListEnvelope(ImportRunSchema);

/**
 * `/v1/jobs/{jobId}` (round 20 C2, as built in C17). `state` is pg-boss's own. `output` is the job's SUBJECT — the
 * resource the job works on, its status and its failure — and never pg-boss's raw output column, which carries a
 * handler's stack trace on failure. A job whose subject failed may still be `completed`: the subject records the
 * failure and the job finishes, so a retry cannot repeat it (7C's rule for the export).
 */
export const JobStatusSchema = z.object({
  jobId: z.string(),
  name: z.string(),
  state: z.enum(["created", "retry", "active", "completed", "cancelled", "failed"]),
  createdOn: TimestampSchema,
  completedOn: TimestampSchema.nullable(),
  output: z
    .object({
      resourceUrl: z.string(),
      status: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type JobStatusDto = z.infer<typeof JobStatusSchema>;
