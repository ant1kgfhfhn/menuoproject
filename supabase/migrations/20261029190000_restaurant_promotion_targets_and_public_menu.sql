alter table public.restaurant_promotions
  add column if not exists promotion_group_id uuid;

create index if not exists restaurant_promotions_group_id_idx
  on public.restaurant_promotions (promotion_group_id);

create or replace function public.get_public_restaurant_promotions(p_restaurant_id uuid)
returns table (
  id uuid,
  restaurant_id uuid,
  title text,
  description text,
  discount_percent integer,
  discount_cents integer,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean,
  promotion_group_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.restaurant_id, p.title, p.description,
         p.discount_percent, p.discount_cents, p.starts_at, p.ends_at,
         p.is_active, p.promotion_group_id
  from public.restaurant_promotions p
  where p.restaurant_id = p_restaurant_id
    and p.is_active = true
    and (p.starts_at is null or p.starts_at <= now())
    and (p.ends_at is null or p.ends_at > now())
  order by p.created_at desc;
$$;

revoke all on function public.get_public_restaurant_promotions(uuid) from public;
grant execute on function public.get_public_restaurant_promotions(uuid) to anon, authenticated;
