import { marketKey } from "./finalization.ts";
import { validateMarketOdds } from "./odds-validation.ts";

export type TicketType = "win" | "place" | "wide" | "quinella";
export type ConfidenceGrade = "S" | "A" | "B" | "C";

export type HorseProbability = {
  rank: number;
  horse_number: number;
  horse_name: string;
  mark: string;
  win_probability: number;
  top3_probability: number;
  confidence: ConfidenceGrade;
  reason: string;
};

export type TicketCandidate = {
  type: TicketType;
  horses: number[];
  hit_probability: number;
  priority: number;
  reason: string;
};

export type TicketSelectionInput = {
  ranking: HorseProbability[];
  ticketCandidates: TicketCandidate[];
  markets: Array<
    { type: string; horses: number[]; odds: number; oddsMax?: number }
  >;
  mode: "normal" | "attack" | "locked";
  budget: number;
  challengeMode?: boolean;
};

export type TicketAuditDecision = {
  type: TicketType;
  horses: number[];
  rawProbability: number;
  calibratedProbability: number;
  confidence: ConfidenceGrade;
  odds: number | null;
  oddsMax: number | null;
  expectedValue: number | null;
  minimumExpectedValue: number;
  ticketScore: number | null;
  decision: "purchased" | "rejected";
  reasonCode: string;
  reasonDetail: string;
  stake: number;
  reason: string;
};

export type TicketSelectionResult = {
  normalizedRanking: Array<
    HorseProbability & {
      normalized_win_probability: number;
      normalized_top3_probability: number;
      calibrated_win_probability: number;
      calibrated_top3_probability: number;
    }
  >;
  purchases: TicketAuditDecision[];
  decisions: TicketAuditDecision[];
};

const HAIRCUT: Record<ConfidenceGrade, number> = {
  S: .95,
  A: .90,
  B: .85,
  C: .75,
};
const CONFIDENCE_SCORE: Record<ConfidenceGrade, number> = {
  S: 1,
  A: .8,
  B: .6,
  C: .4,
};
const TYPE_MULTIPLIER: Record<TicketType, number> = {
  wide: 1.05,
  win: 1,
  place: .95,
  quinella: .90,
};
const MIN_EV: Record<TicketType, number> = {
  wide: 1.10,
  win: 1.15,
  place: 1.15,
  quinella: 1.20,
};
const TYPE_CAP: Record<TicketType, number> = {
  wide: .70,
  win: .40,
  place: .40,
  quinella: .25,
};

const finiteProbability = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
  value <= 1;

function normalizeToTarget(
  values: number[],
  requestedTarget: number,
): number[] {
  const target = Math.min(requestedTarget, values.length);
  const result = Array(values.length).fill(0);
  let remaining = target;
  let active = values.map((_, index) => index);
  while (active.length && remaining > 1e-12) {
    const sum = active.reduce((total, index) => total + values[index], 0);
    if (sum <= 0) {
      const share = Math.min(1, remaining / active.length);
      for (const index of active) result[index] = share;
      break;
    }
    const capped: number[] = [];
    for (const index of active) {
      const proposed = values[index] / sum * remaining;
      if (proposed >= 1) {
        result[index] = 1;
        remaining -= 1;
        capped.push(index);
      }
    }
    if (!capped.length) {
      for (const index of active) {
        result[index] = values[index] / sum * remaining;
      }
      break;
    }
    active = active.filter((index) => !capped.includes(index));
  }
  return result;
}

export function validatePredictionProposal(
  value: any,
  raceId: string,
  runners: Array<{ horseNumber: number; horseName: string }>,
): string[] {
  const errors: string[] = [];
  if (String(value?.race_id) !== raceId) {
    errors.push("race_idが対象レースと一致しない");
  }
  const ranking = Array.isArray(value?.ranking) ? value.ranking : [];
  if (ranking.length !== runners.length || ranking.length < 5) {
    errors.push("全出走馬の順位が必要");
  }
  const validNumbers = new Set(runners.map((runner) => runner.horseNumber));
  const nameByNumber = new Map(
    runners.map((runner) => [runner.horseNumber, runner.horseName.trim()]),
  );
  const ranks = ranking.map((horse: any) => Number(horse.rank));
  const numbers = ranking.map((horse: any) => Number(horse.horse_number));
  if (
    new Set(ranks).size !== ranking.length ||
    new Set(numbers).size !== ranking.length ||
    ranks.some((rank: number) =>
      !Number.isInteger(rank) || rank < 1 || rank > runners.length
    ) ||
    numbers.some((number: number) => !validNumbers.has(number))
  ) errors.push("全出走馬の順位または馬番が不正");
  for (const horse of ranking) {
    if (
      !finiteProbability(horse.win_probability) ||
      !finiteProbability(horse.top3_probability) ||
      horse.win_probability > horse.top3_probability
    ) errors.push("馬別確率が不正");
    if (!["S", "A", "B", "C"].includes(horse.confidence)) {
      errors.push("馬別信頼度が不正");
    }
    if (
      String(horse.horse_name ?? "").trim() !==
        nameByNumber.get(Number(horse.horse_number))
    ) errors.push("馬名が出走表と一致しない");
    if (!String(horse.reason ?? "").trim()) errors.push("馬別評価理由が未記載");
  }
  const candidates = Array.isArray(value?.ticket_candidates)
    ? value.ticket_candidates
    : [];
  if (candidates.length > 7) errors.push("候補馬券が多すぎる");
  const counts = new Map<string, number>();
  const candidateKeys = new Set<string>();
  for (const candidate of candidates) {
    const type = String(candidate.type);
    if (!["win", "place", "wide", "quinella"].includes(type)) {
      errors.push("候補券種が不正");
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
    const horses = Array.isArray(candidate.horses)
      ? candidate.horses.map(Number)
      : [];
    const required = ["wide", "quinella"].includes(type) ? 2 : 1;
    if (
      horses.length !== required || new Set(horses).size !== required ||
      horses.some((horse: number) => !validNumbers.has(horse))
    ) errors.push("候補馬券の馬番が不正");
    const key = marketKey(type, horses);
    if (candidateKeys.has(key)) errors.push("候補馬券が重複");
    candidateKeys.add(key);
    if (!finiteProbability(candidate.hit_probability)) {
      errors.push("候補馬券の的中確率が不正");
    }
    if (!Number.isInteger(candidate.priority) || candidate.priority < 1) {
      errors.push("候補馬券の優先順位が不正");
    }
    if (!String(candidate.reason ?? "").trim()) {
      errors.push("候補馬券の理由が未記載");
    }
  }
  if (
    (counts.get("wide") ?? 0) > 4 || (counts.get("win") ?? 0) > 1 ||
    (counts.get("place") ?? 0) > 1 || (counts.get("quinella") ?? 0) > 1
  ) errors.push("券種別候補上限を超過");
  return [...new Set(errors)];
}

function worstConfidence(grades: ConfidenceGrade[]): ConfidenceGrade {
  return [...grades].sort((a, b) => HAIRCUT[a] - HAIRCUT[b])[0] ?? "C";
}

function structuralReason(
  candidate: TicketCandidate,
  rankByHorse: Map<number, number>,
  mode: string,
): string | null {
  const ranks = candidate.horses.map((horse) => rankByHorse.get(horse) ?? 999);
  if (candidate.type === "win" && ranks[0] !== 1) return "NOT_MAIN_HORSE";
  if (candidate.type === "place" && ranks[0] !== 1) return "NOT_MAIN_HORSE";
  if (candidate.type === "wide") {
    const key = [...ranks].sort((a, b) => a - b).join("-");
    if (!["1-2", "1-3", "2-3", "1-4"].includes(key)) return "NOT_MAIN_HORSE";
  }
  if (candidate.type === "quinella" && mode !== "attack") {
    return "BOOST_NOT_ALLOWED";
  }
  return null;
}

function thresholdReason(
  type: TicketType,
  probability: number,
  odds: number,
  ev: number,
): string | null {
  if (type === "wide" && probability < .25) return "PROBABILITY_TOO_LOW";
  if (type === "win" && probability < .15) return "PROBABILITY_TOO_LOW";
  if (type === "place" && probability < .60) return "PROBABILITY_TOO_LOW";
  if (type === "place" && odds < 1.5) return "ODDS_TOO_LOW";
  if (type === "quinella" && probability < .10) return "PROBABILITY_TOO_LOW";
  if (ev < MIN_EV[type]) return "EV_BELOW_THRESHOLD";
  return null;
}

function allocateStakes(
  selected: TicketAuditDecision[],
  budget: number,
): TicketAuditDecision[] {
  const budgetUnits = Math.floor(budget / 100);
  const affordable = selected.slice(0, budgetUnits);
  const allocated = affordable.map((decision) => ({ ...decision, stake: 100 }));
  const typeUnits = new Map<TicketType, number>();
  for (const decision of allocated) {
    typeUnits.set(decision.type, (typeUnits.get(decision.type) ?? 0) + 1);
  }
  let remaining = budgetUnits - allocated.length;
  while (remaining > 0) {
    const candidates = allocated.filter((decision) => {
      if (decision.reasonCode === "CHALLENGE_RESCUE") return false;
      const cap = Math.floor(budgetUnits * TYPE_CAP[decision.type]);
      return (typeUnits.get(decision.type) ?? 0) < cap;
    });
    if (!candidates.length) break;
    candidates.sort((a, b) =>
      (Number(b.ticketScore) / (b.stake / 100 + 1)) -
      (Number(a.ticketScore) / (a.stake / 100 + 1))
    );
    candidates[0].stake += 100;
    typeUnits.set(
      candidates[0].type,
      (typeUnits.get(candidates[0].type) ?? 0) + 1,
    );
    remaining--;
  }
  return allocated;
}

export function selectTickets(
  input: TicketSelectionInput,
): TicketSelectionResult {
  const ordered = [...input.ranking].sort((a, b) => a.rank - b.rank);
  const winNormalized = normalizeToTarget(
    ordered.map((horse) => horse.win_probability),
    1,
  );
  const top3Normalized = normalizeToTarget(
    ordered.map((horse) => horse.top3_probability),
    3,
  );
  const normalizedRanking = ordered.map((horse, index) => {
    const normalizedTop3 = top3Normalized[index];
    const normalizedWin = Math.min(winNormalized[index], normalizedTop3);
    return {
      ...horse,
      normalized_win_probability: normalizedWin,
      normalized_top3_probability: normalizedTop3,
      calibrated_win_probability: normalizedWin * HAIRCUT[horse.confidence],
      calibrated_top3_probability: normalizedTop3 * HAIRCUT[horse.confidence],
    };
  });
  const horseByNumber = new Map(
    normalizedRanking.map((horse) => [horse.horse_number, horse]),
  );
  const rankByHorse = new Map(
    normalizedRanking.map((horse) => [horse.horse_number, horse.rank]),
  );
  const marketByKey = new Map(
    input.markets.map((
      market,
    ) => [marketKey(market.type, market.horses), market]),
  );
  const decisions: TicketAuditDecision[] = input.ticketCandidates.map(
    (candidate) => {
      const type = candidate.type;
      const horses = candidate.horses.map((horse) => horseByNumber.get(horse))
        .filter(Boolean) as typeof normalizedRanking;
      const confidence = worstConfidence(
        horses.map((horse) => horse.confidence),
      );
      const rawProbability = type === "win"
        ? horses[0]?.normalized_win_probability ?? 0
        : type === "place"
        ? horses[0]?.normalized_top3_probability ?? 0
        : candidate.hit_probability;
      const calibratedProbability = rawProbability * HAIRCUT[confidence];
      const market = marketByKey.get(marketKey(type, candidate.horses));
      const oddsValidation = market
        ? validateMarketOdds({
          type: market.type,
          odds: Number(market.odds),
          oddsMax: market.oddsMax,
        })
        : { valid: false, reason: "ODDS_UNAVAILABLE" as const };
      const odds = market && oddsValidation.valid ? Number(market.odds) : null;
      const expectedValue = odds == null ? null : calibratedProbability * odds;
      const structural = structuralReason(candidate, rankByHorse, input.mode);
      const threshold = odds == null || expectedValue == null
        ? oddsValidation.reason ?? "ODDS_UNAVAILABLE"
        : thresholdReason(type, calibratedProbability, odds, expectedValue);
      const standardRescue = threshold === "EV_BELOW_THRESHOLD" &&
        expectedValue != null &&
        expectedValue >= 1.05 && confidence === "S";
      const challengeRescue = input.challengeMode === true &&
        threshold === "EV_BELOW_THRESHOLD" && expectedValue != null &&
        expectedValue >= 1.00 && ["S", "A"].includes(confidence);
      const rescue = standardRescue || challengeRescue;
      const dataQuality = confidence === "C" ? "DATA_UNCERTAIN" : null;
      const reasonCode = structural ?? dataQuality ??
        (rescue ? null : threshold);
      const ticketScore = expectedValue == null
        ? null
        : (expectedValue * 50 + calibratedProbability * 30 +
          CONFIDENCE_SCORE[confidence] * 20) *
          TYPE_MULTIPLIER[type];
      return {
        type,
        horses: candidate.horses,
        rawProbability,
        calibratedProbability,
        confidence,
        odds,
        oddsMax: market?.oddsMax == null ? null : Number(market.oddsMax),
        expectedValue,
        minimumExpectedValue: MIN_EV[type],
        ticketScore,
        decision: reasonCode ? "rejected" : "purchased",
        reasonCode: reasonCode ??
          (challengeRescue
            ? "CHALLENGE_RESCUE"
            : standardRescue
            ? "RESCUE_HIGH_CONFIDENCE"
            : "ELIGIBLE"),
        reasonDetail: reasonCode
          ? `${reasonCode}: EV=${expectedValue?.toFixed(3) ?? "N/A"}`
          : challengeRescue
          ? `チャレンジ枠の100円限定候補: EV=${expectedValue?.toFixed(3)}`
          : standardRescue
          ? `S信頼度の少額救済候補: EV=${expectedValue?.toFixed(3)}`
          : `券種条件を通過: EV=${expectedValue?.toFixed(3)}`,
        stake: 0,
        reason: candidate.reason,
      };
    },
  );

  const eligible = decisions.filter((decision) =>
    decision.decision === "purchased"
  )
    .sort((a, b) => Number(b.ticketScore) - Number(a.ticketScore));
  const selected: TicketAuditDecision[] = [];
  const typeCount = new Map<TicketType, number>();
  for (
    const decision of eligible.filter((decision) =>
      decision.type !== "quinella"
    )
  ) {
    if (selected.length >= 3) break;
    const cap = decision.type === "wide" ? 2 : 1;
    if ((typeCount.get(decision.type) ?? 0) >= cap) continue;
    if (
      decision.type === "wide" && (typeCount.get("wide") ?? 0) === 1 &&
      Number(decision.expectedValue) < 1.15 &&
      !["RESCUE_HIGH_CONFIDENCE", "CHALLENGE_RESCUE"].includes(
        decision.reasonCode,
      )
    ) continue;
    selected.push(decision);
    typeCount.set(decision.type, (typeCount.get(decision.type) ?? 0) + 1);
  }

  if (input.mode === "attack") {
    const matchingQuinella = eligible.filter((decision) =>
      decision.type === "quinella"
    )
      .find((quinella) =>
        selected.some((wide) =>
          wide.type === "wide" &&
          marketKey("wide", wide.horses).slice(5) ===
            marketKey("wide", quinella.horses).slice(5)
        )
      );
    if (matchingQuinella) {
      if (selected.length < 3) selected.push(matchingQuinella);
      else {
        const replaceable = selected.filter((decision) =>
          decision.type !== "wide"
        )
          .sort((a, b) => Number(a.ticketScore) - Number(b.ticketScore))[0];
        if (
          replaceable &&
          Number(matchingQuinella.ticketScore) > Number(replaceable.ticketScore)
        ) {
          selected.splice(selected.indexOf(replaceable), 1, matchingQuinella);
        }
      }
    }
  }

  const selectedKeys = new Set(
    selected.map((decision) => marketKey(decision.type, decision.horses)),
  );
  for (const decision of decisions) {
    if (
      decision.decision === "purchased" &&
      !selectedKeys.has(marketKey(decision.type, decision.horses))
    ) {
      decision.decision = "rejected";
      decision.reasonCode = decision.type === "quinella"
        ? "NO_MATCHING_WIDE"
        : "TOO_MANY_TICKETS";
      decision.reasonDetail = decision.reasonCode;
    }
  }

  const purchases = allocateStakes(
    selected.filter((decision) =>
      selectedKeys.has(marketKey(decision.type, decision.horses))
    ),
    input.budget,
  );
  const purchaseByKey = new Map(
    purchases.map((
      purchase,
    ) => [marketKey(purchase.type, purchase.horses), purchase]),
  );
  for (const decision of decisions) {
    const purchase = purchaseByKey.get(
      marketKey(decision.type, decision.horses),
    );
    if (purchase) {
      Object.assign(decision, purchase, {
        decision: "purchased",
        reasonCode: purchase.reasonCode,
      });
    } else if (decision.decision === "purchased") {
      decision.decision = "rejected";
      decision.reasonCode = "BUDGET_LIMIT";
      decision.reasonDetail = "100円単位の予算配分対象外";
    }
  }
  return { normalizedRanking, purchases, decisions };
}
