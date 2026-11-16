-- Dulja application roles. Run as a database administrator.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_migrator') then
    create role app_migrator login nosuperuser nobypassrls nocreaterole;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw login nosuperuser nobypassrls nocreaterole;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'app_auth') then
    create role app_auth nologin nosuperuser nobypassrls nocreaterole noinherit;
  end if;

  execute format('grant create on database %I to app_migrator', current_database());
end
$$;

alter role app_migrator set timezone = 'UTC';
alter role app_rw set timezone = 'UTC';

grant app_auth to app_migrator with inherit false;
