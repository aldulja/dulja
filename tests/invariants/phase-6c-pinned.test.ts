import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERRORS } from "@dulja/contracts";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { JOBS } from "@dulja/db";
import { ROUTES } from "@dulja/api/routes";
import { PROBES } from "./probes";
import { sharedApi } from "../support/api";
import { sourceFiles, REPO_ROOT } from "../support/source";
describe("phase6C pinned contracts", () => {
  it("preserves the DELETE privilege list without granting deletion on staff records", async () => {
    const { api } = await sharedApi();
    const rows = await api.db.admin<
      { table_name: string }[]
    >`select distinct table_name from information_schema.role_table_grants where grantee='app_rw' and table_schema='app' and privilege_type='DELETE' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
    for (const table of ["employee", "pos_cashier", "branch_pos_policy", "attendance_event"])
      expect(
        sourceFiles(["packages/db/src", "apps/api/src"]).some((f) =>
          new RegExp(`delete\\s+from\\s+app\\.${table}\\b`, "i").test(f.text),
        ),
      ).toBe(false);
  });
  it("adds exactly four permission codes and the registered limit error", () => {
    expect(ERRORS.ERR_POS_LIMIT_EXCEEDED.status).toBe(422);
    expect(
      PERMISSIONS.filter((p) => p.phase === "6C")
        .map((p) => p.code)
        .toSorted(),
    ).toEqual([
      "hr.attendance.record",
      "hr.employee.manage",
      "hr.employee.read",
      "pos.cashier.manage_pin",
    ]);
  });
  it("mounts all four resource modules with isolation probes", () => {
    const routes = ROUTES.filter((r) =>
      /(employees|cashiers|branch-pos-policies|attendance-events)$/.test(r.path),
    );
    expect(routes).toHaveLength(4);
    for (const route of routes) expect(PROBES[route.path]).toBeDefined();
  });
  it("adds no protected-table writer allowance for sync or staff", () => {
    const rule = readFileSync(join(REPO_ROOT, "scripts/lint/rules/posting-only-tables.ts"), "utf8");
    expect(rule).not.toContain("packages/db/src/sync");
    expect(rule).not.toContain("packages/db/src/staff");
  });
  it("reads current authority and branch policy without using a snapshot for a server decision", () => {
    const files = sourceFiles(["packages/db/src/sync", "apps/api/src", "apps/worker/src"]).filter(
      (f) => !f.path.endsWith("cashier-compare.ts"),
    );
    const sql = files.flatMap((f) =>
      [...f.text.matchAll(/`([^`]+)`/g)].map((m) => ({ path: f.path, text: m[1]! })),
    );
    expect(
      sql
        .filter((q) => /from\s+app\.pos_cashier/i.test(q.text) && /\bsnapshot\b/i.test(q.text))
        .map((q) => q.path),
    ).toEqual([]);
    const limits = sourceFiles(["packages/db/src/sync"]).find((f) =>
      f.path.endsWith("/limits.ts"),
    )!;
    expect(limits.text).toContain("from app.branch_pos_policy");
    expect(limits.text).toContain("app.principal_has");
    expect(limits.text).toContain("requiredCodesFor(ticket)");
  });
  it("has no server PIN-login verifier and no unsafe queries in the slice source", () => {
    expect(sourceFiles(["apps/api/src"]).some((f) => f.text.includes("verifyPin"))).toBe(false);
    const mine = sourceFiles([
      "packages/db/src/staff",
      "packages/db/src/sync/limits.ts",
      "packages/db/src/sync/cash-rounding.ts",
      "apps/api/src/routes/hr",
      "apps/api/src/routes/pos",
    ]);
    expect(mine.filter((f) => f.text.includes(".unsafe(")).map((f) => f.path)).toEqual([]);
  });
  it("keeps the sixteen-job registry and wires the comparison handler in actual boot/test paths", () => {
    expect(Object.keys(JOBS)).toHaveLength(16);
    for (const path of ["apps/worker/src/index.ts", "apps/worker/test/support/worker.ts"])
      expect(readFileSync(join(REPO_ROOT, path), "utf8")).toMatch(
        /registerHandler\("pos\.cashier\.compare",\s*cashierCompare\)/,
      );
  });
});
