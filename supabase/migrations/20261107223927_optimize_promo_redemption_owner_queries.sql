create index if not exists payment_events_user_id_idx
  on public.payment_events (user_id);

create index if not exists promo_redemptions_user_id_idx
  on public.promo_redemptions (user_id);

drop policy if exists "promo redemptions owner only"
  on public.promo_redemptions;

create policy "promo redemptions owner only"
  on public.promo_redemptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
