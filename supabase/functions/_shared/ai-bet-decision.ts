import { marketKey } from "./finalization.ts";
import { validateMarketOdds } from "./odds-validation.ts";
import type {
  ConfidenceGrade,
  TicketAuditDecision,
  TicketType,
} from "./ticket-selection.ts";

const HAIRCUT: Record<ConfidenceGrade, number> = {
  S: .95,
  A: .90,
  B: .85,
  C: .75,
};
const MIN_EV: Record<TicketType, number> = {
  wide: 0,
  win: 0,
  place: 0,
  quinella: 0,
};

export type AiBetContext = {
  raceId: string;
  runners: Array<{ horseNumber: number; horseName: string }>;
  markets: Array<
    { type: string; horses: number[]; odds: number; oddsMax?: number }
  >;
  mode: "normal" | "attack" | "locked";
  maximumTotalStake: number;
  availableBalance: number;
  saleOpen: boolean;
};

const probability = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
  value <= 1;

export function minimumHitReturn(
  buys: any[],
  context: AiBetContext,
): { minimumReturn: number; totalStake: number } | null {
  const markets = new Map(
    context.markets.filter((market) => validateMarketOdds(market).valid)
      .map((market) => [marketKey(market.type, market.horses), market]),
  );
  const purchased = buys.map((bet) => ({
    ...bet,
    stake: Number(bet.stake),
    market: markets.get(marketKey(bet.bet_type, bet.horses)),
  })).filter((bet) => bet.market && bet.stake >= 100);
  if (purchased.length < 2) return null;
  const totalStake = purchased.reduce((sum, bet) => sum + bet.stake, 0);
  const numbers = context.runners.map((runner) => runner.horseNumber);
  const placeCount = numbers.length >= 8 ? 3 : 2;
  let minimumReturn = Number.POSITIVE_INFINITY;
  for (const first of numbers) for (const second of numbers) {
    if (second === first) continue;
    for (const third of numbers) {
      if (third === first || third === second) continue;
      const top3 = new Set([first, second, third]);
      const top2 = new Set([first, second]);
      let scenarioReturn = 0;
      for (const bet of purchased) {
        const horses = bet.horses.map(Number);
        const hit = bet.bet_type === "win"
          ? horses[0] === first
          : bet.bet_type === "place"
          ? [first, second, third].slice(0, placeCount).includes(horses[0])
          : bet.bet_type === "wide"
          ? horses.every((horse: number) => top3.has(horse))
          : bet.bet_type === "quinella"
          ? horses.every((horse: number) => top2.has(horse))
          : false;
        if (hit) scenarioReturn += Math.floor(bet.stake * Number(bet.market.odds));
      }
      if (scenarioReturn > 0) minimumReturn = Math.min(minimumReturn, scenarioReturn);
    }
  }
  return Number.isFinite(minimumReturn) ? { minimumReturn, totalStake } : null;
}

export function validateAiBetDecision(
  value: any,
  context: AiBetContext,
): string[] {
  const errors: string[] = [];
  if (String(value?.race_id) !== context.raceId) {
    errors.push("race_idが対象レースと一致しない");
  }
  for (
    const field of [
      "reason",
      "independent_basis",
      "external_consensus_assessment",
      "budget_reason",
    ]
  ) {
    if (!String(value?.[field] ?? "").trim()) errors.push(`${field}が未記載`);
  }
  if (!Array.isArray(value?.contradicting_evidence)) {
    errors.push("反対材料が未記載");
  }
  if (!Array.isArray(value?.data_caveats)) errors.push("データ注意点が未記載");

  const ranking = Array.isArray(value?.ranking) ? value.ranking : [];
  const validNumbers = new Set(
    context.runners.map((runner) => runner.horseNumber),
  );
  const nameByNumber = new Map(
    context.runners.map((
      runner,
    ) => [runner.horseNumber, runner.horseName.trim()]),
  );
  const ranks = ranking.map((horse: any) => Number(horse.rank));
  const numbers = ranking.map((horse: any) => Number(horse.horse_number));
  if (
    ranking.length !== context.runners.length || ranking.length < 5 ||
    new Set(ranks).size !== ranking.length ||
    new Set(numbers).size !== ranking.length ||
    ranks.some((rank: number) =>
      !Number.isInteger(rank) || rank < 1 || rank > ranking.length
    ) ||
    numbers.some((number: number) => !validNumbers.has(number))
  ) errors.push("全出走馬の順位が不正");
  for (const horse of ranking) {
    if (
      !probability(horse.win_probability) ||
      !probability(horse.top3_probability) ||
      horse.win_probability > horse.top3_probability
    ) errors.push("馬別確率が不正");
    if (!["S", "A", "B", "C"].includes(horse.confidence)) {
      errors.push("馬別信頼度が不正");
    }
    if (
      String(horse.horse_name ?? "").trim() !==
        nameByNumber.get(Number(horse.horse_number))
    ) {
      errors.push("馬名が出走表と一致しない");
    }
    if (!String(horse.reason ?? "").trim()) errors.push("馬別理由が未記載");
  }

  const markets = new Map(
    context.markets.filter((market) => validateMarketOdds(market).valid)
      .map((market) => [marketKey(market.type, market.horses), market]),
  );
  const bets = Array.isArray(value?.bets) ? value.bets : [];
  const seen = new Set<string>();
  let totalStake = 0;
  for (const bet of bets) {
    const type = String(bet.bet_type) as TicketType;
    if (!["win", "place", "wide", "quinella"].includes(type)) {
      errors.push("対象外券種");
    }
    const horses = Array.isArray(bet.horses) ? bet.horses.map(Number) : [];
    const required = ["wide", "quinella"].includes(type) ? 2 : 1;
    if (
      horses.length !== required || new Set(horses).size !== required ||
      horses.some((horse: number) => !validNumbers.has(horse))
    ) errors.push("買い目の馬番が不正");
    const key = marketKey(type, horses);
    if (seen.has(key)) errors.push("買い目分析が重複");
    seen.add(key);
    if (!markets.has(key)) errors.push("有効な実オッズに存在しない買い目");
    if (!probability(bet.hit_probability)) errors.push("馬券的中確率が不正");
    for (const field of ["reason", "odds_assessment", "stake_reason", "risk"]) {
      if (!String(bet?.[field] ?? "").trim()) {
        errors.push(`馬券の${field}が未記載`);
      }
    }
    const stake = Number(bet.stake);
    if (bet.decision === "BUY") {
      if (!context.saleOpen) errors.push("発売時間外");
      if (!Number.isInteger(stake) || stake < 100 || stake % 100 !== 0) {
        errors.push("購入額が100円単位ではない");
      }
      totalStake += Number.isFinite(stake) ? stake : 0;
    } else if (bet.decision === "REJECT") {
      if (stake !== 0) errors.push("見送り馬券の金額は0円ではない");
    } else errors.push("馬券判断が不正");
  }
  const buys = bets.filter((bet: any) => bet.decision === "BUY");
  if (value?.action === "BET" && !buys.length) {
    errors.push("BETなのに購入馬券がない");
  }
  if (value?.action === "SKIP" && buys.length) {
    errors.push("SKIPなのに購入馬券がある");
  }
  if (!["BET", "SKIP"].includes(value?.action)) errors.push("最終actionが不正");
  if (context.mode === "locked" && buys.length) {
    errors.push("資金ロック中の購入");
  }
  if (totalStake > context.maximumTotalStake) {
    errors.push("レース予算上限を超過");
  }
  if (totalStake > context.availableBalance) errors.push("利用可能残高を超過");
  const returnFloor = minimumHitReturn(buys, context);
  if (returnFloor && returnFloor.minimumReturn < returnFloor.totalStake) {
    errors.push(
      `的中しても回収割れする買い方（最低払戻${returnFloor.minimumReturn}円／購入総額${returnFloor.totalStake}円）。買い目か配分を絞ること`,
    );
  }
  const boughtKeys = new Set(
    buys.map((bet: any) => marketKey(bet.bet_type, bet.horses)),
  );
  for (const bet of buys.filter((bet: any) => bet.bet_type === "quinella")) {
    if (context.mode !== "attack") errors.push("NORMAL時の馬連購入");
    if (!boughtKeys.has(marketKey("wide", bet.horses))) {
      errors.push("馬連に対応する購入ワイドがない");
    }
  }
  return [...new Set(errors)];
}

function worstConfidence(grades: ConfidenceGrade[]): ConfidenceGrade {
  return [...grades].sort((a, b) => HAIRCUT[a] - HAIRCUT[b])[0] ?? "C";
}

export function buildAiBetAudit(value: any, context: AiBetContext): {
  purchases: TicketAuditDecision[];
  decisions: TicketAuditDecision[];
} {
  const ranking = new Map<number, any>(
    (value.ranking ?? []).map((
      horse: any,
    ) => [Number(horse.horse_number), horse]),
  );
  const markets = new Map(
    context.markets.map((
      market,
    ) => [marketKey(market.type, market.horses), market]),
  );
  const decisions: TicketAuditDecision[] = (value.bets ?? []).map(
    (bet: any): TicketAuditDecision => {
      const market = markets.get(marketKey(bet.bet_type, bet.horses));
      const confidence = worstConfidence(
        bet.horses.map((horse: number) =>
          ranking.get(Number(horse))?.confidence ?? "C"
        ),
      );
      const rawProbability = Number(bet.hit_probability);
      const calibratedProbability = rawProbability * HAIRCUT[confidence];
      const odds = Number(market?.odds);
      const expectedValue = calibratedProbability * odds;
      const purchased = bet.decision === "BUY";
      return {
        type: bet.bet_type,
        horses: bet.horses.map(Number),
        rawProbability,
        calibratedProbability,
        confidence,
        odds,
        oddsMax: market?.oddsMax == null ? null : Number(market.oddsMax),
        expectedValue,
        minimumExpectedValue: MIN_EV[bet.bet_type as TicketType],
        ticketScore: null,
        decision: purchased ? "purchased" : "rejected",
        reasonCode: purchased ? "AI_SELECTED" : "AI_REJECTED",
        reasonDetail:
          `${bet.reason} / オッズ評価: ${bet.odds_assessment} / リスク: ${bet.risk}`,
        stake: purchased ? Number(bet.stake) : 0,
        reason: bet.reason,
      };
    },
  );
  return {
    purchases: decisions.filter((decision) =>
      decision.decision === "purchased"
    ),
    decisions,
  };
}
