import { assertEquals } from "jsr:@std/assert@1.0.14";
import { validateFinalDecision } from "./adaptive-prompts.ts";

Deno.test("technical validator respects an AI allocation", () => {
  assertEquals(
    validateFinalDecision({
      race_id: "r",
      action: "BET",
      bets: [{ bet_type: "place", horses: [3], stake: 12300 }],
    }, {
      raceId: "r",
      horseNumbers: [3],
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
    bets: [{ bet_type: "wide", horses: [3, 99], stake: 105 }],
  }, {
    raceId: "r",
    horseNumbers: [3, 7],
    availableBalance: 100,
    saleOpen: true,
  });
  assertEquals(errors, [
    "存在しない馬番を含む",
    "金額が100円単位ではない",
    "利用可能残高を超過",
  ]);
});
