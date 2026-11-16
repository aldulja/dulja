-- reverse dependency order (§3.4.5). drop table removes its indexes, its policy, and the
-- audit_row / stamp_uploaded_by triggers with it; app_meta itself is never dropped.
drop table if exists app.attachment;
