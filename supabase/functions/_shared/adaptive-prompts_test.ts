import { assertEquals } from "jsr:@std/assert@1.0.14";
import { validateFinalDecision } from "./adaptive-prompts.ts";

Deno.test("technical validator respects an AI allocation", () => {
  assertEquals(
    validateFinalDecision({
      race_id: "r",
      action: "BET",
      predicted_top3: [
        { rank: 1, horse_number: 3 },
        { rank: 2, horse_number: 7 },
        { rank: 3, horse_number: 9 },
      ],
      bets: [{ bet_type: "place", horses: [3], stake: 12300 }],
    }, {
      raceId: "r",
      horseNumbers: [3, 7, 9],
      availableBalance: 100000,
      saleOpen: true,
    }),
    [],
  );
});
Deno.test("technical validator rejects invalid but does not clamp it", () => {
  const errors = validateFinalDecision({
    race_id: "r",
    action: "BET",
    predicted_top3: [
      { rank: 1, horse_number: 3 },
      { rank: 2, horse_number: 7 },
      { rank: 3, horse_number: 8 },
    ],
    bets: [{ bet_type: "wide", horses: [3, 99], stake: 105 }],
  }, {
    raceId: "r",
    horseNumbers: [3, 7, 8],
    availableBalance: 100,
    saleOpen: true,
  });
  assertEquals(errors, [
    "存在しない馬番を含む",
    "金額が100円単位ではない",
    "利用可能残高を超過",
  ]);
});
