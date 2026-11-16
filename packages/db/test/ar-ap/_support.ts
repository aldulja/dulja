// packages/db/test/ar-ap/_support.ts — shared by every ar-ap suite in slice 4A. Deliberately file-local to this
// directory and NOT `fixtures.ts` helpers: §4.17 assigns 4A exactly one row (`seedPaymentTerm`) and hazard 9
// forbids inventing a second beside the register. A later slice that needs one moves it to §4.17.1 by amendment.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDocumentTypes } from "../../src/seed/document-types";
import { uuidv7, withTenant, type Db, type Seed } from "../index";

/**
 * The seed pack's root, resolved from THIS file rather than from `process.cwd()`: Vitest runs each package's
 * project from that package's own directory, so a repo-relative "packages/db/seed/my" does not resolve here
 * and a cwd-relative "seed/my" breaks the moment the suite is run from anywhere else — the trap
 * `scripts/reseed-verify.ts` and every 3C suite already avoid the same way. Stated as a constant so five
 * suites cannot spell it two ways.
 */
export const PACK_ROOT = fileURLToPath(new URL("../../seed/my", import.meta.url));

/**
 * Loads the pack's document types through 1A's REAL loader, so every test exercises the SEEDED file rather
 * than an inline policy. `loadDocumentTypes` loads every file in the directory — which is intended: each
 * later task's suite gets its own type for free as the files land — so the result is filtered by `code`
 * and returned keyed by the camel-cased code (`SALES_INVOICE` → `salesInvoiceType`).
 *
 * `loadDocumentTypes` takes a POOL and opens its own production `withTenant`, which refuses a transaction
 * (ERR_TENANT_CONTEXT_NESTED), so it is called on `db.rw` directly. The catalogue it validates approval codes
 * against is read from `app.permission` — `@dulja/contracts` is not importable from this directory
 * (dependency-rule), and migration 0014's table is the same set by construction.
 */
export async function loadTypesFromPack(
  db: Db,
  s: Seed,
  codes: readonly string[],
): Promise<Record<string, string>> {
  const catalogue = (
    await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ code: string }[]>`select code from app.permission order by code`,
    )
  ).map((row) => row.code);
  const results = await loadDocumentTypes(
    db.rw,
    { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
    join(PACK_ROOT, "document-types"),
    catalogue,
  );
  const out: Record<string, string> = {};
  for (const code of codes) {
    const hit = results.find((r) => r.code === code);
    if (hit === undefined) throw new Error(`the seed pack has no document type ${code}`);
    const key = `${code.toLowerCase().replace(/_(.)/g, (_, c: string) => c.toUpperCase())}Type`;
    out[key] = hit.documentTypeId;
  }
  return out;
}

/** The id of the company's account `code`, or a throw naming hazard 33 — never a null account. */
export async function accountByCode(db: Db, s: Seed, code: string): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = ${code}`;
    if (row === undefined) {
      throw new Error(`account ${code} does not resolve for this company (hazard 33)`);
    }
    return row.id;
  });
}

/**
 * `a + b` over two 4-dp decimal strings, added as integer hundredths-of-a-cent. Every corridor assertion in
 * Tasks 6 and 7 is "the balance moved by exactly X", and `Number(before) + 12` — the obvious spelling — is the
 * shape §3.7.5's `no-number-money` rule exists to stop. A test is not exempt from Global Constraint 4, and
 * `Money` is not usable here because these are raw account balances read as text with no currency attached.
 */
export function plus4(a: string, b: string): string {
  const total = scaled4(a) + scaled4(b);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** A decimal string as an integer count of hundredths of a cent (scale 4), sign kept. */
function scaled4(v: string): bigint {
  const negative = v.startsWith("-");
  const [whole, fraction = ""] = (negative ? v.slice(1) : v).split(".");
  const n = BigInt(`${whole}${`${fraction}0000`.slice(0, 4)}`);
  return negative ? -n : n;
}
