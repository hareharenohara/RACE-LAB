export interface CalibrationBin {
  low: number;
  high: number;
  rate: number;
  count: number;
}
export interface CalibrationProfile {
  bins: CalibrationBin[];
}
export interface CalibrationObservation {
  predicted: number;
  outcome: boolean;
  occurredAt: string;
}
export interface CalibrationFit {
  adopted: boolean;
  profile: CalibrationProfile | null;
  sampleSize: number;
  baselineBrier: number | null;
  validationBrier: number | null;
  improvement: number;
}

const round = (n: number, d = 6) => Number(n.toFixed(d));
const brier = (rows: CalibrationObservation[], map: (p: number) => number) =>
  rows.reduce((s, x) => s + (map(x.predicted) - (x.outcome ? 1 : 0)) ** 2, 0) /
  rows.length;
export function calibrateProbability(
  profile: CalibrationProfile | undefined,
  predicted: number,
) {
  const p = Math.min(1, Math.max(0, predicted)),
    bin = profile?.bins.find((x) => p >= x.low && (p < x.high || x.high === 1));
  return round(bin ? bin.rate : p);
}
export function fitCalibration(
  rows: CalibrationObservation[],
  minimum = 30,
  minimumImprovement = .002,
): CalibrationFit {
  const valid = rows.filter((x) =>
    Number.isFinite(x.predicted) && x.predicted >= 0 && x.predicted <= 1
  ).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  if (valid.length < minimum) {
    return {
      adopted: false,
      profile: null,
      sampleSize: valid.length,
      baselineBrier: null,
      validationBrier: null,
      improvement: 0,
    };
  }
  const cut = Math.floor(valid.length * .7),
    train = valid.slice(0, cut),
    validation = valid.slice(cut),
    global = train.filter((x) => x.outcome).length / train.length;
  const bins: Array<CalibrationBin> = Array.from({ length: 5 }, (_, i) => {
    const low = i / 5,
      high = (i + 1) / 5,
      items = train.filter((x) =>
        x.predicted >= low && (x.predicted < high || high === 1)
      );
    const meanPred = items.length
      ? items.reduce((s, x) => s + x.predicted, 0) / items.length
      : (low + high) / 2;
    const hits = items.filter((x) => x.outcome).length;
    return {
      low,
      high,
      count: items.length,
      rate: round((hits + meanPred * 10) / (items.length + 10)),
    };
  });
  const profile = { bins },
    baseline = brier(validation, (p) => p),
    calibrated = brier(validation, (p) => calibrateProbability(profile, p)),
    improvement = baseline - calibrated;
  return {
    adopted: improvement >= minimumImprovement,
    profile: improvement >= minimumImprovement ? profile : null,
    sampleSize: valid.length,
    baselineBrier: round(baseline),
    validationBrier: round(calibrated),
    improvement: round(improvement),
  };
}
