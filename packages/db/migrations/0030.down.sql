-- Reverse of 0030, in reverse dependency order. The audit and RLS objects are attached by the app_meta
-- procedures and go with the tables (contracts §3.4.5).
drop index if exists app.promotion_window_idx;
drop table if exists app.promotion;
drop index if exists app.price_list_line_item_idx;
drop table if exists app.price_list_line;
drop table if exists app.price_list;
