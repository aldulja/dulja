import type { Sql } from "postgres";

export interface StaffContextRow {
  company_id: string;
  company_code: string;
  company_name: string;
  base_currency: string;
  branch_id: string;
  branch_code: string;
  name_en: string;
  name_ar: string | null;
}

/**
 * Selectable context only; callers still authorize every operation independently. The seven codes are the
 * gates of the screens this selector serves: the four 6C staff codes, `pos.report.read` for 6D's shift and
 * Z-report screens, `admin.company.manage` for the branch limits (PR 12 review amendment, contracts 6C
 * staff-screen context reconciliation) and `hr.payroll.read` for 8B's payroll run screens (8B T15).
 */
export async function listStaffContext(tx: Sql): Promise<StaffContextRow[]> {
  return tx<StaffContextRow[]>`
    select c.id as company_id,c.code as company_code,c.name as company_name,
           c.base_currency,b.id as branch_id,b.code as branch_code,b.name_en,b.name_ar
      from app.company c
      join app.dimension_type dt on dt.company_id=c.id and dt.code='BRANCH'
      join app.dimension_value b on b.dimension_type_id=dt.id and b.archived_at is null
     where exists (
       select 1 from unnest(array['hr.employee.read','hr.employee.manage',
          'hr.attendance.record','pos.cashier.manage_pin','pos.report.read',
          'admin.company.manage','hr.payroll.read']::text[]) authority(code)
        where app.actor_has(authority.code,c.id,b.id)
     )
     order by c.code,c.id,b.code,b.id`;
}
