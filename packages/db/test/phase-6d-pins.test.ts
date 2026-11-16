// packages/db/test/phase-6d-pins.test.ts — FIVE cases. Its whole import list is node, vitest and this
// package; there is no `@dulja/contracts` and no `apps/` or `tests/` path in it, and that is the point.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listApplied } from "../src/migrate";
import { startDb, type Db } from "./harness";

// The repository root and a file reader, computed locally — the same three lines as Task 4's pack test and
// for the same reason: §4.17.1 puts `REPO_ROOT`/`repoFile` in `tests/support/**` (0B/0C) and `packages/db`
// may not import the `tests` workspace (§3.1); inventing a shared `packages/db` helper would be a new
// registered name with no §4.17.1 row (hazard 9). 0C computes it the same way (0c:415).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const repoFile = (relativePath: string): string =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

describe("6D pins (db tier) — the claims this slice's prose makes, asserted mechanically", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  it("this slice added NO ERRORS row", () => {
    // Every code the slice raises was shipped by 0B, 4B, 6A or 6C. The `error-codes` lint enforces the
    // other direction (a code with no raiser); this asserts that no 6D-shaped token was added. It is a
    // SOURCE read, not an import — `errors.ts` is `@dulja/contracts` and this file may not name it.
    const errors = repoFile("packages/contracts/src/errors.ts");
    for (const own of ["ERR_SHIFT_", "ERR_ZREPORT_"]) expect(errors).not.toContain(own);
  });

  it("this slice added NO DatasetId member — shift and till_event are 7C's rows (§4.16.2)", () => {
    // The guard this case carried — `datasets.ts` quotes neither "shift" nor "till_event" — was true only until
    // 7C added the members, and 7C retired it in that commit (§3.7.3; contracts round 15, A16 item 10). What
    // stays true of 6D: the two members live in 7C's own `datasets/pos.ts`, and 6D's report file defines no
    // dataset of its own.
    const path = "packages/db/src/reports/datasets.ts";
    if (!existsSync(join(REPO_ROOT, path))) return;
    expect(repoFile(path)).toContain('from "./datasets/pos"');
    expect(repoFile("packages/db/src/reports/datasets/pos.ts")).toContain('id: "shift"');
    expect(repoFile("packages/db/src/reports/pos.ts")).not.toContain("defineDataset");
  });

  it("the pos module holds exactly sixteen permission codes and 6D contributed two", async () => {
    // **Read from `app.permission`, not from an import of `PERMISSIONS`.** 3B's precedent (3b:3435,
    // citing 1a:5105): `dependency-rule` forbids `packages/db` naming `@dulja/contracts`. The table is
    // global and un-RLS'd (plan0A:1254), so `db.admin` reads it with no tenant context. There is no
    // `phase` column on it, so the two 6D codes are asserted by membership rather than by a filter —
    // `permission-catalogue.test.ts` (0B) is what pins the table against `permissions.ts` both ways.
    const pos = await db.admin<{ code: string }[]>`
      select code from app.permission where module = 'pos' order by code`;
    expect(pos).toHaveLength(16);
    expect(pos.map((p) => p.code)).toContain("pos.report.read");
    expect(pos.map((p) => p.code)).toContain("pos.shift.close_any");
  });

  it("6d-till.json seeds only 6D's own account codes, and no other file seeds them", () => {
    const charts = readdirSync(join(REPO_ROOT, "packages/db/seed/my/chart-of-accounts"));
    for (const code of ["1130", "5120", "5130"]) {
      const owners = charts.filter((f) =>
        repoFile(`packages/db/seed/my/chart-of-accounts/${f}`).includes(`"${code}"`),
      );
      expect(owners).toEqual(["6d-till.json"]); // hazard 32: exactly one seeding slice per code
    }
  });

  it("the migrations applied after 0069 are exactly this slice's, and 0073 is unused (§3.4.1)", async () => {
    const applied = (await listApplied(db.admin)).filter((v) => v >= 70 && v <= 73);
    // 0071 because OD-10 was answered yes on 2026-11-04 (docs/owner/od-10/decision.md); 0073 is allocated and
    // left unused, and no slice borrows it.
    expect(applied.filter((v) => v === 73)).toEqual([]);
    expect(applied).toEqual([70, 71, 72]);
  });
});
