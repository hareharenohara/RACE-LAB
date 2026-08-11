create table public.prediction_worker_leases (
  batch_run_id uuid primary key references public.batch_runs(id) on delete cascade,
  lease_id uuid not null,
  locked_until timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.prediction_worker_leases enable row level security;
revoke all on public.prediction_worker_leases from anon,authenticated;

create or replace function public.acquire_prediction_worker_lease(
  p_batch_run_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer default 140
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare v_acquired boolean := false;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception using message='INVALID_LEASE_SECONDS',errcode='P0001';
  end if;
  insert into public.prediction_worker_leases(batch_run_id,lease_id,locked_until)
  values(p_batch_run_id,p_lease_id,now()+make_interval(secs=>p_lease_seconds))
  on conflict(batch_run_id) do update set
    lease_id=excluded.lease_id,
    locked_until=excluded.locked_until,
    created_at=now()
  where public.prediction_worker_leases.locked_until < now()
  returning true into v_acquired;
  return coalesce(v_acquired,false);
end;
$$;

create or replace function public.release_prediction_worker_lease(
  p_batch_run_id uuid,
  p_lease_id uuid
)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.prediction_worker_leases
  where batch_run_id=p_batch_run_id and lease_id=p_lease_id;
$$;

revoke all on function public.acquire_prediction_worker_lease(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.release_prediction_worker_lease(uuid,uuid) from public,anon,authenticated;
grant execute on function public.acquire_prediction_worker_lease(uuid,uuid,integer) to service_role;
grant execute on function public.release_prediction_worker_lease(uuid,uuid) to service_role;
