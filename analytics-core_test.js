import "./analytics-core.js";

const { validationStats, strategyStats } = globalThis.RaceAnalytics;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const bet = (probability, hit, stake = 100, returned = hit ? 200 : 0) => ({
  strategy: "balanced",
  stake,
  estimated_probability: probability,
  settlements: [{ is_hit: hit, return_amount: returned }],
});

Deno.test("calibration compares predicted probability with outcomes", () => {
  const stats = validationStats([bet(0.8, true), bet(0.2, false)]);
  assert(stats.count === 2, "settled count");
  assert(stats.predictedRate === 0.5, "predicted rate");
  assert(stats.observedRate === 0.5, "observed rate");
  assert(stats.calibrationGap === 0, "calibration gap");
  assert(stats.brierScore === 0.04, "brier score");
});

Deno.test("pending bets and invalid probabilities are excluded", () => {
  const stats = validationStats([
    { estimated_probability: 0.9, settlements: [] },
    bet(1.2, true),
    bet(0.6, true),
  ]);
  assert(stats.count === 1, "only valid settled bet");
  assert(stats.brierScore === 0.16, "valid bet score");
});

Deno.test("strategy performance uses settled stakes only", () => {
  const pending = {
    strategy: "balanced",
    stake: 5000,
    estimated_probability: 0.5,
    settlements: [],
  };
  const stats = strategyStats(
    [bet(0.6, true, 1000, 1800), pending],
    "balanced",
  );
  assert(stats.settled === 1, "settled count");
  assert(stats.staked === 1000, "settled stake");
  assert(stats.returned === 1800, "return");
  assert(stats.profit === 800 && stats.roi === 180, "performance");
});
