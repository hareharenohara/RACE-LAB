create table public.probability_calibration_profiles (
  id uuid primary key default gen_random_uuid(), strategy public.strategy_type not null,
  bet_type public.bet_type not null, bins jsonb not null, sample_size integer not null,
  baseline_brier numeric(10,8) not null, validation_brier numeric(10,8) not null,
  improvement numeric(10,8) not null, is_active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index probability_calibration_one_active_idx on public.probability_calibration_profiles(strategy,bet_type) where is_active;
alter table public.bets add column raw_estimated_probability numeric(8,7), add column calibration_profile_id uuid references public.probability_calibration_profiles(id);
create index bets_calibration_profile_id_idx on public.bets(calibration_profile_id);
alter table public.probability_calibration_profiles enable row level security;
create policy "owner read" on public.probability_calibration_profiles for select to authenticated using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
revoke all on public.probability_calibration_profiles from anon;
grant select on public.probability_calibration_profiles to authenticated;
