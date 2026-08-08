import {
  DEFAULT_EVALUATION_WEIGHTS,
  type EvaluationWeights,
} from "./horse-evaluation.ts";

export interface EvaluationSnapshot {
  raceId: string;
  abilityScore: number;
  suitabilityScore: number;
  conditionScore: number;
  raceContextScore: number;
  isWinner: boolean;
  predictedAt?: string;
}

export interface OptimizationResult {
  adopted: boolean;
  weights: EvaluationWeights;
  sampleSize: number;
  trainingBrier: number | null;
  validationBrier: number | null;
  baselineValidationBrier: number | null;
  improvement: number;
}

const round = (value: number, digits = 6) => Number(value.toFixed(digits));

function candidates(): EvaluationWeights[] {
  const result: EvaluationWeights[] = [];
  for (let ability = 0.1; ability <= 0.7; ability += 0.05) {
    for (let suitability = 0.1; suitability <= 0.6; suitability += 0.05) {
      for (let condition = 0.05; condition <= 0.5; condition += 0.05) {
        const raceContext = 1 - ability - suitability - condition;
        if (raceContext < 0.05 || raceContext > 0.35) continue;
        result.push({
          ability: round(ability, 2),
          suitability: round(suitability, 2),
          condition: round(condition, 2),
          raceContext: round(raceContext, 2),
        });
      }
    }
  }
  return result;
}

function groupByRace(rows: EvaluationSnapshot[]) {
  const races = new Map<string, EvaluationSnapshot[]>();
  for (const row of rows) {
    const race = races.get(row.raceId) ?? [];
    race.push(row);
    races.set(row.raceId, race);
  }
  return [...races.entries()].sort(([, a], [, b]) =>
    String(a[0]?.predictedAt ?? a[0]?.raceId).localeCompare(
      String(b[0]?.predictedAt ?? b[0]?.raceId),
    )
  );
}

export function multiclassBrier(
  races: Array<[string, EvaluationSnapshot[]]>,
  weights: EvaluationWeights,
) {
  if (!races.length) return Infinity;
  let total = 0;
  for (const [, runners] of races) {
    const scores = runners.map((row) =>
      row.abilityScore * weights.ability +
      row.suitabilityScore * weights.suitability +
      row.conditionScore * weights.condition +
      row.raceContextScore * weights.raceContext
    );
    const max = Math.max(...scores),
      raw = scores.map((x) => Math.exp((x - max) / 12)),
      sum = raw.reduce((a, b) => a + b, 0);
    total += raw.reduce((error, value, index) => {
      const expected = runners[index].isWinner ? 1 : 0;
      return error + (value / sum - expected) ** 2;
    }, 0) / runners.length;
  }
  return total / races.length;
}

export function optimizeEvaluationWeights(
  rows: EvaluationSnapshot[],
  current = DEFAULT_EVALUATION_WEIGHTS,
  minimumRaces = 30,
  minimumImprovement = 0.002,
): OptimizationResult {
  const races = groupByRace(rows).filter(([, runners]) =>
    runners.length >= 2 && runners.filter((row) => row.isWinner).length === 1
  );
  if (races.length < minimumRaces) {
    return {
      adopted: false,
      weights: current,
      sampleSize: races.length,
      trainingBrier: null,
      validationBrier: null,
      baselineValidationBrier: null,
      improvement: 0,
    };
  }
  const split = Math.max(1, Math.floor(races.length * 0.7)),
    training = races.slice(0, split),
    validation = races.slice(split);
  let best = current, bestTraining = multiclassBrier(training, current);
  for (const candidate of candidates()) {
    const score = multiclassBrier(training, candidate);
    if (score < bestTraining) {
      best = candidate;
      bestTraining = score;
    }
  }
  const baseline = multiclassBrier(validation, current),
    validationBrier = multiclassBrier(validation, best),
    improvement = baseline - validationBrier,
    adopted = improvement >= minimumImprovement;
  return {
    adopted,
    weights: adopted ? best : current,
    sampleSize: races.length,
    trainingBrier: round(bestTraining),
    validationBrier: round(validationBrier),
    baselineValidationBrier: round(baseline),
    improvement: round(improvement),
  };
}
