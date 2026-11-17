import { ROUTES } from "@dulja/api";
import { sourceFiles } from "../support/source";
import { fullRegression } from "../support/api";
import {
  buildTicket,
  posFixture,
  signSyncRequest,
  syncRequest,
  uuidv7Sync,
} from "../invariants/support/pos";

// The heading is the spec's own title for LEGACY-046 (spec:603), as for every LEGACY file; the new-system sentence
// this file pins is "typed, server-authenticated request metadata with one canonical name per concept,
// checked in one place", which terminalAuth makes executable (6A T15).
fullRegression(
  "LEGACY-046",
  "Site protection triggers are bypassable, and two different flags share one name — 6A",
  {
    "one definition per concept (spec:603, contracts4.10.3)": async ({ expect }) => {
      const files = sourceFiles(["apps", "packages"]);
      expect(
        files
          .filter((f) => /export function canonicalSyncRequest\b/.test(f.text))
          .map((f) => f.path),
      ).toEqual(["packages/sync/src/signing.ts"]);
      expect(
        files.filter((f) => /export const TERMINAL_TOKEN_HEADER\b/.test(f.text)).map((f) => f.path),
      ).toEqual(["apps/api/src/middleware/terminal-auth.ts"]);
      expect(
        files
          .filter(
            (f) =>
              f.path !== "packages/sync/src/signing.ts" &&
              /\$\{[^}]*method[^}]*\}\\n\$\{[^}]*\}\\n\$\{[^}]*\}\\n\$\{/.test(f.text),
          )
          .map((f) => f.path),
      ).toEqual([]);
    },
    "forged identity headers do not choose the acting tenant or principal": async ({
      api,
      b,
      expect,
    }) => {
      const f = await posFixture(api, "LEGACY046");
      const other = await posFixture(api, "LEGACY046 other");
      const mixed = signSyncRequest(other.terminal, { method: "GET", path: "/v1/sync/catalogue" });
      expect(
        (
          await api.request({
            method: "GET",
            path: "/v1/sync/catalogue",
            headers: { ...mixed, "X-Terminal-Id": f.terminal.terminalId },
          })
        ).status,
      ).toBe(401);
      const ticket = buildTicket(f);
      const batch = {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [ticket],
        shifts: [],
        tillEvents: [],
      };
      const forged = await syncRequest(api, f.terminal, {
        method: "POST",
        path: "/v1/sync/tickets",
        body: { ...batch, tickets: [{ ...ticket, tenant_id: b.tenant }] },
      });
      expect(forged.status).toBe(400);
      const res = await syncRequest(api, f.terminal, {
        method: "POST",
        path: "/v1/sync/tickets",
        body: batch,
        headers: { "X-Tenant-Id": b.tenant, "X-Actor-Id": b.human },
      });
      expect(res.status).toBe(200);
      const [doc] = await api.db.admin<
        { tenant_id: string; created_by: string }[]
      >`select tenant_id,created_by from app.document where client_ref=${ticket.clientRef}`;
      expect(doc).toEqual({ tenant_id: f.s.tenant, created_by: f.terminal.principalId });
    },
    "every terminal module is guarded by its registered auth mode": async ({ api, expect }) => {
      const modules = ROUTES.filter((r) => r.auth === "terminal");
      expect(modules.length).toBeGreaterThan(0);
      for (const module of modules) {
        expect(module.path.startsWith("/v1/sync/")).toBe(true);
        expect((await api.request({ method: "GET", path: module.path })).status).toBe(401);
      }
      expect(
        ROUTES.filter(
          (r) =>
            r.path.startsWith("/v1/sync/") && r.auth !== "terminal" && r.path !== "/v1/sync/enrol",
        ),
      ).toEqual([]);
    },
  },
);
