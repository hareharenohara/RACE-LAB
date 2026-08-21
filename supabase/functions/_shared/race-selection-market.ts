import type { Entry, RaceOdds } from "./types.ts";
import { validateMarketOdds } from "./odds-validation.ts";

export type RaceSelectionMarket = {
  status: "available" | "unavailable";
  captured_at: string;
  runners: Array<{
    horse_number: number;
    horse_name: string;
    win_odds: number;
    popularity: number | null;
  }>;
};

/** Compact market view for screening; full ticket odds remain a final-decision input. */
export function buildRaceSelectionMarket(
  entries: Entry[],
  odds: RaceOdds[],
  capturedAt = new Date().toISOString(),
): RaceSelectionMarket {
  const names = new Map(entries.map((entry) => [
    entry.horseNumber,
    entry.horseName,
  ]));
  const runners = odds
    .filter((market) =>
      market.type === "win" && market.horses.length === 1 &&
      validateMarketOdds(market).valid && names.has(market.horses[0])
    )
    .map((market) => ({
      horse_number: market.horses[0],
      horse_name: names.get(market.horses[0])!,
      win_odds: Number(market.odds),
      popularity: Number.isFinite(Number(market.popularity))
        ? Number(market.popularity)
        : null,
    }))
    .sort((a, b) =>
      (a.popularity ?? Number.MAX_SAFE_INTEGER) -
        (b.popularity ?? Number.MAX_SAFE_INTEGER) ||
      a.win_odds - b.win_odds || a.horse_number - b.horse_number
    );
  return {
    status: runners.length ? "available" : "unavailable",
    captured_at: capturedAt,
    runners,
  };
}
