import type { Sql } from "postgres";

export interface PrincipalWithPermission {
  principalId: string;
  displayName: string;
}

export async function whoCan(
  tx: Sql,
  companyId: string,
  permissionCode: string,
  branchId?: string | null,
): Promise<PrincipalWithPermission[]> {
  const rows = await tx<{ id: string; display_name: string }[]>`
    select distinct principal.id, principal.display_name
      from app.principal principal
      join app.role_assignment assignment on assignment.principal_id = principal.id
      join app.role_permission grant_row on grant_row.role_id = assignment.role_id
     where assignment.company_id = ${companyId}
       and grant_row.permission_code = ${permissionCode}
       and (assignment.expires_at is null or assignment.expires_at > now())
       and (${branchId ?? null}::uuid is null
            or not exists (
              select 1 from app.role_assignment_branch branch
               where branch.principal_id = assignment.principal_id
                 and branch.role_id = assignment.role_id
                 and branch.company_id = assignment.company_id)
            or exists (
              select 1 from app.role_assignment_branch branch
               where branch.principal_id = assignment.principal_id
                 and branch.role_id = assignment.role_id
                 and branch.company_id = assignment.company_id
                 and branch.branch_id = ${branchId ?? null}::uuid))
     order by principal.display_name`;
  return rows.map((row) => ({ principalId: row.id, displayName: row.display_name }));
}
