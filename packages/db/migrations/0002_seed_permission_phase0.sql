-- Phase 0 permission catalogue (spec:2135).
insert into app.permission(code,module,mutating,description) values
('admin.user.manage','admin',true,'Invite, list, and expire tenant users'),
('admin.role.manage','admin',true,'Create roles and manage permissions'),
('admin.role.assign','admin',true,'Assign roles within companies'),
('admin.company.manage','admin',true,'Create and maintain companies'),
('admin.audit_log.read','admin',false,'Read the append-only audit log')
on conflict(code) do update set module=excluded.module,mutating=excluded.mutating,description=excluded.description;
