import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import { callGemini, MODEL } from "../_shared/gemini-client.ts";
import { STRATEGIES } from "../_shared/ai-contracts.ts";
import { STRATEGY_POLICIES } from "../_shared/strategy-policy.ts";
import { JraProvider } from "../_shared/jra-provider.ts";
import {
  evaluateRace,
  type EvaluationWeights,
} from "../_shared/horse-evaluation.ts";
import {
  calibrateProbability,
  type CalibrationProfile,
} from "../_shared/probability-calibrator.ts";
import {
  betCandidateKey,
  buildBetCandidates,
  candidateRejectionReason,
} from "../_shared/bet-candidates.ts";
import type { PastRun, RaceSummary, Strategy } from "../_shared/types.ts";
import { nextAnalysisChunk } from "../_shared/pipeline.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const hash = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const SELECTION_SCHEMA = {
  type: "object",
  properties: {
    selections: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          race_id: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          reason: { type: "string" },
        },
        required: ["race_id", "score", "reason"],
      },
    },
  },
  required: ["selections"],
};

const PREDICTION_SCHEMA = {
  type: "object",
  properties: {
    predictions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          race_id: { type: "string" },
          action: { type: "string", enum: ["BET", "SKIP"] },
          candidate_id: { type: "string", nullable: true },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          stake: { type: "integer", minimum: 0 },
          reason: { type: "string" },
          stake_reason: { type: "string" },
        },
        required: [
          "race_id",
          "action",
          "candidate_id",
          "confidence",
          "stake",
          "reason",
          "stake_reason",
        ],
      },
    },
  },
  required: ["predictions"],
};

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          strategy: { type: "string", enum: STRATEGIES },
          race_id: { type: "string" },
          approved: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["strategy", "race_id", "approved", "reason"],
      },
    },
  },
  required: ["decisions"],
};

const SINGLE_SCREEN_SCHEMA = {
  type: "object",
  properties: { analyses: { type: "array", items: { type: "object", properties: {
    race_id: { type: "string" }, predictability: { type: "integer", minimum: 0, maximum: 100 },
    axis_reliability: { type: "integer", minimum: 0, maximum: 100 }, pace_clarity: { type: "integer", minimum: 0, maximum: 100 },
    data_confidence: { type: "integer", minimum: 0, maximum: 100 }, key_horses: { type: "array", items: { type: "integer" } },
    risks: { type: "array", items: { type: "string" } }, reason: { type: "string" },
  }, required: ["race_id", "predictability", "axis_reliability", "pace_clarity", "data_confidence", "key_horses", "risks", "reason"] } } },
  required: ["analyses"],
};
const SINGLE_SYNTHESIS_SCHEMA = {
  type: "object", properties: { selections: { type: "array", maxItems: 12, items: { type: "object", properties: {
    race_id: { type: "string" }, priority: { type: "integer", minimum: 1, maximum: 100 }, reason: { type: "string" },
  }, required: ["race_id", "priority", "reason"] } } }, required: ["selections"],
};
const SINGLE_DEEP_SCHEMA = {
  type: "object", properties: { analyses: { type: "array", items: { type: "object", properties: {
    race_id: { type: "string" }, axis_horses: { type: "array", items: { type: "integer" } }, opponent_horses: { type: "array", items: { type: "integer" } },
    dark_horses: { type: "array", items: { type: "integer" } }, avoid_horses: { type: "array", items: { type: "integer" } },
    pace_scenario: { type: "string" }, confidence: { type: "integer", minimum: 0, maximum: 100 }, strengths: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } }, recommended_ticket_types: { type: "array", items: { type: "string", enum: ["win","place","wide","quinella","exacta","trio","trifecta"] } },
  }, required: ["race_id","axis_horses","opponent_horses","dark_horses","avoid_horses","pace_scenario","confidence","strengths","risks","recommended_ticket_types"] } } }, required: ["analyses"],
};
const SINGLE_PROPOSAL_SCHEMA = {
  type: "object", properties: { tickets: { type: "array", maxItems: 20, items: { type: "object", properties: {
    proposal_id: { type: "string" }, race_id: { type: "string" }, type: { type: "string", enum: ["win","place","wide","quinella","exacta","trio","trifecta"] },
    horses: { type: "array", items: { type: "integer" } }, stake: { type: "integer", minimum: 500, maximum: 10000 }, confidence: { type: "integer", minimum: 0, maximum: 100 },
    reason: { type: "string" }, stake_reason: { type: "string" },
  }, required: ["proposal_id","race_id","type","horses","stake","confidence","reason","stake_reason"] } },
  overall_reason: { type: "string" } }, required: ["tickets","overall_reason"],
};
const SINGLE_FINAL_SCHEMA = {
  type: "object", properties: { decisions: { type: "array", maxItems: 20, items: { type: "object", properties: {
    proposal_id: { type: "string" }, action: { type: "string", enum: ["BET","SKIP"] }, stake: { type: "integer", minimum: 0, maximum: 10000 }, reason: { type: "string" },
  }, required: ["proposal_id","action","stake","reason"] } }, overall_reason: { type: "string" } }, required: ["decisions","overall_reason"],
};

async function aiCall(
  db: any,
  batchId: string,
  purpose: "screening" | "prediction" | "audit",
  strategy: Strategy | "single" | null,
  prompt: string,
  schema: Record<string, unknown>,
) {
  const inputHash = await hash({ prompt, schema });
  const { data: callId, error } = await db.rpc("reserve_ai_call", {
    p_batch_run_id: batchId,
    p_purpose: purpose,
    p_strategy: strategy,
    p_model: MODEL,
    p_prompt_version: "single-v1",
    p_input_hash: inputHash,
    p_request_json: { prompt, schema },
  });
  if (error) throw new Error(error.message);
  try {
    const result = await callGemini(prompt, schema);
    await db.from("ai_calls").update({
      status: "succeeded",
      response_json: result.raw,
      output_hash: await hash(result.value),
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      completed_at: new Date().toISOString(),
    }).eq("id", callId);
    return { ...result, callId, inputHash };
  } catch (error) {
    await db.from("ai_calls").update({
      status: "failed",
      error_message: String(error),
      completed_at: new Date().toISOString(),
    }).eq("id", callId);
    throw error;
  }
}

const nextStage = (stage: string) => {
  const order = [
    "selection:conservative",
    "selection:balanced",
    "selection:aggressive",
    "prediction:conservative",
    "prediction:balanced",
    "prediction:aggressive",
    "audit",
  ];
  return order[order.indexOf(stage) + 1] ?? "complete";
};

const cleanRace = (race: any) => ({
  race_id: String(race.race_id),
  track: race.track,
  race_number: race.race_number,
  race_name: race.race_name,
  race_class: race.race_class,
  start_time: race.start_time,
  surface: race.surface,
  distance: race.distance,
  runner_count: race.runner_count,
  top_horses: race.top_horses,
  candidates: (race.candidates ?? []).filter((candidate: any) =>
    candidate.eligible
  ).map((candidate: any) => ({
    candidate_id: candidate.candidate_id,
    type: candidate.type,
    horses: candidate.horses,
    odds: candidate.odds,
    estimated_probability: candidate.estimated_probability,
    expected_value: candidate.expected_value,
    data_quality: candidate.data_quality,
  })),
});

async function runAnalysis(db: any, batch: any, metadata: any) {
  const queue: any[] = Array.isArray(metadata.race_queue)
    ? metadata.race_queue
    : [];
  const offset = Number(metadata.analysis_offset ?? 0);
  const page = nextAnalysisChunk<any>(
    queue,
    offset,
    Number(metadata.analysis_chunk_size ?? 4),
  );
  const chunk = page.items;
  if (!chunk.length) {
    return {
      ...metadata,
      pipeline_stage: "selection:conservative",
      analysis_offset: queue.length,
    };
  }
  const provider = new JraProvider();
  const { data: weightProfile, error: weightError } = await db.from(
    "evaluation_weight_profiles",
  ).select(
    "id,ability_weight,suitability_weight,condition_weight,race_context_weight,formula_version",
  ).eq("is_active", true).single();
  if (weightError || !weightProfile) {
    throw weightError ?? new Error("WEIGHTS_MISSING");
  }
  const weights: EvaluationWeights = {
    ability: Number(weightProfile.ability_weight),
    suitability: Number(weightProfile.suitability_weight),
    condition: Number(weightProfile.condition_weight),
    raceContext: Number(weightProfile.race_context_weight),
  };
  const additions: Record<string, any[]> = { single: [] };
  let historyRows = 0, historyErrors = 0;
  for (const item of chunk) {
    const summary: RaceSummary = {
      externalId: String(item.external_id),
      raceDate: String(batch.target_date),
      track: String(item.track),
      raceNumber: Number(item.race_number),
      raceName: String(item.race_name),
      raceClass: item.race_class ?? undefined,
      startTime: String(item.start_time),
      surface: item.surface ?? undefined,
      distance: item.distance == null ? undefined : Number(item.distance),
      sourceUrl: `https://race.netkeiba.com/race/shutuba.html?race_id=${
        String(item.external_id).replace("jra:", "")
      }`,
    };
    const detail = await provider.getDetail(summary);
    const horseRows = detail.entries.map((entry) => {
      const externalId = String(entry.umaxScores.horse_id);
      return {
        external_id: `jra:${externalId}`,
        name: entry.horseName,
        sex: entry.sex,
        birth_year: entry.age
          ? Number(String(batch.target_date).slice(0, 4)) - entry.age
          : null,
      };
    });
    const { data: horses, error: horseError } = await db.from("horses").upsert(
      horseRows,
      { onConflict: "external_id" },
    ).select("id,external_id");
    if (horseError) throw horseError;
    const horseIds = new Map<string, string>(
      (horses ?? []).map((horse: any) => [
        String(horse.external_id).replace("jra:", ""),
        String(horse.id),
      ]),
    );
    const entryRows = detail.entries.flatMap((entry) => {
      const externalHorseId = String(entry.umaxScores.horse_id);
      const horseId = horseIds.get(externalHorseId);
      if (!horseId) return [];
      const win = detail.odds.find((odd) =>
        odd.type === "win" && odd.horses[0] === entry.horseNumber
      );
      const place = detail.odds.find((odd) =>
        odd.type === "place" && odd.horses[0] === entry.horseNumber
      );
      return [{
        race_id: item.race_id,
        horse_id: horseId,
        horse_number: entry.horseNumber,
        gate_number: entry.gateNumber,
        jockey: entry.jockey,
        trainer: entry.trainer,
        weight_carried: entry.weightCarried,
        horse_weight: entry.horseWeight,
        horse_weight_delta: entry.horseWeightDelta,
        win_odds: win?.odds,
        place_odds_low: place?.odds,
        place_odds_high: place?.oddsMax,
        popularity: win?.popularity,
        raw_data: { provider: "netkeiba" },
      }];
    });
    if (entryRows.length) {
      const { error: entryError } = await db.from("race_entries").upsert(
        entryRows,
        { onConflict: "race_id,horse_number" },
      );
      if (entryError) throw entryError;
    }
    try {
      const collected = await provider.getPastRuns(summary);
      const pastRows = await Promise.all(collected.flatMap((run) => {
        const horseId = horseIds.get(run.externalHorseId);
        if (!horseId) return [];
        return [
          hash(run.rawData).then((sourceHash) => ({
            horse_id: horseId,
            race_date: run.raceDate,
            track: run.track,
            race_name: run.raceName,
            race_class: run.raceClass,
            surface: run.surface,
            distance: run.distance,
            condition: run.condition,
            finish_position: run.finishPosition,
            popularity: run.popularity,
            finish_time: run.finishTime,
            corner_positions: run.cornerPositions,
            last3f: run.last3f,
            margin: run.margin === undefined ? null : String(run.margin),
            jockey: run.jockey,
            weight_carried: run.weightCarried,
            horse_weight: run.horseWeight,
            runner_count: run.runnerCount,
            source_hash: sourceHash,
            raw_data: run.rawData,
          })),
        ];
      }));
      if (pastRows.length) {
        const { error: pastError } = await db.from("past_runs").upsert(
          pastRows,
          { onConflict: "horse_id,race_date,track,race_name" },
        );
        if (pastError) throw pastError;
        historyRows += pastRows.length;
      }
    } catch (error) {
      historyErrors++;
      console.error("PAST_RUN_COLLECTION_FAILED", summary.externalId, error);
    }
    const dbHorseIds = [...horseIds.values()];
    const { data: pastRows, error: pastError } = await db.from("past_runs")
      .select(
        "horse_id,race_date,track,race_name,race_class,surface,distance,condition,finish_position,popularity,odds,finish_time,corner_positions,last3f,margin,jockey,weight_carried,horse_weight,runner_count",
      ).in("horse_id", dbHorseIds).order("race_date", { ascending: false })
      .limit(500);
    if (pastError) throw pastError;
    const externalByDbId = new Map<string, string>(
      [...horseIds].map(([externalId, dbId]) => [dbId, externalId]),
    );
    const historyByHorse = new Map<string, PastRun[]>();
    for (const row of pastRows ?? []) {
      const externalId = externalByDbId.get(String(row.horse_id));
      if (!externalId) continue;
      const history = historyByHorse.get(externalId) ?? [];
      if (history.length >= 5) continue;
      history.push({
        raceDate: row.race_date,
        track: row.track,
        raceName: row.race_name,
        raceClass: row.race_class,
        surface: row.surface,
        distance: row.distance,
        condition: row.condition,
        finishPosition: row.finish_position,
        popularity: row.popularity,
        odds: row.odds,
        finishTime: row.finish_time,
        cornerPositions: row.corner_positions,
        last3f: row.last3f,
        margin: row.margin == null ? undefined : Number(row.margin),
        jockey: row.jockey,
        weightCarried: row.weight_carried,
        horseWeight: row.horse_weight,
        runnerCount: row.runner_count,
      });
      historyByHorse.set(externalId, history);
    }
    const evaluations = evaluateRace(
      summary,
      detail.entries,
      historyByHorse,
      weights,
    );
    const snapshots = evaluations.flatMap((evaluation) => {
      const entry = detail.entries.find((value) =>
        value.horseNumber === evaluation.horseNumber
      );
      const horseId = entry
        ? horseIds.get(String(entry.umaxScores.horse_id))
        : undefined;
      return horseId
        ? [{
          race_id: item.race_id,
          horse_id: horseId,
          horse_number: evaluation.horseNumber,
          ability_score: evaluation.abilityScore,
          suitability_score: evaluation.suitabilityScore,
          condition_score: evaluation.conditionScore,
          race_context_score: evaluation.raceContextScore,
          overall_score: evaluation.overallScore,
          estimated_win_probability: evaluation.estimatedWinProbability,
          data_quality: evaluation.dataQuality,
          features: evaluation.features,
          weight_profile_id: weightProfile.id,
        }]
        : [];
    });
    if (snapshots.length) {
      const { error: snapshotError } = await db.from(
        "horse_evaluation_snapshots",
      ).upsert(snapshots, { onConflict: "race_id,horse_id" });
      if (snapshotError) throw snapshotError;
    }
    const topHorses = [...evaluations].sort((a, b) =>
      b.overallScore - a.overallScore
    ).map((evaluation) => {
      const entry = detail.entries.find((value) =>
        value.horseNumber === evaluation.horseNumber
      );
      return {
      horse_number: evaluation.horseNumber,
      horse_name: evaluation.horseName,
      jockey: entry?.jockey,
      trainer: entry?.trainer,
      weight_carried: entry?.weightCarried,
      horse_weight: entry?.horseWeight,
      horse_weight_delta: entry?.horseWeightDelta,
      win_odds: entry?.winOdds,
      popularity: entry?.popularity,
      overall_score: evaluation.overallScore,
      ability_score: evaluation.abilityScore,
      suitability_score: evaluation.suitabilityScore,
      condition_score: evaluation.conditionScore,
      race_context_score: evaluation.raceContextScore,
      estimated_win_probability: evaluation.estimatedWinProbability,
      data_quality: evaluation.dataQuality,
      features: evaluation.features,
    };
    });
    additions.single.push({
      race_id: String(item.race_id),
      external_id: String(item.external_id),
      track: item.track,
      race_number: item.race_number,
      race_name: item.race_name,
      race_class: item.race_class,
      start_time: item.start_time,
      surface: item.surface,
      distance: item.distance,
      runner_count: detail.entries.length,
      horses: topHorses,
    });
  }
  const analysis = { ...(metadata.analysis ?? {}) };
  const existingSingle = analysis.races ?? [];
  const processedSingle = new Set(
    additions.single.map((race: any) => race.race_id),
  );
  analysis.races = [
    ...existingSingle.filter((race: any) =>
      !processedSingle.has(String(race.race_id))
    ),
    ...additions.single,
  ];
  const newOffset = page.nextOffset;
  return {
    ...metadata,
    pipeline_stage: page.complete ? "screen:0" : "analysis",
    analysis_offset: newOffset,
    analysis,
    history_rows: Number(metadata.history_rows ?? 0) + historyRows,
    history_errors: Number(metadata.history_errors ?? 0) + historyErrors,
    formula_version: weightProfile.formula_version,
  };
}

async function runSelection(
  db: any,
  batch: any,
  metadata: any,
  strategy: Strategy,
) {
  const source = metadata.analysis?.[strategy];
  if (!source?.races) throw new Error("PIPELINE_ANALYSIS_MISSING");
  const races = source.races.map(cleanRace).filter((race: any) =>
    race.candidates.length
  );
  const response = await aiCall(
    db,
    batch.id,
    "screening",
    strategy,
    `戦略=${strategy}、目的=${
      STRATEGY_POLICIES[strategy].objective
    }。数値計算済みの候補だけを比較し、適格レースが5件以上なら必ず5件、未満なら全件を選ぶ。候補にない馬券や確率は作らない。scoreは戦略適合度。\n${
      JSON.stringify(races)
    }`,
    SELECTION_SCHEMA,
  );
  const raw = (response.value as any)?.selections;
  if (!Array.isArray(raw)) throw new Error("SELECTION_SHAPE_INVALID");
  const valid = new Map(races.map((race: any) => [race.race_id, race]));
  const seen = new Set<string>();
  const selected = raw.flatMap((item: any) => {
    const raceId = String(item.race_id ?? "");
    if (!valid.has(raceId) || seen.has(raceId)) return [];
    seen.add(raceId);
    return [{
      race_id: raceId,
      score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
      reason: String(item.reason || "数値候補と戦略条件に基づく選定"),
    }];
  }).slice(0, 5);
  const supplements = races.filter((race: any) => !seen.has(race.race_id))
    .sort((a: any, b: any) =>
      (b.candidates[0].expected_value * b.candidates[0].data_quality) -
      (a.candidates[0].expected_value * a.candidates[0].data_quality)
    ).slice(0, Math.max(0, Math.min(5, races.length) - selected.length))
    .map((race: any) => ({
      race_id: race.race_id,
      score: Math.min(
        100,
        Math.round(
          race.candidates[0].expected_value *
            race.candidates[0].data_quality * 50,
        ),
      ),
      reason: "AIの不足枠を期待値とデータ品質の上位候補で補完",
    }));
  const finalSelections = [...selected, ...supplements].slice(0, 5);
  await db.from("race_selections").delete().eq("batch_run_id", batch.id).eq(
    "strategy",
    strategy,
  );
  if (finalSelections.length) {
    const { error } = await db.from("race_selections").insert(
      finalSelections.map((item, index) => ({
        batch_run_id: batch.id,
        race_id: item.race_id,
        strategy,
        score: item.score,
        reason: item.reason,
        rank: index + 1,
        ai_call_id: response.callId,
      })),
    );
    if (error) throw error;
  }
  return { ...metadata, pipeline_stage: nextStage(metadata.pipeline_stage) };
}

async function runPrediction(
  db: any,
  batch: any,
  metadata: any,
  strategy: Strategy,
) {
  const { data: selections, error } = await db.from("race_selections").select(
    "race_id,rank",
  ).eq("batch_run_id", batch.id).eq("strategy", strategy).order("rank");
  if (error) throw error;
  const ids = new Set(
    (selections ?? []).map((item: any) => String(item.race_id)),
  );
  const races = (metadata.analysis?.[strategy]?.races ?? []).map(cleanRace)
    .filter((race: any) => ids.has(race.race_id));
  const { data: account } = await db.from("strategy_accounts").select(
    "current_balance",
  ).eq("strategy", strategy).single();
  const response = await aiCall(
    db,
    batch.id,
    "prediction",
    strategy,
    `戦略=${strategy}、目的=${STRATEGY_POLICIES[strategy].objective}、残高=${
      Number(account?.current_balance ?? 100000)
    }円。各レースで候補IDを1つ選ぶかSKIP。候補の馬番・券種・確率は変更禁止。最大3レース採用を意識するが全レースを回答する。金額は100円単位。\n${
      JSON.stringify(races)
    }`,
    PREDICTION_SCHEMA,
  );
  const raw = (response.value as any)?.predictions;
  if (!Array.isArray(raw)) throw new Error("PREDICTION_SHAPE_INVALID");
  const byRace = new Map(races.map((race: any) => [race.race_id, race]));
  const received = new Map<string, any>();
  for (const item of raw) {
    const raceId = String(item.race_id ?? ""),
      race = byRace.get(raceId) as any;
    if (!race || received.has(raceId)) continue;
    const candidate = race.candidates.find((value: any) =>
      value.candidate_id === item.candidate_id
    );
    const bet = item.action === "BET" && candidate;
    received.set(raceId, {
      race_id: raceId,
      action: bet ? "BET" : "SKIP",
      candidate_id: bet ? candidate.candidate_id : null,
      confidence: Math.max(
        0,
        Math.min(100, Math.round(Number(item.confidence) || 0)),
      ),
      stake: bet
        ? Math.max(100, Math.floor(Number(item.stake || 100) / 100) * 100)
        : 0,
      reason: String(item.reason || "条件比較により見送り"),
      stake_reason: String(item.stake_reason || "購入なし"),
    });
  }
  for (const race of races) {
    if (!received.has(race.race_id)) {
      received.set(race.race_id, {
        race_id: race.race_id,
        action: "SKIP",
        candidate_id: null,
        confidence: 0,
        stake: 0,
        reason: "AI応答に存在しないため安全側で見送り",
        stake_reason: "購入なし",
      });
    }
  }
  return {
    ...metadata,
    pipeline_stage: nextStage(metadata.pipeline_stage),
    drafts: {
      ...(metadata.drafts ?? {}),
      [strategy]: [...received.values()],
    },
    prediction_ai_calls: {
      ...(metadata.prediction_ai_calls ?? {}),
      [strategy]: response.callId,
    },
  };
}

async function runAudit(db: any, batch: any, metadata: any) {
  const auditInput = STRATEGIES.flatMap((strategy) =>
    (metadata.drafts?.[strategy] ?? []).map((draft: any) => {
      const race = (metadata.analysis?.[strategy]?.races ?? []).map(cleanRace)
        .find((item: any) => item.race_id === draft.race_id);
      return {
        strategy,
        ...draft,
        candidate: race?.candidates.find((candidate: any) =>
          candidate.candidate_id === draft.candidate_id
        ) ?? null,
      };
    })
  );
  const response = await aiCall(
    db,
    batch.id,
    "audit",
    null,
    `最終監査。新しい買い目は作らず、戦略整合性、期待値、品質、資金偏りを確認して各提案を承認または却下する。SKIPはapproved=false。\n${
      JSON.stringify(auditInput)
    }`,
    AUDIT_SCHEMA,
  );
  const approvals = new Map<string, any>();
  for (const decision of (response.value as any)?.decisions ?? []) {
    approvals.set(`${decision.strategy}:${decision.race_id}`, decision);
  }
  let predictionCount = 0, betCount = 0;
  for (const strategy of STRATEGIES) {
    const policy = STRATEGY_POLICIES[strategy];
    const drafts = metadata.drafts?.[strategy] ?? [];
    const enriched = drafts.map((draft: any) => {
      const race = (metadata.analysis?.[strategy]?.races ?? []).map(cleanRace)
        .find((item: any) => item.race_id === draft.race_id);
      const candidate = race?.candidates.find((item: any) =>
        item.candidate_id === draft.candidate_id
      );
      const audit = approvals.get(`${strategy}:${draft.race_id}`);
      return { draft, candidate, audit };
    });
    const accepted = new Set(
      enriched.filter((item: any) =>
        item.draft.action === "BET" && item.candidate?.expected_value >=
          policy.minimumExpectedValue &&
        item.candidate?.data_quality >= policy.minimumDataQuality &&
        item.audit?.approved === true
      ).sort((a: any, b: any) =>
        (b.candidate.expected_value * b.candidate.data_quality) -
        (a.candidate.expected_value * a.candidate.data_quality)
      ).slice(0, 3).map((item: any) => item.draft.race_id),
    );
    let dayStake = 0;
    for (const item of enriched) {
      const approved = accepted.has(item.draft.race_id),
        candidate = item.candidate;
      const finalStake = approved
        ? Math.floor(
          Math.min(
            item.draft.stake,
            policy.maxStakePerRace,
            policy.maxStakePerDay - dayStake,
          ) / 100,
        ) * 100
        : 0;
      const action = approved && finalStake >= 100 ? "bet" : "skip";
      const { data: existing } = await db.from("predictions").select("id")
        .eq("batch_run_id", batch.id).eq("strategy", strategy).eq(
          "race_id",
          item.draft.race_id,
        ).maybeSingle();
      if (existing) continue;
      const rawResponse = {
        ...item.draft,
        audit: item.audit ?? { approved: false, reason: "監査応答なし" },
      };
      const { data: prediction, error } = await db.from("predictions").insert({
        batch_run_id: batch.id,
        race_id: item.draft.race_id,
        strategy,
        ai_call_id: metadata.prediction_ai_calls[strategy],
        action,
        confidence: item.draft.confidence,
        reason: action === "bet"
          ? item.draft.reason
          : String(item.audit?.reason || item.draft.reason),
        input_hash: await hash(metadata.analysis?.[strategy]),
        prediction_hash: await hash(rawResponse),
        predicted_at: new Date().toISOString(),
        raw_response: rawResponse,
      }).select("id").single();
      if (error) throw error;
      predictionCount++;
      if (action === "bet") {
        const { data: bet, error: betError } = await db.from("bets").insert({
          prediction_id: prediction.id,
          race_id: item.draft.race_id,
          strategy,
          bet_type: candidate.type,
          combination: candidate.horses,
          stake: finalStake,
          odds_at_prediction: candidate.odds,
          raw_estimated_probability: candidate.estimated_probability,
          estimated_probability: candidate.estimated_probability,
          expected_value: candidate.expected_value,
          reason: item.draft.reason,
          stake_reason: item.draft.stake_reason,
        }).select("id").single();
        if (betError) throw betError;
        await db.from("bet_decisions").insert({
          prediction_id: prediction.id,
          bet_id: bet.id,
          race_id: item.draft.race_id,
          strategy,
          bet_type: candidate.type,
          combination: candidate.horses,
          proposed_stake: item.draft.stake,
          final_stake: finalStake,
          odds: candidate.odds,
          raw_probability: candidate.estimated_probability,
          calibrated_probability: candidate.estimated_probability,
          expected_value: candidate.expected_value,
          minimum_expected_value: policy.minimumExpectedValue,
          data_quality: candidate.data_quality,
          minimum_data_quality: policy.minimumDataQuality,
          decision: finalStake < item.draft.stake ? "reduced" : "purchased",
          reason_code: finalStake < item.draft.stake
            ? "STAKE_REDUCED"
            : "PURCHASED",
          reason_detail: String(item.audit?.reason || "最終監査を通過"),
        });
        dayStake += finalStake;
        betCount++;
      }
    }
  }
  return {
    ...metadata,
    pipeline_stage: "complete",
    analysis: undefined,
    drafts: undefined,
    completed_summary: { predictions: predictionCount, bets: betCount },
  };
}

const compactSingleRace = (race: any) => ({
  race_id: race.race_id, track: race.track, race_number: race.race_number,
  race_name: race.race_name, race_class: race.race_class,
  start_time: race.start_time, surface: race.surface, distance: race.distance,
  runner_count: race.runner_count, horses: race.horses,
});

async function runSingleScreen(db: any, batch: any, metadata: any, index: number) {
  const races = (metadata.analysis?.races ?? []).slice(index * 9, index * 9 + 9).map(compactSingleRace);
  if (!races.length) throw new Error("SINGLE_SCREEN_INPUT_MISSING");
  const response = await aiCall(db, batch.id, "screening", "single",
    `全馬の再現可能な数値評価を根拠に各レースの予測可能性を評価する。買い目や期待値はまだ決めない。人気や単勝オッズだけで評価せず、能力差、軸の信頼性、展開の読みやすさ、データ品質、崩れるリスクを比較する。入力された全レースを必ず1件ずつ回答する。\n${JSON.stringify(races)}`,
    SINGLE_SCREEN_SCHEMA);
  return { ...metadata, pipeline_stage: index < 3 ? `screen:${index + 1}` : "synthesis",
    screenings: [...(metadata.screenings ?? []), { index, analyses: (response.value as any).analyses ?? [], ai_call_id: response.callId }] };
}

async function runSingleSynthesis(db: any, batch: any, metadata: any) {
  const analyses = (metadata.screenings ?? []).flatMap((x: any) => x.analyses ?? []);
  const response = await aiCall(db, batch.id, "screening", "single",
    `全36レースの一次分析を横断比較し、詳細分析する価値が高いレースを最大12件選ぶ。購入数を決める段階ではない。期待値ではなく、着順構造を説明できるか、軸の信頼性、展開の明確さ、データ品質を優先する。適切なレースがなければ12件未満でよい。\n${JSON.stringify(analyses)}`,
    SINGLE_SYNTHESIS_SCHEMA);
  const valid = new Set((metadata.analysis?.races ?? []).map((r: any) => String(r.race_id)));
  const seen = new Set<string>();
  const selections = ((response.value as any).selections ?? []).filter((x: any) => {
    const id = String(x.race_id); if (!valid.has(id) || seen.has(id)) return false; seen.add(id); return true;
  }).slice(0, 12);
  return { ...metadata, pipeline_stage: "deep:0", detail_selections: selections, synthesis_ai_call_id: response.callId };
}

async function runSingleDeep(db: any, batch: any, metadata: any, index: number) {
  const ids = (metadata.detail_selections ?? []).map((x: any) => String(x.race_id));
  const selected = new Set(ids.slice(index * 6, index * 6 + 6));
  const races = (metadata.analysis?.races ?? []).filter((r: any) => selected.has(String(r.race_id))).map(compactSingleRace);
  if (!races.length) return { ...metadata, pipeline_stage: index === 0 ? "deep:1" : "proposal" };
  const response = await aiCall(db, batch.id, "screening", "single",
    `各レースの全馬を比較し、軸候補、相手、穴、消し、想定展開、予測の弱点を詳細分析する。券種は分析内容から提案するが、オッズや期待値は捏造しない。勝ち切りと複勝圏の可能性を区別する。\n${JSON.stringify(races)}`,
    SINGLE_DEEP_SCHEMA);
  return { ...metadata, pipeline_stage: index === 0 ? "deep:1" : "proposal",
    deep_analyses: [...(metadata.deep_analyses ?? []), ...((response.value as any).analyses ?? [])] };
}

async function runSingleProposal(db: any, batch: any, metadata: any) {
  const response = await aiCall(db, batch.id, "prediction", "single",
    `詳細分析から購入価値があると判断した買い目だけを提案する。券種、馬番、組合せ、金額を自分で決める。最低500円、100円単位、1日合計10000円以内、最大20点。予算を使い切る必要はなく、良い候補がなければticketsを空にする。的中可能性を期待値より先に考え、1%未満と思う買い目は提案しない。同一買い目を重複させない。\n${JSON.stringify(metadata.deep_analyses ?? [])}`,
    SINGLE_PROPOSAL_SCHEMA);
  const tickets = ((response.value as any).tickets ?? []).map((x: any, i: number) => ({ ...x,
    proposal_id: String(x.proposal_id || `p${i + 1}`), stake: Math.floor(Number(x.stake) / 100) * 100 }));
  return { ...metadata, pipeline_stage: "verify", proposals: tickets, proposal_overall_reason: (response.value as any).overall_reason, proposal_ai_call_id: response.callId, verify_offset: 0, verifications: [] };
}

async function runSingleVerify(db: any, batch: any, metadata: any) {
  const proposals = metadata.proposals ?? [], offset = Number(metadata.verify_offset ?? 0);
  const chunk = proposals.slice(offset, offset + 4), races = metadata.analysis?.races ?? [];
  const provider = new JraProvider(), verifications: any[] = [];
  for (const proposal of chunk) {
    const race = races.find((r: any) => String(r.race_id) === String(proposal.race_id));
    if (!race) { verifications.push({ proposal_id: proposal.proposal_id, valid: false, reason: "RACE_NOT_FOUND" }); continue; }
    const summary: RaceSummary = { externalId: race.external_id, raceDate: batch.target_date, track: race.track,
      raceNumber: Number(race.race_number), raceName: race.race_name, raceClass: race.race_class,
      startTime: race.start_time, surface: race.surface, distance: race.distance,
      sourceUrl: `https://race.netkeiba.com/race/shutuba.html?race_id=${String(race.external_id).replace("jra:", "")}` };
    const detail = await provider.getDetail(summary);
    const evaluations = (race.horses ?? []).map((h: any) => ({ horseNumber: Number(h.horse_number),
      estimatedWinProbability: Number(h.estimated_win_probability), dataQuality: Number(h.data_quality) }));
    const candidate = buildBetCandidates(evaluations, detail.odds).find((c) =>
      betCandidateKey(c.type, c.horses) === betCandidateKey(proposal.type, proposal.horses));
    const reason = candidate ? candidateRejectionReason(candidate) : "ODDS_NOT_FOUND";
    if (!candidate || reason || candidate.estimatedProbability < .01) {
      verifications.push({ proposal_id: proposal.proposal_id, race_id: proposal.race_id, valid: false,
        reason: reason ?? "PROBABILITY_BELOW_ONE_PERCENT" });
    } else {
      verifications.push({ proposal_id: proposal.proposal_id, race_id: proposal.race_id, valid: true,
        type: candidate.type, horses: candidate.horses, odds: candidate.odds,
        estimated_probability: candidate.estimatedProbability,
        expected_value: candidate.expectedValue, data_quality: candidate.dataQuality,
        proposed_stake: proposal.stake, confidence: proposal.confidence,
        reason: proposal.reason, stake_reason: proposal.stake_reason });
    }
  }
  const nextOffset = offset + chunk.length;
  return { ...metadata, pipeline_stage: nextOffset >= proposals.length ? "final" : "verify",
    verify_offset: nextOffset, verifications: [...(metadata.verifications ?? []), ...verifications] };
}

async function runSingleFinal(db: any, batch: any, metadata: any) {
  const valid = (metadata.verifications ?? []).filter((x: any) => x.valid);
  const response = await aiCall(db, batch.id, "audit", "single",
    `これは最終意思決定。検証済みの有効候補だけから購入または見送りを決める。合計10000円以内、1点500円以上、100円単位。予算を使い切る必要はなく、全見送りも尊重する。的中確率、確率信頼性、有限試行回数、オッズ、期待値の順に考える。候補にない買い目は作らない。\n${JSON.stringify({ valid_candidates: valid, rejected_count: (metadata.verifications ?? []).length - valid.length, initial_reason: metadata.proposal_overall_reason })}`,
    SINGLE_FINAL_SCHEMA);
  const byId = new Map(valid.map((x: any) => [String(x.proposal_id), x]));
  let remaining = 10000;
  const decisions = ((response.value as any).decisions ?? []).map((d: any) => {
    const candidate: any = byId.get(String(d.proposal_id));
    let stake = Math.floor(Number(d.stake ?? 0) / 100) * 100;
    if (!candidate || d.action !== "BET" || stake < 500 || remaining < 500) return { ...d, action: "SKIP", stake: 0, candidate };
    stake = Math.min(stake, remaining); remaining -= stake; return { ...d, action: "BET", stake, candidate };
  });
  const grouped = new Map<string, any[]>();
  for (const d of decisions) { if (!d.candidate) continue; const id = String(d.candidate.race_id); grouped.set(id, [...(grouped.get(id) ?? []), d]); }
  let predictionCount = 0, betCount = 0;
  for (const [raceId, rows] of grouped) {
    const purchased = rows.filter((d) => d.action === "BET");
    const { data: prediction, error } = await db.from("predictions").insert({ batch_run_id: batch.id,
      race_id: raceId, strategy: "single", ai_call_id: response.callId, action: purchased.length ? "bet" : "skip",
      confidence: Math.max(0, ...rows.map((d) => Number(d.candidate?.confidence ?? 0))),
      reason: purchased.length ? purchased.map((d) => d.reason).join(" / ") : rows.map((d) => d.reason).join(" / "),
      input_hash: response.inputHash, prediction_hash: await hash(rows), predicted_at: new Date().toISOString(), raw_response: rows }).select("id").single();
    if (error) throw error; predictionCount++;
    for (const d of rows) {
      const c = d.candidate; let betId = null;
      if (d.action === "BET") { const { data: bet, error: betError } = await db.from("bets").insert({ prediction_id: prediction.id,
        race_id: raceId, strategy: "single", bet_type: c.type, combination: c.horses, stake: d.stake,
        odds_at_prediction: c.odds, raw_estimated_probability: c.estimated_probability,
        estimated_probability: c.estimated_probability, expected_value: c.expected_value,
        reason: c.reason, stake_reason: c.stake_reason }).select("id").single(); if (betError) throw betError; betId = bet.id; betCount++; }
      await db.from("bet_decisions").insert({ prediction_id: prediction.id, bet_id: betId, race_id: raceId,
        strategy: "single", bet_type: c.type, combination: c.horses, proposed_stake: c.proposed_stake,
        final_stake: d.action === "BET" ? d.stake : 0, odds: c.odds, raw_probability: c.estimated_probability,
        calibrated_probability: c.estimated_probability, expected_value: c.expected_value, minimum_expected_value: 0,
        data_quality: c.data_quality, minimum_data_quality: 0, decision: d.action === "BET" ? (d.stake < c.proposed_stake ? "reduced" : "purchased") : "rejected",
        reason_code: d.action === "BET" ? "AI_FINAL_PURCHASE" : "AI_FINAL_SKIP", reason_detail: d.reason });
    }
  }
  return { ...metadata, pipeline_stage: "complete", analysis: undefined, screenings: undefined,
    deep_analyses: undefined, proposals: undefined, verifications: undefined,
    completed_summary: { predictions: predictionCount, bets: betCount, spent: 10000 - remaining }, final_ai_call_id: response.callId };
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ status: "ok", model: MODEL });
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);
  if (req.headers.get("x-batch-secret") !== Deno.env.get("BATCH_SECRET")) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL"),
    key = Deno.env.get("SUPABASE_SECRET_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "ENV" }, 500);
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: rows, error } = await db.from("batch_runs").select(
    "id,target_date,status,metadata",
  ).eq("status", "running").order("started_at").limit(10);
  if (error) return json({ error: error.message }, 500);
  const batch = (rows ?? []).find((row: any) =>
    row.metadata?.pipeline_version === "single-v1" &&
    row.metadata?.pipeline_stage !== "complete"
  );
  if (!batch) return json({ status: "idle" });
  const metadata = batch.metadata ?? {},
    stage = String(metadata.pipeline_stage);
  const retryAt = metadata.next_attempt_at
    ? Date.parse(metadata.next_attempt_at)
    : 0;
  if (retryAt > Date.now()) return json({ status: "retry_wait", stage });
  try {
    let next: any;
    if (stage === "analysis") {
      next = await runAnalysis(db, batch, metadata);
    } else if (stage.startsWith("screen:")) {
      next = await runSingleScreen(db, batch, metadata, Number(stage.split(":")[1]));
    } else if (stage === "synthesis") {
      next = await runSingleSynthesis(db, batch, metadata);
    } else if (stage.startsWith("deep:")) {
      next = await runSingleDeep(db, batch, metadata, Number(stage.split(":")[1]));
    } else if (stage === "proposal") {
      next = await runSingleProposal(db, batch, metadata);
    } else if (stage === "verify") {
      next = await runSingleVerify(db, batch, metadata);
    } else if (stage === "final") {
      next = await runSingleFinal(db, batch, metadata);
    } else throw new Error(`PIPELINE_STAGE_INVALID:${stage}`);
    const complete = next.pipeline_stage === "complete";
    const { error: updateError } = await db.from("batch_runs").update({
      status: complete ? "succeeded" : "running",
      finished_at: complete ? new Date().toISOString() : null,
      metadata: { ...next, next_attempt_at: null },
    }).eq("id", batch.id);
    if (updateError) throw updateError;
    return json({
      status: complete ? "succeeded" : "stage_succeeded",
      completed_stage: stage,
      next_stage: next.pipeline_stage,
      batchRunId: batch.id,
    });
  } catch (error) {
    const attempts = {
      ...(metadata.pipeline_attempts ?? {}),
      [stage]: Number(metadata.pipeline_attempts?.[stage] ?? 0) + 1,
    };
    const fatal = attempts[stage] >= 2 ||
      String(error).includes("AI_DAILY_LIMIT_REACHED");
    await db.from("batch_runs").update({
      status: fatal ? "failed" : "running",
      finished_at: fatal ? new Date().toISOString() : null,
      error_message: fatal ? String(error) : null,
      metadata: {
        ...metadata,
        pipeline_attempts: attempts,
        next_attempt_at: fatal
          ? null
          : new Date(Date.now() + 65_000).toISOString(),
        last_error: String(error),
      },
    }).eq("id", batch.id);
    return json({
      error: fatal ? "PIPELINE_FAILED" : "PIPELINE_RETRY_SCHEDULED",
      stage,
      detail: String(error),
    }, fatal ? 500 : 202);
  }
});
