export type Stage1Race = {
  raceName: string;
  raceClass?: string | null;
  surface?: string | null;
  condition?: string | null;
  runnerCount?: number | null;
};

export type Stage1Result = { eligible: boolean; reasons: string[] };

const includesAny = (value: string, words: string[]) =>
  words.some((word) => value.toLowerCase().includes(word.toLowerCase()));

/** Cheap, explainable pre-filter. It never decides a bet. */
export function applyStage1Filter(race: Stage1Race): Stage1Result {
  const text = `${race.raceName} ${race.raceClass ?? ""}`;
  const reasons: string[] = [];
  if (includesAny(text, ["新馬", "maiden debut"])) reasons.push("NEWCOMER");
  if (includesAny(text, ["障害", "jump"])) reasons.push("JUMP");
  if (includesAny(text, ["未勝利", "maiden"])) reasons.push("MAIDEN");
  if (includesAny(text, ["ハンデ", "handicap"])) reasons.push("HANDICAP");
  if (includesAny(text, ["2歳", "2yo"])) reasons.push("TWO_YEAR_OLD");
  if (includesAny(race.condition ?? "", ["重", "不良", "heavy", "soft"])) {
    reasons.push("BAD_GOING");
  }
  if (race.runnerCount != null && race.runnerCount <= 7) {
    reasons.push("TOO_FEW_RUNNERS");
  }
  if (race.runnerCount != null && race.runnerCount >= 17) {
    reasons.push("TOO_MANY_RUNNERS");
  }
  return { eligible: reasons.length === 0, reasons };
}
