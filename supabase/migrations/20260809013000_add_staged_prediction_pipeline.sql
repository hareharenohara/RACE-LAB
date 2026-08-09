update public.app_settings
set model = 'gemini-3.6-flash', daily_api_limit = 10, updated_at = now()
where id = true;

alter table public.app_settings
  alter column model set default 'gemini-3.6-flash',
  alter column daily_api_limit set default 10;

alter table public.ai_calls drop constraint if exists ai_calls_purpose_check;
alter table public.ai_calls
  add constraint ai_calls_purpose_check
  check (purpose in ('screening','prediction','audit'));

alter table public.predictions
  add column if not exists batch_run_id uuid references public.batch_runs(id);

create unique index if not exists predictions_batch_strategy_race_idx
  on public.predictions(batch_run_id,strategy,race_id)
  where batch_run_id is not null;

