revoke execute
  on function public.get_public_restaurant_promotions(uuid)
  from public, anon, authenticated;
