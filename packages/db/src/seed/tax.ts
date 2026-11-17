import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { validateTaxPack } from "@dulja/domain";
import { taxCodeAccountMisfit } from "../tax/codes";
import { SeedError } from "./types";
import { readPackFile } from "./packs";
import type { LoaderContext, PackLoader } from "./packs";

export interface TaxRegimeManifest {
  code: string;
  version: number;
  jurisdiction: "MY";
  effectiveFrom: string;
  effectiveTo?: string | null;
  nameEn: string;
  nameAr?: string;
  source: string;
}
export interface TaxCodeManifest {
  regimeCode: string;
  regimeVersion: number;
  codes: {
    code: string;
    nameEn: string;
    nameAr?: string;
    rate: string;
    kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
    roundingMode: "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";
    accountCode: string | null;
    effectiveFrom: string;
    effectiveTo?: string | null;
  }[];
}

/** Whether a regime's own `source` declares it synthetic test data rather than a published figure. The
 *  marker is the prefix the shipped `SYNTH-MY-v1` carries ("SYNTHETIC-TEST-v1 — not a published figure
 *  (OD-15)") and the one test the OD-15 provenance guard (`packages/db/test/seed/tax-pack.test.ts`) applies to
 *  every shipped regime, so "synthetic" means one thing in both places. */
function isSyntheticRegime(regime: TaxRegimeManifest): boolean {
  return regime.source.startsWith("SYNTHETIC");
}

/**
 * One regime is two files, named from its own **code**, so a second regime cannot overwrite a first.
 *
 * **The code alone must be unique within a pack directory**, and the shipped convention is what makes that
 * true: a regime's version is carried *in* its code (`SYNTH-MY-v1`), so a second version is a second code
 * and a second file pair. The manifest's `version` field is still checked — `taxLoader` refuses a
 * `*.codes.json` whose `regimeVersion` disagrees with its `*.regime.json` — but it is not part of the file
 * name, because `SYNTH-MY-v1-v1.regime.json` would say the same thing twice.
 */
export function taxFileNames(regimeCode: string): { regime: string; codes: string } {
  return { regime: `${regimeCode}.regime.json`, codes: `${regimeCode}.codes.json` };
}

/**
 * The `--only tax` loader (§3.4.8, §4.2.13, amendment A6). Reads every `*.regime.json` under
 * `<packRoot>/tax/`, inserts the regime, then inserts its codes from the matching `*.codes.json`, linking
 * `output_account_id` / `input_account_id` by the §4.15 account CODE.
 *
 * **Returns the number of ROWS INSERTED**, which is `PackLoader.load`'s contract verbatim — zero on a
 * re-run, which is what "changes nothing" means (spec:2002). `on conflict … do nothing` returns no row on a
 * hit, so counting `returning id` results is exact. **`do nothing`, not `do update`:** §3.4.8 reserves
 * `do update` for `posting_policy` alone, and a changed rate is a NEW regime version or a new
 * `effective_from` — never an edit of a row a filed return already points at (LEGACY-020, ADR 0050).
 *
 * **A missing account fails loudly.** `chart-of-accounts` runs earlier in application order, so an absent
 * `2300` is the PACK's problem and not the tenant's; letting it pass would leave `output_account_id` null
 * and `postDocument` would resolve `tax_code.output_account` to nothing at post — the silent-null failure
 * `tax_code_account_for_kind_check` and this check exist together to prevent. **So does an account of the
 * wrong type**: an output code's account must be a liability and an input code's an asset
 * (`taxCodeAccountMisfit`, the rule `createTaxCode` applies), because the tie-out signs each account by type.
 *
 * **Every file is validated against `tax-pack.schema.json` before anything is read out of it**, through
 * `validateTaxPack` — the shape 1A's `documentTypesLoader` uses for `document-type-seed.schema.json`
 * (§4.3.7). A fault is a `SeedError` naming the file and the JSON path, so the CLI's exit code 1 and its
 * message form are unchanged.
 *
 * **When `config.appEnv` is `production`, a synthetic regime is skipped** (PR 11 review, round 3): its files
 * are read and validated like any other, nothing of it is inserted, and the skip is reported through
 * `ctx.reportSkip`, which `seed` prints in `SeedResult.skipped`. A regime whose `source` is not synthetic loads
 * in production exactly as everywhere else; dev and staging load every regime.
 */
const check = (file: string, value: unknown): void => {
  const report = validateTaxPack(value);
  if (!report.ok) {
    throw new SeedError(
      `${file} does not match urn:dulja:tax-pack:1: ` +
        report.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; "),
    );
  }
};

export const taxLoader: PackLoader = {
  name: "tax",
  async load(tx: Sql, ctx: LoaderContext): Promise<number> {
    const dir = join(ctx.packRoot, "tax");
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".regime.json"))
        .toSorted();
    } catch (e) {
      throw new SeedError(
        `${dir} is not a readable directory — a tax pack needs it (§3.4.8): ${String(e)}`,
      );
    }

    // The loader's first act on every object it reads is to validate it against tax-pack.schema.json.

    let inserted = 0;
    for (const file of files) {
      const regime = readPackFile<TaxRegimeManifest>(ctx.packRoot, "tax", file);
      check(file, regime);
      const names = taxFileNames(regime.code);
      if (file !== names.regime) {
        throw new SeedError(
          `${file}: a regime file must be named ${names.regime} after its own code`,
        );
      }
      // BOTH files are read and checked BEFORE either insert. A rollback would cover the correctness, but
      // a loader that inserts a regime and then rejects its codes reports the second file's fault after
      // having done work — and the CLI's message is the only thing a seed operator sees.
      const manifest = readPackFile<TaxCodeManifest>(ctx.packRoot, "tax", names.codes);
      check(names.codes, manifest);
      if (manifest.regimeCode !== regime.code || manifest.regimeVersion !== regime.version) {
        throw new SeedError(
          `${names.codes}: names regime ${manifest.regimeCode} v${manifest.regimeVersion}, ` +
            `but ${file} declares ${regime.code} v${regime.version}`,
        );
      }
      // PR 11 review, round 3. A synthetic regime's codes and rates are invented test data (OD-15), and
      // SALES_INVOICE/PURCHASE_INVOICE policy version 2 apply tax, so loading it into a production company would
      // put selectable fake codes on real invoices and returns. Skipped AFTER both files are validated — a
      // malformed pack still fails loudly in production — and reported, never silent. Dev and staging load it.
      if (ctx.config.appEnv === "production" && isSyntheticRegime(regime)) {
        ctx.reportSkip?.({
          subPack: "tax",
          file,
          reason:
            `${regime.code} v${regime.version} is a synthetic regime (source ${JSON.stringify(regime.source)}) ` +
            "and is never seeded when APP_ENV=production",
        });
        continue;
      }

      const regimeRows = await tx<{ id: string }[]>`
        insert into app.tax_regime (tenant_id, company_id, code, jurisdiction, version, effective_from,
                                    effective_to, name_en, name_ar, source)
        values (${ctx.tenantId}, ${ctx.companyId}, ${regime.code}, ${regime.jurisdiction}, ${regime.version},
                ${regime.effectiveFrom}, ${regime.effectiveTo ?? null}, ${regime.nameEn},
                ${regime.nameAr ?? null}, ${regime.source})
        on conflict (company_id, code, version) do nothing
        returning id`;
      inserted += regimeRows.length;
      const [regimeRow] =
        regimeRows.length > 0
          ? regimeRows
          : await tx<{ id: string }[]>`
        select id from app.tax_regime
         where company_id = ${ctx.companyId} and code = ${regime.code} and version = ${regime.version}`;
      if (!regimeRow)
        throw new SeedError(`${file}: the regime row could neither be inserted nor read back`);

      for (const c of manifest.codes) {
        let accountId: string | null = null;
        if (c.accountCode !== null) {
          const [account] = await tx<{ id: string; type: string }[]>`
            select id, type::text from app.account where company_id = ${ctx.companyId} and code = ${c.accountCode}`;
          if (!account) {
            throw new SeedError(
              `${names.codes}: account ${c.accountCode} is not seeded for this company — ` +
                `seed --only chart-of-accounts first (§3.4.8, §4.15)`,
            );
          }
          // The rule `createTaxCode` applies at runtime, applied here too: the tie-out signs every account a
          // regime's codes name by its type, and a pack is a writer of those accounts like any other.
          const misfit = taxCodeAccountMisfit(c.kind, c.accountCode, account.type);
          if (misfit) throw new SeedError(`${names.codes}: ${c.code}: ${misfit}`);
          accountId = account.id;
        }
        const rows = await tx<{ id: string }[]>`
          insert into app.tax_code (tenant_id, company_id, regime_id, code, name_en, name_ar, rate, kind,
                                    rounding_mode, output_account_id, input_account_id,
                                    effective_from, effective_to)
          values (${ctx.tenantId}, ${ctx.companyId}, ${regimeRow.id}, ${c.code}, ${c.nameEn},
                  ${c.nameAr ?? null}, ${c.rate}, ${c.kind}, ${c.roundingMode},
                  ${c.kind === "output" ? accountId : null},
                  ${c.kind === "input" ? accountId : null},
                  ${c.effectiveFrom}, ${c.effectiveTo ?? null})
          on conflict (company_id, code, effective_from) do nothing
          returning id`;
        inserted += rows.length;
      }
    }
    return inserted;
  },
};
