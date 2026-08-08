import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import { JraProvider } from "../_shared/jra-provider.ts";
import { callGemini, MODEL } from "../_shared/gemini-client.ts";
import { evaluateRace } from "../_shared/horse-evaluation.ts";
import {
  PREDICTION_SCHEMA,
  SELECTION_SCHEMA,
  STRATEGIES,
  validatePredictions,
  validateSelections,
} from "../_shared/ai-contracts.ts";
import type { PastRun, Strategy } from "../_shared/types.ts";
const json = (x: unknown, s = 200) =>
    new Response(JSON.stringify(x), {
      status: s,
      headers: { "content-type": "application/json" },
    }),
  unordered = new Set(["wide", "quinella", "trio"]);
const h = async (x: unknown) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(x)),
        ),
      ),
    ].map((b) => b.toString(16).padStart(2, "0")).join(""),
  ok = (t: string, ns: number[]) =>
    `${t}:${(unordered.has(t) ? [...ns].sort((a, b) => a - b) : ns).join("-")}`;
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
        "id,external_id,track,race_number,race_name,start_time,surface,distance",
      );
    if (re) throw re;
    const screenInput = (saved ?? []).map((r) => ({
        race_id: r.id,
        track: r.track,
        race_number: r.race_number,
        race_name: r.race_name,
        start_time: r.start_time,
        surface: r.surface,
        distance: r.distance,
      })
      ),
      screen = await ai(
        db,
        batch.id,
        "screening",
        null,
        `JRA中央競馬の一覧から保守型・バランス型・積極型ごとに最大3レースを選定。無理に選ばず空配列可。race_id厳守。\n${
          JSON.stringify(screenInput)
        }`,
        SELECTION_SCHEMA,
      ),
      valid = new Set(screenInput.map((r) => String(r.race_id))),
      sel = validateSelections(screen.value, valid);
    for (const s of STRATEGIES) {
      for (let i = 0; i < sel[s].length; i++) {
        await db.from("race_selections").insert({
          batch_run_id: batch.id,
          race_id: sel[s][i].race_id,
          strategy: s,
          score: sel[s][i].score,
          reason: sel[s][i].reason,
          rank: i + 1,
          ai_call_id: screen.callId,
        });
      }
    }
    const chosen = new Set(
        STRATEGIES.flatMap((s) => sel[s].map((x) => x.race_id)),
      ),
      details = new Map<
        string,
        Awaited<ReturnType<JraProvider["getDetail"]>>
      >(),
      horseDbIds = new Map<string, string>();
    let historyRequests = 0, historyRows = 0, historyErrors = 0;
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
                surface: run.surface,
                distance: run.distance,
                condition: run.condition,
                finish_position: run.finishPosition,
                popularity: run.popularity,
                finish_time: run.finishTime,
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
          "horse_id,race_date,track,race_name,surface,distance,condition,finish_position,popularity,odds,finish_time,last3f,margin,jockey,weight_carried,horse_weight,runner_count",
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
        surface: row.surface,
        distance: row.distance,
        condition: row.condition,
        finishPosition: row.finish_position,
        popularity: row.popularity,
        odds: row.odds,
        finishTime: row.finish_time,
        last3f: row.last3f,
        margin: row.margin == null ? undefined : Number(row.margin),
        jockey: row.jockey,
        weightCarried: row.weight_carried,
        horseWeight: row.horse_weight,
        runnerCount: row.runner_count,
      });
      pastRunsByHorse.set(externalId, history);
    }
    let pc = 0, bc = 0;
    for (const s of STRATEGIES) {
      const ids = new Set(sel[s].map((x) => x.race_id)),
        input = [...ids].map((id) => {
          const d = details.get(id)!;
          return {
            race_id: id,
            race: d.race,
            entries: d.entries,
            evaluations: evaluateRace(d.race, d.entries, pastRunsByHorse),
            odds: d.odds.sort((a, b) =>
              (a.popularity ?? 9999) - (b.popularity ?? 9999)
            ).slice(0, 350),
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
          `JRAの${s}戦略。残高${
            account?.current_balance ?? 100000
          }円。evaluationsは過去走から決定論的に計算した総合評価で、オッズや現在人気を含まない。estimatedWinProbabilityと市場オッズから期待値を判断し、dataQualityが0.6未満なら原則SKIP。入力にある買い目だけ100円単位で提案。各買い目にreason（評価値とオッズに基づく具体的理由）とstake_reason（期待値・確率・戦略・残高に基づく購入金額の根拠）を必ず記載。弱ければSKIP。\n${
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
        checked = validatePredictions(pr.value, s, ids, numbers),
        market = new Map<string, number>();
      for (const x of input) {
        for (const o of x.odds) {
          market.set(`${x.race_id}:${ok(o.type, o.horses)}`, o.odds);
        }
      }
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
        for (const b of p.bets as any[]) {
          const odds = market.get(`${p.race_id}:${ok(b.type, b.horses)}`);
          if (!odds) throw new Error("ODDS_NOT_FOUND");
          await db.from("bets").insert({
            prediction_id: pred.id,
            race_id: p.race_id,
            strategy: s,
            bet_type: b.type,
            combination: b.horses,
            stake: b.stake,
            odds_at_prediction: odds,
            estimated_probability: b.estimated_probability,
            expected_value: odds * b.estimated_probability,
            reason: b.reason,
            stake_reason: b.stake_reason,
          });
          bc++;
        }
      }
    }
    await db.from("batch_runs").update({
      status: "succeeded",
      races_fetched: races.length,
      api_requests: 2 + chosen.size * 2 + historyRequests + 4,
      finished_at: new Date().toISOString(),
      metadata: {
        provider: "jra_netkeiba",
        details: chosen.size,
        history_requests: historyRequests,
        history_rows: historyRows,
        history_errors: historyErrors,
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
