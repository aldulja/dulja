import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { startDb, type Db } from "./harness";

describe("schema linter", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => db.stop());
  it("reports no violations for the shipped schema", async () =>
    expect(await lintSchema(db.admin)).toEqual([]));
  it("reports each missing tenant-invariant for a bare table, and the transaction rolls back", async () => {
    await db.migrator
      .begin(async (tx) => {
        await tx`create table app.rogue (id int)`;
        const violations = await lintSchema(tx as never);
        expect(
          violations
            .filter((v) => v.table === "rogue")
            .map((v) => v.rule)
            .toSorted(),
        ).toEqual([
          "audit_trigger",
          "created_at",
          "rls_enabled",
          "rls_forced",
          "tenant_id",
          "tenant_isolation_policy",
        ]);
        expect(violations.filter((v) => v.table !== "rogue")).toEqual([]);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect(await lintSchema(db.admin)).toEqual([]);
  });
  it("reports plain tenant-scoped foreign keys and leaves plain references to global tables alone", async () => {
    await db.migrator
      .begin(async (tx) => {
        await tx`create table app.child (id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid references app.company(id), principal_id uuid references app.principal(id), created_at timestamptz not null default now())`;
        // company is tenant-scoped, so its FK must carry tenant_id; tenant and principal are global catalogues,
        // so a plain reference to either is correct and must not appear in the list.
        expect(
          (await lintSchema(tx as never))
            .filter((v) => v.table === "child" && v.rule === "composite_fk")
            .map((v) => v.detail),
        ).toEqual([expect.stringContaining("company")]);
        throw new Error("rollback");
      })
      .catch(() => undefined);
  });
  it("reports a permissive policy that would weaken a tenant gate and an unstamped actor column", async () => {
    await db.migrator
      .begin(async (tx) => {
        await tx`create policy leaky_gate on app.company using (true)`;
        await tx`create table app.gadget (id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), approved_by uuid, created_at timestamptz not null default now())`;
        const violations = await lintSchema(tx as never);
        expect(violations.filter((v) => v.table === "company").map((v) => v.rule)).toEqual([
          "extra_permissive_policy",
        ]);
        expect(violations.filter((v) => v.table === "gadget").map((v) => v.rule)).toContain(
          "stamp_actor",
        );
        throw new Error("rollback");
      })
      .catch(() => undefined);
  });
  it("reports an app_rw UPDATE grant on an immutable table", async () => {
    await db.migrator
      .begin(async (tx) => {
        await tx`grant update on app.ledger_entry to app_rw`;
        expect(
          (await lintSchema(tx as never))
            .filter((v) => v.table === "ledger_entry")
            .map((v) => v.rule),
        ).toEqual(["immutable_privileges"]);
        throw new Error("rollback");
      })
      .catch(() => undefined);
  });
  it("reports an immutable table whose append-only trigger has been dropped", async () => {
    // The privilege and the trigger are two independent halves of the same guarantee, so the linter has
    // to catch either one going missing on its own.
    await db.migrator
      .begin(async (tx) => {
        await tx`drop trigger ledger_entry_immutable on app.ledger_entry`;
        expect(
          (await lintSchema(tx as never))
            .filter((v) => v.table === "ledger_entry")
            .map((v) => v.rule),
        ).toEqual(["immutable_trigger"]);
        throw new Error("rollback");
      })
      .catch(() => undefined);
  });
  it("a partitioned table is linted like an ordinary one (relkind_partition — contracts §3.5.2)", async () => {
    // The rules the partitioned parent must be reported for are collected INSIDE the rolled-back
    // transaction and asserted OUTSIDE it. Asserting inside would make the failing expect reject the
    // transaction promise, and the `.catch` that swallows the deliberate rollback error would swallow
    // the assertion too — the test would pass while the rule was still missing.
    let parent: string[] = [];
    await db.migrator
      .begin(async (tx) => {
        await tx`create table app.rogue_part (id uuid not null, effective_date date not null) partition by range (effective_date)`;
        await tx`create table app.rogue_part_2026 partition of app.rogue_part for values from ('2026-01-01') to ('2027-01-01')`;
        const violations = await lintSchema(tx as never);
        parent = violations
          .filter((violation) => violation.table === "rogue_part")
          .map((violation) => violation.rule)
          .toSorted();
        throw new Error("rollback");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback") throw error;
      });
    expect(parent).toEqual([
      "audit_trigger",
      "created_at",
      "rls_enabled",
      "rls_forced",
      "tenant_id",
      "tenant_isolation_policy",
    ]);
    expect(await lintSchema(db.admin)).toEqual([]);
  });
  it("reports missing and permissive branch policies on a new table while preserving shipped guards", async () => {
    let missing: string[] = [],
      permissive: string[] = [];
    await db.migrator
      .begin(async (tx) => {
        await tx`create table app.rogue_branch (id uuid primary key,branch_id uuid,company_id uuid)`;
        missing = (await lintSchema(tx as never))
          .filter((v) => v.table === "rogue_branch")
          .map((v) => v.rule);
        await tx`create policy branch_isolation on app.rogue_branch using (true)`;
        permissive = (await lintSchema(tx as never))
          .filter((v) => v.table === "rogue_branch" && v.rule === "branch_isolation_policy")
          .map((v) => v.detail);
        throw new Error("rollback-branch-probe");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback-branch-probe") throw error;
      });
    expect(missing).toContain("branch_isolation_policy");
    expect(permissive).toEqual([expect.stringContaining("PERMISSIVE")]);
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
