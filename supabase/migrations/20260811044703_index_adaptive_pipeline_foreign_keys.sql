create index entry_identity_checks_horse_id_idx
  on public.entry_identity_checks(horse_id);

create index race_pipeline_items_race_id_idx
  on public.race_pipeline_items(race_id);

create index rollover_states_source_bet_id_idx
  on public.rollover_states(source_bet_id);
