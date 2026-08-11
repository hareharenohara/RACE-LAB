create table public.prediction_integration_test_runs (
  id uuid primary key default gen_random_uuid(),
  batch_run_id uuid not null references public.batch_runs(id) on delete cascade,
  race_id uuid not null references public.races(id) on delete cascade,
  ai_call_id uuid not null references public.ai_calls(id) on delete restrict,
  available_balance integer not null check (available_balance >= 0),
  rollover_state jsonb,
  input_payload jsonb not null,
  decision jsonb not null,
  validation_errors text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique(batch_run_id,race_id)
);

create index prediction_integration_test_runs_race_idx
  on public.prediction_integration_test_runs(race_id);
create index prediction_integration_test_runs_ai_call_idx
  on public.prediction_integration_test_runs(ai_call_id);

alter table public.prediction_integration_test_runs enable row level security;
create policy "owner read" on public.prediction_integration_test_runs
for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));

revoke all on public.prediction_integration_test_runs from anon;
grant select on public.prediction_integration_test_runs to authenticated;

comment on table public.prediction_integration_test_runs is
  'Isolated Gemini end-to-end test outputs. Never creates bets or changes paper balances.';
