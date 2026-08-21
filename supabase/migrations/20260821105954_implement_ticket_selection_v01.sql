alter table public.bet_decisions
  add column confidence_grade text
    check (confidence_grade is null or confidence_grade in ('S','A','B','C')),
  add column ticket_score numeric(12,5),
  add column odds_high numeric(12,2);

drop function if exists public.finalize_prediction_decision(
  uuid,uuid,uuid,public.strategy_type,uuid,public.prediction_action,smallint,
  text,text,text,timestamptz,jsonb,jsonb
);

create function public.finalize_prediction_decision(
  p_pipeline_item_id uuid,
  p_batch_run_id uuid,
  p_race_id uuid,
  p_strategy public.strategy_type,
  p_ai_call_id uuid,
  p_action public.prediction_action,
  p_confidence smallint,
  p_reason text,
  p_input_hash text,
  p_prediction_hash text,
  p_predicted_at timestamptz,
  p_raw_response jsonb,
  p_bets jsonb,
  p_decisions jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_prediction_id uuid;
  v_existing_action public.prediction_action;
  v_existing_bets integer;
  v_bet jsonb;
  v_decision jsonb;
  v_snapshot_id uuid;
  v_bet_id uuid;
  v_expected_bets integer;
  v_combination smallint[];
begin
  if p_bets is null or jsonb_typeof(p_bets) <> 'array' then
    raise exception using message='FINAL_BETS_NOT_ARRAY',errcode='P0001';
  end if;
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'array' then
    raise exception using message='FINAL_DECISIONS_NOT_ARRAY',errcode='P0001';
  end if;
  v_expected_bets := jsonb_array_length(p_bets);
  if (p_action='bet' and v_expected_bets=0) or
     (p_action='skip' and v_expected_bets<>0) then
    raise exception using message='FINAL_ACTION_BETS_MISMATCH',errcode='P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('prediction-final:'||p_batch_run_id::text||':'||p_race_id::text)
  );

  select p.id,p.action,count(b.id)::integer
    into v_prediction_id,v_existing_action,v_existing_bets
  from public.predictions p
  left join public.bets b on b.prediction_id=p.id
  where p.batch_run_id=p_batch_run_id and p.strategy=p_strategy and p.race_id=p_race_id
  group by p.id,p.action;

  if v_prediction_id is not null then
    if v_existing_action='skip' or v_existing_bets>0 then
      update public.race_pipeline_items
      set state='completed',last_error=null,updated_at=pg_catalog.now()
      where id=p_pipeline_item_id and batch_run_id=p_batch_run_id and race_id=p_race_id;
      return v_prediction_id;
    end if;
    raise exception using message='INCOMPLETE_PREDICTION_EXISTS',errcode='P0001';
  end if;

  insert into public.predictions(
    batch_run_id,race_id,strategy,ai_call_id,action,confidence,reason,
    input_hash,prediction_hash,predicted_at,raw_response
  ) values (
    p_batch_run_id,p_race_id,p_strategy,p_ai_call_id,p_action,p_confidence,p_reason,
    p_input_hash,p_prediction_hash,p_predicted_at,p_raw_response
  ) returning id into v_prediction_id;

  for v_bet in select value from jsonb_array_elements(p_bets)
  loop
    v_combination := array(select jsonb_array_elements_text(v_bet->'horses'))::smallint[];
    insert into public.market_odds_snapshots(
      batch_run_id,race_id,bet_type,combination,odds_low,odds_high,
      source_name,source_url,captured_at,content_hash
    ) values (
      p_batch_run_id,p_race_id,(v_bet->>'bet_type')::public.bet_type,
      v_combination,(v_bet->>'odds')::numeric,nullif(v_bet->>'odds_max','')::numeric,
      'netkeiba',v_bet->>'source_url',(v_bet->>'captured_at')::timestamptz,
      v_bet->>'content_hash'
    ) returning id into v_snapshot_id;

    v_bet_id := public.create_reserved_paper_bet(
      v_prediction_id,p_race_id,p_strategy,(v_bet->>'bet_type')::public.bet_type,
      v_combination,(v_bet->>'stake')::integer,v_snapshot_id,(v_bet->>'odds')::numeric,
      nullif(v_bet->>'raw_probability','')::numeric,
      nullif(v_bet->>'calibrated_probability','')::numeric,
      nullif(v_bet->>'expected_value','')::numeric,
      v_bet->>'reason',v_bet->>'stake_reason'
    );
  end loop;

  for v_decision in select value from jsonb_array_elements(p_decisions)
  loop
    v_combination := array(select jsonb_array_elements_text(v_decision->'horses'))::smallint[];
    v_bet_id := null;
    if v_decision->>'decision' = 'purchased' then
      select b.id into v_bet_id
      from public.bets b
      where b.prediction_id=v_prediction_id
        and b.bet_type=(v_decision->>'bet_type')::public.bet_type
        and b.combination=v_combination
      limit 1;
      if v_bet_id is null then
        raise exception using message='PURCHASED_DECISION_BET_NOT_FOUND',errcode='P0001';
      end if;
    end if;

    insert into public.bet_decisions(
      prediction_id,bet_id,race_id,strategy,bet_type,combination,
      proposed_stake,final_stake,odds,odds_high,raw_probability,
      calibrated_probability,expected_value,minimum_expected_value,
      data_quality,minimum_data_quality,decision,reason_code,reason_detail,
      confidence_grade,ticket_score
    ) values (
      v_prediction_id,v_bet_id,p_race_id,p_strategy,v_decision->>'bet_type',v_combination,
      coalesce((v_decision->>'proposed_stake')::integer,0),
      coalesce((v_decision->>'final_stake')::integer,0),
      nullif(v_decision->>'odds','')::numeric,
      nullif(v_decision->>'odds_max','')::numeric,
      nullif(v_decision->>'raw_probability','')::numeric,
      nullif(v_decision->>'calibrated_probability','')::numeric,
      nullif(v_decision->>'expected_value','')::numeric,
      coalesce((v_decision->>'minimum_expected_value')::numeric,0),
      null,0,v_decision->>'decision',v_decision->>'reason_code',
      coalesce(nullif(v_decision->>'reason_detail',''),'No detail'),
      v_decision->>'confidence_grade',nullif(v_decision->>'ticket_score','')::numeric
    );
  end loop;

  update public.race_pipeline_items
  set state='completed',final_attempts=final_attempts+1,last_error=null,
      updated_at=pg_catalog.now()
  where id=p_pipeline_item_id and batch_run_id=p_batch_run_id and race_id=p_race_id;
  if not found then
    raise exception using message='PIPELINE_ITEM_NOT_FOUND',errcode='P0001';
  end if;
  return v_prediction_id;
end;
$$;

revoke all on function public.finalize_prediction_decision(
  uuid,uuid,uuid,public.strategy_type,uuid,public.prediction_action,smallint,
  text,text,text,timestamptz,jsonb,jsonb,jsonb
) from public,anon,authenticated;
grant execute on function public.finalize_prediction_decision(
  uuid,uuid,uuid,public.strategy_type,uuid,public.prediction_action,smallint,
  text,text,text,timestamptz,jsonb,jsonb,jsonb
) to service_role;

comment on column public.bet_decisions.ticket_score is
  'Deterministic v0.1 score: EV, calibrated hit probability and confidence with ticket-type weighting.';
