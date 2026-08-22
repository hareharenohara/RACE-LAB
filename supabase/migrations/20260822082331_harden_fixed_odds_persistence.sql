create or replace function public.normalize_fixed_market_odds_high()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Netkeiba represents the unused upper bound of fixed-price markets as 0.
  -- Keeping that placeholder would violate odds_high >= odds_low at settlement.
  if new.bet_type::text not in ('place', 'wide') then
    new.odds_high := null;
  end if;
  return new;
end;
$$;

revoke all on function public.normalize_fixed_market_odds_high()
from public, anon, authenticated;
grant execute on function public.normalize_fixed_market_odds_high()
to service_role;

drop trigger if exists normalize_fixed_market_odds_high
on public.market_odds_snapshots;
create trigger normalize_fixed_market_odds_high
before insert on public.market_odds_snapshots
for each row execute function public.normalize_fixed_market_odds_high();

drop trigger if exists normalize_fixed_decision_odds_high
on public.bet_decisions;
create trigger normalize_fixed_decision_odds_high
before insert on public.bet_decisions
for each row execute function public.normalize_fixed_market_odds_high();

comment on function public.normalize_fixed_market_odds_high() is
  'Normalizes provider oddsMax placeholders for fixed-price markets before persistence.';
