-- MENUO production schema. Apply after creating the Supabase project.
create extension if not exists pgcrypto;

create table if not exists public.plans(
  id text primary key,
  name text not null,
  price_cents integer not null default 0 check(price_cents>=0),
  restaurant_limit integer not null default 1 check(restaurant_limit>0),
  dish_limit integer,
  qr_limit integer not null default 1 check(qr_limit>0),
  features jsonb not null default '{}'::jsonb
);
insert into public.plans(id,name,price_cents,restaurant_limit,dish_limit,qr_limit,features) values
('FREE','FREE',0,1,10,1,'{"allergens":false,"languages":false,"analytics":false}'),
('PRO','PRO',999,2,null,2,'{"allergens":true,"languages":true,"analytics":true}'),
('BUSINESS','BUSINESS',1999,9999,null,9999,'{"allergens":true,"languages":true,"analytics":true,"branches":true,"promotions":true}')
on conflict(id) do update set name=excluded.name,price_cents=excluded.price_cents,restaurant_limit=excluded.restaurant_limit,dish_limit=excluded.dish_limit,qr_limit=excluded.qr_limit,features=excluded.features;

create table if not exists public.profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default 'Пользователь',
  last_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.subscriptions(
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_id text not null default 'FREE' references public.plans(id),
  status text not null default 'active' check(status in('active','trialing','past_due','canceled','incomplete')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.restaurants(
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, slug text not null, logo_url text, address text, phone text, description text,
  website text, instagram text, facebook text, hours jsonb not null default '{}'::jsonb,
  default_locale text not null default 'ru', published boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id,slug)
);
create table if not exists public.categories(
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null, sort_order integer not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(), unique(restaurant_id,name)
);
create table if not exists public.dishes(
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  name text not null, description text not null default '', price_cents integer not null default 0 check(price_cents>=0),
  currency text not null default 'EUR', image_url text, is_available boolean not null default true,
  sort_order integer not null default 0, allergens jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.dish_translations(
  id uuid primary key default gen_random_uuid(),
  dish_id uuid not null references public.dishes(id) on delete cascade,
  locale text not null, name text, description text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(dish_id,locale)
);
create table if not exists public.qr_codes(
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text,'-',''),
  name text not null default 'Основной QR', is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.analytics_events(
  id bigint generated always as identity primary key,
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  qr_code_id uuid references public.qr_codes(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists restaurants_owner_idx on public.restaurants(owner_id);
create index if not exists categories_restaurant_idx on public.categories(restaurant_id,sort_order);
create index if not exists dishes_restaurant_idx on public.dishes(restaurant_id,sort_order);
create index if not exists dishes_category_idx on public.dishes(category_id);
create index if not exists dish_translations_dish_idx on public.dish_translations(dish_id);
create index if not exists analytics_restaurant_created_idx on public.analytics_events(restaurant_id,created_at desc);

create or replace function public.touch_updated_at() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function public.touch_updated_at();
drop trigger if exists restaurants_updated_at on public.restaurants;
create trigger restaurants_updated_at before update on public.restaurants for each row execute function public.touch_updated_at();
drop trigger if exists dishes_updated_at on public.dishes;
create trigger dishes_updated_at before update on public.dishes for each row execute function public.touch_updated_at();
drop trigger if exists dish_translations_updated_at on public.dish_translations;
create trigger dish_translations_updated_at before update on public.dish_translations for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,first_name,last_name) values(new.id,coalesce(nullif(new.raw_user_meta_data->>'first_name',''),'Пользователь'),coalesce(new.raw_user_meta_data->>'last_name','')) on conflict(id) do nothing;
 insert into public.subscriptions(user_id,plan_id,status) values(new.id,'FREE','active') on conflict(user_id) do nothing;
 return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.enforce_plan_limits() returns trigger language plpgsql security definer set search_path='' as $$
declare v_plan public.plans%rowtype; v_owner uuid; v_count integer;
begin
 if tg_table_name='restaurants' then
   select * into v_plan from public.plans where id=coalesce((select plan_id from public.subscriptions where user_id=new.owner_id),'FREE');
   if (select count(*) from public.restaurants where owner_id=new.owner_id and id<>new.id)>=v_plan.restaurant_limit then raise exception 'restaurant_limit_reached'; end if;
 elsif tg_table_name='dishes' then
   select owner_id into v_owner from public.restaurants where id=new.restaurant_id;
   select * into v_plan from public.plans where id=coalesce((select plan_id from public.subscriptions where user_id=v_owner),'FREE');
   if v_plan.dish_limit is not null and (select count(*) from public.dishes where restaurant_id=new.restaurant_id and id<>new.id)>=v_plan.dish_limit then raise exception 'dish_limit_reached'; end if;
 elsif tg_table_name='qr_codes' then
   select owner_id into v_owner from public.restaurants where id=new.restaurant_id;
   select * into v_plan from public.plans where id=coalesce((select plan_id from public.subscriptions where user_id=v_owner),'FREE');
   if (select count(*) from public.qr_codes q join public.restaurants r on r.id=q.restaurant_id where r.owner_id=v_owner and q.id<>new.id)>=v_plan.qr_limit then raise exception 'qr_limit_reached'; end if;
 end if;
 return new;
end $$;
drop trigger if exists restaurants_plan_limits on public.restaurants;
create trigger restaurants_plan_limits before insert on public.restaurants for each row execute function public.enforce_plan_limits();
drop trigger if exists dishes_plan_limits on public.dishes;
create trigger dishes_plan_limits before insert on public.dishes for each row execute function public.enforce_plan_limits();
drop trigger if exists qr_codes_plan_limits on public.qr_codes;
create trigger qr_codes_plan_limits before insert on public.qr_codes for each row execute function public.enforce_plan_limits();

create or replace function public.get_my_plan() returns jsonb language sql security definer stable set search_path='' as $$
select jsonb_build_object('plan',p.id,'name',p.name,'price_cents',p.price_cents,'restaurant_limit',p.restaurant_limit,'dish_limit',p.dish_limit,'qr_limit',p.qr_limit,'features',p.features,'status',s.status)
from public.subscriptions s join public.plans p on p.id=s.plan_id where s.user_id=(select auth.uid()) $$;

create or replace function public.get_public_menu(p_token text) returns jsonb language sql security definer stable set search_path='' as $$
select jsonb_build_object(
 'restaurant',jsonb_build_object('id',r.id,'name',r.name,'description',r.description,'address',r.address,'phone',r.phone,'website',r.website,'instagram',r.instagram,'facebook',r.facebook,'hours',r.hours,'default_locale',r.default_locale),
 'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort_order',c.sort_order) order by c.sort_order) from public.categories c where c.restaurant_id=r.id and c.is_active=true),'[]'::jsonb),
 'dishes',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'category_id',d.category_id,'name',d.name,'description',d.description,'price_cents',d.price_cents,'currency',d.currency,'image_url',d.image_url,'is_available',d.is_available,'sort_order',d.sort_order,'allergens',d.allergens) order by d.sort_order) from public.dishes d where d.restaurant_id=r.id),'[]'::jsonb)
)
from public.qr_codes q join public.restaurants r on r.id=q.restaurant_id
where q.token=p_token and q.is_active=true and r.published=true limit 1 $$;
revoke all on function public.get_public_menu(text) from public;
grant execute on function public.get_public_menu(text) to anon,authenticated;
revoke all on function public.get_my_plan() from public;
grant execute on function public.get_my_plan() to authenticated;

alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.restaurants enable row level security;
alter table public.categories enable row level security;
alter table public.dishes enable row level security;
alter table public.dish_translations enable row level security;
alter table public.qr_codes enable row level security;
alter table public.analytics_events enable row level security;

revoke all on table public.plans,public.profiles,public.subscriptions,public.restaurants,public.categories,public.dishes,public.dish_translations,public.qr_codes,public.analytics_events from anon,authenticated;
grant select on public.plans to anon,authenticated;
grant select,update on public.profiles to authenticated;
grant select on public.subscriptions to authenticated;
grant select,insert,update,delete on public.restaurants,public.categories,public.dishes,public.dish_translations,public.qr_codes to authenticated;
grant insert on public.analytics_events to anon,authenticated;
grant select on public.analytics_events to authenticated;

create policy plans_read on public.plans for select to anon,authenticated using(true);
create policy profiles_read on public.profiles for select to authenticated using((select auth.uid())=id);
create policy profiles_update on public.profiles for update to authenticated using((select auth.uid())=id) with check((select auth.uid())=id);
create policy subscriptions_read on public.subscriptions for select to authenticated using((select auth.uid())=user_id);
create policy restaurants_select on public.restaurants for select to authenticated using((select auth.uid())=owner_id);
create policy restaurants_insert on public.restaurants for insert to authenticated with check((select auth.uid())=owner_id);
create policy restaurants_update on public.restaurants for update to authenticated using((select auth.uid())=owner_id) with check((select auth.uid())=owner_id);
create policy restaurants_delete on public.restaurants for delete to authenticated using((select auth.uid())=owner_id);
create policy categories_all on public.categories for all to authenticated using(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid()))) with check(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid())));
create policy dishes_all on public.dishes for all to authenticated using(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid()))) with check(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid())));
create policy translations_all on public.dish_translations for all to authenticated using(exists(select 1 from public.dishes d join public.restaurants r on r.id=d.restaurant_id where d.id=dish_id and r.owner_id=(select auth.uid()))) with check(exists(select 1 from public.dishes d join public.restaurants r on r.id=d.restaurant_id where d.id=dish_id and r.owner_id=(select auth.uid())));
create policy qr_all on public.qr_codes for all to authenticated using(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid()))) with check(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid())));
create policy analytics_insert on public.analytics_events for insert to anon,authenticated with check(restaurant_id is null or exists(select 1 from public.restaurants r where r.id=restaurant_id and r.published=true));
create policy analytics_owner_read on public.analytics_events for select to authenticated using(exists(select 1 from public.restaurants r where r.id=restaurant_id and r.owner_id=(select auth.uid())));
