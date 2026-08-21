import { selectRaceAssessments } from "./adaptive-prompts.ts";

const assessment = (
  race_id: string,
  overrides: Record<string, unknown> = {},
) => ({
  race_id,
  scores: {
    anchor_clarity: 10,
    ranking_stability: 10,
    opponent_concentration: 8,
    wide_viability: 10,
    win_viability: 5,
    data_reliability: 5,
  },
  uncertainty_penalty: 10,
  selected: false,
  priority: null,
  budget_weight: 0,
  provisional_ranking: [
    { horse_number: 1, mark: "◎" },
    { horse_number: 2, mark: "○" },
  ],
  provisional_wide_pairs: [[1, 2]],
  provisional_win_candidate: 1,
  selection_reason: "AIが評価した勝負理由",
  decision_reason: "他レースと比較した選択理由",
  conflicts: [],
  risks: [],
  required_final_refresh: ["直前オッズ"],
  ...overrides,
});

const horses = new Map([
  ["r1", new Set([1, 2, 3])],
  ["r2", new Set([1, 2, 3])],
  ["r3", new Set([1, 2, 3])],
  ["r4", new Set([1, 2, 3])],
]);

Deno.test("system preserves the three races and priorities selected by AI", () => {
  const selected = selectRaceAssessments(
    {
      assessments: [
        assessment("r1", { selected: true, priority: 2, budget_weight: 30 }),
        assessment("r2"),
        assessment("r3", { selected: true, priority: 1, budget_weight: 50 }),
        assessment("r4", { selected: true, priority: 3, budget_weight: 20 }),
      ],
    },
    new Set(horses.keys()),
    horses,
  );
  if (selected.map((race) => race.race_id).join(",") !== "r3,r1,r4") {
    throw new Error("AI selection order was overwritten");
  }
});

Deno.test("low AI scores do not cause a system rejection", () => {
  const selected = selectRaceAssessments(
    {
      assessments: [
        assessment("r1", { selected: true, priority: 1, budget_weight: 100 }),
      ],
    },
    new Set(["r1"]),
    new Map([["r1", new Set([1, 2, 3])]]),
  );
  if (selected.length !== 1) throw new Error("system score gate still exists");
});

Deno.test("AI must select exactly three when three or more are available", () => {
  let threw = false;
  try {
    selectRaceAssessments(
      {
        assessments: [
          assessment("r1", { selected: true, priority: 1, budget_weight: 60 }),
          assessment("r2", { selected: true, priority: 2, budget_weight: 40 }),
          assessment("r3"),
          assessment("r4"),
        ],
      },
      new Set(horses.keys()),
      horses,
    );
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("AI was allowed to select fewer than three");
});

Deno.test("race selection requires every eligible race exactly once", () => {
  let threw = false;
  try {
    selectRaceAssessments(
      {
        assessments: [
          assessment("r1", { selected: true, priority: 1, budget_weight: 100 }),
        ],
      },
      new Set(["r1", "r2"]),
      horses,
    );
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("incomplete assessment was accepted");
});
