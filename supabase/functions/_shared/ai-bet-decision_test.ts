import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  buildAiBetAudit,
  minimumHitReturn,
  validateAiBetDecision,
} from "./ai-bet-decision.ts";

const ranking = [1, 2, 3, 4, 5].map((horse, index) => ({
  rank: index + 1,
  horse_number: horse,
  horse_name: `馬${horse}`,
  mark: ["◎", "○", "▲", "△", "☆"][index],
  win_probability: [.30, .24, .19, .15, .12][index],
  top3_probability: [.70, .65, .60, .55, .50][index],
  confidence: index < 2 ? "A" : "B",
  reason: `馬${horse}を${index + 1}位とした能力・適性・展開理由`,
}));

const decision = {
  race_id: "r",
  action: "BET",
  overall_confidence: "A",
  reason: "AIが総合比較してこの買い目を選択",
  independent_basis: "参考指数は1番を支持したが拘束条件にはしていない",
  external_consensus_assessment: "外部評価の一致と対立を比較した",
  contradicting_evidence: ["2番を上位とする外部評価もある"],
  data_caveats: ["初コースの馬がいる"],
  budget_reason: "1500円のうち本線へ厚く配分",
  ranking,
  bets: [
    {
      bet_type: "wide",
      horses: [1, 2],
      hit_probability: .44,
      decision: "BUY",
      stake: 1000,
      reason: "AIの本線2頭",
      odds_assessment: "3.2倍なら確率との比較で勝負可能",
      stake_reason: "最も自信があるため予算の中心",
      risk: "2番が展開不利になる可能性",
    },
    {
      bet_type: "win",
      horses: [1],
      hit_probability: .30,
      decision: "REJECT",
      stake: 0,
      reason: "勝ち切りより連軸向き",
      odds_assessment: "単勝妙味はあるがワイドを優先",
      stake_reason: "本線へ資金を集中するため0円",
      risk: "差し届かない可能性",
    },
  ],
};

const context = {
  raceId: "r",
  runners: ranking.map((horse) => ({
    horseNumber: horse.horse_number,
    horseName: horse.horse_name,
  })),
  markets: [
    { type: "wide", horses: [1, 2], odds: 3.2, oddsMax: 3.8 },
    { type: "win", horses: [1], odds: 4.2 },
  ],
  mode: "normal" as const,
  maximumTotalStake: 1500,
  availableBalance: 100000,
  saleOpen: true,
};

Deno.test("AI bet and amount pass when only technical rules are satisfied", () => {
  assertEquals(validateAiBetDecision(decision, context), []);
  const audit = buildAiBetAudit(decision, context);
  assertEquals(audit.purchases.length, 1);
  assertEquals(audit.purchases[0].stake, 1000);
  assertEquals(audit.purchases[0].reasonCode, "AI_SELECTED");
  assertEquals(audit.decisions[1].reasonCode, "AI_REJECTED");
});

Deno.test("system does not reject an AI bet for low EV", () => {
  const lowOddsContext = {
    ...context,
    markets: [{ type: "wide", horses: [1, 2], odds: 1.2, oddsMax: 1.3 }, {
      type: "win",
      horses: [1],
      odds: 4.2,
    }],
  };
  assertEquals(validateAiBetDecision(decision, lowOddsContext), []);
  const audit = buildAiBetAudit(decision, lowOddsContext);
  if (Number(audit.purchases[0].expectedValue) >= 1) {
    throw new Error("test EV should be below one");
  }
});

Deno.test("system rejects only invalid odds, budget, and ticket mechanics", () => {
  const invalid = structuredClone(decision);
  invalid.bets[0].stake = 1600;
  const errors = validateAiBetDecision(invalid, {
    ...context,
    markets: [{ type: "wide", horses: [1, 2], odds: 9999.9, oddsMax: 0 }, {
      type: "win",
      horses: [1],
      odds: 4.2,
    }],
  });
  if (
    !errors.includes("有効な実オッズに存在しない買い目") ||
    !errors.includes("レース予算上限を超過")
  ) {
    throw new Error(`technical safeguards missing: ${errors}`);
  }
});

Deno.test("multiple tickets pass when every hit scenario returns the total stake", () => {
  const proposal = structuredClone(decision);
  proposal.bets = [
    { ...proposal.bets[0], stake: 800 },
    {
      ...proposal.bets[0],
      horses: [1, 3],
      stake: 400,
      reason: "押さえワイド",
    },
  ];
  const multiContext = {
    ...context,
    markets: [
      { type: "wide", horses: [1, 2], odds: 3.2, oddsMax: 3.8 },
      { type: "wide", horses: [1, 3], odds: 4.0, oddsMax: 4.8 },
    ],
  };
  assertEquals(minimumHitReturn(proposal.bets, multiContext), {
    minimumReturn: 1600,
    totalStake: 1200,
  });
  assertEquals(validateAiBetDecision(proposal, multiContext), []);
});

Deno.test("multiple tickets are rejected when a hit scenario is gami", () => {
  const proposal = structuredClone(decision);
  proposal.bets = [
    { ...proposal.bets[0], stake: 600 },
    {
      ...proposal.bets[0],
      horses: [1, 3],
      stake: 600,
      reason: "広げすぎた押さえワイド",
    },
  ];
  const multiContext = {
    ...context,
    markets: [
      { type: "wide", horses: [1, 2], odds: 1.5, oddsMax: 1.8 },
      { type: "wide", horses: [1, 3], odds: 1.6, oddsMax: 2.0 },
    ],
  };
  const errors = validateAiBetDecision(proposal, multiContext);
  if (!errors.some((error) => error.includes("的中しても回収割れ"))) {
    throw new Error(`gami portfolio was accepted: ${errors}`);
  }
});
