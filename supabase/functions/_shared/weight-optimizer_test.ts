import { optimizeEvaluationWeights } from "./weight-optimizer.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const makeRaces = (count: number, abilityPredictsWinner: boolean) =>
  Array.from(
    { length: count },
    (_, race) =>
      Array.from({ length: 6 }, (_, horse) => {
        const winner = horse === 0;
        return {
          raceId: String(race).padStart(3, "0"),
          abilityScore: abilityPredictsWinner ? winner ? 95 : 30 + horse : 50,
          suitabilityScore: abilityPredictsWinner
            ? winner ? 30 : 90 - horse
            : 50,
          conditionScore: 50,
          raceContextScore: 50,
          isWinner: winner,
        };
      }),
  ).flat();

Deno.test("optimizer waits for the minimum race sample", () => {
  const result = optimizeEvaluationWeights(makeRaces(29, true));
  assert(!result.adopted, "must not adopt early");
  assert(result.sampleSize === 29, "sample size");
  assert(result.validationBrier === null, "no premature validation");
});

Deno.test("optimizer adopts weights only after held-out improvement", () => {
  const result = optimizeEvaluationWeights(makeRaces(40, true));
  assert(result.adopted, "strong held-out improvement should adopt");
  assert(result.weights.ability > 0.4, "ability weight should increase");
  assert(result.improvement >= 0.002, "minimum improvement");
});

Deno.test("optimizer keeps current weights when no signal improves validation", () => {
  const result = optimizeEvaluationWeights(makeRaces(40, false));
  assert(!result.adopted, "no signal should not change weights");
});
