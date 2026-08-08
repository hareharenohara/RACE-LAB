import { buildHorseFeatures, evaluateRace } from "./horse-evaluation.ts";
import type { Entry, PastRun, RaceSummary } from "./types.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const race: RaceSummary = {
  externalId: "jra:test",
  raceDate: "2026-08-08",
  track: "東京",
  raceNumber: 1,
  raceName: "test",
  startTime: "2026-08-08T10:00:00+09:00",
  surface: "turf",
  distance: 1600,
  condition: "good",
  sourceUrl: "https://example.com",
};
const entry = (id: string, number: number, popularity = 1): Entry => ({
  umaxScores: { horse_id: id },
  horseNumber: number,
  horseName: `horse-${id}`,
  gateNumber: number,
  jockey: "騎手A",
  weightCarried: 56,
  horseWeight: 480,
  horseWeightDelta: 0,
  popularity,
  sourceData: { horse_id: id },
});
const runs = (positions: number[]): PastRun[] =>
  positions.map((position, index) => ({
    raceDate: `2026-0${7 - index}-01`,
    track: "東京",
    surface: "turf",
    distance: 1600,
    condition: "good",
    finishPosition: position,
    runnerCount: 16,
    last3f: 34 + index * 0.2,
    jockey: "騎手A",
  }));

Deno.test("strong recent form receives the higher score and probability", () => {
  const entries = [entry("strong", 1), entry("weak", 2)];
  const result = evaluateRace(
    race,
    entries,
    new Map([
      ["strong", runs([1, 2, 1, 3, 2])],
      ["weak", runs([10, 12, 8, 11, 9])],
    ]),
  );
  assert(result[0].overallScore > result[1].overallScore, "score order");
  assert(
    result[0].estimatedWinProbability > result[1].estimatedWinProbability,
    "probability order",
  );
  assert(
    Math.abs(
      result.reduce((sum, item) => sum + item.estimatedWinProbability, 0) - 1,
    ) < 0.001,
    "probabilities sum to one",
  );
});

Deno.test("current popularity does not affect the evaluation", () => {
  const history = new Map([["same", runs([2, 3, 2, 4, 3])]]);
  const first = evaluateRace(race, [entry("same", 1, 1)], history)[0];
  const second = evaluateRace(race, [entry("same", 1, 15)], history)[0];
  assert(
    first.overallScore === second.overallScore,
    "odds-derived popularity leaked into score",
  );
});

Deno.test("missing history lowers data quality", () => {
  const result = evaluateRace(race, [entry("new", 1)], new Map())[0];
  assert(result.dataQuality < 0.5, "missing history should be low quality");
});

Deno.test("feature engineering exposes suitability, trend, and workload", () => {
  const history: PastRun[] = [
    {
      raceDate: "2026-07-25",
      track: race.track,
      surface: race.surface,
      distance: race.distance,
      condition: race.condition,
      finishPosition: 1,
      runnerCount: 16,
      last3f: 33.8,
      margin: 0.5,
      jockey: "騎手A",
      weightCarried: 55,
    },
    {
      raceDate: "2026-06-20",
      track: race.track,
      surface: race.surface,
      distance: 1800,
      condition: race.condition,
      finishPosition: 2,
      runnerCount: 14,
      last3f: 34.2,
      margin: 0.1,
      jockey: "騎手A",
      weightCarried: 55,
    },
    ...runs([10, 11, 12]).map((run) => ({
      ...run,
      track: "中山",
      surface: "dirt",
      distance: 1200,
      condition: "heavy",
      jockey: "騎手B",
    })),
  ];
  const features = buildHorseFeatures(entry("fit", 1), race, history);
  assert(features.surfaceFit > 60, "surface fit");
  assert(features.distanceFit > 80, "distance fit");
  assert(features.courseFit > 80, "course fit");
  assert(features.formTrend > 70, "improving trend");
  assert(features.closingPerformance > 55, "closing performance");
  assert(features.marginPerformance > 45, "margin performance");
  assert(features.jockeyPartnership > 80, "jockey partnership");
  assert(features.weightCarriedChange === 1, "weight carried change");
  assert(features.layoffDays === 14, "layoff days");
});

Deno.test("evaluation includes neutral features when history is missing", () => {
  const result = evaluateRace(race, [entry("new", 1)], new Map())[0];
  assert(result.features.recentForm === 50, "neutral recent form");
  assert(result.features.weightCarriedChange === null, "unknown workload");
  assert(result.features.layoffDays === null, "unknown layoff");
});
