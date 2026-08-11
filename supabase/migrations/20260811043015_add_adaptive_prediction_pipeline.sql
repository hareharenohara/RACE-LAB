create table public.race_pipeline_items (
  id uuid primary key default gen_random_uuid(),
  batch_run_id uuid not null references public.batch_runs(id) on delete cascade,
  race_id uuid not null references public.races(id) on delete cascade,
  state text not null default 'stage1_pending' check (state in (
    'stage1_pending','stage1_rejected','evidence_pending','evidence_ready',
    'evidence_insufficient','selected','not_selected','final_refresh_pending',
    'final_decided','invalid_output','completed','failed'
  )),
  stage1_reasons text[] not null default '{}',
  evidence jsonb not null default '[]'::jsonb,
  evidence_quality jsonb not null default '{}'::jsonb,
  selection_rank smallint,
  selection_reason text,
  final_attempts smallint not null default 0,
  next_action_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_run_id,race_id)
);

create index race_pipeline_items_work_idx on public.race_pipeline_items(state,next_action_at);
create index race_pipeline_items_batch_idx on public.race_pipeline_items(batch_run_id,state);

create table public.rollover_states (
  strategy public.strategy_type primary key,
  pending_amount integer not null default 0 check (pending_amount >= 0 and pending_amount % 100 = 0),
  source_bet_id uuid references public.bets(id),
  consecutive_hits integer not null default 0 check (consecutive_hits >= 0),
  updated_at timestamptz not null default now()
);
insert into public.rollover_states(strategy) values ('single') on conflict do nothing;

alter table public.race_pipeline_items enable row level security;
alter table public.rollover_states enable row level security;
create policy "owner read" on public.race_pipeline_items for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
create policy "owner read" on public.rollover_states for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
revoke all on public.race_pipeline_items,public.rollover_states from anon;
grant select on public.race_pipeline_items,public.rollover_states to authenticated;

comment on table public.race_pipeline_items is 'Adaptive v2 per-race workflow state. Program state controls data collection, never wagering merit.';
