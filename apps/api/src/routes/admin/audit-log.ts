import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { AuditLogList, AuditLogQuery, decodeCursor, encodeCursor } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { AUDIT_IMAGE_RULES, MODULE_ROW_GATES, projectAuditImage } from "@dulja/db";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../middleware/require-permission";

const READ = PERMISSION["admin.audit_log.read"];
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** The export registry's image rules as two parallel arrays; `''` = no gate beyond the audit read. */
const RULE_TABLES = [...AUDIT_IMAGE_RULES.keys()];
const RULE_GATES = [...AUDIT_IMAGE_RULES.values()].map((rule) => rule.gate ?? "");
const MODULES = Object.keys(MODULE_ROW_GATES).toSorted();
const MODULE_GATES = MODULES.map((module) => MODULE_ROW_GATES[module]!);
/** Every code the handler asks of the caller, company by company. */
const AUDIT_CODES = [
  ...new Set([READ, ...RULE_GATES.filter((gate) => gate !== ""), ...MODULE_GATES]),
].toSorted();

export const auditLogRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result) => {
    if (!result.success) throw result.error;
  },
});

auditLogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["admin"],
    middleware: [
      requirePermission(PERMISSION["admin.audit_log.read"], { company: "any" }),
    ] as const,
    summary: "Read the append-only audit log",
    request: { query: AuditLogQuery },
    responses: {
      200: {
        description: "A page of audit rows",
        content: { "application/json": { schema: AuditLogList } },
      },
    },
  }),
  async (context) => {
    const { cursor, limit, tableName, actorId, action, from, to } = context.req.valid("query");
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await context.var.withTenant(async (tx) => {
      // Which codes the caller holds in which company (ADR 0090). A ROW is visible in a company where the
      // caller holds the audit read; a row whose company cannot be resolved (the tenant, its principals, roles
      // and currencies, and a system event naming none) only to a caller who holds it in EVERY company. An
      // IMAGE is served only when the caller also holds its table's own gate there (the export's registry).
      const held = await tx<{ company_id: string; code: string }[]>`
        select c.id as company_id, k.code
          from app.company c cross join unnest(${AUDIT_CODES}::text[]) as k(code)
         where app.actor_has(k.code, c.id)`;
      const [count] = await tx<{ n: number }[]>`select count(*)::int as n from app.company`;
      const companies = count?.n ?? 0;
      const everywhere = AUDIT_CODES.filter(
        (code) => companies > 0 && held.filter((row) => row.code === code).length === companies,
      );
      const read = held.filter((row) => row.code === READ).map((row) => row.company_id);
      const uuidAt = (key: string) =>
        tx`(case when i.img ->> ${key} ~ ${UUID_PATTERN} then (i.img ->> ${key})::uuid end)`;
      // Every document an image names. `entity_id` (a custom-field value) counts only when it IS a document the
      // caller can see, since it may name a party or an item; every other key names a document by definition.
      const docRefs = () => tx`
        case when a.table_name = 'document' then ${uuidAt("id")} end,
        ${uuidAt("document_id")}, ${uuidAt("source_document_id")}, ${uuidAt("target_document_id")},
        ${uuidAt("settlement_document_id")}, ${uuidAt("settled_document_id")},
        ${uuidAt("reconcilable_document_id")},
        (select x.document_id from app.ledger_entry x where x.id = ${uuidAt("entry_id")}),
        (select x.id from app.document x where x.id = ${uuidAt("entity_id")})`;
      return tx<
        {
          seq: string;
          actor_id: string;
          occurred_at: Date;
          table_name: string;
          row_id: string;
          action: "insert" | "update" | "delete";
          before: unknown;
          after: unknown;
          images_visible: boolean;
        }[]
      >`
      select a.seq::text as seq, a.actor_id, a.occurred_at, a.table_name, a.row_id, a.action, a.before, a.after,
             (rule.gate is not null
               and (rule.gate = ''
                    or (r.company_id is null and rule.gate = any(${everywhere}::text[]))
                    or exists (select 1 from unnest(${held.map((row) => row.company_id)}::uuid[],
                                                    ${held.map((row) => row.code)}::text[]) as h(company_id, code)
                                where h.company_id = r.company_id and h.code = rule.gate))
               -- a row of a gated module's DOCUMENT (a PAYROLL's lines, links, ledger rows…) also needs that
               -- module's code at the document's branch — the export's MODULE_ROW_GATES, and the generic
               -- document routes' rule. A referenced document the caller cannot see withholds the images.
               and (select count(distinct ref.id) from unnest(array[${docRefs()}]::uuid[]) as ref(id))
                 = (select count(*) from app.document d
                     where d.id = any(array[${docRefs()}]::uuid[])
                       and not exists (
                         select 1 from app.document_type t
                           join unnest(${MODULES}::text[], ${MODULE_GATES}::text[]) as m(module, gate)
                             on m.module = t.module::text
                          where t.id = d.document_type_id
                            and not app.actor_has(m.gate, d.company_id, d.branch_id))))
               as images_visible
        from app.audit_log a
        cross join lateral (select coalesce(a.after, a.before) as img) i
        cross join lateral (
          select coalesce(
            case when a.table_name = 'company' then ${uuidAt("id")} end,
            ${uuidAt("company_id")},
            ${uuidAt("companyId")},
            (select x.company_id from app.employee x where x.id = ${uuidAt("employee_id")}),
            (select x.company_id from app.document x where x.id = ${uuidAt("document_id")}),
            (select x.company_id from app.document_type x where x.id = ${uuidAt("document_type_id")}),
            (select x.company_id from app.dimension_type x where x.id = ${uuidAt("dimension_type_id")}),
            (select x.company_id from app.item x where x.id = ${uuidAt("item_id")}),
            (select x.company_id from app.price_list x where x.id = ${uuidAt("price_list_id")})
          ) as company_id) r
        left join unnest(${RULE_TABLES}::text[], ${RULE_GATES}::text[]) as rule(table_name, gate)
          on rule.table_name = a.table_name
       where (${tableName ?? null}::text is null or a.table_name = ${tableName ?? null})
         and (${actorId ?? null}::uuid is null or a.actor_id = ${actorId ?? null}::uuid)
         and (${action ?? null}::text is null or a.action = ${action ?? null})
         and (${from ?? null}::date is null or a.occurred_at >= ${from ?? null}::date)
         and (${to ?? null}::date is null or a.occurred_at < (${to ?? null}::date + 1))
         and (${after ? after.id : null}::bigint is null or a.seq < ${after ? after.id : null}::bigint)
         and (case when r.company_id is null then ${everywhere.includes(READ)}::boolean
                   else r.company_id = any(${read}::uuid[]) end)
       order by a.seq desc limit ${limit + 1}`;
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return context.json({
      items: page.map((row) => ({
        seq: row.seq,
        actorId: row.actor_id,
        occurredAt: row.occurred_at.toISOString(),
        tableName: row.table_name,
        rowId: row.row_id,
        action: row.action,
        before: row.images_visible ? projectAuditImage(row.table_name, row.before) : null,
        after: row.images_visible ? projectAuditImage(row.table_name, row.after) : null,
        imagesWithheld: !row.images_visible && (row.before !== null || row.after !== null),
      })),
      next_cursor: rows.length > limit && last ? encodeCursor({ k: [], id: last.seq }) : null,
    });
  },
);
