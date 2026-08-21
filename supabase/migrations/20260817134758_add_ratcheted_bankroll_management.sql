create table public.daily_bankroll_states (
  id uuid primary key default gen_random_uuid(),
  strategy public.strategy_type not null,
  session_date date not null,
  opening_balance integer not null check (opening_balance > 0),
  peak_balance integer not null check (peak_balance > 0),
  loss_floor integer not null check (loss_floor >= 0),
  lock_balance integer not null check (lock_balance >= 0),
  peak_profit_rate numeric(10,7) not null default 0,
  lock_profit_rate numeric(10,7) not null default 0,
  mode text not null default 'normal' check (mode in ('normal','attack','locked')),
  target_profit_rate numeric(10,7) not null default 0.0225,
  maximum_loss_rate numeric(10,7) not null default 0.035,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy,session_date),
  check (peak_balance >= opening_balance),
  check (lock_balance >= loss_floor)
);

alter table public.race_pipeline_items
  add column budget_weight smallint check (budget_weight between 1 and 100),
  add column initial_budget integer check (initial_budget >= 0 and initial_budget % 100 = 0),
  add column final_budget integer check (final_budget >= 0 and final_budget % 100 = 0),
  add column budget_mode text check (budget_mode in ('normal','attack','locked'));

alter table public.market_odds_snapshots
  drop constraint if exists market_odds_snapshots_bet_type_check;
alter table public.market_odds_snapshots
  add constraint market_odds_snapshots_bet_type_check
  check (bet_type in ('win','place','wide','quinella'));

create index daily_bankroll_states_date_idx
  on public.daily_bankroll_states(session_date desc,strategy);

alter table public.daily_bankroll_states enable row level security;
create policy "owner read" on public.daily_bankroll_states for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
revoke all on public.daily_bankroll_states from anon;
grant select on public.daily_bankroll_states to authenticated;

create or replace function public.enforce_daily_bankroll_floor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session_date date;
  v_balance integer;
  v_reserved bigint;
  v_floor integer;
begin
  select br.target_date into v_session_date
  from public.bets b
  join public.predictions p on p.id=b.prediction_id
  join public.batch_runs br on br.id=p.batch_run_id
  where b.id=new.bet_id;

  select current_balance into v_balance
  from public.strategy_accounts
  where strategy=new.strategy
  for update;

  select greatest(loss_floor,lock_balance) into v_floor
  from public.daily_bankroll_states
  where strategy=new.strategy and session_date=v_session_date;

  if v_floor is null then
    raise exception using message='DAILY_BANKROLL_STATE_REQUIRED',errcode='P0001';
  end if;

  select coalesce(sum(amount),0) into v_reserved
  from public.paper_fund_reservations
  where strategy=new.strategy and status='open';

  if v_balance-v_reserved-new.amount<v_floor then
    raise exception using message='DAILY_BANKROLL_FLOOR_EXCEEDED',errcode='P0001';
  end if;
  return new;
end;
$$;

create trigger paper_fund_reservations_daily_floor
before insert on public.paper_fund_reservations
for each row execute function public.enforce_daily_bankroll_floor();

revoke all on function public.enforce_daily_bankroll_floor() from public,anon,authenticated;
