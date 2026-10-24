create or replace function private.get_public_menu(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  r public.restaurants;
  result jsonb;
  v_plan_id text := 'free';
  v_allergens_enabled boolean := false;
begin
  select rr.* into r
  from public.restaurants rr
  join public.qr_codes q on q.restaurant_id=rr.id
  where q.token=p_token and q.is_active=true and rr.published=true
  limit 1;

  if not found then
    select rr.* into r
    from public.restaurants rr
    where rr.slug=p_token and rr.published=true
    limit 1;
  end if;
  if not found then return null; end if;

  select coalesce((
    select s.plan_id from public.subscriptions s
    where s.user_id=r.owner_id and s.status in ('trialing','active','past_due')
    limit 1
  ),'free') into v_plan_id;

  select coalesce(p.allergens,false) into v_allergens_enabled
  from public.plans p where p.id=v_plan_id;

  select jsonb_build_object(
    'restaurant',jsonb_build_object(
      'id',r.id,'name',r.name,'slug',r.slug,'logo_url',r.logo_url,
      'address',r.address,'phone',r.phone,'description',r.description,
      'website',r.website,'instagram',r.instagram,'facebook',r.facebook,
      'hours',r.hours,'default_locale',r.default_locale,'plan_id',v_plan_id
    ),
    'categories',coalesce((
      select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort_order',c.sort_order) order by c.sort_order,c.created_at)
      from public.categories c where c.restaurant_id=r.id and c.is_active=true
    ),'[]'::jsonb),
    'dishes',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',d.id,'category_id',d.category_id,'name',d.name,'description',d.description,
        'price_cents',d.price_cents,'currency',d.currency,'image_url',d.image_url,
        'is_available',d.is_available,'sort_order',d.sort_order,
        'discount_percent',d.discount_percent,'discount_cents',d.discount_cents,
        'allergens',case when v_allergens_enabled then coalesce(d.allergens,array[]::text[]) else array[]::text[] end
      ) order by d.sort_order,d.created_at)
      from public.dishes d where d.restaurant_id=r.id
    ),'[]'::jsonb),
    'promotions',case when v_plan_id='business' then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',promo.id,'title',promo.title,'description',promo.description,
        'discount_percent',promo.discount_percent,'discount_cents',promo.discount_cents,
        'starts_at',promo.starts_at,'ends_at',promo.ends_at
      ) order by promo.created_at desc)
      from public.restaurant_promotions promo
      where promo.restaurant_id=r.id and promo.is_active
        and (promo.starts_at is null or promo.starts_at<=now())
        and (promo.ends_at is null or promo.ends_at>now())
    ),'[]'::jsonb) else '[]'::jsonb end
  ) into result;

  return result;
end;
$function$;
