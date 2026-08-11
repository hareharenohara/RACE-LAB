import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import { JraProvider } from "../_shared/jra-provider.ts";
import { callGemini, MODEL } from "../_shared/gemini-client.ts";
import { applyStage1Filter } from "../_shared/stage1-filter.ts";
import {
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
  validateFinalDecision,
} from "../_shared/adaptive-prompts.ts";
import {
  sha256Json,
  verifySourceIdentities,
} from "../_shared/source-evidence.ts";
import type { RaceSummary } from "../_shared/types.ts";

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
      error_message: String(error),
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
      const checks = verifySourceIdentities(
        normalized.horses.map((horse) => ({
          horseNumber: horse.horseNumber,
          horseName: horse.horseName,
        })),
        canonical,
      );
      const identityStatus = checks.length && checks.every((x) =>
          x.status !== "mismatch"
        )
        ? "verified"
        : checks.some((x) => x.status !== "mismatch")
        ? "partial"
        : "failed";
      const safe = {
        ...normalized,
        horses: normalized.horses.filter((horse) =>
          checks.find((x) => x.horseNumber === horse.horseNumber)?.status !==
            "mismatch"
        ),
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
        parser_version: "external-generic-v2",
        identity_status: identityStatus,
        extracted_data: safe,
      }).select("id").single();
      if (snapshotError) throw snapshotError;
      if (checks.length) {
        const { error: checkError } = await db.from("entry_identity_checks")
          .insert(checks.map((check) => ({
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
    evidence_quality: { ...quality, snapshot_ids: snapshotIds },
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
  const input = {
    target_date: batch.target_date,
    races: items.map((x: any) => ({
      race_id: x.race_id,
      race: x.races,
      evidence: x.evidence,
      quality: x.evidence_quality,
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
  const validIds = new Set(items.map((x: any) => String(x.race_id)));
  const selections = ((call.value as any).selections ?? []).filter((x: any) =>
    validIds.has(String(x.race_id))
  ).slice(0, 3);
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
    await db.from("race_pipeline_items").update({
      state: "selected",
      selection_rank: selected.priority,
      selection_reason: selected.reason,
      next_action_at: finalAt,
      updated_at: nowIso(),
    }).eq("id", item.id);
    await db.from("race_selections").upsert({
      batch_run_id: batch.id,
      race_id: item.race_id,
      strategy: "single",
      score: Math.max(0, 100 - (Number(selected.priority) - 1) * 10),
      reason: selected.reason,
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
  const { data: race } = await db.from("races").select("*").eq(
    "id",
    item.race_id,
  ).single();
  const detail = await new JraProvider().getDetail(summaryFrom(race));
  await saveDetail(db, race, detail);
  const odds = detail.odds.filter((x: any) =>
    ["win", "place", "wide"].includes(x.type)
  );
  const { data: available } = await db.rpc("available_paper_balance", {
    p_strategy: "single",
  });
  const { data: rollover } = await db.from("rollover_states").select("*").eq(
    "strategy",
    "single",
  ).single();
  const finalEvidence: any[] = [];
  const refreshedSources = await Promise.all(
    SOURCE_PROFILES.map(async (profile) => {
      try {
        return normalizeSourcePage(
          profile,
          await fetchRaceSourcePage(profile, {
            raceDate: race.race_date,
            track: race.track,
            raceNumber: race.race_number,
          }),
        );
      } catch (error) {
        return {
          source: profile.name,
          status: "unavailable",
          missingFields: [String(error)],
        };
      }
    }),
  );
  finalEvidence.push(...refreshedSources);
  const input = {
    race: { ...race, entries: detail.entries },
    external_evidence: finalEvidence,
    market_odds: odds,
    available_paper_balance: Number(available ?? 0),
    rollover_state: rollover,
    selected_reason: item.selection_reason,
    captured_at: nowIso(),
    technical_rules: { bet_types: ["win", "place", "wide"], stake_unit: 100 },
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
  const technicalContext = {
    raceId: String(race.id),
    horseNumbers: detail.entries.map((x: any) => x.horseNumber),
    availableBalance: Number(available ?? 0),
    saleOpen: batch.metadata?.integration_test === true ||
      Date.now() < Date.parse(race.start_time),
    marketKeys: odds.map((x: any) =>
      `${x.type}:${
        [...x.horses].sort((a: number, b: number) => a - b).join("-")
      }`
    ),
  };
  let errors = validateFinalDecision(call.value, {
    ...technicalContext,
  });
  if (errors.length) {
    call = await ai(
      db,
      batch.id,
      "audit",
      buildFinalDecisionPrompt(input, errors),
      FINAL_DECISION_SCHEMA,
      { correction_of: call.callId, errors },
    );
    errors = validateFinalDecision(call.value, {
      ...technicalContext,
    });
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
  const decision: any = call.value;
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
  const { data: prediction, error: predictionError } = await db.from(
    "predictions",
  ).insert({
    batch_run_id: batch.id,
    race_id: race.id,
    strategy: "single",
    ai_call_id: call.callId,
    action: decision.action === "BET" ? "bet" : "skip",
    confidence: decision.confidence,
    reason: decision.reason,
    input_hash: call.inputHash,
    prediction_hash: await hash(decision),
    predicted_at: nowIso(),
    raw_response: decision,
  }).select("id").single();
  if (predictionError) throw predictionError;
  for (const bet of decision.bets) {
    const market = odds.find((x: any) =>
      x.type === bet.bet_type &&
      JSON.stringify([...x.horses].sort()) ===
        JSON.stringify([...bet.horses].sort())
    );
    if (!market) {
      throw new Error(`MARKET_ODDS_NOT_FOUND:${bet.bet_type}:${bet.horses}`);
    }
    const { data: snapshot, error: snapshotError } = await db.from(
      "market_odds_snapshots",
    ).insert({
      batch_run_id: batch.id,
      race_id: race.id,
      bet_type: bet.bet_type,
      combination: bet.horses,
      odds_low: market.odds,
      odds_high: market.oddsMax ?? null,
      source_name: "netkeiba",
      source_url: race.source_url,
      captured_at: input.captured_at,
      content_hash: await hash(market),
    }).select("id").single();
    if (snapshotError) throw snapshotError;
    const { error: betError } = await db.rpc("create_reserved_paper_bet", {
      p_prediction_id: prediction.id,
      p_race_id: race.id,
      p_strategy: "single",
      p_bet_type: bet.bet_type,
      p_combination: bet.horses,
      p_stake: bet.stake,
      p_market_snapshot_id: snapshot.id,
      p_odds_at_prediction: market.odds,
      p_raw_estimated_probability: null,
      p_estimated_probability: null,
      p_expected_value: null,
      p_reason: bet.reason,
      p_stake_reason: bet.stake_reason,
    });
    if (betError) throw betError;
  }
  await db.from("race_pipeline_items").update({
    state: "completed",
    final_attempts: item.final_attempts + 1,
    updated_at: nowIso(),
  }).eq("id", item.id);
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
      if (selected) await finalDecision(db, batch, selected);
      const { count } = await db.from("race_pipeline_items").select("id", {
        count: "exact",
        head: true,
      }).eq("batch_run_id", batch.id).eq("state", "selected");
      if (!count) metadata = { ...metadata, pipeline_stage: "complete" };
      else {
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
      status: complete ? "succeeded" : "running",
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
      error_message: String(error),
      metadata: { ...batch.metadata, last_error: String(error) },
    }).eq("id", batch.id);
    await db.rpc("release_prediction_worker_lease", {
      p_batch_run_id: batch.id,
      p_lease_id: leaseId,
    });
    return json({ error: "PIPELINE_ERROR", detail: String(error) }, 500);
  }
});
