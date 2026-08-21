import { assertEquals } from "jsr:@std/assert@1";
import { buildRaceSelectionMarket } from "./race-selection-market.ts";

Deno.test("builds a compact win market ordered by popularity", () => {
  const market = buildRaceSelectionMarket(
    [
      { umaxScores: { horse_id: "h1" }, horseNumber: 1, horseName: "一番星", sourceData: {} },
      { umaxScores: { horse_id: "h2" }, horseNumber: 2, horseName: "二番手", sourceData: {} },
    ],
    [
      { type: "wide", horses: [1, 2], odds: 3.2, oddsMax: 4.1 },
      { type: "win", horses: [1], odds: 5.4, popularity: 2 },
      { type: "win", horses: [2], odds: 3.1, popularity: 1 },
    ],
    "2026-08-22T00:00:00.000Z",
  );
  assertEquals(market, {
    status: "available",
    captured_at: "2026-08-22T00:00:00.000Z",
    runners: [
      { horse_number: 2, horse_name: "二番手", win_odds: 3.1, popularity: 1 },
      { horse_number: 1, horse_name: "一番星", win_odds: 5.4, popularity: 2 },
    ],
  });
});

Deno.test("invalid placeholder odds become unavailable", () => {
  const market = buildRaceSelectionMarket(
    [{ umaxScores: { horse_id: "h1" }, horseNumber: 1, horseName: "一番星", sourceData: {} }],
    [{ type: "win", horses: [1], odds: 9999.9, popularity: 1 }],
  );
  assertEquals(market.status, "unavailable");
  assertEquals(market.runners, []);
});
