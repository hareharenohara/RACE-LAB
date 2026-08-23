do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'strategy_accounts',
    'predictions',
    'batch_runs',
    'bets',
    'race_selections',
    'ai_calls',
    'race_pipeline_items',
    'rollover_states',
    'paper_fund_reservations',
    'source_data_snapshots',
    'daily_bankroll_states',
    'races',
    'race_results',
    'settlements',
    'bet_decisions'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null
      and not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      )
    then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$$;
