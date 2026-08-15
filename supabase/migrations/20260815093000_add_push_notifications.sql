create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create table public.push_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  race_id uuid not null references public.races(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  unique (subscription_id, race_id)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_notification_deliveries enable row level security;

create policy "owners read push subscriptions" on public.push_subscriptions
for select to authenticated using ((select auth.uid()) = user_id);
create policy "owners create push subscriptions" on public.push_subscriptions
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owners update push subscriptions" on public.push_subscriptions
for update to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy "owners delete push subscriptions" on public.push_subscriptions
for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.push_subscriptions, public.push_notification_deliveries from anon;
revoke all on public.push_notification_deliveries from authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create index push_subscriptions_user_idx on public.push_subscriptions(user_id);
create index push_deliveries_race_idx on public.push_notification_deliveries(race_id);
