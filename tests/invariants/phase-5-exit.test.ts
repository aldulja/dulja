// tests/invariants/phase-5-exit.test.ts (5B T11)
//
// Phase 5's exit gate. Every assertion here re-states an equality some earlier slice pinned; none of
// them is new logic. A failure is a defect in the task that owns the pinned thing, NOT something to
// fix here.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// `lintSchema` and `listApplied` are MAIN-barrel exports of @dulja/db (§4.1); `@dulja/db/test` is
// exactly `export * from "./harness"; export * from "./fixtures";` (§4.2.12) and carries neither.
import { JOBS, lintSchema, listApplied } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { PERMISSIONS } from "@dulja/contracts";
import { ROUTES } from "@dulja/api/routes"; // §4.2.7: the module's two entry points
// §4.2.6 puts `registeredJobNames()` in `apps/worker/src/handler.ts` and `JOB_PROBES` in
// `tests/invariants/probes.ts` — NEITHER is a `@dulja/db` export, whose job surface is `JOBS`,
// `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `EnqueueOptions`, `createJobClient` and
// `JOB_NAMES`. 0D's own `tests/invariants/job-isolation.test.ts` imports them exactly this way
// (`@dulja/worker/handler` and `./probes`), which is the precedent this file follows rather than
// inventing a second route to either name.
import { registeredJobNames } from "@dulja/worker/handler";
import { ROLES } from "../../packages/db/seed/roles";
import { JOB_PROBES, PROBES, TENANT_FREE } from "./probes"; // §4.2.6, §4.2.7: both registries live in the test tier
import { REPO_ROOT, sourceFiles } from "../support/source"; // §4.17.1, owner 0B

let db: Db;
beforeAll(async () => {
  db = await startDb();
}, 300_000);
afterAll(async () => {
  await db.stop();
});

describe("Phase 5 exit — schema (5B T11)", () => {
  it("lintSchema reports zero violations across all fifty-eight migrations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("the applied migration ledger starts at 0001, strictly ascends, and reaches 0058", async () => {
    // §4.1 fixes `listApplied(sql: Sql): Promise<number[]>` — a list of VERSION NUMBERS, not rows.
    const versions = [...(await listApplied(db.admin))].toSorted((x, y) => x - y);
    expect(versions[0]).toBe(1);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i], `${versions[i]} is not above ${versions[i - 1]}`).toBeGreaterThan(
        versions[i - 1]!,
      );
    }
    // NO no-gap assertion. §3.4.1 says in terms that "unused numbers stay unused (gaps are fine —
    // `discover()` sorts whatever exists)", and two numbers in 0001–0058 are reserved with no DDL:
    // 0009 (0C) and 0010 (0E), neither of which ships a file. A no-gap loop would fail on a correct
    // repository, which is the worst kind of gate.
    expect(versions[versions.length - 1]).toBeGreaterThanOrEqual(58);
    expect(versions).toContain(57);
    expect(versions).toContain(58);
  });

  it("the pinned app_rw DELETE list is UNCHANGED by slice 5B", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and privilege_type = 'DELETE' and table_schema = 'app'
       order by table_name`;
    // §3.5.4, after migration 0023. 2B is the only slice that ever extends this list, and 5B is not
    // 2B: a transmission is cancelled (spec:2049), never deleted.
    expect(rows.map((r) => r.table_name)).toEqual([
      "document",
      "document_line",
      "idempotency_key",
      "role_assignment_branch",
      "role_permission",
    ]);
  });

  it("einvoice_transmission has forced RLS and a policy named exactly tenant_isolation", async () => {
    const [t] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
       where oid = 'app.einvoice_transmission'::regclass`;
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.admin<{ policyname: string }[]>`
      select policyname from pg_policies where schemaname = 'app' and tablename = 'einvoice_transmission'`;
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });
});

describe("Phase 5 exit — registries (5B T11)", () => {
  it("every route module has a probe and every probe names a route (test 12)", () => {
    const paths = new Set(ROUTES.map((r) => r.path));
    for (const r of ROUTES) {
      if (TENANT_FREE.has(r.path)) continue;
      expect(Object.keys(PROBES), `no PROBES entry for ${r.path}`).toContain(r.path);
    }
    for (const key of Object.keys(PROBES)) {
      expect(paths, `PROBES key ${key} matches no route`).toContain(key);
    }
  });

  it("einvoice-transmissions is the ONE module slice 5B added", () => {
    const fiveB = ROUTES.filter((r) => r.path.endsWith("/einvoice-transmissions"));
    expect(fiveB).toHaveLength(1);
    expect(fiveB[0]!.permissions).toEqual(["accounting.tax.file"]);
    expect(fiveB[0]!.auth).toBe("human");
  });

  it("every registered job name has a JOB_PROBES entry (test 12's job half)", () => {
    for (const name of registeredJobNames()) {
      expect(Object.keys(JOB_PROBES), `no JOB_PROBES entry for ${name}`).toContain(name);
    }
    expect(Object.keys(JOBS)).toContain("accounting.tax.submit");
  });

  it("accounting.tax.file is in the catalogue exactly once, phase 5B, and is granted only to accountant (test 36)", () => {
    const rows = PERMISSIONS.filter((p) => p.code === "accounting.tax.file");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: "accounting", mutating: true, phase: "5B" });
    const holders = ROLES.filter(
      (r) => r.code !== "admin" && r.permissions.includes("accounting.tax.file"),
    ).map((r) => r.code);
    expect(holders).toEqual(["accountant"]);
  });
});

describe("Phase 5 exit — hazard 2 and no SQL text (5B T11)", () => {
  it("the hazard-2 grep is green (no authority literal outside a profile, ADR 0051 or a test)", () => {
    // Runs the same script CI runs. A non-zero exit throws with the script's own output attached,
    // which names the offending file and line.
    const out = execFileSync("bash", ["scripts/check/no-authority-literals.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("hazard-2 check OK");
  });

  it("no sql.unsafe and no string-built SQL exists in this slice's surface (test 27)", () => {
    // §4.17.1: `sourceFiles(roots?)` walks the repository and returns `scripts/lint/types.ts`'s
    // `SourceFile { path; text; lines }` — the text is already read, so nothing here calls
    // `readFileSync` on the result.
    // **Roots are DIRECTORIES.** 0B's walker calls `readdirSync(join(REPO_ROOT, root))` on each root,
    // so a file path passed as a root throws ENOTDIR. Walk the two workspace trees and filter.
    const SURFACE = [
      "packages/db/src/einvoice",
      "apps/api/src/routes/accounting/einvoice-transmissions.ts",
      "apps/worker/src/handlers/accounting-tax-submit.ts",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", "apps"]).filter((f) =>
      SURFACE.some((s) => f.path === s || f.path.startsWith(`${s}/`)),
    )) {
      if (/sql\.unsafe|tx\.unsafe/.test(file.text)) offenders.push(`${file.path}: unsafe`);
      // A tagged template never concatenates; a `${}` inside a plain string that reaches a query does.
      if (/`\s*select[^`]*"\s*\+/i.test(file.text)) offenders.push(`${file.path}: concatenation`);
    }
    expect(offenders).toEqual([]);
  });

  it("the ADR 0051 gate holds: a myinvois profile requires an accepted, verified ADR 0051", () => {
    // §4.17.1's `repoFile(relativePath): string` READS a file as text and has no `exists` member, so
    // presence is tested with `node:fs` against `REPO_ROOT` — Vitest runs the `tests` workspace from
    // `tests/`, which is why the join is against `REPO_ROOT` and not a bare relative path.
    const profile = existsSync(join(REPO_ROOT, "packages/db/einvoice-profiles/myinvois.v1.json"));
    const adrPath = join(REPO_ROOT, "docs/adr/0051-verified-lhdn-myinvois-requirement-set.md");
    const accepted =
      existsSync(adrPath) && /\*\*Status:\*\*\s*accepted\b/i.test(readFileSync(adrPath, "utf8"));
    // A proposal records the unresolved gate; it does not authorize a production profile.
    expect(
      profile,
      "a production profile requires verified and accepted authority requirements",
    ).toBe(accepted);
  });
});
