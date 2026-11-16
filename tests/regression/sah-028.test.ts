import { fullRegression } from "../support/api";

fullRegression("SAH-028", "Passwords are stored and compared in cleartext", {
  "no identity table in schema app has a password or credential column": async ({
    api,
    expect,
  }) => {
    // Scoped to the identity tables, not schema-wide: 6A's `terminal_enrolment` and 8A's HR envelope carry
    // legitimate secret material, and this block cannot be edited when they land (contracts §3.7.3). The defect
    // was `Users.Password` in cleartext, and these three tables are where such a column would go.
    const cols = await api.db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and table_name in ('principal', 'membership', 'tenant')
         and (column_name ~* 'password' or column_name ~* 'passwd' or column_name ~* 'secret'
              or column_name ~* 'credential' or column_name ~* 'api_key')`;
    expect(cols).toEqual([]);
  },

  "a principal is a subject reference, not a credential store": async ({ api, expect }) => {
    const cols = await api.db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'principal' order by column_name`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("auth_subject");
    expect(names.filter((n) => /pass|secret|hash|token/i.test(n))).toEqual([]);
  },

  "the API never accepts a password: the invite body is e-mail and display name only": async ({
    api,
    a,
    expect,
  }) => {
    const res = await api.request({
      method: "POST",
      path: "/v1/admin/users",
      as: a.human,
      body: { email: "sah028@example.test", displayName: "SAH-028", password: "hunter2" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const [row] = await api.db.admin<{ auth_subject: string }[]>`
      select auth_subject from app.principal where id = ${created.id}`;
    expect(row!.auth_subject).toMatch(/^stub:[0-9a-f]{32}$/); // server-obtained subject; the password went nowhere
  },
});

import { sourceFiles as syncCredentialSources } from "../support/source";
fullRegression(
  "SAH-028",
  "Enrolment tickets are one-shot secrets, not application passwords — 6A",
  {
    "sync contains no password hashing and enrolment stores a SHA256 lookup": async ({
      api,
      expect,
    }) => {
      const files = syncCredentialSources(["packages/db/src/sync", "apps/api/src"]);
      for (const file of files.filter(
        (f) => f.path.startsWith("packages/db/src/sync/") || f.path.includes("/sync/"),
      ))
        expect(file.text, file.path).not.toMatch(/\b(?:argon2|bcrypt|scrypt)\s*\(/);
      const [definition] = await api.db.admin<
        { src: string }[]
      >`select prosrc as src from pg_proc where pronamespace='app'::regnamespace and proname='resolve_enrolment'`;
      expect(definition!.src).toMatch(/code_hash/);
      expect(definition!.src).toMatch(/redeemed_at/);
      const enrolment = files.find((f) => f.path === "packages/db/src/sync/enrolment.ts")!;
      expect(enrolment.text).toContain('createHash("sha256")');
    },
  },
);

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source";
import { posFixture } from "../invariants/support/pos";
import { seedEmployee, grantCodes } from "@dulja/db/test";
fullRegression("SAH-028", "Passwords are stored and compared in cleartext — 6C", {
  "cashier credentials are Argon2id and their PIN cannot travel in a response": async ({
    api,
    expect,
  }) => {
    const f = await posFixture(api, "SAH028 STAFF");
    await grantCodes(api.db, f.s, { codes: ["admin.user.manage"] });
    const employeeId = await seedEmployee(api.db, f.s, { employeeNumber: "SAH028-NEW" });
    const created = await api.request({
      as: f.s.human,
      method: "POST",
      path: `/v1/companies/${f.s.company}/cashiers`,
      body: {
        employeeId,
        branchId: f.s.hq,
        displayName: "PIN regression",
        email: `pin-${employeeId}@example.invalid`,
        pin: "9836",
      },
    });
    expect(created.status).toBe(201);
    const raw = await created.text();
    expect(raw).not.toMatch(/9836|pin_hash|pinHash|argon2/);
    const rows = await api.db.admin<
      { pin_hash: string }[]
    >`select pin_hash from app.pos_cashier where tenant_id=${f.s.tenant}`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.pin_hash).toMatch(/^\$argon2id\$/);
    const routes = syncCredentialSources(["apps/api/src/routes/pos"]);
    const cashier = routes.find((r) => r.path.endsWith("/cashiers.ts"))!;
    expect(cashier.text).toContain("CashierSchema.parse");
    const { CashierSchema } = await import("@dulja/contracts/pos/cashier");
    expect(
      Object.keys(CashierSchema.shape).filter((key) =>
        /^(pin|pinHash|pin_hash|password)$/i.test(key),
      ),
    ).toEqual([]);
    const migrations = join(REPO_ROOT, "packages/db/migrations");
    const offenders = readdirSync(migrations).filter(
      (p) =>
        p.endsWith(".sql") &&
        /^\s*password\b|\bpassword\s+text/im.test(readFileSync(join(migrations, p), "utf8")),
    );
    expect(offenders).toEqual([]);
  },
});

import type { StartedApi } from "../../apps/api/test/support/app";
import { tillFixture } from "../invariants/support/till";
import { registerPosHandlers } from "../../apps/pos/src/main/register";
import {
  PIN_FAILURES_BEFORE_LOCKOUT,
  PIN_LOCKOUT_BASE_MS,
  TILL_PIN_FAILURES_PER_WINDOW,
  TILL_PIN_WINDOW_MS,
} from "../../apps/pos/src/main/authority";

/** A till holding the server's real cashier mirror, reached only through the IPC handlers its renderer calls. */
async function tillHandlers(api: StartedApi, name: string) {
  const f = await tillFixture(api, name);
  await f.loops.pullNow();
  f.db.raw
    .prepare(
      "insert into meta(key,value) values ('branch_id',?) on conflict(key) do update set value=excluded.value",
    )
    .run(f.staff.branchA);
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const clock = { now: new Date() };
  const names = [
    "enrol",
    "login",
    "openShift",
    "closeShift",
    "search",
    "priceCheck",
    "sell",
    "tender",
    "clock",
    "receipt",
    "print",
    "pull",
    "drain",
    "status",
  ];
  registerPosHandlers({
    ipcMain: { handle: (channel, listener) => void listeners.set(channel, listener) },
    channels: Object.fromEntries(names.map((n) => [n, n])),
    db: f.db,
    store: f.store,
    loops: f.loops,
    deviceStore: { get: async () => null, set: async () => {}, remove: async () => {} },
    baseUrl: "http://localhost",
    terminalId: f.terminalId,
    allowEvent: () => true,
    print: async () => {},
    onEnrolled: async () => {},
    now: () => clock.now,
  });
  const call = async (method: string, input: unknown) =>
    (await listeners.get(method)!({}, input)) as {
      ok: boolean;
      value?: { principalId?: string };
      error?: { code: string; detail: string };
    };
  return { f, clock, call };
}

fullRegression("SAH-028", "No rate limiting or lockout on failed attempts — 6B till PIN", {
  "five wrong PINs lock an employee number at sign-in and supervisor approval alike": async ({
    api,
    expect,
  }) => {
    const { f, clock, call } = await tillHandlers(api, "SAH028TILL");
    try {
      const cashier = { employeeNumber: "SAH028TILL-EA", pin: "4321" };
      const supervisor = "SAH028TILL-ES"; // real PIN 9999, holds pos.ticket.override
      const sale = (pin: string) => ({
        shiftId: f.staff.shiftA, // approvals are verified before the shift is looked at
        lines: [{ itemId: f.staff.itemId, quantity: "1.000000" }],
        approvals: [{ employeeNumber: supervisor, pin, subject: "discount", reason: "SAH-028" }],
      });
      expect((await call("login", cashier)).ok).toBe(true);
      for (let i = 0; i < PIN_FAILURES_BEFORE_LOCKOUT; i++)
        expect(
          i < 3
            ? await call("sell", sale("0000"))
            : await call("login", { employeeNumber: supervisor, pin: "0000" }),
        ).toMatchObject({ ok: false, error: { code: "ERR_TILL_PIN_INVALID" } });
      // Locked: the right PIN and a wrong one get the same answer, so the lockout is no oracle for the PIN.
      const right = await call("login", { employeeNumber: supervisor, pin: "9999" });
      const wrong = await call("login", { employeeNumber: supervisor, pin: "0000" });
      expect(right).toMatchObject({ ok: false, error: { code: "ERR_RATE_LIMITED" } });
      expect(wrong).toEqual(right);
      expect((await call("login", cashier)).ok).toBe(true);
      expect(await call("sell", sale("9999"))).toMatchObject({
        ok: false,
        error: { code: "ERR_RATE_LIMITED" },
      });
      // The refused attempts were not counted, or the lockout would have doubled past this point.
      clock.now = new Date(clock.now.getTime() + PIN_LOCKOUT_BASE_MS);
      expect(await call("login", { employeeNumber: supervisor, pin: "9999" })).toMatchObject({
        ok: true,
        value: { principalId: f.staff.supervisorA },
      });
      // Every PIN the till takes goes through that one counted door; nothing verifies a PIN beside it.
      expect(
        syncCredentialSources(["apps/pos/src"])
          .filter((file) => /\b(?:loginCashier|verifyPin)\s*\(/.test(file.text))
          .map((file) => file.path),
      ).toEqual(["apps/pos/src/main/authority.ts"]);
    } finally {
      await f.close();
    }
  },

  "one PIN sprayed across employee numbers pauses PIN entry at the till": async ({
    api,
    expect,
  }) => {
    const { f, clock, call } = await tillHandlers(api, "SAH028SPRAY");
    try {
      for (let i = 0; i < TILL_PIN_FAILURES_PER_WINDOW; i++)
        expect(
          await call("login", { employeeNumber: `SAH028SPRAY-X${i}`, pin: "1234" }),
        ).toMatchObject({ ok: false, error: { code: "ERR_TILL_PIN_INVALID" } });
      const cashier = { employeeNumber: "SAH028SPRAY-EA", pin: "4321" };
      expect(await call("login", cashier)).toMatchObject({
        ok: false,
        error: { code: "ERR_RATE_LIMITED" },
      });
      clock.now = new Date(clock.now.getTime() + TILL_PIN_WINDOW_MS);
      expect(await call("login", cashier)).toMatchObject({
        ok: true,
        value: { principalId: f.staff.cashierA },
      });
    } finally {
      await f.close();
    }
  },
});

// 9B Task 12 — ⚠️ OD-26 (spec:2468, Part VII #4: "Is `Users.Password` hashed client-side?"). §2.12's default is a
// forced reset and no import, and it holds whatever the answer: Dulja's identity is Supabase with MFA, so there is no
// password column to rehash a legacy credential into. These cases keep it true — a future loader with a `USERS`
// source, or a declared `PASSWORD`/`PIN` column, fails here. 9A's `NEVER_READ` is not in the importer barrel (contracts
// round 20 C16 item 13), so its "intact, and no loader declares a column it lists" case is
// `packages/importer/test/load/registry.test.ts`'s.
import { loaders } from "@dulja/importer";
import { InviteUserBody } from "@dulja/contracts/admin/user";
fullRegression("SAH-028", "Passwords are stored and compared in cleartext — 9B, the import path", {
  "registers no loader whose source table is USERS": async ({ expect }) => {
    expect(loaders.length).toBeGreaterThan(0);
    expect(loaders.map((l) => l.sourceTable)).not.toContain("USERS");
  },

  "declares no source column named PASSWORD or PIN, in any loader (OD-26 default)": async ({
    expect,
  }) => {
    const declared = loaders.flatMap((l) =>
      l.sourceColumns.map((c) => [l.sourceTable, c.name].join(".")),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((n) => /PASSWORD|PASSWD|\bPIN\b/i.test(n))).toEqual([]);
  },

  "no importer source names a legacy credential column, and the loaders never name a password or a PIN":
    async ({ expect }) => {
      const importer = syncCredentialSources(["packages/importer/src"]);
      expect(importer.length).toBeGreaterThan(0);
      expect(
        importer
          .filter((f) => /\bUSERPASSWORD\b|\bUSRPASSWORD\b|\bUSRPIN\b|\bUSERPIN\b/i.test(f.text))
          .map((f) => f.path),
      ).toEqual([]);
      // The loaders, their scalars and the registry: not one mention, in code or in a comment.
      const load = importer.filter((f) => f.path.startsWith("packages/importer/src/load/"));
      expect(load.length).toBeGreaterThan(0);
      expect(
        load.filter((f) => /PASSWORD|PASSWD|\bPIN\b/i.test(f.text)).map((f) => f.path),
      ).toEqual([]);
    },

  "users are INVITED, never migrated: the invite carries no password field to put one into":
    async ({ api, a, expect }) => {
      // The structural half of "cannot be migrated" (spec:2338): the wire body has exactly two members.
      expect(Object.keys(InviteUserBody.shape).toSorted()).toEqual(["displayName", "email"]);
      const res = await api.request({
        method: "POST",
        path: "/v1/admin/users",
        as: a.human,
        body: { email: "sah028-9b@example.test", displayName: "SAH-028 9B", password: "hunter2" },
      });
      // The extra member is dropped by the schema, not stored: the 0B block above proves the principal's subject is
      // server-obtained. Here, nothing in the answer carries it either.
      expect(res.status).toBe(201);
      expect(await res.text()).not.toContain("hunter2");
    },
});
