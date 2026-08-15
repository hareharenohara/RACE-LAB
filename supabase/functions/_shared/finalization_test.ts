import { marketKey, resolveFinalMarkets } from "./finalization.ts";

Deno.test("market matching is numeric and order independent", () => {
  if (marketKey("wide", [10, 2]) !== "wide:2-10") {
    throw new Error("horse numbers were not sorted numerically");
  }
  const [{ market }] = resolveFinalMarkets(
    [{ bet_type: "wide", horses: [10, 2] }],
    [{ type: "wide", horses: [2, 10], odds: 3.2 }],
  );
  if (market.odds !== 3.2) throw new Error("matching market was not found");
});

Deno.test("missing market fails before any persistence call", () => {
  let failed = false;
  try {
    resolveFinalMarkets([{ bet_type: "win", horses: [1] }], []);
  } catch (error) {
    failed = String(error).includes("MARKET_ODDS_NOT_FOUND");
  }
  if (!failed) throw new Error("missing market was accepted");
});
