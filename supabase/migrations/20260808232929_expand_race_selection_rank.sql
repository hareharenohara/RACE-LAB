alter table public.race_selections
drop constraint if exists race_selections_rank_check;

alter table public.race_selections
add constraint race_selections_rank_check check (rank between 1 and 5);
