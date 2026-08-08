import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import * as cheerio from "npm:cheerio@1.0.0";
import { optimizeEvaluationWeights } from "../_shared/weight-optimizer.ts";

type BetType =
  | "win"
  | "place"
  | "wide"
  | "quinella"
  | "exacta"
  | "trio"
  | "trifecta";
type Payout = { type: BetType; horses: number[]; payout: number };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const headers = {
  "user-agent": "RaceLab-Personal/1.0",
  "referer": "https://race.netkeiba.com/",
};
const typeMap: Record<string, BetType | undefined> = {
  "単勝": "win",
  "複勝": "place",
  "ワイド": "wide",
  "馬連": "quinella",
  "馬単": "exacta",
  "3連複": "trio",
  "3連単": "trifecta",
  "三連複": "trio",
  "三連単": "trifecta",
};
const horseCount: Record<BetType, number> = {
  win: 1,
  place: 1,
  wide: 2,
  quinella: 2,
  exacta: 2,
  trio: 3,
  trifecta: 3,
};
const unordered = new Set<BetType>(["wide", "quinella", "trio"]);
const key = (type: BetType, horses: number[]) =>
  type + ":" +
  (unordered.has(type) ? [...horses].sort((a, b) => a - b) : horses).join("-");
const hash = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ].map((x) => x.toString(16).padStart(2, "0")).join("");

function parseResult(html: string) {
  const $ = cheerio.load(html), finishOrder: number[] = [];
  $(".RaceTable01 tbody tr, .RaceTable01 tr.HorseList").each((_, row) => {
    const rank = Number($(row).find(".Rank").first().text().trim());
    const horse = Number($(row).find("td.Num.Txt_C").first().text().trim());
    if (
      Number.isInteger(rank) && rank > 0 && Number.isInteger(horse) && horse > 0
    ) finishOrder[rank - 1] = horse;
  });
  const payouts: Payout[] = [];
  $(".Payout_Detail_Table tr").each((_, row) => {
    const cells = $(row).find("th,td").toArray();
    if (cells.length < 3) return;
    const label = $(cells[0]).text().replace(/\s/g, ""), type = typeMap[label];
    if (!type) return;
    const horses = $(cells[1]).text().match(/\d+/g)?.map(Number) ?? [];
    const amounts = $(cells[2]).text().match(/[\d,]+(?=円)/g)?.map((x) =>
      Number(x.replaceAll(",", ""))
    ) ?? [];
    const size = horseCount[type];
    for (let i = 0; i < amounts.length; i++) {
      const combo = horses.slice(i * size, (i + 1) * size);
      if (combo.length === size && amounts[i] >= 0) {
        payouts.push({ type, horses: combo, payout: amounts[i] });
      }
    }
  });
  return { finishOrder: finishOrder.filter(Number.isFinite), payouts };
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ status: "ok" });
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);
  if (req.headers.get("x-batch-secret") !== Deno.env.get("BATCH_SECRET")) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL"),
    secret = Deno.env.get("SUPABASE_SECRET_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? (() => {
        try {
          return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")
            .default;
        } catch {
          return undefined;
        }
      })();
  if (!url || !secret) return json({ error: "ENV" }, 500);
  const db = createClient(url, secret, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    .slice(0, 10);
  const { data: races, error } = await db.from("races").select(
    "id,external_id,track,race_number,start_time,status",
  ).like("external_id", "jra:%").gte("race_date", since).lt(
    "start_time",
    cutoff,
  ).neq("status", "finished").order("start_time").limit(12);
  if (error) return json({ error: error.message }, 500);
  let checked = 0, settledRaces = 0, settledBets = 0, pending = 0;
  for (const race of races ?? []) {
    checked++;
    const raceId = String(race.external_id).replace("jra:", "");
    try {
      const response = await fetch(
        "https://race.netkeiba.com/race/result.html?race_id=" + raceId,
        { headers },
      );
      if (!response.ok) {
        pending++;
        continue;
      }
      const html = await response.text(), parsed = parseResult(html);
      if (
        parsed.finishOrder.length < 3 ||
        !parsed.payouts.some((x) => x.type === "win")
      ) {
        pending++;
        continue;
      }
      const sourceHash = await hash(parsed);
      await db.from("race_results").upsert({
        race_id: race.id,
        finish_order: parsed.finishOrder,
        result_json: { provider: "netkeiba", payouts: parsed.payouts },
        confirmed_at: new Date().toISOString(),
        source_hash: sourceHash,
      }, { onConflict: "race_id" });
      for (let finish = 0; finish < parsed.finishOrder.length; finish++) {
        const { error: evaluationError } = await db.from(
          "horse_evaluation_snapshots",
        ).update({
          actual_finish_position: finish + 1,
          is_winner: finish === 0,
          evaluated_at: new Date().toISOString(),
        }).eq("race_id", race.id).eq(
          "horse_number",
          parsed.finishOrder[finish],
        );
        if (evaluationError) throw evaluationError;
      }
      for (const payout of parsed.payouts) {
        await db.from("payouts").upsert({
          race_id: race.id,
          bet_type: payout.type,
          combination: payout.horses,
          payout_per_100: payout.payout,
          is_refund: false,
        }, { onConflict: "race_id,bet_type,combination" });
      }
      const payoutMap = new Map(
        parsed.payouts.map((x) => [key(x.type, x.horses), x.payout]),
      );
      const { data: bets } = await db.from("bets").select(
        "id,strategy,bet_type,combination,stake,settlements(id)",
      ).eq("race_id", race.id);
      for (const bet of bets ?? []) {
        if (bet.settlements?.length) continue;
        const payout = payoutMap.get(
          key(bet.bet_type as BetType, (bet.combination ?? []).map(Number)),
        ) ?? 0;
        const returnAmount = Math.round(Number(bet.stake) / 100 * payout);
        const { error: settlementError } = await db.from("settlements").insert({
          bet_id: bet.id,
          stake: bet.stake,
          return_amount: returnAmount,
          is_hit: returnAmount > 0,
        });
        if (settlementError) throw settlementError;
        const { data: account, error: accountError } = await db.from(
          "strategy_accounts",
        ).select("*").eq("strategy", bet.strategy).single();
        if (accountError) throw accountError;
        const balance = Number(account.current_balance) - Number(bet.stake) +
          returnAmount;
        const { error: updateError } = await db.from("strategy_accounts")
          .update({
            current_balance: balance,
            total_staked: Number(account.total_staked) + Number(bet.stake),
            total_returned: Number(account.total_returned) + returnAmount,
            minimum_balance: Math.min(Number(account.minimum_balance), balance),
            updated_at: new Date().toISOString(),
          }).eq("strategy", bet.strategy);
        if (updateError) throw updateError;
        settledBets++;
      }
      await db.from("races").update({
        status: "finished",
        updated_at: new Date().toISOString(),
      }).eq("id", race.id);
      settledRaces++;
    } catch (error) {
      console.error("result settlement failed", race.external_id, error);
      pending++;
    }
  }
  let weightUpdate = { adopted: false, sampleSize: 0, improvement: 0 };
  try {
    const { data: profile, error: profileError } = await db.from(
      "evaluation_weight_profiles",
    ).select(
      "id,ability_weight,suitability_weight,condition_weight,race_context_weight",
    ).eq("is_active", true).single();
    if (profileError) throw profileError;
    const { data: snapshots, error: snapshotError } = await db.from(
      "horse_evaluation_snapshots",
    ).select(
      "race_id,ability_score,suitability_score,condition_score,race_context_score,is_winner,predicted_at",
    ).not("is_winner", "is", null).order("predicted_at").limit(10000);
    if (snapshotError) throw snapshotError;
    const optimized = optimizeEvaluationWeights(
      (snapshots ?? []).map((row) => ({
        raceId: row.race_id,
        abilityScore: Number(row.ability_score),
        suitabilityScore: Number(row.suitability_score),
        conditionScore: Number(row.condition_score),
        raceContextScore: Number(row.race_context_score),
        isWinner: Boolean(row.is_winner),
        predictedAt: row.predicted_at,
      })),
      {
        ability: Number(profile.ability_weight),
        suitability: Number(profile.suitability_weight),
        condition: Number(profile.condition_weight),
        raceContext: Number(profile.race_context_weight),
      },
    );
    weightUpdate = {
      adopted: optimized.adopted,
      sampleSize: optimized.sampleSize,
      improvement: optimized.improvement,
    };
    if (optimized.adopted) {
      const { data: next, error: insertError } = await db.from(
        "evaluation_weight_profiles",
      ).insert({
        ability_weight: optimized.weights.ability,
        suitability_weight: optimized.weights.suitability,
        condition_weight: optimized.weights.condition,
        race_context_weight: optimized.weights.raceContext,
        sample_size: optimized.sampleSize,
        training_brier: optimized.trainingBrier,
        validation_brier: optimized.validationBrier,
        improvement: optimized.improvement,
        is_active: false,
      }).select("id").single();
      if (insertError) throw insertError;
      const { error: disableError } = await db.from(
        "evaluation_weight_profiles",
      ).update({ is_active: false }).eq("id", profile.id);
      if (disableError) throw disableError;
      const { error: activateError } = await db.from(
        "evaluation_weight_profiles",
      ).update({ is_active: true }).eq("id", next.id);
      if (activateError) {
        await db.from("evaluation_weight_profiles").update({ is_active: true })
          .eq("id", profile.id);
        throw activateError;
      }
    }
  } catch (error) {
    console.error("weight optimization failed", error);
  }
  return json({
    status: "ok",
    checked,
    settledRaces,
    settledBets,
    pending,
    weightUpdate,
  });
});
