import { TILL_CODES } from "../../apps/pos/src/main/authority";
import { POS_PERMISSION } from "@dulja/db";
import { sourceFiles } from "../support/source";
import { ROUTES } from "@dulja/api";
import { ERRORS, PERMISSIONS } from "@dulja/contracts";
import { fullRegression } from "../support/api";

fullRegression("LEGACY-047", "Only 7 of ~55 permission flags are ever read by the database", {
  "the catalogue and the seeded table are the same set, in both directions": async ({
    api,
    expect,
  }) => {
    const rows = await api.db.admin<
      { code: string }[]
    >`select code from app.permission order by code`;
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].map((p) => p.code).toSorted());
  },

  "every catalogue code has a registered route or apply-time authority gate": async ({
    api,
    expect,
  }) => {
    const gated = new Set(ROUTES.flatMap((r) => [...r.permissions] as string[]));
    const apply = sourceFiles(["packages/db/src/sync/apply.ts"])[0]!.text;
    const limits = sourceFiles(["packages/db/src/sync/limits.ts"])[0]!.text;
    const shifts = sourceFiles(["packages/db/src/sync/shifts.ts"])[0]!.text;
    const applyCodes = new Map<string, string>(
      Object.entries(POS_PERMISSION)
        .filter(([, code]) => !gated.has(code))
        .map(([field, code]) => [code, field]),
    );
    expect([...applyCodes.keys()].toSorted()).toEqual([
      "pos.customer.create",
      "pos.shift.close_any",
      "pos.shift.own",
      "pos.ticket.discount",
      "pos.ticket.override",
      "pos.ticket.return",
      "pos.ticket.return_blind",
      "pos.ticket.sell",
      "pos.ticket.void",
    ]);
    const pricing = sourceFiles(["apps/pos/src/main/pricing.ts"])[0]!.text;
    for (const p of PERMISSIONS) {
      if (gated.has(p.code)) continue;
      if (p.code === "pos.price.check") {
        expect(TILL_CODES).toContain(p.code);
        expect(pricing).toContain('PERMISSION["pos.price.check"]');
        expect(pricing).toContain("requireCode");
        continue;
      }
      if (p.code === "pos.attendance.clock") {
        expect(TILL_CODES).toContain(p.code);
        expect(apply).toContain("'pos.attendance.clock'");
        expect(apply).toContain("attendance.principalId");
        expect(apply).toContain("app.principal_has");
        continue;
      }
      const field = applyCodes.get(p.code);
      expect(field, p.code).toBeDefined();
      if (p.code === POS_PERMISSION.shiftOwn || p.code === POS_PERMISSION.shiftCloseAny) {
        expect(shifts, p.code).toContain(`POS_PERMISSION.${field}`);
        expect(shifts).toContain("app.principal_has");
        expect(shifts).toContain("terminal.branchId");
      } else if (p.code === POS_PERMISSION.ticketOverride)
        expect(apply, p.code).toContain(`POS_PERMISSION.${field}`);
      else expect(limits, p.code).toContain(`"${p.code}"`);
    }
    expect(apply).toContain("await verifyTicket(");
    expect(apply).toContain("verdict.missingCodes.length");
    expect(limits).toMatch(/for \(const code of requiredCodesFor\(ticket\)\)/);
    expect(limits).toContain("app.principal_has");
    expect(limits).toContain("ticket.cashierPrincipalId");
    expect(limits).toContain("ctx.companyId");
    expect(limits).toContain("ctx.branchId");
    expect(apply).toContain("terminal.companyId");
    expect(apply).toContain("terminal.branchId");
    expect(apply).toContain("await recordOverride");
    const [guard] = await api.db.admin<
      { src: string }[]
    >`select prosrc as src from pg_proc where pronamespace='app'::regnamespace and proname='assert_override_authorised'`;
    expect(guard!.src).toContain("coalesce(new.attributed_to, new.actor_id)");
    expect(guard!.src).toContain(
      "app.principal_has(p, new.override_code, d.company_id, d.branch_id)",
    );
    expect(guard!.src).toContain("p = d.created_by");
    expect(guard!.src).toContain("p is not distinct from d.attributed_to");
  },

  "a code that is not in the catalogue cannot be granted": async ({ api, a, expect }) => {
    await expect(
      api.db.migrator.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
        const [role] = await tx<
          { id: string }[]
        >`select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${role!.id}, 'admin.invented.code')`;
      }),
    ).rejects.toThrow(/foreign key|permission/i);
    expect(Object.keys(ERRORS)).toContain("ERR_RBAC_FORBIDDEN");
  },
});
