-- Repair MENUO production schema drift without deleting existing data.
alter table public.qr_codes
  alter column token set default replace(gen_random_uuid()::text,'-','');

insert into public.plans(
  id,name,price_monthly_cents,max_restaurants,max_dishes_per_restaurant,max_qr_codes,
  allergens,multilingual,analytics,branches,promos
) values
('free','FREE',0,1,10,1,false,false,false,false,false),
('pro','PRO',999,2,null,2,true,true,true,false,false),
('business','BUSINESS',1999,9999,null,9999,true,true,true,true,true)
on conflict(id) do update set
  name=excluded.name,
  price_monthly_cents=excluded.price_monthly_cents,
  max_restaurants=excluded.max_restaurants,
  max_dishes_per_restaurant=excluded.max_dishes_per_restaurant,
  max_qr_codes=excluded.max_qr_codes,
  allergens=excluded.allergens,
  multilingual=excluded.multilingual,
  analytics=excluded.analytics,
  branches=excluded.branches,
  promos=excluded.promos;

update public.subscriptions s
set plan_id='free'
where not exists(select 1 from public.plans p where p.id=s.plan_id);

create or replace function public.enforce_plan_limits()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_owner uuid;
  v_plan public.plans%rowtype;
  v_limit integer;
begin
  if tg_table_name='restaurants' then
    v_owner:=new.owner_id;
    select p.* into v_plan from public.plans p
    where p.id=coalesce((select s.plan_id from public.subscriptions s where s.user_id=v_owner and s.status in ('trialing','active','past_due') limit 1),'free');
    v_limit:=coalesce(v_plan.max_restaurants,1);
    if (select count(*) from public.restaurants r where r.owner_id=v_owner and r.id<>new.id)>=v_limit then raise exception 'restaurant_limit_reached'; end if;
  elsif tg_table_name='dishes' then
    select r.owner_id into v_owner from public.restaurants r where r.id=new.restaurant_id;
    select p.* into v_plan from public.plans p
    where p.id=coalesce((select s.plan_id from public.subscriptions s where s.user_id=v_owner and s.status in ('trialing','active','past_due') limit 1),'free');
    if v_plan.max_dishes_per_restaurant is not null and
       (select count(*) from public.dishes d where d.restaurant_id=new.restaurant_id and d.id<>new.id)>=v_plan.max_dishes_per_restaurant
    then raise exception 'dish_limit_reached'; end if;
  elsif tg_table_name='qr_codes' then
    select r.owner_id into v_owner from public.restaurants r where r.id=new.restaurant_id;
    select p.* into v_plan from public.plans p
    where p.id=coalesce((select s.plan_id from public.subscriptions s where s.user_id=v_owner and s.status in ('trialing','active','past_due') limit 1),'free');
    v_limit:=coalesce(v_plan.max_qr_codes,1);
    if (select count(*) from public.qr_codes q join public.restaurants r on r.id=q.restaurant_id where r.owner_id=v_owner and q.id<>new.id)>=v_limit
    then raise exception 'qr_limit_reached'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists restaurants_plan_limits on public.restaurants;
create trigger restaurants_plan_limits before insert on public.restaurants for each row execute function public.enforce_plan_limits();
drop trigger if exists dishes_plan_limits on public.dishes;
create trigger dishes_plan_limits before insert on public.dishes for each row execute function public.enforce_plan_limits();
drop trigger if exists qr_codes_plan_limits on public.qr_codes;
create trigger qr_codes_plan_limits before insert on public.qr_codes for each row execute function public.enforce_plan_limits();

grant execute on function public.enforce_plan_limits() to authenticated,service_role;

create or replace function public.get_my_plan()
returns text language sql stable security definer set search_path='public'
as $$
  select coalesce((select plan_id from public.subscriptions where user_id=auth.uid() and status in ('trialing','active','past_due') limit 1),'free');
$$;
grant execute on function public.get_my_plan() to authenticated;
