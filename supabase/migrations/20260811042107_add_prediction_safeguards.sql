-- Immutable evidence captured before a race starts. Raw HTML is intentionally
-- not retained here; extracted facts plus a content hash are sufficient to
-- reproduce the exact payload sent to the model without exhausting DB space.
create table public.source_data_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_run_id uuid references public.batch_runs(id) on delete set null,
  race_id uuid not null references public.races(id) on delete cascade,
  stage text not null check (stage in ('screening','final')),
  source_name text not null,
  source_url text not null,
  captured_at timestamptz not null,
  content_hash text not null,
  parser_version text not null,
  identity_status text not null check (identity_status in ('verified','partial','failed')),
  extracted_data jsonb not null,
  created_at timestamptz not null default now(),
  unique (race_id,stage,source_name,captured_at)
);

create table public.entry_identity_checks (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.source_data_snapshots(id) on delete cascade,
  race_id uuid not null references public.races(id) on delete cascade,
  horse_id uuid references public.horses(id),
  horse_number smallint not null,
  source_horse_name text not null,
  canonical_horse_name text,
  source_external_id text,
  canonical_external_id text,
  match_status text not null check (match_status in ('exact','normalized','mismatch')),
  mismatch_reason text,
  checked_at timestamptz not null default now(),
  unique (snapshot_id,horse_number)
);

-- Market observations are separate from final payouts. A place or wide quote
-- may contain a range, while payouts store the single confirmed amount per 100.
create table public.market_odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_run_id uuid references public.batch_runs(id) on delete set null,
  race_id uuid not null references public.races(id) on delete cascade,
  bet_type public.bet_type not null check (bet_type in ('win','place','wide')),
  combination smallint[] not null,
  odds_low numeric(12,2) not null check (odds_low > 0),
  odds_high numeric(12,2) check (odds_high is null or odds_high >= odds_low),
  source_name text not null,
  source_url text not null,
  captured_at timestamptz not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (race_id,bet_type,combination,source_name,captured_at)
);

alter table public.bets
  add column market_snapshot_id uuid references public.market_odds_snapshots(id);

alter table public.ai_calls
  add column input_schema_version text not null default 'legacy-v1',
  add column generation_config jsonb not null default '{}'::jsonb,
  add column evidence_manifest jsonb not null default '{}'::jsonb;

-- Open reservations make available balance explicit and prevent two unsettled
-- races from spending the same paper funds.
create table public.paper_fund_reservations (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null unique references public.bets(id) on delete restrict,
  strategy public.strategy_type not null,
  amount integer not null check (amount > 0 and amount % 100 = 0),
  status text not null default 'open' check (status in ('open','settled','released')),
  reserved_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'open' and closed_at is null) or (status <> 'open' and closed_at is not null))
);

create index source_data_snapshots_race_idx on public.source_data_snapshots(race_id,captured_at desc);
create index source_data_snapshots_batch_idx on public.source_data_snapshots(batch_run_id);
create index entry_identity_checks_race_idx on public.entry_identity_checks(race_id,horse_number);
create index market_odds_snapshots_race_idx on public.market_odds_snapshots(race_id,captured_at desc);
create index market_odds_snapshots_batch_idx on public.market_odds_snapshots(batch_run_id);
create index bets_market_snapshot_idx on public.bets(market_snapshot_id);
create index paper_fund_reservations_open_idx on public.paper_fund_reservations(strategy,reserved_at) where status='open';

create or replace function public.reject_snapshot_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using message='IMMUTABLE_SNAPSHOT',errcode='P0001';
end;
$$;

create trigger source_data_snapshots_immutable
before update or delete on public.source_data_snapshots
for each row execute function public.reject_snapshot_mutation();

create trigger entry_identity_checks_immutable
before update or delete on public.entry_identity_checks
for each row execute function public.reject_snapshot_mutation();

create trigger market_odds_snapshots_immutable
before update or delete on public.market_odds_snapshots
for each row execute function public.reject_snapshot_mutation();

revoke all on function public.reject_snapshot_mutation() from public,anon,authenticated;

create or replace function public.available_paper_balance(p_strategy public.strategy_type)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select greatest(0,a.current_balance-coalesce(sum(r.amount) filter (where r.status='open'),0))::integer
  from public.strategy_accounts a
  left join public.paper_fund_reservations r on r.strategy=a.strategy
  where a.strategy=p_strategy
  group by a.current_balance;
$$;

create or replace function public.create_reserved_paper_bet(
  p_prediction_id uuid,
  p_race_id uuid,
  p_strategy public.strategy_type,
  p_bet_type public.bet_type,
  p_combination smallint[],
  p_stake integer,
  p_market_snapshot_id uuid,
  p_odds_at_prediction numeric,
  p_raw_estimated_probability numeric,
  p_estimated_probability numeric,
  p_expected_value numeric,
  p_reason text,
  p_stake_reason text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bet_id uuid;
  v_balance integer;
  v_reserved bigint;
begin
  if p_stake<=0 or p_stake%100<>0 then
    raise exception using message='INVALID_STAKE',errcode='P0001';
  end if;
  if p_market_snapshot_id is null then
    raise exception using message='MARKET_SNAPSHOT_REQUIRED',errcode='P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('paper-funds:'||p_strategy::text));
  select current_balance into v_balance from public.strategy_accounts where strategy=p_strategy for update;
  if v_balance is null then raise exception using message='ACCOUNT_NOT_FOUND',errcode='P0001'; end if;
  select coalesce(sum(amount),0) into v_reserved from public.paper_fund_reservations
  where strategy=p_strategy and status='open';
  if v_balance-v_reserved<p_stake then
    raise exception using message='INSUFFICIENT_AVAILABLE_BALANCE',errcode='P0001';
  end if;
  if not exists (
    select 1 from public.predictions
    where id=p_prediction_id and race_id=p_race_id and strategy=p_strategy and action='bet'
  ) then raise exception using message='PREDICTION_MISMATCH',errcode='P0001'; end if;
  if not exists (
    select 1 from public.market_odds_snapshots
    where id=p_market_snapshot_id and race_id=p_race_id and bet_type=p_bet_type and combination=p_combination
  ) then raise exception using message='MARKET_SNAPSHOT_MISMATCH',errcode='P0001'; end if;

  insert into public.bets(
    prediction_id,race_id,strategy,bet_type,combination,stake,
    market_snapshot_id,odds_at_prediction,raw_estimated_probability,
    estimated_probability,expected_value,reason,stake_reason
  ) values (
    p_prediction_id,p_race_id,p_strategy,p_bet_type,p_combination,p_stake,
    p_market_snapshot_id,p_odds_at_prediction,p_raw_estimated_probability,
    p_estimated_probability,p_expected_value,p_reason,p_stake_reason
  ) returning id into v_bet_id;
  insert into public.paper_fund_reservations(bet_id,strategy,amount)
  values(v_bet_id,p_strategy,p_stake);
  return v_bet_id;
end;
$$;

create or replace function public.settle_paper_bet(
  p_bet_id uuid,
  p_return_amount integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bet public.bets%rowtype;
  v_balance integer;
begin
  if p_return_amount<0 then raise exception using message='INVALID_RETURN',errcode='P0001'; end if;
  select * into v_bet from public.bets where id=p_bet_id;
  if not found then raise exception using message='BET_NOT_FOUND',errcode='P0001'; end if;
  if exists(select 1 from public.settlements where bet_id=p_bet_id) then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('paper-funds:'||v_bet.strategy::text));
  select current_balance into v_balance from public.strategy_accounts where strategy=v_bet.strategy for update;
  insert into public.settlements(bet_id,stake,return_amount,is_hit)
  values(v_bet.id,v_bet.stake,p_return_amount,p_return_amount>0);
  update public.strategy_accounts set
    current_balance=v_balance-v_bet.stake+p_return_amount,
    total_staked=total_staked+v_bet.stake,
    total_returned=total_returned+p_return_amount,
    minimum_balance=least(minimum_balance,v_balance-v_bet.stake+p_return_amount),
    updated_at=now()
  where strategy=v_bet.strategy;
  update public.paper_fund_reservations set status='settled',closed_at=now()
  where bet_id=v_bet.id and status='open';
end;
$$;

alter table public.source_data_snapshots enable row level security;
alter table public.entry_identity_checks enable row level security;
alter table public.market_odds_snapshots enable row level security;
alter table public.paper_fund_reservations enable row level security;

create policy "owner read" on public.source_data_snapshots for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
create policy "owner read" on public.entry_identity_checks for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
create policy "owner read" on public.market_odds_snapshots for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));
create policy "owner read" on public.paper_fund_reservations for select to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid())));

revoke all on public.source_data_snapshots,public.entry_identity_checks,public.market_odds_snapshots,public.paper_fund_reservations from anon;
grant select on public.source_data_snapshots,public.entry_identity_checks,public.market_odds_snapshots,public.paper_fund_reservations to authenticated;
revoke all on function public.available_paper_balance(public.strategy_type) from public,anon,authenticated;
revoke all on function public.create_reserved_paper_bet(uuid,uuid,public.strategy_type,public.bet_type,smallint[],integer,uuid,numeric,numeric,numeric,numeric,text,text) from public,anon,authenticated;
revoke all on function public.settle_paper_bet(uuid,integer) from public,anon,authenticated;
grant execute on function public.available_paper_balance(public.strategy_type) to service_role;
grant execute on function public.create_reserved_paper_bet(uuid,uuid,public.strategy_type,public.bet_type,smallint[],integer,uuid,numeric,numeric,numeric,numeric,text,text) to service_role;
grant execute on function public.settle_paper_bet(uuid,integer) to service_role;
