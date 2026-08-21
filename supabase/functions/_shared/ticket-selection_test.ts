import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import {
  selectTickets,
  validatePredictionProposal,
} from "./ticket-selection.ts";

const ranking = [
  [1, 7, .27, .64, "S"],
  [2, 11, .18, .56, "A"],
  [3, 3, .12, .42, "A"],
  [4, 9, .10, .38, "B"],
  [5, 2, .08, .34, "B"],
  [6, 5, .25, .66, "C"],
].map(([rank, horse, win, top3, confidence]) => ({
  rank: Number(rank),
  horse_number: Number(horse),
  horse_name: `馬${horse}`,
  mark: ["◎", "○", "▲", "△", "☆", "消"][Number(rank) - 1],
  win_probability: Number(win),
  top3_probability: Number(top3),
  confidence: confidence as "S" | "A" | "B" | "C",
  reason: "評価根拠",
}));

const candidates = [
  {
    type: "wide" as const,
    horses: [7, 11],
    hit_probability: .41,
    priority: 1,
    reason: "本線",
  },
  {
    type: "wide" as const,
    horses: [7, 3],
    hit_probability: .30,
    priority: 2,
    reason: "対抗",
  },
  {
    type: "win" as const,
    horses: [7],
    hit_probability: .27,
    priority: 3,
    reason: "勝ち切り",
  },
  {
    type: "place" as const,
    horses: [7],
    hit_probability: .64,
    priority: 4,
    reason: "安定",
  },
  {
    type: "quinella" as const,
    horses: [7, 11],
    hit_probability: .14,
    priority: 5,
    reason: "BOOST",
  },
];

Deno.test("proposal requires every runner and valid probabilities", () => {
  const errors = validatePredictionProposal(
    {
      race_id: "r",
      ranking,
      ticket_candidates: candidates,
    },
    "r",
    ranking.map((horse) => ({
      horseNumber: horse.horse_number,
      horseName: horse.horse_name,
    })),
  );
  assertEquals(errors, []);
});

Deno.test("normal mode calculates EV, applies caps, and records rejections", () => {
  const result = selectTickets({
    ranking,
    ticketCandidates: candidates,
    mode: "normal",
    budget: 1500,
    markets: [
      { type: "wide", horses: [7, 11], odds: 3.2, oddsMax: 3.8 },
      { type: "wide", horses: [7, 3], odds: 4.5, oddsMax: 5.2 },
      { type: "win", horses: [7], odds: 5.5 },
      { type: "place", horses: [7], odds: 2.1, oddsMax: 2.5 },
      { type: "quinella", horses: [7, 11], odds: 9.5 },
    ],
  });
  assert(result.purchases.length <= 3);
  assert(result.purchases.every((purchase) => purchase.stake % 100 === 0));
  assert(
    result.purchases.filter((purchase) => purchase.type === "wide")
      .reduce((sum, purchase) => sum + purchase.stake, 0) <= 1000,
  );
  assertEquals(
    result.decisions.find((decision) => decision.type === "quinella")
      ?.reasonCode,
    "BOOST_NOT_ALLOWED",
  );
  assert(
    result.decisions.every((decision) => decision.expectedValue !== undefined),
  );
});

Deno.test("attack allows only a quinella matching a purchased wide", () => {
  const result = selectTickets({
    ranking,
    ticketCandidates: candidates,
    mode: "attack",
    budget: 1500,
    markets: [
      { type: "wide", horses: [7, 11], odds: 3.2, oddsMax: 3.8 },
      { type: "wide", horses: [7, 3], odds: 4.5, oddsMax: 5.2 },
      { type: "win", horses: [7], odds: 5.5 },
      { type: "place", horses: [7], odds: 2.1, oddsMax: 2.5 },
      { type: "quinella", horses: [7, 11], odds: 12 },
    ],
  });
  const boost = result.purchases.find((purchase) =>
    purchase.type === "quinella"
  );
  if (boost) {
    assert(result.purchases.some((purchase) =>
      purchase.type === "wide" &&
      purchase.horses.join("-") === boost.horses.join("-")
    ));
    assert(boost.stake <= 300);
  }
});

Deno.test("locked or zero budget produces no purchase and keeps audits", () => {
  const result = selectTickets({
    ranking,
    ticketCandidates: candidates,
    mode: "locked",
    budget: 0,
    markets: [{ type: "wide", horses: [7, 11], odds: 3.2, oddsMax: 3.8 }],
  });
  assertEquals(result.purchases, []);
  assert(result.decisions.length === candidates.length);
});

Deno.test("pre-sale placeholders never reach EV calculation", () => {
  const result = selectTickets({
    ranking,
    ticketCandidates: [candidates[0]],
    markets: [{
      type: "wide",
      horses: [7, 11],
      odds: 9999.9,
      oddsMax: 0,
    }],
    mode: "normal",
    budget: 1500,
  });
  assertEquals(result.purchases, []);
  assertEquals(result.decisions[0].expectedValue, null);
  assertEquals(result.decisions[0].reasonCode, "ODDS_UNAVAILABLE");
});

Deno.test("challenge rescue requires non-negative EV and stays at 100 yen", () => {
  const result = selectTickets({
    ranking,
    ticketCandidates: [candidates[2]],
    markets: [{ type: "win", horses: [7], odds: 4 }],
    mode: "normal",
    budget: 500,
    challengeMode: true,
  });
  assertEquals(result.purchases.length, 1);
  assertEquals(result.purchases[0].reasonCode, "CHALLENGE_RESCUE");
  assertEquals(result.purchases[0].stake, 100);
});

Deno.test("confidence C is recorded as data uncertain even with high EV", () => {
  const lowConfidenceRanking = ranking.map((horse, index) =>
    index === 0 ? { ...horse, confidence: "C" as const } : horse
  );
  const result = selectTickets({
    ranking: lowConfidenceRanking,
    ticketCandidates: [{
      type: "win",
      horses: [7],
      hit_probability: .30,
      priority: 1,
      reason: "高オッズ",
    }],
    markets: [{ type: "win", horses: [7], odds: 10 }],
    mode: "normal",
    budget: 1000,
  });
  assertEquals(result.purchases.length, 0);
  assertEquals(result.decisions[0].reasonCode, "DATA_UNCERTAIN");
});
