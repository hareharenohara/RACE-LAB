alter table public.past_runs
add column if not exists corner_positions smallint[];

alter table public.evaluation_weight_profiles
add column if not exists formula_version text not null default 'horse-v1';
