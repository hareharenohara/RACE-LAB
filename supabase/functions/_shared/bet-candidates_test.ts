import {
  betCandidateKey,
  buildBetCandidates,
  candidateRejectionReason,
  selectCandidateShortlist,
  selectTopRaceProposalIds,
} from "./bet-candidates.ts";
import type { BetType, RaceOdds } from "./types.ts";

const close = (actual: number, expected: number) => {
  if (Math.abs(actual - expected) > 1e-6) throw new Error(`expected ${expected}, got ${actual}`);
};
const market = (type: BetType, horses: number[], odds = 2): RaceOdds => ({ type, horses, odds });

Deno.test("probabilities cover all seven ticket types", () => {
  const evaluations = [1, 2, 3].map((horseNumber) => ({ horseNumber, estimatedWinProbability: 1 / 3, dataQuality: .8 }));
  const odds = [market("win", [1]), market("place", [1]), market("wide", [1, 2]), market("quinella", [1, 2]), market("exacta", [1, 2]), market("trio", [1, 2, 3]), market("trifecta", [1, 2, 3])];
  const candidates = buildBetCandidates(evaluations, odds);
  const byKey = new Map(candidates.map((item) => [betCandidateKey(item.type, item.horses), item]));
  if (candidates.length !== odds.length) throw new Error("missing candidates");
  close(byKey.get("win:1")!.estimatedProbability, 1 / 3);
  close(byKey.get("place:1")!.estimatedProbability, 2 / 3);
  close(byKey.get("wide:1-2")!.estimatedProbability, 1);
  close(byKey.get("quinella:1-2")!.estimatedProbability, 1 / 3);
  close(byKey.get("exacta:1-2")!.estimatedProbability, 1 / 6);
  close(byKey.get("trio:1-2-3")!.estimatedProbability, 1);
  close(byKey.get("trifecta:1-2-3")!.estimatedProbability, 1 / 6);
});

Deno.test("non-actionable ceiling odds and practically unreachable bets are rejected", () => {
  if (candidateRejectionReason({ odds: 999999.9, estimatedProbability: .01 }) !== "ODDS_NOT_ACTIONABLE") {
    throw new Error("ceiling odds must be rejected");
  }
  if (candidateRejectionReason({ odds: 500, estimatedProbability: .0009 }) !== "PROBABILITY_TOO_LOW") {
    throw new Error("near-zero probability must be rejected");
  }
  if (candidateRejectionReason({ odds: 9999.9, estimatedProbability: .001 }) !== null) {
    throw new Error("boundary-valid candidate was rejected");
  }
});

Deno.test("shortlist keeps the best expected value per allowed type", () => {
  const candidates = buildBetCandidates([
    { horseNumber: 1, estimatedWinProbability: .6, dataQuality: .9 },
    { horseNumber: 2, estimatedWinProbability: .3, dataQuality: .8 },
    { horseNumber: 3, estimatedWinProbability: .1, dataQuality: .7 },
  ], [market("win", [1], 2), market("win", [2], 5), market("place", [1], 2)]);
  const shortlist = selectCandidateShortlist(candidates, ["win"], 1);
  if (shortlist.length !== 1 || shortlist[0].horses[0] !== 2) throw new Error("wrong shortlist");
});

Deno.test("only the strongest three valid race proposals are adopted", () => {
  const selected = selectTopRaceProposalIds([
    { raceId: "skip", action: "SKIP", score: 99 },
    { raceId: "a", action: "BET", score: 1.1 },
    { raceId: "b", action: "BET", score: 1.4 },
    { raceId: "c", action: "BET", score: 1.3 },
    { raceId: "d", action: "BET", score: 1.2 },
    { raceId: "invalid", action: "BET", score: null },
  ]);
  if ([...selected].join(",") !== "b,c,d") {
    throw new Error(`unexpected adopted races: ${[...selected]}`);
  }
});
