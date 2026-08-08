update public.app_settings
set daily_api_limit = 20,
    updated_at = now()
where id = true;

alter table public.app_settings
  alter column daily_api_limit set default 20;

alter table public.app_settings
  add constraint app_settings_daily_api_limit_check
  check (daily_api_limit between 1 and 20);

create unique index batch_runs_one_running_per_target_idx
  on public.batch_runs (target_date, parser_version)
  where status = 'running';

create index if not exists ai_calls_requested_at_idx
  on public.ai_calls (requested_at);

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
  minute_count integer;
  jst_day_start timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('race-lab-ai-api-quota'));

  select least(daily_api_limit, 20)
    into daily_limit
    from public.app_settings
    where id = true;

  daily_limit := coalesce(daily_limit, 20);
  jst_day_start := pg_catalog.date_trunc('day', pg_catalog.timezone('Asia/Tokyo', pg_catalog.now()))
    at time zone 'Asia/Tokyo';

  select count(*)
    into daily_count
    from public.ai_calls
    where requested_at >= jst_day_start;

  if daily_count >= daily_limit then
    raise exception using message = 'AI_DAILY_LIMIT_REACHED', errcode = 'P0001';
  end if;

  select count(*)
    into minute_count
    from public.ai_calls
    where requested_at >= pg_catalog.now() - interval '1 minute';

  if minute_count >= 5 then
    raise exception using message = 'AI_MINUTE_LIMIT_REACHED', errcode = 'P0001';
  end if;

  insert into public.ai_calls (
    batch_run_id, purpose, strategy, provider, model, prompt_version,
    input_hash, request_json, status
  ) values (
    p_batch_run_id, p_purpose, p_strategy, 'google', p_model,
    p_prompt_version, p_input_hash, p_request_json, 'running'
  )
  returning id into call_id;

  return call_id;
end;
$$;

revoke all on function public.reserve_ai_call(uuid, text, public.strategy_type, text, text, text, jsonb) from public;
revoke all on function public.reserve_ai_call(uuid, text, public.strategy_type, text, text, text, jsonb) from anon;
revoke all on function public.reserve_ai_call(uuid, text, public.strategy_type, text, text, text, jsonb) from authenticated;
grant execute on function public.reserve_ai_call(uuid, text, public.strategy_type, text, text, text, jsonb) to service_role;
