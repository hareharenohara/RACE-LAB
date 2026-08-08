import type { BetType, Strategy } from "./types.ts";
export interface StrategyPolicy {
  minimumDataQuality: number;
  minimumExpectedValue: number;
  allowedBetTypes: BetType[];
  maxStakePerRace: number;
  maxStakePerDay: number;
  objective: string;
}
export const STRATEGY_POLICIES: Record<Strategy, StrategyPolicy> = {
  conservative: {
    minimumDataQuality: .8,
    minimumExpectedValue: 1.12,
    allowedBetTypes: ["win", "place", "wide"],
    maxStakePerRace: 1000,
    maxStakePerDay: 3000,
    objective: "資金維持と的中安定性を最優先",
  },
  balanced: {
    minimumDataQuality: .68,
    minimumExpectedValue: 1.07,
    allowedBetTypes: ["win", "place", "wide", "quinella", "exacta", "trio"],
    maxStakePerRace: 2000,
    maxStakePerDay: 6000,
    objective: "回収率と安定性を両立",
  },
  aggressive: {
    minimumDataQuality: .58,
    minimumExpectedValue: 1.04,
    allowedBetTypes: [
      "win",
      "place",
      "wide",
      "quinella",
      "exacta",
      "trio",
      "trifecta",
    ],
    maxStakePerRace: 3000,
    maxStakePerDay: 10000,
    objective: "変動を許容し長期期待値を重視",
  },
};
export const strategyPrompt = (strategy: Strategy, balance: number) => {
  const p = STRATEGY_POLICIES[strategy];
  return `戦略=${strategy}。目的=${p.objective}。残高=${balance}円。必須条件: dataQuality>=${p.minimumDataQuality}、推定確率×提示オッズ>=${p.minimumExpectedValue}、許可馬券=${
    p.allowedBetTypes.join(",")
  }、1レース合計<=${p.maxStakePerRace}円、1日合計<=${p.maxStakePerDay}円。100円単位。最終回答前に馬番、馬券種、オッズ、推定確率、期待値、dataQuality、金額上限を自己確認する。条件を満たす候補を優先して探すが、基準を下げて無理に買わない。SKIPでもreference_pickに本命馬、参考買い目、見送り理由を残す。再提案は行わない。`;
};
