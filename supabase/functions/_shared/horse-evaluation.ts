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
  features: HorseFeatures;
}

export interface HorseFeatures {
  recentForm: number;
  formTrend: number;
  surfaceFit: number;
  distanceFit: number;
  courseFit: number;
  goingFit: number;
  closingPerformance: number;
  marginPerformance: number;
  jockeyPartnership: number;
  weightCarriedChange: number | null;
  layoffDays: number | null;
  averageSpeed: number | null;
  averageFinalCornerRatio: number | null;
  averageClassLevel: number | null;
}

export interface EvaluationWeights {
  ability: number;
  suitability: number;
  condition: number;
  raceContext: number;
}

export const DEFAULT_EVALUATION_WEIGHTS: EvaluationWeights = {
  ability: 0.4,
  suitability: 0.3,
  condition: 0.2,
  raceContext: 0.1,
};

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
const classLevels: Record<string, number> = {
  newcomer: 1,
  maiden: 2,
  "1win": 3,
  "2win": 4,
  "3win": 5,
  open: 6,
  listed: 7,
  G3: 8,
  G2: 9,
  G1: 10,
};

const timeSeconds = (value?: string) => {
  const match = value?.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

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

const scoredMean = (runs: PastRun[], fallback = 50) =>
  mean(runs.map(finishScore), fallback);

function layoffDays(runs: PastRun[], raceDate: string) {
  const lastDate = runs[0]?.raceDate ? new Date(runs[0].raceDate) : null;
  return lastDate
    ? Math.max(
      0,
      Math.round(
        (new Date(raceDate).getTime() - lastDate.getTime()) / 86400000,
      ),
    )
    : null;
}

export function buildHorseFeatures(
  entry: Entry,
  race: RaceSummary,
  runs: PastRun[],
): HorseFeatures {
  const distanceRuns = race.distance == null
      ? []
      : runs.filter((run) =>
        run.distance != null && Math.abs(run.distance - race.distance!) <= 200
      ),
    surfaceRuns = race.surface == null
      ? []
      : runs.filter((run) => run.surface === race.surface),
    courseRuns = runs.filter((run) => run.track === race.track),
    goingRuns = race.condition == null
      ? []
      : runs.filter((run) => run.condition === race.condition),
    recent = scoredMean(runs.slice(0, 2)),
    older = scoredMean(runs.slice(2, 5), recent),
    closing = runs.filter((run) => run.last3f != null).map((run) => {
      const distanceAdjustment = ((run.distance ?? 1600) - 1600) / 400 * 0.35,
        baseline = run.surface === "dirt" ? 37 : 35;
      return clamp(50 + (baseline + distanceAdjustment - run.last3f!) * 12);
    }),
    margins = runs.filter((run) =>
      run.margin != null && run.finishPosition != null
    ).map((run) =>
      clamp(
        50 + (run.finishPosition === 1 ? run.margin! : -run.margin!) * 15,
      )
    ),
    jockeyRuns = entry.jockey
      ? runs.filter((run) => run.jockey === entry.jockey)
      : [],
    latestWeight = runs.find((run) => run.weightCarried != null)?.weightCarried;
  const speeds = runs.flatMap((run) => {
      const seconds = timeSeconds(run.finishTime);
      return seconds && run.distance ? [run.distance / seconds] : [];
    }),
    finalCornerRatios = runs.flatMap((run) => {
      const finalCorner = run.cornerPositions?.at(-1);
      return finalCorner && run.runnerCount
        ? [finalCorner / run.runnerCount]
        : [];
    }),
    levels = runs.flatMap((run) =>
      run.raceClass && classLevels[run.raceClass] != null
        ? [classLevels[run.raceClass]]
        : []
    );
  return {
    recentForm: round(weightedMean(runs.map(finishScore))),
    formTrend: round(clamp(50 + (recent - older) * 0.75)),
    surfaceFit: round(scoredMean(surfaceRuns)),
    distanceFit: round(scoredMean(distanceRuns)),
    courseFit: round(scoredMean(courseRuns)),
    goingFit: round(scoredMean(goingRuns)),
    closingPerformance: round(mean(closing)),
    marginPerformance: round(mean(margins)),
    jockeyPartnership: round(scoredMean(jockeyRuns)),
    weightCarriedChange: entry.weightCarried != null && latestWeight != null
      ? round(entry.weightCarried - latestWeight)
      : null,
    layoffDays: layoffDays(runs, race.raceDate),
    averageSpeed: speeds.length ? round(mean(speeds), 3) : null,
    averageFinalCornerRatio: finalCornerRatios.length
      ? round(mean(finalCornerRatios), 3)
      : null,
    averageClassLevel: levels.length ? round(mean(levels), 2) : null,
  };
}

function abilityScore(runs: PastRun[], features: HorseFeatures) {
  if (!runs.length) return 50;
  const finishes = runs.map(finishScore);
  const average = mean(finishes);
  const variance = mean(finishes.map((score) => (score - average) ** 2), 0);
  const stability = clamp(100 - Math.sqrt(variance) * 2);
  return clamp(
    features.recentForm * 0.55 + stability * 0.15 +
      features.closingPerformance * 0.15 +
      features.marginPerformance * 0.15,
  );
}

function suitabilityScore(features: HorseFeatures) {
  return clamp(
    features.distanceFit * 0.35 + features.surfaceFit * 0.3 +
      features.courseFit * 0.2 + features.goingFit * 0.15,
  );
}

function conditionScore(
  entry: Entry,
  runs: PastRun[],
  features: HorseFeatures,
) {
  if (!runs.length) return 50;
  const daysSince = features.layoffDays;
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
    features.formTrend * 0.4 + layoff * 0.25 + weightChange * 0.2 +
      jockeyContinuity * 0.15,
  );
}

function raceContextScore(
  entry: Entry,
  entries: Entry[],
  features: HorseFeatures,
) {
  const gate = entry.gateNumber && entries.length > 1
    ? 100 - ((entry.gateNumber - 1) / (entries.length - 1)) * 35
    : 50;
  const carried = entries.map((item) => item.weightCarried).filter((value) =>
    value != null
  ) as number[];
  const weight = entry.weightCarried != null && carried.length
    ? clamp(50 + (mean(carried) - entry.weightCarried) * 8)
    : 50;
  return clamp(gate * 0.4 + weight * 0.4 + features.jockeyPartnership * 0.2);
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
  weights = DEFAULT_EVALUATION_WEIGHTS,
): HorseEvaluation[] {
  const base = entries.map((entry) => {
    const runs = (pastRunsByHorse.get(entry.umaxScores.horse_id) ?? []).slice(
      0,
      5,
    );
    const features = buildHorseFeatures(entry, race, runs);
    const ability = abilityScore(runs, features);
    const suitability = suitabilityScore(features);
    const condition = conditionScore(entry, runs, features);
    const context = raceContextScore(entry, entries, features);
    const overall = ability * weights.ability +
      suitability * weights.suitability + condition * weights.condition +
      context * weights.raceContext;
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
      features,
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
