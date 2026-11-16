-- 0053.down.sql — reverse dependency order (§3.4.5).
drop index if exists app.tax_code_regime_idx;
drop table if exists app.tax_code;
drop table if exists app.tax_regime;
