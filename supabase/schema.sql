-- AI競馬予想・収益検証 MVP schema
create extension if not exists pgcrypto;

create type public.strategy_type as enum ('conservative','balanced','aggressive');
create type public.race_status as enum ('scheduled','running','finished','cancelled');
create type public.prediction_action as enum ('bet','skip');
create type public.bet_type as enum ('win','place','wide','quinella','exacta','trio','trifecta');
create type public.run_status as enum ('running','succeeded','failed','partial');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.races (
  id uuid primary key default gen_random_uuid(), external_id text not null unique,
  race_date date not null, track text not null, race_number smallint not null check (race_number between 1 and 12),
  race_name text not null, start_time timestamptz not null, surface text, distance smallint,
  course text, race_class text, condition text, weather text, runner_count smallint,
  status public.race_status not null default 'scheduled', source_url text not null,
  source_fetched_at timestamptz not null, source_hash text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(race_date, track, race_number)
);

create table public.horses (
  id uuid primary key default gen_random_uuid(), external_id text unique, name text not null,
  sex text, birth_year smallint, created_at timestamptz not null default now()
);

create table public.race_entries (
  id uuid primary key default gen_random_uuid(), race_id uuid not null references public.races(id) on delete cascade,
  horse_id uuid not null references public.horses(id), horse_number smallint not null, gate_number smallint,
  jockey text, trainer text, weight_carried numeric(4,1), horse_weight smallint, horse_weight_delta smallint,
  win_odds numeric(10,2), place_odds_low numeric(10,2), place_odds_high numeric(10,2), popularity smallint,
  running_style text, source_data jsonb not null default '{}'::jsonb, raw_data jsonb not null default '{}'::jsonb,
  unique(race_id, horse_number), unique(race_id, horse_id)
);

create table public.past_runs (
  id uuid primary key default gen_random_uuid(), horse_id uuid not null references public.horses(id),
  race_date date not null, track text, race_name text, race_class text, surface text, distance smallint,
  condition text, finish_position smallint, popularity smallint, odds numeric(10,2), finish_time text,
  last3f numeric(4,1), margin text, jockey text, weight_carried numeric(4,1), horse_weight smallint,
  runner_count smallint, source_hash text not null, raw_data jsonb not null default '{}'::jsonb,
  unique(horse_id, race_date, track, race_name)
);

create table public.batch_runs (
  id uuid primary key default gen_random_uuid(), target_date date not null, status public.run_status not null default 'running',
  parser_version text not null, started_at timestamptz not null default now(), finished_at timestamptz,
  races_fetched integer not null default 0, api_requests integer not null default 0,
  error_message text, metadata jsonb not null default '{}'::jsonb
);

create table public.ai_calls (
  id uuid primary key default gen_random_uuid(), batch_run_id uuid references public.batch_runs(id),
  purpose text not null check (purpose in ('screening','prediction')), strategy public.strategy_type,
  provider text not null default 'google', model text not null default 'gemini-3.6-flash',
  prompt_version text not null, input_hash text not null, output_hash text,
  request_json jsonb not null, response_json jsonb, input_tokens integer, output_tokens integer,
  status text not null, requested_at timestamptz not null default now(), completed_at timestamptz,
  error_message text
);

create table public.race_selections (
  id uuid primary key default gen_random_uuid(), batch_run_id uuid not null references public.batch_runs(id),
  race_id uuid not null references public.races(id), strategy public.strategy_type not null,
  score smallint not null check(score between 0 and 100), reason text not null,
  rank smallint not null check(rank between 1 and 3), ai_call_id uuid not null references public.ai_calls(id),
  created_at timestamptz not null default now(), unique(batch_run_id,strategy,rank), unique(batch_run_id,strategy,race_id)
);

create table public.predictions (
  id uuid primary key default gen_random_uuid(), race_id uuid not null references public.races(id),
  strategy public.strategy_type not null, ai_call_id uuid not null references public.ai_calls(id),
  action public.prediction_action not null, confidence smallint not null check(confidence between 0 and 100),
  reason text not null, input_hash text not null, prediction_hash text not null,
  predicted_at timestamptz not null, locked_at timestamptz not null default now(), raw_response jsonb not null,
  unique(race_id,strategy,predicted_at)
);

create table public.bets (
  id uuid primary key default gen_random_uuid(), prediction_id uuid not null references public.predictions(id),
  race_id uuid not null references public.races(id), strategy public.strategy_type not null,
  bet_type public.bet_type not null, combination smallint[] not null, stake integer not null check(stake > 0 and stake % 100 = 0),
  odds_at_prediction numeric(12,2), estimated_probability numeric(8,7) check(estimated_probability between 0 and 1),
  expected_value numeric(12,5), reason text, stake_reason text,
  created_at timestamptz not null default now()
);

create table public.race_results (
  race_id uuid primary key references public.races(id), finish_order smallint[] not null,
  result_json jsonb not null, confirmed_at timestamptz not null, source_hash text not null
);

create table public.payouts (
  id uuid primary key default gen_random_uuid(), race_id uuid not null references public.races(id),
  bet_type public.bet_type not null, combination smallint[] not null, payout_per_100 integer not null check(payout_per_100 >= 0),
  is_refund boolean not null default false, unique(race_id,bet_type,combination)
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(), bet_id uuid not null unique references public.bets(id),
  stake integer not null, return_amount integer not null default 0, profit integer generated always as (return_amount-stake) stored,
  is_hit boolean not null, settled_at timestamptz not null default now()
);

create table public.strategy_accounts (
  strategy public.strategy_type primary key, initial_balance integer not null default 100000,
  current_balance integer not null default 100000, total_staked bigint not null default 0,
  total_returned bigint not null default 0, minimum_balance integer not null default 100000,
  updated_at timestamptz not null default now()
);
insert into public.strategy_accounts(strategy) values ('conservative'),('balanced'),('aggressive');

create table public.evaluation_weight_profiles (
  id uuid primary key default gen_random_uuid(), ability_weight numeric(5,4) not null,
  suitability_weight numeric(5,4) not null, condition_weight numeric(5,4) not null,
  race_context_weight numeric(5,4) not null, sample_size integer not null default 0,
  training_brier numeric(10,8), validation_brier numeric(10,8), improvement numeric(10,8),
  is_active boolean not null default false, created_at timestamptz not null default now(),
  check (abs(ability_weight+suitability_weight+condition_weight+race_context_weight-1)<0.0001)
);
create unique index evaluation_weight_profiles_one_active_idx on public.evaluation_weight_profiles(is_active) where is_active;
insert into public.evaluation_weight_profiles(ability_weight,suitability_weight,condition_weight,race_context_weight,sample_size,is_active) values(0.4,0.3,0.2,0.1,0,true);

create table public.horse_evaluation_snapshots (
  race_id uuid not null references public.races(id) on delete cascade,
  horse_id uuid not null references public.horses(id) on delete cascade, horse_number smallint not null,
  ability_score numeric(6,2) not null, suitability_score numeric(6,2) not null,
  condition_score numeric(6,2) not null, race_context_score numeric(6,2) not null,
  overall_score numeric(6,2) not null, estimated_win_probability numeric(8,7) not null,
  data_quality numeric(5,4) not null, features jsonb not null,
  weight_profile_id uuid not null references public.evaluation_weight_profiles(id),
  actual_finish_position smallint, is_winner boolean, predicted_at timestamptz not null default now(),
  evaluated_at timestamptz, primary key(race_id,horse_id)
);
create index horse_evaluation_snapshots_result_idx on public.horse_evaluation_snapshots(race_id,is_winner) where is_winner is not null;
create index horse_evaluation_snapshots_horse_id_idx on public.horse_evaluation_snapshots(horse_id);
create index horse_evaluation_snapshots_weight_profile_id_idx on public.horse_evaluation_snapshots(weight_profile_id);

create table public.app_settings (
  id boolean primary key default true check(id), model text not null default 'gemini-3.6-flash',
  run_time_local time not null default '07:00', timezone text not null default 'Asia/Tokyo',
  max_races_per_strategy smallint not null default 3 check(max_races_per_strategy between 0 and 3),
  daily_api_limit smallint not null default 20 check(daily_api_limit between 1 and 20), parser_version text not null default 'jra-netkeiba-v1', updated_at timestamptz not null default now()
);
insert into public.app_settings(id) values(true);

-- Read access is owner-only. Batch writes use a secret key inside Edge Functions.
alter table public.profiles enable row level security;
alter table public.races enable row level security; alter table public.horses enable row level security;
alter table public.race_entries enable row level security; alter table public.past_runs enable row level security;
alter table public.batch_runs enable row level security; alter table public.ai_calls enable row level security;
alter table public.race_selections enable row level security; alter table public.predictions enable row level security;
alter table public.bets enable row level security; alter table public.race_results enable row level security;
alter table public.payouts enable row level security; alter table public.settlements enable row level security;
alter table public.strategy_accounts enable row level security; alter table public.app_settings enable row level security;
alter table public.evaluation_weight_profiles enable row level security; alter table public.horse_evaluation_snapshots enable row level security;

create policy "profile owner" on public.profiles for select to authenticated using ((select auth.uid())=user_id);
do $$ declare t text; begin
  foreach t in array array['races','horses','race_entries','past_runs','batch_runs','ai_calls','race_selections','predictions','bets','race_results','payouts','settlements','strategy_accounts','app_settings']
  loop execute format('create policy "owner read" on public.%I for select to authenticated using (exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))',t); end loop;
end $$;
create policy "owner read" on public.evaluation_weight_profiles for select to authenticated using (exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));
create policy "owner read" on public.horse_evaluation_snapshots for select to authenticated using (exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

create index ai_calls_batch_run_id_idx on public.ai_calls(batch_run_id);
create index ai_calls_requested_at_idx on public.ai_calls(requested_at);
create index bets_prediction_id_idx on public.bets(prediction_id);
create index bets_race_id_idx on public.bets(race_id);
create index predictions_ai_call_id_idx on public.predictions(ai_call_id);
create index race_entries_horse_id_idx on public.race_entries(horse_id);
create index race_selections_ai_call_id_idx on public.race_selections(ai_call_id);
create index race_selections_race_id_idx on public.race_selections(race_id);

-- Immutable prediction ledger: normal clients receive no insert/update/delete grants.
-- Admin batch code must reject a second prediction after race start and write hashes before insertion.
