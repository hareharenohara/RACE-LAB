import type { BetType, RaceOdds } from "./types.ts";

export interface WinProbability {
  horseNumber: number;
  estimatedWinProbability: number;
  dataQuality: number;
}
export interface BetCandidate {
  type: BetType;
  horses: number[];
  odds: number;
  estimatedProbability: number;
  expectedValue: number;
  dataQuality: number;
}

// Values at or above this level are not treated as executable prices. The
// upstream feed uses 999999.9 as a ceiling, and very thin exotic markets can
// temporarily publish similarly unusable prices.
export const MAX_ACTIONABLE_ODDS = 10_000;
export const MIN_ACTIONABLE_PROBABILITY = 0.001;

export type CandidateRejectionReason =
  | "ODDS_NOT_FINITE"
  | "ODDS_NOT_POSITIVE"
  | "ODDS_NOT_ACTIONABLE"
  | "PROBABILITY_TOO_LOW";

export function candidateRejectionReason(
  candidate: Pick<BetCandidate, "odds" | "estimatedProbability">,
): CandidateRejectionReason | null {
  if (!Number.isFinite(candidate.odds)) return "ODDS_NOT_FINITE";
  if (candidate.odds <= 0) return "ODDS_NOT_POSITIVE";
  if (candidate.odds >= MAX_ACTIONABLE_ODDS) return "ODDS_NOT_ACTIONABLE";
  if (
    !Number.isFinite(candidate.estimatedProbability) ||
    candidate.estimatedProbability < MIN_ACTIONABLE_PROBABILITY
  ) return "PROBABILITY_TOO_LOW";
  return null;
}

const unordered = new Set<BetType>(["wide", "quinella", "trio"]);
export const betCandidateKey = (type: BetType, horses: number[]) =>
  `${type}:${(unordered.has(type) ? [...horses].sort((a, b) => a - b) : horses).join("-")}`;
const add = (values: Map<string, number>, key: string, probability: number) =>
  values.set(key, (values.get(key) ?? 0) + probability);
const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** Expand win probabilities into all supported markets with a Plackett-Luce model. */
export function buildBetCandidates(
  evaluations: WinProbability[],
  odds: RaceOdds[],
): BetCandidate[] {
  const valid = evaluations.filter((item) =>
    item.horseNumber > 0 && item.estimatedWinProbability > 0 &&
    Number.isFinite(item.estimatedWinProbability)
  );
  const total = valid.reduce((sum, item) => sum + item.estimatedWinProbability, 0);
  if (!valid.length || total <= 0) return [];
  const runners = valid.map((item) => ({
    horse: item.horseNumber,
    probability: item.estimatedWinProbability / total,
    quality: item.dataQuality,
  }));
  const probabilities = new Map<string, number>();
  const placeCount = runners.length >= 8 ? 3 : 2;
  for (const first of runners) {
    add(probabilities, betCandidateKey("win", [first.horse]), first.probability);
    for (const second of runners) {
      if (second.horse === first.horse) continue;
      const pair = first.probability * second.probability /
        (1 - first.probability);
      add(probabilities, betCandidateKey("exacta", [first.horse, second.horse]), pair);
      add(probabilities, betCandidateKey("quinella", [first.horse, second.horse]), pair);
      if (placeCount === 2) {
        add(probabilities, betCandidateKey("place", [first.horse]), pair);
        add(probabilities, betCandidateKey("place", [second.horse]), pair);
      }
      for (const third of runners) {
        if (third.horse === first.horse || third.horse === second.horse) continue;
        const triple = pair * third.probability /
          (1 - first.probability - second.probability);
        add(probabilities, betCandidateKey("trifecta", [first.horse, second.horse, third.horse]), triple);
        add(probabilities, betCandidateKey("trio", [first.horse, second.horse, third.horse]), triple);
        add(probabilities, betCandidateKey("wide", [first.horse, second.horse]), triple);
        add(probabilities, betCandidateKey("wide", [first.horse, third.horse]), triple);
        add(probabilities, betCandidateKey("wide", [second.horse, third.horse]), triple);
        if (placeCount === 3) {
          add(probabilities, betCandidateKey("place", [first.horse]), triple);
          add(probabilities, betCandidateKey("place", [second.horse]), triple);
          add(probabilities, betCandidateKey("place", [third.horse]), triple);
        }
      }
    }
  }
  const qualities = new Map(runners.map((item) => [item.horse, item.quality]));
  return odds.flatMap((market) => {
    const probability = probabilities.get(betCandidateKey(market.type, market.horses));
    if (!probability || !Number.isFinite(market.odds) || market.odds <= 0) return [];
    return [{
      type: market.type,
      horses: market.horses,
      odds: market.odds,
      estimatedProbability: round(Math.min(1, probability), 7),
      expectedValue: round(probability * market.odds, 4),
      dataQuality: round(Math.min(...market.horses.map((horse) => qualities.get(horse) ?? 0)), 4),
    }];
  });
}

export function selectCandidateShortlist(
  candidates: BetCandidate[],
  allowedTypes: BetType[],
  perType = 8,
): BetCandidate[] {
  return allowedTypes.flatMap((type) => candidates
    .filter((candidate) => candidate.type === type)
    .sort((a, b) => b.expectedValue - a.expectedValue)
    .slice(0, perType));
}

export interface ScoredRaceProposal {
  raceId: string;
  action: string;
  score: number | null;
}

/** Selects no more than the strongest race-level BET proposals. */
export function selectTopRaceProposalIds(
  proposals: ScoredRaceProposal[],
  maximum = 3,
): Set<string> {
  return new Set(proposals
    .filter((proposal) =>
      proposal.action === "BET" && proposal.score != null &&
      Number.isFinite(proposal.score)
    )
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, maximum)
    .map((proposal) => proposal.raceId));
}
