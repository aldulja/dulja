import { readdirSync } from "node:fs";
import { join } from "node:path";
import { composeTemplateSource } from "@dulja/domain";
import { readPackFile, readPackText, type LoaderContext, type PackLoader } from "./packs";
import { SeedError } from "./types";

export interface TemplateManifest {
  documentType: string;
  code: string;
  version: number;
  nameEn: string;
  nameAr?: string;
  /** ADR 0016's closed value set — `chromium` alone; a second engine is a later migration plus adapter. */
  engine: "chromium";
  paper?: "A4" | "A5" | "receipt";
  labels: { en: Record<string, string>; ar: Record<string, string> };
}

/** The body's extension follows the engine, so `<TYPE>.<code>.v<N>.<ext>` (§4.5.9) is mechanical. */
export const TEMPLATE_BODY_EXTENSION: Readonly<Record<TemplateManifest["engine"], string>> = {
  chromium: "html",
};

export function templateFileNames(
  m: Pick<TemplateManifest, "documentType" | "code" | "version" | "engine">,
): { manifest: string; body: string } {
  const stem = `${m.documentType}.${m.code}.v${m.version}`;
  return { manifest: `${stem}.json`, body: `${stem}.${TEMPLATE_BODY_EXTENSION[m.engine]}` };
}

function fail(file: string, why: string): never {
  throw new SeedError(`${file}: ${why}`);
}

function assertManifest(file: string, m: TemplateManifest): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(m.documentType ?? "")) {
    fail(file, "documentType must match ^[A-Z][A-Z0-9_]{1,63}$");
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(m.code ?? ""))
    fail(file, "code must match ^[a-z][a-z0-9-]{0,31}$");
  if (!Number.isInteger(m.version) || m.version < 1)
    fail(file, "version must be a positive integer");
  if (!m.nameEn) fail(file, "nameEn is required");
  if (!(m.engine in TEMPLATE_BODY_EXTENSION)) {
    fail(
      file,
      `engine must be one of ${Object.keys(TEMPLATE_BODY_EXTENSION).join(", ")} (ADR 0016)`,
    );
  }
  for (const lang of ["en", "ar"] as const) {
    if (!m.labels?.[lang] || typeof m.labels[lang] !== "object") {
      fail(file, `labels.${lang} is required (spec:2061 — both catalogues)`);
    }
  }
  const expected = templateFileNames(m).manifest;
  if (file !== expected) {
    fail(file, `file name must be ${expected} for this documentType/code/version/engine`);
  }
}

/**
 * The `--only templates` loader (§3.4.8, §4.2.13). Reads every `*.json` manifest under
 * `<packRoot>/templates/`, reads its body beside it, composes the two into `print_template.source`
 * (ADR 0032) and inserts `on conflict … do nothing`: §3.4.8 reserves `do update` for `posting_policy`,
 * and a changed template body ships as a NEW `version`, which is what `unique (document_type_id, code,
 * version)` and spec:1240's "version-controlled" mean.
 *
 * **Returns the number of ROWS INSERTED**, which is `PackLoader.load`'s contract verbatim — zero on a
 * re-run, which is what "changes nothing" means (§4.2.13). `on conflict … do nothing` returns no row on
 * a hit, so counting the `returning id` results is exact.
 */
export const templatesLoader: PackLoader = {
  name: "templates",
  async load(tx, ctx: LoaderContext): Promise<number> {
    const dir = join(ctx.packRoot, "templates");
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .toSorted();
    } catch (e) {
      // A pack root without the directory must fail with a message naming it, like every other seed
      // failure — never a bare ENOENT stack trace out of node:fs.
      throw new SeedError(
        `${dir} is not a readable directory — a templates pack needs it (§3.4.8): ${String(e)}`,
      );
    }

    let inserted = 0;
    for (const file of files) {
      const manifest = readPackFile<TemplateManifest>(ctx.packRoot, "templates", file);
      assertManifest(file, manifest);
      const body = readPackText(ctx.packRoot, "templates", templateFileNames(manifest).body);
      const source = composeTemplateSource({ labels: manifest.labels }, body);

      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${ctx.companyId} and code = ${manifest.documentType}`;
      if (!type) {
        throw new SeedError(
          `${file}: document type ${manifest.documentType} is not seeded for this tenant — seed --only document-types first (contracts §3.4.8)`,
        );
      }

      const rows = await tx<{ id: string }[]>`
        insert into app.print_template (tenant_id, company_id, document_type_id, code, version, name_en, name_ar, engine, source, paper)
        values (${ctx.tenantId}, ${ctx.companyId}, ${type.id}, ${manifest.code}, ${manifest.version},
                ${manifest.nameEn}, ${manifest.nameAr ?? null}, ${manifest.engine}, ${source}, ${manifest.paper ?? "A4"})
        on conflict (document_type_id, code, version) do nothing
        returning id`;
      inserted += rows.length;
    }
    return inserted;
  },
};
