create table public.bet_decisions (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references public.predictions(id) on delete cascade,
  bet_id uuid references public.bets(id) on delete set null,
  race_id uuid not null references public.races(id),
  strategy public.strategy_type not null,
  bet_type text not null,
  combination smallint[] not null,
  proposed_stake integer not null check (proposed_stake >= 0),
  final_stake integer not null default 0 check (final_stake >= 0),
  odds numeric(12,2),
  raw_probability numeric(8,7),
  calibrated_probability numeric(8,7),
  expected_value numeric(12,5),
  minimum_expected_value numeric(12,5) not null,
  data_quality numeric(8,7),
  minimum_data_quality numeric(8,7) not null,
  decision text not null check (decision in ('purchased', 'reduced', 'rejected')),
  reason_code text not null,
  reason_detail text not null,
  calibration_profile_id uuid references public.probability_calibration_profiles(id),
  created_at timestamptz not null default now()
);

create index bet_decisions_prediction_id_idx on public.bet_decisions(prediction_id);
create index bet_decisions_created_at_idx on public.bet_decisions(created_at desc);

alter table public.bet_decisions enable row level security;
create policy "owner read" on public.bet_decisions for select to authenticated
using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid())));

revoke all on public.bet_decisions from anon;
grant select on public.bet_decisions to authenticated;

comment on table public.bet_decisions is
  'Immutable audit trail of every AI bet proposal and the deterministic program decision.';
