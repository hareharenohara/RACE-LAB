create table public.evaluation_weight_profiles (
  id uuid primary key default gen_random_uuid(),
  ability_weight numeric(5,4) not null,
  suitability_weight numeric(5,4) not null,
  condition_weight numeric(5,4) not null,
  race_context_weight numeric(5,4) not null,
  sample_size integer not null default 0,
  training_brier numeric(10,8),
  validation_brier numeric(10,8),
  improvement numeric(10,8),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  check (abs(ability_weight + suitability_weight + condition_weight + race_context_weight - 1) < 0.0001)
);

create unique index evaluation_weight_profiles_one_active_idx
  on public.evaluation_weight_profiles (is_active) where is_active;

insert into public.evaluation_weight_profiles (
  ability_weight, suitability_weight, condition_weight, race_context_weight,
  sample_size, is_active
) values (0.4, 0.3, 0.2, 0.1, 0, true);

create table public.horse_evaluation_snapshots (
  race_id uuid not null references public.races(id) on delete cascade,
  horse_id uuid not null references public.horses(id) on delete cascade,
  horse_number smallint not null,
  ability_score numeric(6,2) not null,
  suitability_score numeric(6,2) not null,
  condition_score numeric(6,2) not null,
  race_context_score numeric(6,2) not null,
  overall_score numeric(6,2) not null,
  estimated_win_probability numeric(8,7) not null,
  data_quality numeric(5,4) not null,
  features jsonb not null,
  weight_profile_id uuid not null references public.evaluation_weight_profiles(id),
  actual_finish_position smallint,
  is_winner boolean,
  predicted_at timestamptz not null default now(),
  evaluated_at timestamptz,
  primary key (race_id, horse_id)
);

create index horse_evaluation_snapshots_result_idx
  on public.horse_evaluation_snapshots (race_id, is_winner)
  where is_winner is not null;

alter table public.evaluation_weight_profiles enable row level security;
alter table public.horse_evaluation_snapshots enable row level security;

create policy "owner read" on public.evaluation_weight_profiles
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid())));
create policy "owner read" on public.horse_evaluation_snapshots
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid())));

revoke all on public.evaluation_weight_profiles from anon;
revoke all on public.horse_evaluation_snapshots from anon;
grant select on public.evaluation_weight_profiles to authenticated;
grant select on public.horse_evaluation_snapshots to authenticated;
