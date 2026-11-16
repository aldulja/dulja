import {
  validateCustomFieldValue,
  type CustomFieldKind,
  type CustomFieldOptions,
} from "@dulja/domain";
import type { Sql } from "postgres";

export type CustomFieldEntity = "document" | "party" | "item" | "employee";
export interface CustomFieldDefinitionRow {
  id: string;
  companyId: string;
  entity: CustomFieldEntity;
  documentTypeId: string | null;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: CustomFieldKind;
  required: boolean;
  options: CustomFieldOptions;
  indexed: boolean;
  archivedAt: string | null;
}
export interface CustomFieldValueRow {
  definitionId: string;
  code: string;
  value: unknown;
}
export interface CreateDefinitionInput {
  companyId: string;
  entity: CustomFieldEntity;
  documentTypeId?: string | null;
  code: string;
  nameEn: string;
  nameAr?: string | null;
  kind: CustomFieldKind;
  required?: boolean;
  options?: CustomFieldOptions;
  indexed?: boolean;
}
export type SetValuesResult =
  | { ok: true; written: number }
  | { ok: false; errors: { path: string; message: string }[] };

export async function createDefinition(tx: Sql, input: CreateDefinitionInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.custom_field_definition
      (tenant_id, company_id, entity, document_type_id, code, name_en, name_ar,
       kind, required, options, indexed)
    values
      (app.current_tenant(), ${input.companyId}, ${input.entity}, ${input.documentTypeId ?? null},
       ${input.code}, ${input.nameEn}, ${input.nameAr ?? null}, ${input.kind},
       ${input.required ?? false}, ${tx.json((input.options ?? {}) as never)},
       ${input.indexed ?? false})
    returning id`;
  return row!.id;
}

export async function listDefinitions(
  tx: Sql,
  companyId: string,
  entity: CustomFieldEntity,
): Promise<CustomFieldDefinitionRow[]> {
  const rows = await tx<
    {
      id: string;
      company_id: string;
      entity: CustomFieldEntity;
      document_type_id: string | null;
      code: string;
      name_en: string;
      name_ar: string | null;
      kind: CustomFieldKind;
      required: boolean;
      options: CustomFieldOptions;
      indexed: boolean;
      archived_at: string | null;
    }[]
  >`
    select id, company_id, entity, document_type_id, code, name_en, name_ar,
           kind, required, options, indexed, archived_at
      from app.custom_field_definition
     where company_id = ${companyId} and entity = ${entity} and archived_at is null
     order by code`;
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    entity: row.entity,
    documentTypeId: row.document_type_id,
    code: row.code,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    kind: row.kind,
    required: row.required,
    options: row.options,
    indexed: row.indexed,
    archivedAt: row.archived_at,
  }));
}

/**
 * `companyId` is the company the caller's route gate cleared, and it bounds the definition lookup.
 * RLS bounds the tenant and nothing else, so without it a caller authorised for one company could
 * name another company's definition id and have its value written under it. A definition outside
 * `companyId` simply never reaches `byId`, so it earns the same "no such custom field definition"
 * error an invented id does — the refusal must not tell the caller the other company's row exists.
 */
/**
 * The ENTITY the values hang off must be a row of `companyId` too: `custom_field_value.entity_id` has no
 * foreign key, so without this a caller authorised for one company could write, under its own definitions,
 * values against another company's document — and `loadSnapshot` reads those values into the other
 * company's posting (`when: { "document.<code>": … }` rules). Items exist since 3A and use the same company
 * bound. `employee` has no table until 8A, so a value against it is refused rather than accepted against nothing.
 */
async function entityBelongs(
  tx: Sql,
  companyId: string,
  entity: CustomFieldEntity,
  entityId: string,
): Promise<boolean> {
  switch (entity) {
    case "document":
      return (
        (await tx`select 1 from app.document where id = ${entityId} and company_id = ${companyId}`)
          .length > 0
      );
    case "party":
      return (
        (await tx`select 1 from app.party where id = ${entityId} and company_id = ${companyId}`)
          .length > 0
      );
    case "item":
      return (
        (await tx`select 1 from app.item where id = ${entityId} and company_id = ${companyId}`)
          .length > 0
      );
    case "employee":
      return false;
  }
}

export async function setValues(
  tx: Sql,
  companyId: string,
  entity: CustomFieldEntity,
  entityId: string,
  values: readonly { definitionId: string; value?: unknown }[],
): Promise<SetValuesResult> {
  if (!(await entityBelongs(tx, companyId, entity, entityId))) {
    // Worded like an invented id: the refusal must not confirm that another company's row exists.
    return {
      ok: false,
      errors: [{ path: "entityId", message: `no ${entity} ${entityId} in this company` }],
    };
  }
  if (values.length === 0) return { ok: true, written: 0 };
  const ids = values.map((value) => value.definitionId);
  const defs = await tx<
    {
      id: string;
      code: string;
      kind: CustomFieldKind;
      required: boolean;
      options: CustomFieldOptions;
    }[]
  >`
    select id, code, kind, required, options from app.custom_field_definition
     where id = any(${ids}::uuid[]) and company_id = ${companyId}
       and entity = ${entity} and archived_at is null`;
  const byId = new Map(defs.map((def) => [def.id, def]));
  const errors: { path: string; message: string }[] = [];
  const normalised: { definitionId: string; value: unknown }[] = [];
  for (const value of values) {
    const def = byId.get(value.definitionId);
    if (!def) {
      errors.push({
        path: value.definitionId,
        message: "no such custom field definition for this entity",
      });
      continue;
    }
    const result = validateCustomFieldValue(def, value.value);
    if (result.ok) normalised.push({ definitionId: value.definitionId, value: result.value });
    else errors.push(...result.errors);
  }
  // A `dimension_value` field stores a uuid the validator can only shape-check; the row it names must be a
  // live value of the field's own dimension type, in THIS company — not any uuid, and not a value of another
  // company's type. `custom_field_value.value` is jsonb with no key to hold that, so it is asserted here.
  for (const entry of normalised) {
    const def = byId.get(entry.definitionId)!;
    if (def.kind !== "dimension_value" || typeof entry.value !== "string") continue;
    const typeId = def.options.dimensionTypeId;
    const live = typeId
      ? await tx`
          select 1 from app.dimension_value v
            join app.dimension_type t on t.id = v.dimension_type_id
           where v.id = ${entry.value} and t.id = ${typeId} and t.company_id = ${companyId}
             and v.archived_at is null`
      : [];
    if (live.length === 0) {
      errors.push({
        path: def.code,
        message: "must be a live value of the field's dimension type in this company",
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  if (normalised.length > 0) {
    // Last wins per definition: SetCustomFieldValuesBody only caps the array at 100, so a repeated
    // definition id reaches here, and one command cannot touch a conflict target twice — the
    // per-value loop this replaced overwrote, a multi-row insert would abort the batch instead.
    const latest = new Map(normalised.map((value) => [value.definitionId, value.value]));
    const batch = [...latest].map(([definitionId, value]) => ({ definitionId, value }));
    // One round trip, where a twenty-field form held the caller's transaction open across twenty.
    // `-> 'value'` and not a `jsonb_to_recordset` column, because that turns a JSON null into a SQL
    // NULL: an empty optional field validates to null, and `value` is `not null`. The per-row insert
    // could not store one either — `tx.json(null)` binds SQL NULL whatever type it declares — so an
    // empty field used to fail the whole request. It now stores a jsonb null and `getValues` returns
    // `value: null`, which is a behaviour change beyond the round-trip fix: whether an explicit null
    // should instead delete the row and clear the field is an owner decision nobody has made. The
    // K_NULL case in packages/db/test/custom-field.test.ts pins today's answer and is where a
    // delete-on-null would start. `tenant_id` stays the function call, which is what binds the row to
    // the transaction's tenant rather than to anything the caller sent.
    await tx`
      insert into app.custom_field_value (tenant_id, definition_id, entity_id, value)
      select app.current_tenant(), (incoming.entry ->> 'definitionId')::uuid, ${entityId},
             incoming.entry -> 'value'
        from jsonb_array_elements(${tx.json(batch as never)}::jsonb) as incoming(entry)
      on conflict (definition_id, entity_id) do update set value = excluded.value`;
  }
  return { ok: true, written: normalised.length };
}

/**
 * Same bound as `setValues`, and for the same reason: `custom_field_value` has no company of its
 * own, it borrows one through its definition, so the join must carry `company_id` or an entity id
 * from another company reads that company's values under the caller's own gate.
 */
export async function getValues(
  tx: Sql,
  companyId: string,
  entity: CustomFieldEntity,
  entityId: string,
): Promise<CustomFieldValueRow[]> {
  const rows = await tx<{ definition_id: string; code: string; value: unknown }[]>`
    select value.definition_id, definition.code, value.value
      from app.custom_field_value value
      join app.custom_field_definition definition on definition.id = value.definition_id
     where value.entity_id = ${entityId} and definition.company_id = ${companyId}
       and definition.entity = ${entity}
     order by definition.code`;
  return rows.map((row) => ({
    definitionId: row.definition_id,
    code: row.code,
    value: row.value,
  }));
}
