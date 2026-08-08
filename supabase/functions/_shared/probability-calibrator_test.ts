import {
  calibrateProbability,
  fitCalibration,
} from "./probability-calibrator.ts";
const assert = (x: boolean, m: string) => {
  if (!x) throw new Error(m);
};
const rows = (n: number, p = .8, hitRate = .3) =>
  Array.from(
    { length: n },
    (_, i) => ({
      predicted: p,
      outcome: i % n < Math.round(n * hitRate) % n,
      occurredAt: String(i).padStart(3, "0"),
    }),
  );
Deno.test("calibration waits for enough observations", () =>
  assert(!fitCalibration(rows(29)).adopted, "early adoption"));
Deno.test("overconfident probabilities are corrected on held-out data", () => {
  const fit = fitCalibration(rows(50));
  assert(fit.adopted, "should adopt");
  assert(calibrateProbability(fit.profile!, .8) < .8, "must lower probability");
});
Deno.test("profile leaves probabilities outside learned mode bounded", () => {
  const p = calibrateProbability({
    bins: [{ low: 0, high: 1, rate: .25, count: 40 }],
  }, .9);
  assert(p === .25, "profile rate");
});
