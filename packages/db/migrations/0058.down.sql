-- 0058 down. Deletes exactly the codes 0058 inserted (§3.6.3) and nothing else.
delete from app.permission where code = 'accounting.tax.file';
