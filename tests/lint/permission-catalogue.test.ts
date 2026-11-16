import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/permission-catalogue";
import type { SourceFile } from "../../scripts/lint/types";

const file = (path: string, text: string): SourceFile => ({
  path,
  text,
  lines: text.split(/\r?\n/),
});
const catalogue = file(
  "packages/contracts/permissions.ts",
  `
  export const PERMISSIONS = [
    { code: "admin.user.manage", module: "admin", mutating: true },
    { code: "admin.audit_log.read", module: "admin", mutating: false },
  ] as const;`,
);

describe("permission-catalogue lint", () => {
  it("passes when every code is evaluated", () => {
    expect(
      rule.run([
        catalogue,
        file(
          "apps/api/src/x.ts",
          `PERMISSION["admin.user.manage"]; PERMISSION["admin.audit_log.read"]`,
        ),
      ]),
    ).toEqual([]);
  });
  it("reports orphan catalogue codes", () => {
    const violations = rule.run([
      catalogue,
      file("apps/api/src/x.ts", `PERMISSION["admin.user.manage"]`),
    ]);
    expect(violations[0]?.detail).toContain("admin.audit_log.read");
  });
  it("reports an uncatalogued handler code", () => {
    const violations = rule.run([
      catalogue,
      file("apps/api/src/x.ts", `requirePermission("admin.ghost.manage", scope)`),
    ]);
    expect(violations.some((item) => item.detail.includes("not in the catalogue"))).toBe(true);
  });
  it("counts codes embedded in database SQL", () => {
    const sql = file(
      "packages/db/src/rbac/x.ts",
      "tx`select app.actor_has('admin.user.manage'), app.actor_has('admin.audit_log.read')`",
    );
    expect(rule.run([catalogue, sql])).toEqual([]);
  });
  it("does not count role seed grants as evaluations", () => {
    const roles = file("packages/db/seed/roles.ts", `permissions: ["admin.audit_log.read"]`);
    expect(rule.run([catalogue, roles])).toHaveLength(1);
  });
  it("is silent in partial runs without the catalogue", () => {
    expect(rule.run([file("apps/api/src/x.ts", "const x = 1")])).toEqual([]);
  });
});
