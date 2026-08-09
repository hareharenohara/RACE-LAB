-- Remove the obsolete three-personality prediction ledger. Race, horse,
-- evaluation and result source data are intentionally retained.
delete from public.bet_decisions
where strategy in ('conservative','balanced','aggressive');
delete from public.settlements
where bet_id in (
  select id from public.bets
  where strategy in ('conservative','balanced','aggressive')
);
delete from public.bets
where strategy in ('conservative','balanced','aggressive');
delete from public.predictions
where strategy in ('conservative','balanced','aggressive');
delete from public.race_selections
where strategy in ('conservative','balanced','aggressive');
delete from public.ai_calls
where strategy in ('conservative','balanced','aggressive');
delete from public.probability_calibration_profiles
where strategy in ('conservative','balanced','aggressive');
delete from public.strategy_accounts
where strategy in ('conservative','balanced','aggressive');

insert into public.strategy_accounts(
  strategy,initial_balance,current_balance,minimum_balance,total_staked,total_returned
) values ('single',100000,100000,100000,0,0);

update public.app_settings
set daily_api_limit=20, updated_at=now()
where id=true;

create or replace function public.reserve_ai_call(
  p_batch_run_id uuid,
  p_purpose text,
  p_strategy public.strategy_type,
  p_model text,
  p_prompt_version text,
  p_input_hash text,
  p_request_json jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  call_id uuid;
  daily_limit integer;
  daily_count integer;
  batch_count integer;
  minute_count integer;
  jst_day_start timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('race-lab-ai-api-quota'));
  select least(daily_api_limit,20) into daily_limit from public.app_settings where id=true;
  daily_limit := coalesce(daily_limit,20);
  jst_day_start := pg_catalog.date_trunc('day',pg_catalog.timezone('Asia/Tokyo',pg_catalog.now())) at time zone 'Asia/Tokyo';

  select count(*) into daily_count from public.ai_calls
  where requested_at>=jst_day_start and model=p_model;
  if daily_count>=daily_limit then
    raise exception using message='AI_MODEL_DAILY_LIMIT_REACHED',errcode='P0001';
  end if;

  select count(*) into batch_count from public.ai_calls where batch_run_id=p_batch_run_id;
  if batch_count>=15 then
    raise exception using message='AI_BATCH_LIMIT_REACHED',errcode='P0001';
  end if;

  select count(*) into minute_count from public.ai_calls
  where requested_at>=pg_catalog.now()-interval '1 minute' and model=p_model;
  if minute_count>=5 then
    raise exception using message='AI_MINUTE_LIMIT_REACHED',errcode='P0001';
  end if;

  insert into public.ai_calls(
    batch_run_id,purpose,strategy,provider,model,prompt_version,
    input_hash,request_json,status
  ) values (
    p_batch_run_id,p_purpose,p_strategy,'google',p_model,p_prompt_version,
    p_input_hash,p_request_json,'running'
  ) returning id into call_id;
  return call_id;
end;
$$;

revoke all on function public.reserve_ai_call(uuid,text,public.strategy_type,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_ai_call(uuid,text,public.strategy_type,text,text,text,jsonb) to service_role;
