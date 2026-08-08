import type { Entry, PastRun, RaceSummary } from "./types.ts";

export interface HorseEvaluation {
  horseNumber: number;
  horseName: string;
  abilityScore: number;
  suitabilityScore: number;
  conditionScore: number;
  raceContextScore: number;
  overallScore: number;
  estimatedWinProbability: number;
  dataQuality: number;
  sampleSize: number;
}

interface EvaluationInput {
  entry: Entry;
  race: RaceSummary;
  pastRuns: PastRun[];
}

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const mean = (values: number[], fallback = 50) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
const weights = [1, 0.75, 0.55, 0.4, 0.3];

function weightedMean(values: number[], fallback = 50) {
  if (!values.length) return fallback;
  const used = weights.slice(0, values.length);
  return values.reduce((sum, value, index) => sum + value * used[index], 0) /
    used.reduce((sum, value) => sum + value, 0);
}

function finishScore(run: PastRun) {
  if (!run.finishPosition) return 50;
  const field = Math.max(run.runnerCount ?? 12, run.finishPosition);
  if (field <= 1) return 100;
  return clamp(100 * (field - run.finishPosition) / (field - 1));
}

function abilityScore(runs: PastRun[]) {
  if (!runs.length) return 50;
  const finishes = runs.map(finishScore);
  const recent = weightedMean(finishes);
  const average = mean(finishes);
  const variance = mean(finishes.map((score) => (score - average) ** 2), 0);
  const stability = clamp(100 - Math.sqrt(variance) * 2);
  const closing = mean(
    runs.filter((run) => run.last3f != null).map((run) =>
      clamp(150 - Number(run.last3f) * 2.5)
    ),
  );
  return clamp(recent * 0.7 + stability * 0.15 + closing * 0.15);
}

function suitabilityScore(race: RaceSummary, runs: PastRun[]) {
  if (!runs.length) return 50;
  const distanceRuns = race.distance == null
    ? []
    : runs.filter((run) =>
      run.distance != null && Math.abs(run.distance - race.distance!) <= 200
    );
  const surfaceRuns = race.surface == null
    ? []
    : runs.filter((run) => run.surface === race.surface);
  const courseRuns = runs.filter((run) => run.track === race.track);
  const conditionRuns = race.condition == null
    ? []
    : runs.filter((run) => run.condition === race.condition);
  return clamp(
    mean(distanceRuns.map(finishScore)) * 0.35 +
      mean(surfaceRuns.map(finishScore)) * 0.3 +
      mean(courseRuns.map(finishScore)) * 0.2 +
      mean(conditionRuns.map(finishScore)) * 0.15,
  );
}

function conditionScore(entry: Entry, runs: PastRun[], raceDate: string) {
  if (!runs.length) return 50;
  const recent = mean(runs.slice(0, 2).map(finishScore));
  const older = mean(runs.slice(2, 5).map(finishScore), recent);
  const trend = clamp(50 + (recent - older) * 0.75);
  const lastDate = runs[0]?.raceDate ? new Date(runs[0].raceDate) : null;
  const daysSince = lastDate
    ? Math.max(
      0,
      (new Date(raceDate).getTime() - lastDate.getTime()) / 86400000,
    )
    : null;
  const layoff = daysSince == null
    ? 50
    : daysSince <= 14
    ? 65
    : daysSince <= 42
    ? 80
    : daysSince <= 90
    ? 60
    : 40;
  const weightChange = entry.horseWeightDelta == null
    ? 50
    : clamp(80 - Math.max(0, Math.abs(entry.horseWeightDelta) - 4) * 4);
  const jockeyContinuity = entry.jockey && runs[0]?.jockey
    ? entry.jockey === runs[0].jockey ? 70 : 50
    : 50;
  return clamp(
    trend * 0.4 + layoff * 0.25 + weightChange * 0.2 +
      jockeyContinuity * 0.15,
  );
}

function raceContextScore(entry: Entry, entries: Entry[]) {
  const gate = entry.gateNumber && entries.length > 1
    ? 100 - ((entry.gateNumber - 1) / (entries.length - 1)) * 35
    : 50;
  const carried = entries.map((item) => item.weightCarried).filter((value) =>
    value != null
  ) as number[];
  const weight = entry.weightCarried != null && carried.length
    ? clamp(50 + (mean(carried) - entry.weightCarried) * 8)
    : 50;
  return clamp(gate * 0.6 + weight * 0.4);
}

function dataQuality(entry: Entry, race: RaceSummary, runs: PastRun[]) {
  const runCoverage = Math.min(runs.length, 5) / 5;
  const currentFields = [
    entry.gateNumber,
    entry.jockey,
    entry.weightCarried,
    entry.horseWeight,
    entry.horseWeightDelta,
    race.surface,
    race.distance,
    race.condition,
  ];
  const currentCoverage =
    currentFields.filter((value) => value != null).length /
    currentFields.length;
  const historicalFields = runs.flatMap((run) => [
    run.finishPosition,
    run.distance,
    run.surface,
    run.track,
    run.last3f,
  ]);
  const historicalCoverage = historicalFields.length
    ? historicalFields.filter((value) => value != null).length /
      historicalFields.length
    : 0;
  return clamp(
    (runCoverage * 0.55 + currentCoverage * 0.2 + historicalCoverage * 0.25) *
      100,
  ) / 100;
}

export function evaluateRace(
  race: RaceSummary,
  entries: Entry[],
  pastRunsByHorse: Map<string, PastRun[]>,
): HorseEvaluation[] {
  const base = entries.map((entry) => {
    const runs = (pastRunsByHorse.get(entry.umaxScores.horse_id) ?? []).slice(
      0,
      5,
    );
    const ability = abilityScore(runs);
    const suitability = suitabilityScore(race, runs);
    const condition = conditionScore(entry, runs, race.raceDate);
    const context = raceContextScore(entry, entries);
    const overall = ability * 0.4 + suitability * 0.3 + condition * 0.2 +
      context * 0.1;
    return {
      horseNumber: entry.horseNumber,
      horseName: entry.horseName,
      abilityScore: round(ability),
      suitabilityScore: round(suitability),
      conditionScore: round(condition),
      raceContextScore: round(context),
      overallScore: round(overall),
      dataQuality: round(dataQuality(entry, race, runs), 2),
      sampleSize: runs.length,
    };
  });
  if (!base.length) return [];
  const maxScore = Math.max(...base.map((item) => item.overallScore));
  const raw = base.map((item) => Math.exp((item.overallScore - maxScore) / 12));
  const uniform = 1 / base.length;
  const adjusted = raw.map((value, index) =>
    base[index].dataQuality * value + (1 - base[index].dataQuality) * uniform
  );
  const total = adjusted.reduce((sum, value) => sum + value, 0);
  return base.map((item, index) => ({
    ...item,
    estimatedWinProbability: round(adjusted[index] / total, 4),
  }));
}
