# Report definitions (the `reports` sub-pack)

One directory per **owning slice**, one `<code>.json` per report, exactly as contracts §4.16.1 fixes:

    packages/db/seed/my/reports/<owning slice, lowercased>/<code>.json

`1b/`, `3d/`, `4b/`, `6d/` (the minimal set spec:2300 ships from Phase 1 onward), `7b/`, `7c/` and `8d/` are
**disjoint** directories, so no two writers ever touch one file.

## The file is an envelope, and it carries TWO different versions

Every file is exactly:

```json
{ "definitionVersion": 1, "definition": { "version": 1, "code": "…" } }
```

and nothing else — the same shape a document-type seed file has (§4.3.7).

| Member               | What it is                                                                                                                                         | Who changes it                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definitionVersion`  | `app.report_definition.version` — the **row** version the `unique (company_id, code, version)` key uses. An integer of at least 1.                 | **You.** §4.16.1 requires a definition seeded for a code an earlier slice already served to be seeded at `definitionVersion = 2` — that is how 7B re-expresses `accounting.trial_balance`, `accounting.ledger`, `inventory.stock_on_hand`, `inventory.valuation` and `inventory.sales_by_item`, and how 7C re-expresses `accounting.ageing`, `pos.z_report` and `pos.sales_by_cashier`. |
| `definition.version` | §4.11.1's **format** version. The JSON Schema pins it to `"const": 1`; a schema change is a new `const` **and** a new `$id`, never a widened enum. | Nobody, until the format itself changes.                                                                                                                                                                                                                                                                                                                                                |

The row version is **never** encoded in the file name: the file is named `<code>.json` and the loader refuses
any other name. Two versions of one code are two `definitionVersion` values in the same file across two
commits — the file is the current definition, and the row history is in the table.

A re-run of the seed with an unchanged `definitionVersion` **replaces** that row's `definition` (`on conflict
… do update`) when the file differs from it, and writes nothing — no row, no audit entry — when it does not.
So an edit ships by editing the file; raising `definitionVersion` is for a version that must coexist with the
old one, which is what "re-expresses" means.

**7A ships this directory and the loader, and no definition.** The `accounting.profit_and_loss` and
`accounting.balance_sheet` _layouts_ are 7A's (`packages/domain/src/reports/statement.ts`); their
_definitions_ are 7B's. Adding a `.json` here from any other slice than the one §4.16.1 names is a review
finding.

Apply the pack with `bun run seed --tenant <tenant_id> --only reports`. Every file is validated against
`packages/domain/report-definition.schema.json`, the closed `DatasetId` registry
(`packages/db/src/reports/datasets.ts`), the live permission catalogue (`app.permission`) and — through
`assertDefinitionFields` — the dataset's own column list, **before** it is inserted; a core row is then
upserted on `(company_id, code, version)` — the §3.4.8 policy-version rule — while a tenant's own clone at the
same version is refused rather than overwritten.
