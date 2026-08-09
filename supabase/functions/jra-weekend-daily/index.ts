import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import { JraProvider } from "../_shared/jra-provider.ts";
import { callGemini, MODEL } from "../_shared/gemini-client.ts";
import {
  evaluateRace,
  type EvaluationWeights,
} from "../_shared/horse-evaluation.ts";
import {
  completeMissingPredictions,
  PREDICTION_SCHEMA,
  SELECTION_SCHEMA,
  STRATEGIES,
  validatePredictions,
  validateSelections,
} from "../_shared/ai-contracts.ts";
import type { PastRun, Strategy } from "../_shared/types.ts";
import {
  calibrateProbability,
  type CalibrationProfile,
} from "../_shared/probability-calibrator.ts";
import {
  STRATEGY_POLICIES,
  strategyPrompt,
} from "../_shared/strategy-policy.ts";
import {
  betCandidateKey,
  buildBetCandidates,
  selectCandidateShortlist,
  selectTopRaceProposalIds,
} from "../_shared/bet-candidates.ts";
const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x), {
    status: s,
    headers: { "content-type": "application/json" },
  });
const h = async (x: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(x)),
      ),
    ),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");

type ScreeningRace = {
  race_id: string;
  track: string;
  race_number: number;
  race_name: string;
  race_class?: string | null;
  start_time: string;
  surface?: string | null;
  distance?: number | null;
};

// A full card contains very large exotic-odds tables. Keep the detailed stage
// within the Edge worker budget while preserving representation from each venue.
export function buildDetailedAnalysisPool(
  races: ScreeningRace[],
  limit = 6,
): ScreeningRace[] {
  const classPriority: Record<string, number> = {
    G1: 7,
    G2: 6,
    G3: 5,
    listed: 4,
    open: 3,
    "3win": 2,
    "2win": 1,
  };
  const ranked = [...races].sort((a, b) =>
    (classPriority[b.race_class ?? ""] ?? 0) -
      (classPriority[a.race_class ?? ""] ?? 0) ||
    b.race_number - a.race_number ||
    a.start_time.localeCompare(b.start_time)
  );
  const selected: ScreeningRace[] = [], perTrack = new Map<string, number>();
  for (const race of ranked) {
    if ((perTrack.get(race.track) ?? 0) >= 2) continue;
    selected.push(race);
    perTrack.set(race.track, (perTrack.get(race.track) ?? 0) + 1);
    if (selected.length === limit) return selected;
  }
  for (const race of ranked) {
    if (selected.some((item) => item.race_id === race.race_id)) continue;
    selected.push(race);
    if (selected.length === limit) break;
  }
  return selected;
}
async function ai(
  db: any,
  batch: string,
  purpose: "screening" | "prediction",
  strategy: Strategy | null,
  prompt: string,
  schema: any,
) {
  const input = await h({ prompt, schema }),
    { data: callId, error } = await db.rpc("reserve_ai_call", {
      p_batch_run_id: batch,
      p_purpose: purpose,
      p_strategy: strategy,
      p_model: MODEL,
      p_prompt_version: "jra-v1",
      p_input_hash: input,
      p_request_json: { prompt, schema },
    });
  if (error) throw new Error(error.message);
  try {
    const r = await callGemini(prompt, schema);
    await db.from("ai_calls").update({
      status: "succeeded",
      response_json: r.raw,
      output_hash: await h(r.value),
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      completed_at: new Date().toISOString(),
    }).eq("id", callId);
    return { ...r, callId, inputHash: input };
  } catch (e) {
    await db.from("ai_calls").update({
      status: "failed",
      error_message: String(e),
      completed_at: new Date().toISOString(),
    }).eq("id", callId);
    throw e;
  }
}
Deno.serve(async (req) => {
  if (req.method === "GET") return json({ status: "ok" });
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);
  if (req.headers.get("x-batch-secret") !== Deno.env.get("BATCH_SECRET")) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }
  const u = Deno.env.get("SUPABASE_URL"),
    k = Deno.env.get("SUPABASE_SECRET_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? (() => {
        try {
          return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")
            .default;
        } catch {
          return undefined;
        }
      })();
  if (!u || !k) return json({ error: "ENV" }, 500);
  const db = createClient(u, k, { auth: { persistSession: false } }),
    body = await req.json().catch(() => ({})) as {
      target_date?: string;
      force?: boolean;
    },
    date = body.target_date ??
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
        new Date(),
      );
  const { data: done } = await db.from("batch_runs").select("id").eq(
    "target_date",
    date,
  ).eq("parser_version", "jra-netkeiba-v1").eq("status", "succeeded")
    .maybeSingle();
  if (done && !body.force) {
    return json({ status: "already_completed", batchRunId: done.id });
  }
  const { data: batch, error: be } = await db.from("batch_runs").insert({
    target_date: date,
    parser_version: "jra-netkeiba-v1",
  }).select("id").single();
  if (be) return json({ error: be.message }, 500);
  try {
    const provider = new JraProvider(),
      races = await provider.getRaceList(date);
    if (!races.length) {
      await db.from("batch_runs").update({
        status: "succeeded",
        races_fetched: 0,
        api_requests: 1,
        finished_at: new Date().toISOString(),
        metadata: { provider: "jra_netkeiba", reason: "no_jra_races" },
      }).eq("id", batch.id);
      return json({ status: "no_jra_races", races: 0, batchRunId: batch.id });
    }
    const rows = races.map((r) => ({
        external_id: r.externalId,
        race_date: r.raceDate,
        track: r.track,
        race_number: r.raceNumber,
        race_name: r.raceName,
        race_class: r.raceClass,
        start_time: r.startTime,
        surface: r.surface,
        distance: r.distance,
        source_url: r.sourceUrl,
        source_fetched_at: new Date().toISOString(),
        source_hash: "jra-list-v1",
      })
      ),
      { data: saved, error: re } = await db.from("races").upsert(rows, {
        onConflict: "external_id",
      }).select(
        "id,external_id,track,race_number,race_name,race_class,start_time,surface,distance",
      );
    if (re) throw re;
    const raceQueue = (saved ?? []).map((row) => ({
      race_id: String(row.id),
      external_id: row.external_id,
      track: row.track,
      race_number: row.race_number,
      race_name: row.race_name,
      race_class: row.race_class,
      start_time: row.start_time,
      surface: row.surface,
      distance: row.distance,
    })).sort((a, b) =>
      a.start_time.localeCompare(b.start_time) ||
      a.track.localeCompare(b.track) ||
      a.race_number - b.race_number
    );
    await db.from("batch_runs").update({
      status: "running",
      races_fetched: raceQueue.length,
      api_requests: 1,
      metadata: {
        provider: "jra_netkeiba",
        pipeline_version: "single-v1",
        pipeline_stage: "analysis",
        pipeline_attempts: {},
        analysis_offset: 0,
        analysis_chunk_size: 4,
        race_queue: raceQueue,
        analysis: { races: [] },
      },
    }).eq("id", batch.id);
    return json({
      status: "queued",
      stage: "analysis",
      races: raceQueue.length,
      batchRunId: batch.id,
    }, 202);

    /* Previous in-process detail analysis retained temporarily for reference.
    const allScreenInput = (saved ?? []).map((r) => ({
        race_id: r.id,
        track: r.track,
        race_number: r.race_number,
        race_name: r.race_name,
        race_class: r.race_class,
        start_time: r.start_time,
        surface: r.surface,
        distance: r.distance,
      })
      ),
      screenInput = buildDetailedAnalysisPool(allScreenInput),
      valid = new Set(screenInput.map((r) => String(r.race_id))),
      chosen = new Set(screenInput.map((r) => String(r.race_id))),
      details = new Map<
        string,
        Awaited<ReturnType<JraProvider["getDetail"]>>
      >(),
      horseDbIds = new Map<string, string>();
    let historyRequests = 0,
      historyRows = 0,
      historyErrors = 0,
      historyClassRows = 0,
      historyTimeRows = 0,
      historyCornerRows = 0;
    for (const id of chosen) {
      const row = (saved ?? []).find((r) => r.id === id)!,
        summary = races.find((r) => r.externalId === row.external_id)!;
      const d = await provider.getDetail(summary);
      details.set(id, d);
      for (const e of d.entries) {
        const horseId = String(e.umaxScores.horse_id),
          { data: horse, error: he } = await db.from("horses").upsert({
            external_id: `jra:${horseId}`,
            name: e.horseName,
            sex: e.sex,
            birth_year: e.age ? Number(date.slice(0, 4)) - e.age : null,
          }, { onConflict: "external_id" }).select("id").single();
        if (he) throw he;
        horseDbIds.set(horseId, horse.id);
        const win = d.odds.find((o) =>
            o.type === "win" && o.horses[0] === e.horseNumber
          ),
          place = d.odds.find((o) =>
            o.type === "place" && o.horses[0] === e.horseNumber
          );
        await db.from("race_entries").upsert({
          race_id: id,
          horse_id: horse.id,
          horse_number: e.horseNumber,
          gate_number: e.gateNumber,
          jockey: e.jockey,
          trainer: e.trainer,
          weight_carried: e.weightCarried,
          horse_weight: e.horseWeight,
          horse_weight_delta: e.horseWeightDelta,
          win_odds: win?.odds,
          place_odds_low: place?.odds,
          place_odds_high: place?.oddsMax,
          popularity: win?.popularity,
          raw_data: { provider: "netkeiba" },
        }, { onConflict: "race_id,horse_number" });
      }
      historyRequests++;
      try {
        const collected = await provider.getPastRuns(summary),
          rows = await Promise.all(collected.flatMap((run) => {
            const horseId = horseDbIds.get(run.externalHorseId);
            if (!horseId) return [];
            return [
              h(run.rawData).then((sourceHash) => ({
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
        historyClassRows += collected.filter((run) => run.raceClass).length;
        historyTimeRows += collected.filter((run) => run.finishTime).length;
        historyCornerRows += collected.filter((run) =>
          run.cornerPositions?.length
        ).length;
        if (rows.length) {
          const { error: historyError } = await db.from("past_runs").upsert(
            rows,
            { onConflict: "horse_id,race_date,track,race_name" },
          );
          if (historyError) throw historyError;
          historyRows += rows.length;
        }
      } catch (historyError) {
        historyErrors++;
        console.error(
          "PAST_RUN_COLLECTION_FAILED",
          summary.externalId,
          historyError,
        );
      }
    }
    const dbHorseIds = [...new Set(horseDbIds.values())],
      { data: pastRows, error: pastError } = dbHorseIds.length
        ? await db.from("past_runs").select(
          "horse_id,race_date,track,race_name,race_class,surface,distance,condition,finish_position,popularity,odds,finish_time,corner_positions,last3f,margin,jockey,weight_carried,horse_weight,runner_count",
        ).in("horse_id", dbHorseIds).order("race_date", { ascending: false })
          .limit(
            1000,
          )
        : { data: [], error: null };
    if (pastError) throw pastError;
    const externalByDbId = new Map(
        [...horseDbIds].map(([externalId, dbId]) => [dbId, externalId]),
      ),
      pastRunsByHorse = new Map<string, PastRun[]>();
    for (const row of pastRows ?? []) {
      const externalId = externalByDbId.get(row.horse_id);
      if (!externalId) continue;
      const history = pastRunsByHorse.get(externalId) ?? [];
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
      pastRunsByHorse.set(externalId, history);
    }
    const { data: weightProfile, error: weightError } = await db.from(
      "evaluation_weight_profiles",
    ).select(
      "id,ability_weight,suitability_weight,condition_weight,race_context_weight,formula_version",
    ).eq("is_active", true).single();
    if (weightError) throw weightError;
    const evaluationWeights: EvaluationWeights = {
        ability: Number(weightProfile.ability_weight),
        suitability: Number(weightProfile.suitability_weight),
        condition: Number(weightProfile.condition_weight),
        raceContext: Number(weightProfile.race_context_weight),
      },
      evaluationsByRace = new Map<string, ReturnType<typeof evaluateRace>>();
    for (const id of chosen) {
      const detail = details.get(id)!,
        evaluations = evaluateRace(
          detail.race,
          detail.entries,
          pastRunsByHorse,
          evaluationWeights,
        );
      evaluationsByRace.set(id, evaluations);
      const snapshots = evaluations.flatMap((evaluation) => {
        const entry = detail.entries.find((item) =>
            item.horseNumber === evaluation.horseNumber
          ),
          horseId = entry
            ? horseDbIds.get(String(entry.umaxScores.horse_id))
            : undefined;
        return horseId
          ? [{
            race_id: id,
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
    }
    const { data: calibrationRows, error: calibrationError } = await db.from(
      "probability_calibration_profiles",
    ).select("id,strategy,bet_type,bins").eq("is_active", true);
    if (calibrationError) throw calibrationError;
    const calibrations = new Map(
      (calibrationRows ?? []).map(
        (row) => [`${row.strategy}:${row.bet_type}`, row],
      ),
    );
    const selectionEligibility = new Map<Strategy, Set<string>>(),
      selectionFallbackScores = new Map<Strategy, Map<string, number>>(),
      selectionInput = Object.fromEntries(STRATEGIES.map((strategy) => {
        const policy = STRATEGY_POLICIES[strategy],
          eligibleRaceIds = new Set<string>(),
          fallbackScores = new Map<string, number>();
        selectionEligibility.set(strategy, eligibleRaceIds);
        selectionFallbackScores.set(strategy, fallbackScores);
        const raceAssessments = screenInput.map((race) => {
          const detail = details.get(String(race.race_id))!,
            evaluations = evaluationsByRace.get(String(race.race_id))!,
            candidates = buildBetCandidates(evaluations, detail.odds)
              .filter((candidate) =>
                policy.allowedBetTypes.includes(candidate.type)
              )
              .map((candidate) => {
                const calibration = calibrations.get(
                    `${strategy}:${candidate.type}`,
                  ),
                  probability = calibrateProbability(
                    calibration?.bins as CalibrationProfile | undefined,
                    candidate.estimatedProbability,
                  ),
                  expectedValue = Number(
                    (probability * candidate.odds).toFixed(4),
                  );
                return {
                  candidate_id: betCandidateKey(
                    candidate.type,
                    candidate.horses,
                  ),
                  type: candidate.type,
                  horses: candidate.horses,
                  odds: candidate.odds,
                  estimated_probability: probability,
                  expected_value: expectedValue,
                  data_quality: candidate.dataQuality,
                  eligible:
                    candidate.dataQuality >= policy.minimumDataQuality &&
                    expectedValue >= policy.minimumExpectedValue,
                };
              }).sort((a, b) =>
                Number(b.eligible) - Number(a.eligible) ||
                b.expected_value - a.expected_value
              ),
            eligibleCandidates = candidates.filter((candidate) =>
              candidate.eligible
            ),
            topEvaluations = [...evaluations].sort((a, b) =>
              b.overallScore - a.overallScore
            ).slice(0, 5).map((evaluation) => {
              const entry = detail.entries.find((item) =>
                item.horseNumber === evaluation.horseNumber
              );
              return {
                horse_number: evaluation.horseNumber,
                horse_name: evaluation.horseName,
                jockey: entry?.jockey,
                trainer: entry?.trainer,
                overall_score: evaluation.overallScore,
                estimated_win_probability: evaluation.estimatedWinProbability,
                data_quality: evaluation.dataQuality,
              };
            });
          if (eligibleCandidates.length) {
            eligibleRaceIds.add(String(race.race_id));
            fallbackScores.set(
              String(race.race_id),
              eligibleCandidates[0].expected_value *
                eligibleCandidates[0].data_quality,
            );
          }
          return {
            ...race,
            runner_count: detail.entries.length,
            top_horses: topEvaluations,
            eligible_candidate_count: eligibleCandidates.length,
            maximum_expected_value: eligibleCandidates[0]?.expected_value ??
              null,
            candidates: candidates.slice(0, 12),
          };
        });
        return [strategy, {
          policy,
          instruction:
            "Select five races when at least five have eligible candidates; otherwise select every eligible race up to five. Rank by fit with this strategy's objective, candidate quality, expected value, market options, and data reliability. Never select a race without an eligible candidate.",
          races: raceAssessments,
        }];
      }));

    // The collection/evaluation phase ends here. AI work is consumed one call
    // per invocation by jra-prediction-worker so RPM, memory and retries remain
    // isolated and successful stages never need to be repeated.
    await db.from("batch_runs").update({
      status: "running",
      races_fetched: races.length,
      api_requests: 2 + chosen.size + historyRequests,
      metadata: {
        provider: "jra_netkeiba",
        pipeline_version: "staged-v1",
        pipeline_stage: "selection:conservative",
        pipeline_attempts: {},
        analysis: selectionInput,
        details: chosen.size,
        history_requests: historyRequests,
        history_rows: historyRows,
        history_errors: historyErrors,
        formula_version: weightProfile.formula_version,
      },
    }).eq("id", batch.id);
    return json({
      status: "queued",
      stage: "selection:conservative",
      races: races.length,
      details: chosen.size,
      batchRunId: batch.id,
    }, 202);

    // Legacy monolithic AI/persistence path intentionally disabled.
    const screen = await ai(
        db,
        batch.id,
        "screening",
        null,
        `全レースについて出走馬、過去走評価、推定勝率、データ品質、実在オッズ、券種別補正確率・期待値を計算済み。保守型・バランス型・積極型の目的と制約を個別に理解し、各戦略で購入条件を満たす候補があるレースを5件選定する。適格レースが5件未満の場合だけ、それ以下を許可する。eligible_candidate_count=0のレースは選定禁止。scoreはその戦略への適合度、reasonには候補券種・期待値・品質と戦略目的の関係を具体的に記載。race_id厳守。\n${
          JSON.stringify(selectionInput)
        }`,
        SELECTION_SCHEMA,
      ),
      proposedSelections = validateSelections(screen.value, valid),
      sel = Object.fromEntries(STRATEGIES.map((strategy) => {
        const selected = proposedSelections[strategy].filter((selection) =>
            selectionEligibility.get(strategy)!.has(selection.race_id)
          ),
          selectedIds = new Set(selected.map((selection) => selection.race_id)),
          supplements = [...selectionFallbackScores.get(strategy)!.entries()]
            .filter(([raceId]) => !selectedIds.has(raceId))
            .sort((a, b) => b[1] - a[1])
            .slice(0, Math.max(0, 5 - selected.length))
            .map(([raceId, score]) => ({
              race_id: raceId,
              score: Math.min(100, Math.max(0, Math.round(score * 50))),
              reason:
                "選定AIの不足枠を、戦略条件を満たす期待値・データ品質上位レースで補完",
            }));
        return [strategy, [...selected, ...supplements].slice(0, 5)];
      })) as ReturnType<typeof validateSelections>;
    for (const strategy of STRATEGIES) {
      for (let rank = 0; rank < sel[strategy].length; rank++) {
        const { error: selectionError } = await db.from("race_selections")
          .insert({
            batch_run_id: batch.id,
            race_id: sel[strategy][rank].race_id,
            strategy,
            score: sel[strategy][rank].score,
            reason: sel[strategy][rank].reason,
            rank: rank + 1,
            ai_call_id: screen.callId,
          });
        if (selectionError) throw selectionError;
      }
    }
    let pc = 0, bc = 0;
    for (const s of STRATEGIES) {
      const ids = new Set(sel[s].map((x) => x.race_id)),
        input = [...ids].map((id) => {
          const d = details.get(id)!;
          const evaluations = evaluationsByRace.get(id)!;
          const candidates = buildBetCandidates(evaluations, d.odds);
          return {
            race_id: id,
            candidate_instructions:
              "Compare expected_value and data_quality across every allowed ticket type instead of defaulting to win bets. Proposals must copy type, horses, and estimated_probability exactly from bet_candidates. SKIP when none meets the strategy policy.",
            race: d.race,
            entries: d.entries,
            evaluations,
            odds: d.odds.sort((a, b) =>
              (a.popularity ?? 9999) - (b.popularity ?? 9999)
            ).slice(0, 350),
            bet_candidates: selectCandidateShortlist(
              candidates,
              STRATEGY_POLICIES[s].allowedBetTypes,
            ).map((candidate) => ({
              type: candidate.type,
              horses: candidate.horses,
              odds: candidate.odds,
              estimated_probability: candidate.estimatedProbability,
              expected_value: candidate.expectedValue,
              data_quality: candidate.dataQuality,
            })),
          };
        }),
        { data: account } = await db.from("strategy_accounts").select(
          "current_balance",
        ).eq("strategy", s).single(),
        pr = await ai(
          db,
          batch.id,
          "prediction",
          s,
          `${
            strategyPrompt(s, Number(account?.current_balance ?? 100000))
          } 選定された最大5レースをすべて評価し、各レースについてBETまたはSKIPを返す。BET候補の中でも特に優秀な最大3レースだけがプログラムに採用される。evaluationsは過去走から決定論的に計算した総合評価で、オッズや現在人気を含まない。入力にある買い目だけ提案。各買い目にreason（評価値とオッズに基づく具体的理由）とstake_reason（期待値・確率・戦略・残高に基づく購入金額の根拠）を必ず記載。\n${
            JSON.stringify(input)
          }`,
          PREDICTION_SCHEMA,
        ),
        numbers = new Map(
          input.map((x) => [
            String(x.race_id),
            new Set(x.entries.map((e) => e.horseNumber)),
          ]),
        ),
        checked = validatePredictions(
          completeMissingPredictions(pr.value, s, ids),
          s,
          ids,
          numbers,
        ),
        market = new Map<string, { odds: number; probability: number }>();
      for (const x of input) {
        const allOdds = details.get(String(x.race_id))!.odds;
        for (const candidate of buildBetCandidates(x.evaluations, allOdds)) {
          market.set(
            `${x.race_id}:${betCandidateKey(candidate.type, candidate.horses)}`,
            {
              odds: candidate.odds,
              probability: candidate.estimatedProbability,
            },
          );
        }
      }
      const policy = STRATEGY_POLICIES[s];
      const acceptedRaceIds = selectTopRaceProposalIds(
        checked.predictions.map((prediction: any) => {
          const evaluations =
              evaluationsByRace.get(String(prediction.race_id)) ?? [],
            eligibleScores = (prediction.bets as any[]).flatMap((bet) => {
              const marketCandidate = market.get(
                  `${prediction.race_id}:${
                    betCandidateKey(bet.type, bet.horses)
                  }`,
                ),
                quality = Math.min(
                  ...bet.horses.map((horse: number) =>
                    evaluations.find((item) => item.horseNumber === horse)
                      ?.dataQuality ?? 0
                  ),
                );
              if (
                !marketCandidate || !policy.allowedBetTypes.includes(bet.type)
              ) return [];
              const calibration = calibrations.get(`${s}:${bet.type}`),
                probability = calibrateProbability(
                  calibration?.bins as CalibrationProfile | undefined,
                  marketCandidate.probability,
                ),
                expectedValue = marketCandidate.odds * probability;
              return quality >= policy.minimumDataQuality &&
                  expectedValue >= policy.minimumExpectedValue
                ? [expectedValue * quality]
                : [];
            });
          return {
            raceId: String(prediction.race_id),
            action: String(prediction.action),
            score: eligibleScores.length ? Math.max(...eligibleScores) : null,
          };
        }),
      );
      let dayStake = 0;
      for (const p of checked.predictions) {
        const { data: pred, error: pe } = await db.from("predictions").insert({
          race_id: p.race_id,
          strategy: s,
          ai_call_id: pr.callId,
          action: p.action === "BET" ? "bet" : "skip",
          confidence: p.confidence,
          reason: p.reason,
          input_hash: pr.inputHash,
          prediction_hash: await h(p),
          predicted_at: new Date().toISOString(),
          raw_response: p,
        }).select("id").single();
        if (pe) throw pe;
        pc++;
        let raceStake = 0;
        for (const b of p.bets as any[]) {
          const marketCandidate = market.get(
              `${p.race_id}:${betCandidateKey(b.type, b.horses)}`,
            ),
            odds = marketCandidate?.odds;
          const evaluations = evaluationsByRace.get(String(p.race_id)) ?? [],
            quality = Math.min(
              ...b.horses.map((horse: number) =>
                evaluations.find((x) => x.horseNumber === horse)?.dataQuality ??
                  0
              ),
            );
          const calibration = calibrations.get(`${s}:${b.type}`),
            rawProbability = marketCandidate?.probability ??
              Number(b.estimated_probability),
            estimatedProbability = calibrateProbability(
              calibration?.bins as CalibrationProfile | undefined,
              rawProbability,
            ),
            expectedValue = odds ? odds * estimatedProbability : null;
          let decision = "rejected",
            reasonCode = "ODDS_NOT_FOUND",
            reasonDetail = "市場オッズが見つからないため見送り",
            stake = 0;
          if (p.action === "BET" && !acceptedRaceIds.has(String(p.race_id))) {
            reasonCode = "RACE_PROPOSAL_NOT_TOP_THREE";
            reasonDetail =
              "5レースの提案比較で上位3レースに入らなかったため見送り";
          } else if (odds && !policy.allowedBetTypes.includes(b.type)) {
            reasonCode = "BET_TYPE_NOT_ALLOWED";
            reasonDetail = "この戦略で許可されていない券種のため見送り";
          } else if (odds && quality < policy.minimumDataQuality) {
            reasonCode = "DATA_QUALITY_LOW";
            reasonDetail = `データ品質 ${quality.toFixed(2)} が基準 ${
              policy.minimumDataQuality.toFixed(2)
            } 未満`;
          } else if (
            odds && Number(expectedValue) < policy.minimumExpectedValue
          ) {
            reasonCode = "EXPECTED_VALUE_LOW";
            reasonDetail = `期待値 ${Number(expectedValue).toFixed(2)} が基準 ${
              policy.minimumExpectedValue.toFixed(2)
            } 未満`;
          } else if (odds) {
            stake = Math.floor(
              Math.min(
                Number(b.stake),
                policy.maxStakePerRace - raceStake,
                policy.maxStakePerDay - dayStake,
              ) / 100,
            ) * 100;
            if (stake < 100) {
              reasonCode = "STAKE_LIMIT_REACHED";
              reasonDetail = "レースまたは1日の購入上限に達したため見送り";
            } else {
              decision = stake < Number(b.stake) ? "reduced" : "purchased";
              reasonCode = decision === "reduced"
                ? "STAKE_REDUCED"
                : "PURCHASED";
              reasonDetail = decision === "reduced"
                ? `上限に合わせて ${
                  Number(b.stake)
                }円から${stake}円へ減額して購入`
                : "すべての基準を通過したため購入";
            }
          }
          let betId: string | null = null;
          if (decision !== "rejected") {
            const { data: savedBet, error: betError } = await db.from("bets")
              .insert({
                prediction_id: pred.id,
                race_id: p.race_id,
                strategy: s,
                bet_type: b.type,
                combination: b.horses,
                stake,
                odds_at_prediction: odds,
                raw_estimated_probability: rawProbability,
                estimated_probability: estimatedProbability,
                calibration_profile_id: calibration?.id,
                expected_value: expectedValue,
                reason: b.reason,
                stake_reason: b.stake_reason,
              }).select("id").single();
            if (betError) throw betError;
            betId = savedBet.id;
            raceStake += stake;
            dayStake += stake;
            bc++;
          }
          const { error: decisionError } = await db.from("bet_decisions")
            .insert({
              prediction_id: pred.id,
              bet_id: betId,
              race_id: p.race_id,
              strategy: s,
              bet_type: b.type,
              combination: b.horses,
              proposed_stake: Number(b.stake),
              final_stake: stake,
              odds,
              raw_probability: rawProbability,
              calibrated_probability: estimatedProbability,
              expected_value: expectedValue,
              minimum_expected_value: policy.minimumExpectedValue,
              data_quality: Number.isFinite(quality) ? quality : 0,
              minimum_data_quality: policy.minimumDataQuality,
              decision,
              reason_code: reasonCode,
              reason_detail: reasonDetail,
              calibration_profile_id: calibration?.id,
            });
          if (decisionError) throw decisionError;
        }
      }
    }
    await db.from("batch_runs").update({
      status: "succeeded",
      races_fetched: races.length,
      api_requests: 2 + chosen.size + historyRequests + 4,
      finished_at: new Date().toISOString(),
      metadata: {
        provider: "jra_netkeiba",
        details: chosen.size,
        history_requests: historyRequests,
        history_rows: historyRows,
        history_errors: historyErrors,
        history_class_rows: historyClassRows,
        history_time_rows: historyTimeRows,
        history_corner_rows: historyCornerRows,
        formula_version: weightProfile.formula_version,
        predictions: pc,
        bets: bc,
      },
    }).eq("id", batch.id);
    return json({
      status: "succeeded",
      races: races.length,
      details: chosen.size,
      historyRows,
      historyErrors,
      predictions: pc,
      bets: bc,
      batchRunId: batch.id,
    });
    */
  } catch (e) {
    await db.from("batch_runs").update({
      status: "failed",
      error_message: e instanceof Error ? e.message : String(e),
      finished_at: new Date().toISOString(),
    }).eq("id", batch.id);
    return json({
      error: "FAILED",
      detail: e instanceof Error ? e.message : String(e),
    }, 500);
  }
});
