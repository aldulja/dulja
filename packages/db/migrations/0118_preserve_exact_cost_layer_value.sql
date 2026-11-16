-- Owner-approved ADRs 0038/0039 amendments; Plan Contracts §3.4.1 tail allocation 0118.
-- Discover tenant contexts through the existing authentication resolver role; never disable FORCE RLS.
-- SET NOT NULL validates every row globally and fails closed if an orphan tenant was not discoverable.
alter table app.cost_layer add column value numeric(19,4);

do $$
declare
  contexts jsonb;
  context jsonb;
  original_role text := current_user;
  original_tenant text := current_setting('app.tenant_id', true);
  original_actor text := current_setting('app.actor_id', true);
begin
  perform set_config('role', 'app_auth', true);
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into contexts
    from (select tenant_id, min(principal_id::text) as actor_id from app.membership group by tenant_id) c;
  perform set_config('role', original_role, true);
  for context in select * from jsonb_array_elements(contexts) loop
    perform set_config('app.tenant_id', context->>'tenant_id', true);
    perform set_config('app.actor_id', context->>'actor_id', true);
    update app.cost_layer l set value = abs(m.value)
      from app.inventory_movement m
     where m.tenant_id = l.tenant_id and m.id = l.movement_id and m.quantity > 0;
    -- Preserve the already-booked answer; the existing bounded replay books only the correction.
    insert into app.cost_booking as b (tenant_id, company_id, movement_id, booked_value, pending)
    select tenant_id, company_id, id, abs(value), 'recost'
      from app.inventory_movement where quantity < 0
    on conflict (tenant_id, movement_id) do update set pending = 'recost', updated_at = now();
    update app.cost_consumption set invalidated_at = now() where invalidated_at is null;
  end loop;
  perform set_config('app.tenant_id', coalesce(original_tenant, ''), true);
  perform set_config('app.actor_id', coalesce(original_actor, ''), true);
end $$;

alter table app.cost_layer alter column value set not null;
alter table app.cost_layer add constraint cost_layer_value_check check (value >= 0);
