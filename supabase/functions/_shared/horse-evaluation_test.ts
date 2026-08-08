import { evaluateRace } from "./horse-evaluation.ts";
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
