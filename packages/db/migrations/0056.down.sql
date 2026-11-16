-- 0056.down.sql — delete exactly the code this file inserted (§3.6.3).
delete from app.permission where code = 'accounting.tax.manage';
