# Adaptive prediction pipeline v2

## Daily flow (JST)

1. 07:00: `jra-weekend-daily` stores only the race card and starts an `adaptive-v2` batch.
2. Stage 1: deterministic rules remove races that are unsuitable for reliable analysis. This stage never chooses a ticket or stake.
3. From 09:00: one eligible race per worker invocation is enriched. Each external source is fetched directly first; 403, 429, 5xx, timeout, or an unusable body triggers ScraperAPI fallback.
4. External HTML is reduced to normalized horse signals. Raw HTML is not sent to Gemini or retained in Postgres. Horse number and normalized horse name must match the canonical entry.
5. Evidence is considered ready with at least two usable sources including one numeric source. Missing evidence is recorded as a data-collection failure, not interpreted as a weak horse.
6. Gemini makes one race-selection call and selects up to three races. The program only validates that returned race IDs exist.
7. At T-20 minutes the selected race is refreshed: entries, external signals, current win/place/wide odds, available paper balance, and place-rollover state.
8. Gemini makes the final BET/SKIP, ticket, and stake decision. The program validates only technical validity. An invalid response receives one correction call and is never silently clamped.
9. Valid BET decisions create atomic paper-fund reservations. No real purchase API is called.
10. Results are polled every three minutes. Settlement atomically updates the paper balance; a winning place bet updates advisory rollover context for the next Gemini decision.

## Technical validation only

- Race ID and horse numbers exist in the refreshed race.
- Ticket type is `win`, `place`, or `wide`.
- Win/place has one horse; wide has two different horses.
- The exact ticket exists in the captured odds snapshot.
- Stake is positive and in 100-yen units.
- Total stake does not exceed available, unreserved paper funds.
- The race has not started.

There is no EV cutoff, confidence cutoff, program stake cap, automatic stake reduction, or fallback ticket.

## Required secrets

- `GEMINI_API_KEY`
- `SCRAPERAPI_KEY`
- `BATCH_SECRET`
- Supabase service key (`SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`)

ScraperAPI is a fallback, so the free trial is not spent on successful direct requests. Usage still needs monitoring because site layout changes can increase fallback traffic.

## Isolated integration-test mode

Passing `integration_test: true` to `jra-weekend-daily` limits Stage 1 to three races and permits a past race to reach technical validation. Final Gemini decisions are written only to `prediction_integration_test_runs`; this mode never inserts production predictions or bets, reserves funds, or changes the 100,000-yen paper balance.
