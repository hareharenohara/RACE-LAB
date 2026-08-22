import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import { JraProvider } from "../_shared/jra-provider.ts";
import { callGemini, MODEL } from "../_shared/gemini-client.ts";
import { applyStage1Filter } from "../_shared/stage1-filter.ts";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  evaluateRace,
  type EvaluationWeights,
} from "../_shared/horse-evaluation.ts";
import {
  EXTERNAL_PARSER_VERSION,
  fetchRaceSourcePage,
  hasEvidenceQuorum,
  normalizeSourcePage,
  SOURCE_PROFILES,
} from "../_shared/external-sources.ts";
import {
  ADAPTIVE_INPUT_SCHEMA_VERSION,
  ADAPTIVE_PROMPT_VERSION,
  buildFinalDecisionPrompt,
  buildRaceSelectionPrompt,
  FINAL_DECISION_SCHEMA,
  RACE_SELECTION_SCHEMA,
  selectRaceAssessments,
} from "../_shared/adaptive-prompts.ts";
import {
  filterVerifiedSourceHorses,
  sha256Json,
} from "../_shared/source-evidence.ts";
import type { RaceSummary } from "../_shared/types.ts";
import { marketKey } from "../_shared/finalization.ts";
import {
  buildAiBetAudit,
  validateAiBetDecision,
} from "../_shared/ai-bet-decision.ts";
import {
  oddsHighForStorage,
  validateMarketOdds,
} from "../_shared/odds-validation.ts";
import { errorMessage } from "../_shared/error-message.ts";
import { buildRaceSelectionMarket } from "../_shared/race-selection-market.ts";
import {
  allocateDailyRiskBudget,
  calculateDailyBankrollState,
  currentRaceBudget,
} from "../_shared/bankroll-management.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const nowIso = () => new Date().toISOString();
const hash = (value: unknown) => sha256Json(value);

function serviceKey() {
  return Deno.env.get("SUPABASE_SECRET_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? (() => {
      try {
        return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
      } catch {
        return undefined;
      }
    })();
}

async function ai(
  db: any,
  batchId: string,
  purpose: "screening" | "prediction" | "audit",
  prompt: string,
  schema: any,
  manifest: any,
) {
  const inputHash = await hash({ prompt, schema });
  const { data: callId, error } = await db.rpc("reserve_ai_call", {
    p_batch_run_id: batchId,
    p_purpose: purpose,
    p_strategy: "single",
    p_model: MODEL,
    p_prompt_version: ADAPTIVE_PROMPT_VERSION,
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
      completed_at: nowIso(),
      input_schema_version: ADAPTIVE_INPUT_SCHEMA_VERSION,
      generation_config: {
        temperature: 0.1,
        response_mime_type: "application/json",
      },
      evidence_manifest: manifest,
    }).eq("id", callId);
    return { ...result, callId, inputHash };
  } catch (error) {
    await db.from("ai_calls").update({
      status: "failed",
      error_message: errorMessage(error),
      completed_at: nowIso(),
    }).eq("id", callId);
    throw error;
  }
}

const summaryFrom = (race: any): RaceSummary => ({
  externalId: race.external_id,
  raceDate: race.race_date,
  track: race.track,
  raceNumber: race.race_number,
  raceName: race.race_name,
  raceClass: race.race_class ?? undefined,
  startTime: race.start_time,
  surface: race.surface ?? undefined,
  distance: race.distance ?? undefined,
  condition: race.condition ?? undefined,
  runnerCount: race.runner_count ?? undefined,
  sourceUrl: race.source_url,
});

async function saveDetail(db: any, race: any, detail: any) {
  await db.from("races").update({
    condition: detail.race.condition,
    weather: detail.race.weather,
    runner_count: detail.entries.length,
    source_fetched_at: nowIso(),
  }).eq("id", race.id);
  const canonical: {
    horseNumber: number;
    horseName: string;
    externalId?: string;
    horseId: string;
  }[] = [];
  for (const entry of detail.entries) {
    const externalId = String(entry.umaxScores?.horse_id ?? "") || null;
    let horseQuery = externalId
      ? db.from("horses").upsert({
        external_id: externalId,
        name: entry.horseName,
      }, { onConflict: "external_id" })
      : db.from("horses").insert({ name: entry.horseName });
    const { data: horse, error } = await horseQuery.select(
      "id,external_id,name",
    ).single();
    if (error) throw error;
    await db.from("race_entries").upsert({
      race_id: race.id,
      horse_id: horse.id,
      horse_number: entry.horseNumber,
      gate_number: entry.gateNumber,
      jockey: entry.jockey,
      trainer: entry.trainer,
      weight_carried: entry.weightCarried,
      horse_weight: entry.horseWeight,
      horse_weight_delta: entry.horseWeightDelta,
      win_odds: entry.winOdds,
      place_odds_low: entry.placeOddsLow,
      place_odds_high: entry.placeOddsHigh,
      popularity: entry.popularity,
      source_data: entry.sourceData,
      raw_data: {},
    }, { onConflict: "race_id,horse_number" });
    canonical.push({
      horseNumber: entry.horseNumber,
      horseName: entry.horseName,
      externalId: horse.external_id ?? undefined,
      horseId: horse.id,
    });
  }
  return canonical;
}

async function stage1(db: any, batch: any) {
  const queue = batch.metadata?.race_queue ?? [];
  let testCandidates = 0;
  for (const item of queue) {
    const { data: race } = await db.from("races").select("*").eq(
      "id",
      item.race_id,
    ).single();
    const quick = applyStage1Filter({
      raceName: race.race_name,
      raceClass: race.race_class,
      surface: race.surface,
      condition: race.condition,
      runnerCount: race.runner_count,
    });
    if (quick.eligible && batch.metadata?.integration_test === true) {
      testCandidates++;
      if (testCandidates > 3) {
        quick.reasons.push("INTEGRATION_TEST_SCOPE_LIMIT");
      }
    }
    const eligible = quick.reasons.length === 0;
    await db.from("race_pipeline_items").upsert({
      batch_run_id: batch.id,
      race_id: race.id,
      state: eligible ? "evidence_pending" : "stage1_rejected",
      stage1_reasons: quick.reasons,
      next_action_at: batch.metadata.selection_due_at,
    }, { onConflict: "batch_run_id,race_id" });
  }
  return { ...batch.metadata, pipeline_stage: "evidence" };
}

async function collectEvidence(db: any, batch: any, item: any) {
  const { data: race, error } = await db.from("races").select("*").eq(
    "id",
    item.race_id,
  ).single();
  if (error) throw error;
  const provider = new JraProvider();
  const detail = await provider.getDetail(summaryFrom(race));
  const selectionMarket = buildRaceSelectionMarket(
    detail.entries,
    detail.odds,
  );
  const canonical = await saveDetail(db, race, detail);
  const refined = applyStage1Filter({
    raceName: detail.race.raceName,
    raceClass: detail.race.raceClass,
    surface: detail.race.surface,
    condition: detail.race.condition,
    runnerCount: detail.entries.length,
  });
  if (!refined.eligible) {
    await db.from("race_pipeline_items").update({
      state: "stage1_rejected",
      stage1_reasons: refined.reasons,
      updated_at: nowIso(),
    }).eq("id", item.id);
    return;
  }
  const evidence: any[] = [], snapshotIds: string[] = [];
  const fetchedSources = await Promise.all(
    SOURCE_PROFILES.map(async (profile) => {
      try {
        const page = await fetchRaceSourcePage(profile, {
          raceDate: race.race_date,
          track: race.track,
          raceNumber: race.race_number,
        });
        return {
          profile,
          page,
          normalized: normalizeSourcePage(profile, page),
        };
      } catch (error) {
        return { profile, error };
      }
    }),
  );
  for (const fetched of fetchedSources) {
    const profile = fetched.profile;
    if ("error" in fetched) {
      evidence.push({
        source: profile.name,
        status: "unavailable",
        numeric: profile.numeric,
        horses: [],
        missingFields: [String(fetched.error)],
      });
      continue;
    }
    try {
      const { page, normalized } = fetched;
      const verified = filterVerifiedSourceHorses(
        normalized.horses,
        canonical,
      );
      const safe = {
        ...normalized,
        horses: verified.horses,
        identityStatus: verified.identityStatus,
      };
      safe.status = safe.horses.length ? "ok" : "unavailable";
      safe.missingFields = safe.horses.length ? [] : ["verified_horse_signals"];
      const { data: snapshot, error: snapshotError } = await db.from(
        "source_data_snapshots",
      ).insert({
        batch_run_id: batch.id,
        race_id: race.id,
        stage: "screening",
        source_name: profile.name,
        source_url: page.url,
        captured_at: page.capturedAt,
        content_hash: await hash(safe),
        parser_version: EXTERNAL_PARSER_VERSION,
        identity_status: verified.identityStatus,
        extracted_data: safe,
      }).select("id").single();
      if (snapshotError) throw snapshotError;
      if (verified.checks.length) {
        const { error: checkError } = await db.from("entry_identity_checks")
          .insert(verified.checks.map((check) => ({
            snapshot_id: snapshot.id,
            race_id: race.id,
            horse_id: canonical.find((horse) =>
              horse.horseNumber === check.horseNumber
            )?.horseId ?? null,
            horse_number: check.horseNumber,
            source_horse_name: check.sourceHorseName,
            canonical_horse_name: check.canonicalHorseName,
            source_external_id: check.sourceExternalId,
            canonical_external_id: check.canonicalExternalId,
            match_status: check.status,
            mismatch_reason: check.reason,
          })));
        if (checkError) throw checkError;
      }
      snapshotIds.push(snapshot.id);
      evidence.push(safe);
    } catch (sourceError) {
      evidence.push({
        source: profile.name,
        status: "unavailable",
        numeric: profile.numeric,
        horses: [],
        missingFields: [String(sourceError)],
      });
    }
  }
  const quality = hasEvidenceQuorum(evidence);
  await db.from("race_pipeline_items").update({
    state: quality.ready ? "evidence_ready" : "evidence_insufficient",
    evidence,
    evidence_quality: {
      ...quality,
      snapshot_ids: snapshotIds,
      selection_market: selectionMarket,
    },
    updated_at: nowIso(),
  }).eq("id", item.id);
}

async function selectRaces(db: any, batch: any) {
  const { data: items } = await db.from("race_pipeline_items").select(
    "*,races(*)",
  ).eq("batch_run_id", batch.id).eq("state", "evidence_ready");
  if (!items?.length) {
    return {
      ...batch.metadata,
      pipeline_stage: "complete",
      completed_summary: { reason: "no_stage1_candidates" },
    };
  }
  const provider = new JraProvider();
  const refreshedMarkets = new Map<
    string,
    ReturnType<typeof buildRaceSelectionMarket>
  >();
  await Promise.all(items.map(async (item: any) => {
    try {
      const detail = await provider.getDetail(summaryFrom(item.races));
      const market = buildRaceSelectionMarket(detail.entries, detail.odds);
      refreshedMarkets.set(String(item.race_id), market);
      item.evidence_quality = {
        ...(item.evidence_quality ?? {}),
        selection_market: market,
      };
      await db.from("race_pipeline_items").update({
        evidence_quality: item.evidence_quality,
        updated_at: nowIso(),
      }).eq("id", item.id);
    } catch {
      refreshedMarkets.set(String(item.race_id), {
        status: "unavailable",
        captured_at: nowIso(),
        runners: [],
      });
    }
  }));
  const input = {
    target_date: batch.target_date,
    races: items.map((x: any) => ({
      race_id: x.race_id,
      race: x.races,
      evidence: x.evidence,
      quality: x.evidence_quality,
      market: refreshedMarkets.get(String(x.race_id)) ?? {
        status: "unavailable",
        captured_at: null,
        runners: [],
      },
    })),
  };
  const call = await ai(
    db,
    batch.id,
    "screening",
    buildRaceSelectionPrompt(input),
    RACE_SELECTION_SCHEMA,
    {
      source_snapshot_ids: items.flatMap((x: any) =>
        x.evidence_quality?.snapshot_ids ?? []
      ),
    },
  );
  const validIds = new Set<string>(items.map((x: any) => String(x.race_id)));
  const horseNumbers = new Map<string, Set<number>>(items.map((x: any) => [
    String(x.race_id),
    new Set<number>(
      (x.evidence ?? []).flatMap((source: any) =>
        (source.horses ?? []).map((horse: any) => Number(horse.horseNumber))
      ).filter(Number.isFinite),
    ),
  ]));
  const selections = selectRaceAssessments(call.value, validIds, horseNumbers);
  const { data: account, error: accountError } = await db.from(
    "strategy_accounts",
  ).select("current_balance").eq("strategy", "single").single();
  if (accountError) throw accountError;
  const { data: existingBankroll } = await db.from("daily_bankroll_states")
    .select("*").eq("strategy", "single").eq(
      "session_date",
      batch.target_date,
    ).maybeSingle();
  const openingBalance = Number(
    existingBankroll?.opening_balance ?? account.current_balance,
  );
  const bankroll = calculateDailyBankrollState(
    openingBalance,
    Number(account.current_balance),
    Number(existingBankroll?.peak_balance ?? openingBalance),
  );
  const allocations = allocateDailyRiskBudget(
    openingBalance,
    selections.map((selection) => ({
      raceId: selection.race_id,
      weight: selection.budget_weight,
    })),
  );
  const { error: bankrollError } = await db.from("daily_bankroll_states")
    .upsert({
      strategy: "single",
      session_date: batch.target_date,
      opening_balance: bankroll.openingBalance,
      peak_balance: bankroll.peakBalance,
      loss_floor: bankroll.lossFloor,
      lock_balance: bankroll.lockBalance,
      peak_profit_rate: bankroll.peakProfitRate,
      lock_profit_rate: bankroll.lockProfitRate,
      mode: bankroll.mode,
      updated_at: nowIso(),
    }, { onConflict: "strategy,session_date" });
  if (bankrollError) throw bankrollError;
  for (const item of items) {
    const selected = selections.find((x: any) =>
      String(x.race_id) === String(item.race_id)
    );
    if (!selected) {
      await db.from("race_pipeline_items").update({
        state: "not_selected",
        updated_at: nowIso(),
      }).eq("id", item.id);
      continue;
    }
    const finalAt = new Date(Date.parse(item.races.start_time) - 20 * 60_000)
      .toISOString();
    const selectionReason =
      `AI_SELECTION: ${selected.selection_reason} / 比較判断: ${selected.decision_reason}`;
    const initialBudget = allocations.get(selected.race_id) ?? 0;
    await db.from("race_pipeline_items").update({
      state: "selected",
      selection_rank: selected.priority,
      selection_reason: selectionReason,
      budget_weight: selected.budget_weight,
      initial_budget: initialBudget,
      budget_mode: "normal",
      next_action_at: finalAt,
      updated_at: nowIso(),
    }).eq("id", item.id);
    await db.from("race_selections").upsert({
      batch_run_id: batch.id,
      race_id: item.race_id,
      strategy: "single",
      score: selected.total_score,
      reason: selectionReason,
      rank: selected.priority,
      ai_call_id: call.callId,
    }, { onConflict: "batch_run_id,strategy,race_id" });
  }
  return {
    ...batch.metadata,
    pipeline_stage: "finals",
    selection_ai_call_id: call.callId,
  };
}

async function finalDecision(db: any, batch: any, item: any) {
  const { data: priorPrediction, error: priorError } = await db.from(
    "predictions",
  ).select("id,action,bets(id)").eq("batch_run_id", batch.id).eq(
    "strategy",
    "single",
  ).eq("race_id", item.race_id).maybeSingle();
  if (priorError) throw priorError;
  if (priorPrediction) {
    const complete = priorPrediction.action === "skip" ||
      priorPrediction.bets?.length > 0;
    await db.from("race_pipeline_items").update({
      state: complete ? "completed" : "failed",
      last_error: complete ? null : "INCOMPLETE_PREDICTION_EXISTS",
      updated_at: nowIso(),
    }).eq("id", item.id);
    return;
  }
  const { data: race } = await db.from("races").select("*").eq(
    "id",
    item.race_id,
  ).single();
  const detail = await new JraProvider().getDetail(summaryFrom(race));
  const canonical = await saveDetail(db, race, detail);
  let independentEvaluation: Record<string, unknown> = {
    status: "unavailable",
    reason: "past_runs_not_collected",
    evaluations: [],
  };
  try {
    const provider = new JraProvider();
    const pastRuns = await provider.getPastRuns(summaryFrom(race));
    const pastRunsByHorse = new Map<string, typeof pastRuns>();
    for (const run of pastRuns) {
      const history = pastRunsByHorse.get(run.externalHorseId) ?? [];
      if (history.length >= 5) continue;
      history.push(run);
      pastRunsByHorse.set(run.externalHorseId, history);
    }
    let weights: EvaluationWeights = DEFAULT_EVALUATION_WEIGHTS;
    const { data: weightProfile } = await db.from("evaluation_weight_profiles")
      .select(
        "ability_weight,suitability_weight,condition_weight,race_context_weight,formula_version",
      ).eq("is_active", true).maybeSingle();
    if (weightProfile) {
      weights = {
        ability: Number(weightProfile.ability_weight),
        suitability: Number(weightProfile.suitability_weight),
        condition: Number(weightProfile.condition_weight),
        raceContext: Number(weightProfile.race_context_weight),
      };
    }
    independentEvaluation = {
      status: "ok",
      formulaVersion: weightProfile?.formula_version ?? "deterministic-v1",
      excludesCurrentOddsAndPopularity: true,
      weights,
      evaluations: evaluateRace(
        detail.race,
        detail.entries,
        pastRunsByHorse,
        weights,
      ).sort((a, b) => b.overallScore - a.overallScore),
    };
  } catch (error) {
    independentEvaluation = {
      status: "unavailable",
      reason: errorMessage(error),
      evaluations: [],
    };
  }
  const odds = detail.odds.filter((x: any) =>
    ["win", "place", "wide", "quinella"].includes(x.type)
  );
  const { data: available } = await db.rpc("available_paper_balance", {
    p_strategy: "single",
  });
  const { data: account, error: accountError } = await db.from(
    "strategy_accounts",
  ).select("current_balance").eq("strategy", "single").single();
  if (accountError) throw accountError;
  const { data: storedBankroll, error: bankrollError } = await db.from(
    "daily_bankroll_states",
  ).select("*").eq("strategy", "single").eq(
    "session_date",
    batch.target_date,
  ).single();
  if (bankrollError) throw bankrollError;
  const openReservations = Math.max(
    0,
    Number(account.current_balance) - Number(available ?? 0),
  );
  const bankroll = calculateDailyBankrollState(
    Number(storedBankroll.opening_balance),
    Number(account.current_balance),
    Number(storedBankroll.peak_balance),
    openReservations,
  );
  const { data: futureItems, error: futureError } = await db.from(
    "race_pipeline_items",
  ).select("initial_budget,races!inner(start_time)").eq(
    "batch_run_id",
    batch.id,
  ).eq("state", "selected").gt("races.start_time", race.start_time);
  if (futureError) throw futureError;
  const futureReservedBudgets = (futureItems ?? []).reduce(
    (sum: number, future: any) => sum + Number(future.initial_budget ?? 0),
    0,
  );
  const wagerBudget = currentRaceBudget(
    bankroll,
    Number(item.initial_budget ?? 0),
    futureReservedBudgets,
  );
  const { error: itemBudgetError } = await db.from("race_pipeline_items")
    .update({
      final_budget: wagerBudget,
      budget_mode: bankroll.mode,
      updated_at: nowIso(),
    }).eq("id", item.id);
  if (itemBudgetError) throw itemBudgetError;
  const { data: rollover } = await db.from("rollover_states").select("*").eq(
    "strategy",
    "single",
  ).single();
  const finalEvidence: any[] = [];
  const refreshedSources = await Promise.all(
    SOURCE_PROFILES.map(async (profile) => {
      try {
        const normalized = normalizeSourcePage(
          profile,
          await fetchRaceSourcePage(profile, {
            raceDate: race.race_date,
            track: race.track,
            raceNumber: race.race_number,
          }),
        );
        const verified = filterVerifiedSourceHorses(
          normalized.horses,
          canonical,
        );
        return {
          ...normalized,
          status: verified.horses.length
            ? "ok" as const
            : "unavailable" as const,
          horses: verified.horses,
          missingFields: verified.horses.length
            ? []
            : ["verified_horse_signals"],
          identityStatus: verified.identityStatus,
        };
      } catch (error) {
        return {
          source: profile.name,
          status: "unavailable",
          numeric: profile.numeric,
          horses: [],
          missingFields: [errorMessage(error)],
          identityStatus: "failed" as const,
        };
      }
    }),
  );
  finalEvidence.push(...refreshedSources);
  const validOdds = odds.filter((market: any) =>
    validateMarketOdds(market).valid
  );
  const input = {
    race: { ...race, entries: detail.entries },
    independent_evaluation: independentEvaluation,
    external_evidence: finalEvidence,
    capital_context: {
      capital_mode: bankroll.mode,
      boost_allowed: bankroll.mode === "attack",
    },
    available_paper_balance: Number(available ?? 0),
    wager_budget: {
      maximum_total_stake: wagerBudget,
      stake_unit: 100,
      daily_loss_floor: bankroll.lossFloor,
      active_lock_balance: bankroll.hardFloor,
    },
    valid_market_odds: validOdds,
    selected_reason: item.selection_reason,
    captured_at: nowIso(),
  };
  let call = await ai(
    db,
    batch.id,
    "prediction",
    buildFinalDecisionPrompt(input),
    FINAL_DECISION_SCHEMA,
    {
      market_captured_at: input.captured_at,
      source_names: finalEvidence.map((x) => x.source),
    },
  );
  const runners = detail.entries.map((entry: any) => ({
    horseNumber: Number(entry.horseNumber),
    horseName: String(entry.horseName),
  }));
  const technicalContext = {
    raceId: String(race.id),
    runners,
    markets: validOdds,
    mode: bankroll.mode,
    maximumTotalStake: wagerBudget,
    availableBalance: Number(available ?? 0),
    saleOpen: batch.metadata?.integration_test === true ||
      Date.now() < Date.parse(race.start_time),
  } as const;
  let errors = validateAiBetDecision(call.value, technicalContext);
  if (errors.length) {
    call = await ai(
      db,
      batch.id,
      "audit",
      buildFinalDecisionPrompt(input, errors),
      FINAL_DECISION_SCHEMA,
      { correction_of: call.callId, errors },
    );
    errors = validateAiBetDecision(call.value, technicalContext);
  }
  if (errors.length) {
    await db.from("race_pipeline_items").update({
      state: "invalid_output",
      final_attempts: item.final_attempts + 2,
      last_error: errors.join("; "),
      updated_at: nowIso(),
    }).eq("id", item.id);
    return;
  }
  const proposal: any = call.value;
  const selection = buildAiBetAudit(proposal, technicalContext);
  const decision = {
    ...proposal,
    system_validation: {
      capital_mode: bankroll.mode,
      maximum_total_stake: wagerBudget,
      validation_errors: [],
      decisions: selection.decisions,
    },
  };
  if (batch.metadata?.integration_test === true) {
    const { error: testError } = await db.from(
      "prediction_integration_test_runs",
    ).upsert({
      batch_run_id: batch.id,
      race_id: race.id,
      ai_call_id: call.callId,
      available_balance: Number(available ?? 0),
      rollover_state: rollover,
      input_payload: input,
      decision,
      validation_errors: [],
    }, { onConflict: "batch_run_id,race_id" });
    if (testError) throw testError;
    await db.from("race_pipeline_items").update({
      state: "completed",
      final_attempts: item.final_attempts + 1,
      updated_at: nowIso(),
    }).eq("id", item.id);
    return;
  }
  const marketByKey = new Map(validOdds.map((market: any) => [
    marketKey(market.type, market.horses),
    market,
  ]));
  const aiBetByKey = new Map((proposal.bets ?? []).map((bet: any) => [
    marketKey(bet.bet_type, bet.horses),
    bet,
  ]));
  const atomicBets = await Promise.all(selection.purchases.map(async (bet) => {
    const market: any = marketByKey.get(marketKey(bet.type, bet.horses));
    if (!market) {
      throw new Error(`MARKET_ODDS_NOT_FOUND:${bet.type}:${bet.horses}`);
    }
    const aiBet: any = aiBetByKey.get(marketKey(bet.type, bet.horses));
    return {
      bet_type: bet.type,
      horses: bet.horses,
      stake: bet.stake,
      reason: aiBet.reason,
      stake_reason: aiBet.stake_reason,
      odds: market.odds,
      odds_max: oddsHighForStorage(market),
      raw_probability: bet.rawProbability,
      calibrated_probability: bet.calibratedProbability,
      expected_value: bet.expectedValue,
      ticket_score: bet.ticketScore,
      confidence_grade: bet.confidence,
      source_url: race.source_url,
      captured_at: input.captured_at,
      content_hash: await hash(market),
    };
  }));
  const auditDecisions = selection.decisions.map((bet) => ({
    bet_type: bet.type,
    horses: bet.horses,
    proposed_stake: bet.stake,
    final_stake: bet.decision === "purchased" ? bet.stake : 0,
    odds: bet.odds,
    odds_max: oddsHighForStorage({
      type: bet.type,
      oddsMax: bet.oddsMax,
    }),
    raw_probability: bet.rawProbability,
    calibrated_probability: bet.calibratedProbability,
    expected_value: bet.expectedValue,
    minimum_expected_value: bet.minimumExpectedValue,
    confidence_grade: bet.confidence,
    ticket_score: bet.ticketScore,
    decision: bet.decision,
    reason_code: bet.reasonCode,
    reason_detail: bet.reasonDetail,
  }));
  const confidenceNumber =
    ({ S: 95, A: 90, B: 85, C: 75 } as Record<string, number>)[
      proposal.overall_confidence
    ] ?? 75;
  const action = proposal.action === "BET" ? "bet" : "skip";
  const reason = proposal.reason;
  const predictedAt = nowIso();
  const { error: finalizeError } = await db.rpc(
    "finalize_prediction_decision",
    {
      p_pipeline_item_id: item.id,
      p_batch_run_id: batch.id,
      p_race_id: race.id,
      p_strategy: "single",
      p_ai_call_id: call.callId,
      p_action: action,
      p_confidence: confidenceNumber,
      p_reason: reason,
      p_input_hash: call.inputHash,
      p_prediction_hash: await hash(decision),
      p_predicted_at: predictedAt,
      p_raw_response: decision,
      p_bets: atomicBets,
      p_decisions: auditDecisions,
    },
  );
  if (finalizeError) throw finalizeError;
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return json({ status: "ok", pipeline: "adaptive-v2", model: MODEL });
  }
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);
  if (req.headers.get("x-batch-secret") !== Deno.env.get("BATCH_SECRET")) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL"), key = serviceKey();
  if (!url || !key) return json({ error: "ENV" }, 500);
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: expiredSelections, error: expiredSelectionError } = await db
    .from("race_pipeline_items").select("id,races!inner(start_time)")
    .eq("state", "selected").lt("races.start_time", nowIso());
  if (expiredSelectionError) {
    return json({ error: expiredSelectionError.message }, 500);
  }
  const expiredIds = (expiredSelections ?? []).map((item: any) => item.id);
  if (expiredIds.length) {
    const { error: expireError } = await db.from("race_pipeline_items").update({
      state: "failed",
      next_action_at: null,
      last_error:
        "FINAL_DECISION_WINDOW_EXPIRED: selected race reached its start time before final decision",
      updated_at: nowIso(),
    }).in("id", expiredIds);
    if (expireError) return json({ error: expireError.message }, 500);
  }
  const { data: batches, error } = await db.from("batch_runs").select(
    "id,target_date,status,metadata",
  ).eq("status", "running").order("started_at").limit(10);
  if (error) return json({ error: error.message }, 500);
  const batch = (batches ?? []).find((x: any) =>
    x.metadata?.pipeline_version === "adaptive-v2"
  );
  if (!batch) return json({ status: "idle" });
  const leaseId = crypto.randomUUID();
  const { data: acquired, error: leaseError } = await db.rpc(
    "acquire_prediction_worker_lease",
    { p_batch_run_id: batch.id, p_lease_id: leaseId, p_lease_seconds: 140 },
  );
  if (leaseError) return json({ error: leaseError.message }, 500);
  if (!acquired) return json({ status: "busy", batchRunId: batch.id }, 202);
  try {
    const stage = batch.metadata.pipeline_stage;
    let metadata = batch.metadata;
    let terminalError: string | null = null;
    if (stage === "stage1") metadata = await stage1(db, batch);
    else if (stage === "evidence") {
      const due = Date.parse(batch.metadata.selection_due_at ?? "");
      const { data: pending } = await db.from("race_pipeline_items").select("*")
        .eq("batch_run_id", batch.id).eq("state", "evidence_pending").limit(1)
        .maybeSingle();
      if (pending && Date.now() >= due) {
        await collectEvidence(db, batch, pending);
      } else if (!pending && Date.now() >= due) {
        metadata = await selectRaces(db, batch);
      } else {
        await db.rpc("release_prediction_worker_lease", {
          p_batch_run_id: batch.id,
          p_lease_id: leaseId,
        });
        return json({
          status: "waiting",
          next: batch.metadata.selection_due_at,
        });
      }
    } else if (stage === "finals") {
      const { data: selected } = await db.from("race_pipeline_items").select(
        "*",
      ).eq("batch_run_id", batch.id)
        .eq("state", "selected").lte("next_action_at", nowIso()).order(
          "next_action_at",
        ).limit(1).maybeSingle();
      if (selected) {
        try {
          await finalDecision(db, batch, selected);
        } catch (error) {
          const message = errorMessage(error);
          const { error: itemError } = await db.from("race_pipeline_items")
            .update({
              state: "failed",
              final_attempts: selected.final_attempts + 1,
              last_error: message,
              updated_at: nowIso(),
            }).eq("id", selected.id);
          if (itemError) throw itemError;
        }
      }
      const { count } = await db.from("race_pipeline_items").select("id", {
        count: "exact",
        head: true,
      }).eq("batch_run_id", batch.id).eq("state", "selected");
      if (!count) {
        const { count: issueCount, error: issueCountError } = await db.from(
          "race_pipeline_items",
        ).select("id", { count: "exact", head: true }).eq(
          "batch_run_id",
          batch.id,
        ).in("state", ["failed", "invalid_output"]);
        if (issueCountError) throw issueCountError;
        if (issueCount) {
          terminalError = `PIPELINE_COMPLETED_WITH_${issueCount}_ITEM_ERRORS`;
        }
        metadata = { ...metadata, pipeline_stage: "complete" };
      } else {
        await db.rpc("release_prediction_worker_lease", {
          p_batch_run_id: batch.id,
          p_lease_id: leaseId,
        });
        return json({ status: "waiting_for_final", remaining: count });
      }
    }
    const complete = metadata.pipeline_stage === "complete";
    await db.from("batch_runs").update({
      metadata,
      status: complete ? (terminalError ? "failed" : "succeeded") : "running",
      error_message: terminalError,
      finished_at: complete ? nowIso() : null,
    }).eq("id", batch.id);
    await db.rpc("release_prediction_worker_lease", {
      p_batch_run_id: batch.id,
      p_lease_id: leaseId,
    });
    return json({
      status: complete ? "succeeded" : "stage_succeeded",
      stage: metadata.pipeline_stage,
      batchRunId: batch.id,
    });
  } catch (error) {
    await db.from("batch_runs").update({
      error_message: errorMessage(error),
      metadata: { ...batch.metadata, last_error: errorMessage(error) },
    }).eq("id", batch.id);
    await db.rpc("release_prediction_worker_lease", {
      p_batch_run_id: batch.id,
      p_lease_id: leaseId,
    });
    return json({ error: "PIPELINE_ERROR", detail: errorMessage(error) }, 500);
  }
});
