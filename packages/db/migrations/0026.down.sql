-- drop table removes its index, its policy and its audit trigger with it; app_meta itself is never dropped.
drop table if exists app.print_template;
