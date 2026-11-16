-- Reverse of 0034, in reverse dependency order (contracts §3.4.5): cost_consumption points at cost_layer,
-- which points at inventory_movement. Dropping a table drops its own indexes with it, so the four partial
-- indexes need no line of their own.
drop table if exists app.stock_valuation;
drop table if exists app.cost_consumption;
drop table if exists app.cost_layer;
