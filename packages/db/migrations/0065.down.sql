drop function if exists app.pos_cashier_sync(uuid, uuid, bigint);
drop trigger if exists pos_cashier_tombstone on app.pos_cashier;
drop function if exists app.pos_cashier_tombstone() cascade;
drop trigger if exists catalogue_revision on app.pos_cashier;
drop table if exists app.pos_cashier;
