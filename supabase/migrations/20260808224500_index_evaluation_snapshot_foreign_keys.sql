create index if not exists horse_evaluation_snapshots_horse_id_idx
  on public.horse_evaluation_snapshots (horse_id);

create index if not exists horse_evaluation_snapshots_weight_profile_id_idx
  on public.horse_evaluation_snapshots (weight_profile_id);
