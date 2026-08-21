import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  allocateDailyRiskBudget,
  calculateDailyBankrollState,
  currentRaceBudget,
  dailyLockProfitRate,
} from "./bankroll-management.ts";

Deno.test("daily ratchet uses reached milestone", () => {
  assertEquals(dailyLockProfitRate(0.0225), 0.01);
  assertEquals(dailyLockProfitRate(0.099), 0.04);
  assertEquals(dailyLockProfitRate(0.10), 0.06);
  assertEquals(dailyLockProfitRate(0.30), 0.22);
});

Deno.test("100k account starts with a 3500 yen normal risk envelope", () => {
  const state = calculateDailyBankrollState(100000, 100000);
  assertEquals(state.lossFloor, 96500);
  assertEquals(state.riskCapacity, 3500);
  assertEquals(state.mode, "normal");
});

Deno.test("target unlocks attack while preserving the ratchet floor", () => {
  const state = calculateDailyBankrollState(100000, 102250);
  assertEquals(state.lockBalance, 101000);
  assertEquals(state.riskCapacity, 1200);
  assertEquals(state.mode, "attack");
});

Deno.test("10 percent peak preserves six percent after drawdown", () => {
  const state = calculateDailyBankrollState(100000, 108000, 110000);
  assertEquals(state.lockBalance, 106000);
  assertEquals(state.riskCapacity, 2000);
  assertEquals(state.mode, "attack");
});

Deno.test("daily risk allocation sums to cap in 100 yen units", () => {
  const allocation = allocateDailyRiskBudget(100000, [
    { raceId: "r1", weight: 45 },
    { raceId: "r2", weight: 30 },
    { raceId: "r3", weight: 25 },
  ]);
  assertEquals([...allocation.values()].reduce((a, b) => a + b, 0), 3500);
  assertEquals(allocation, new Map([["r1", 1600], ["r2", 1000], ["r3", 900]]));
});

Deno.test("normal budget carries unused risk but protects future races", () => {
  const state = calculateDailyBankrollState(100000, 99500);
  assertEquals(currentRaceBudget(state, 1000, 1000), 2000);
});
