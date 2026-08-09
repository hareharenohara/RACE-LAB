import {
  completeMissingPredictions,
  validatePredictions,
  validateSelections,
} from "./ai-contracts.ts";

const selection = (race_id: string, score = 80) => ({
  race_id,
  score,
  reason: "strategy fit",
});

Deno.test("screening accepts five races per strategy", () => {
  const ids = new Set(["1", "2", "3", "4", "5"]),
    rows = [...ids].map((id) => selection(id)),
    result = validateSelections({
      conservative: rows,
      balanced: rows,
      aggressive: rows,
    }, ids);
  if (result.conservative.length !== 5) {
    throw new Error("five were not accepted");
  }
});

Deno.test("screening rejects more than five races", () => {
  const ids = new Set(["1", "2", "3", "4", "5", "6"]),
    rows = [...ids].map((id) => selection(id));
  let rejected = false;
  try {
    validateSelections({
      conservative: rows,
      balanced: [],
      aggressive: [],
    }, ids);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("six selections were accepted");
});

Deno.test("missing AI race responses are completed as safe skips", () => {
  const ids = new Set(["1", "2"]),
    horseNumbers = new Map([
      ["1", new Set([1])],
      ["2", new Set([2])],
    ]);
  const completed = completeMissingPredictions(
    {
      strategy: "balanced",
      predictions: [{
        race_id: "1",
        action: "SKIP",
        confidence: 50,
        reason: "見送り",
        bets: [],
      }],
    },
    "balanced",
    ids,
  );
  const validated = validatePredictions(
    completed,
    "balanced",
    ids,
    horseNumbers,
  );
  if (validated.predictions.length !== 2) throw new Error("skip not completed");
});
