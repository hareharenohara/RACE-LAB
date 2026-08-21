import { assertEquals } from "jsr:@std/assert@1.0.14";
import { validateMarketOdds } from "./odds-validation.ts";

Deno.test("rejects pre-sale placeholders", () => {
  assertEquals(validateMarketOdds({ type: "wide", odds: 9999.9, oddsMax: 0 }), {
    valid: false,
    reason: "ODDS_UNAVAILABLE",
  });
});

Deno.test("rejects malformed range odds", () => {
  assertEquals(validateMarketOdds({ type: "place", odds: 2.2, oddsMax: 1.8 }), {
    valid: false,
    reason: "ODDS_RANGE_INVALID",
  });
});

Deno.test("accepts valid fixed and range markets", () => {
  assertEquals(
    validateMarketOdds({ type: "win", odds: 4.2, oddsMax: 0 }).valid,
    true,
  );
  assertEquals(
    validateMarketOdds({ type: "wide", odds: 3.2, oddsMax: 4.1 }).valid,
    true,
  );
});
