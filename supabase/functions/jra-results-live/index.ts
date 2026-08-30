import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import * as cheerio from "npm:cheerio@1.0.0";
import webpush from "npm:web-push@3.6.7";
import { optimizeEvaluationWeights } from "../_shared/weight-optimizer.ts";
import { fitCalibration } from "../_shared/probability-calibrator.ts";
import { calculateDailyBankrollState } from "../_shared/bankroll-management.ts";

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
  const $ = cheerio.load(html), finishOrder: number[] = [], popularityByHorse: Record<number, number> = {};
  $(".RaceTable01 tbody tr, .RaceTable01 tr.HorseList").each((_, row) => {
    const rank = Number($(row).find(".Rank").first().text().trim());
    const horse = Number($(row).find("td.Num.Txt_C").first().text().trim());
    const popularity = Number($(row).find(".OddsPeople").first().text().trim());
    if (
      Number.isInteger(rank) && rank > 0 && Number.isInteger(horse) && horse > 0
    ) {
      finishOrder[rank - 1] = horse;
      if (Number.isInteger(popularity) && popularity > 0) popularityByHorse[horse] = popularity;
    }
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
  return { finishOrder: finishOrder.filter(Number.isFinite), popularityByHorse, payouts };
}

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;

async function sendHitNotifications(
  // The project intentionally uses the dynamic Supabase schema client here;
  // generated database types are not checked into this repository.
  db: any,
  race: { id: string; track: string; race_number: number; race_name?: string },
  stake: number,
  returned: number,
) {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) {
    console.warn("push notification skipped: VAPID secrets are not configured");
    return 0;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const { data: subscriptions, error } = await db.from("push_subscriptions")
    .select("id,endpoint,p256dh,auth");
  if (error) throw error;
  let sent = 0;
  for (const subscription of subscriptions ?? []) {
    const { error: claimError } = await db.from("push_notification_deliveries")
      .insert({ subscription_id: subscription.id, race_id: race.id });
    if (claimError?.code === "23505") continue;
    if (claimError) throw claimError;
    try {
      const profit = returned - stake;
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, JSON.stringify({
        title: `${race.track} ${race.race_number}R 的中`,
        body: `${race.race_name ? `${race.race_name}・` : ""}購入 ${yen(stake)}・払戻 ${yen(returned)}・収支 ${profit >= 0 ? "+" : ""}${yen(profit)}`,
        tag: `race-hit-${race.id}`,
        url: `/?race=${encodeURIComponent(race.id)}`,
      }));
      sent++;
    } catch (pushError) {
      const statusCode = Number((pushError as { statusCode?: number }).statusCode);
      if (statusCode === 404 || statusCode === 410) {
        await db.from("push_subscriptions").delete().eq("id", subscription.id);
      }
      await db.from("push_notification_deliveries").delete()
        .eq("subscription_id", subscription.id).eq("race_id", race.id);
      console.error("push notification failed", subscription.id, pushError);
    }
  }
  return sent;
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
  const { data: recentRaces, error } = await db.from("races").select(
    "id,external_id,race_date,track,race_number,race_name,start_time,status,race_results(result_json)",
  ).like("external_id", "jra:%").gte("race_date", since).lt(
    "start_time",
    cutoff,
  ).order("start_time", { ascending: false }).limit(100);
  if (error) return json({ error: error.message }, 500);
  const races = (recentRaces ?? []).filter((race) => {
    if (race.status !== "finished") return true;
    const result = Array.isArray(race.race_results)
      ? race.race_results[0]
      : race.race_results;
    const popularities = result?.result_json?.popularity_by_horse;
    return !popularities || Object.keys(popularities).length === 0;
  }).sort((a, b) =>
    Number(a.status === "finished") - Number(b.status === "finished") ||
    Date.parse(a.start_time) - Date.parse(b.start_time)
  ).slice(0, 12);
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
        result_json: { provider: "netkeiba", payouts: parsed.payouts, popularity_by_horse: parsed.popularityByHorse },
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
        "id,strategy,bet_type,combination,stake,settlements(id,return_amount)",
      ).eq("race_id", race.id);
      let raceStake = 0, raceReturn = 0;
      for (const bet of bets ?? []) {
        raceStake += Number(bet.stake);
        if (bet.settlements?.length) {
          raceReturn += Number(bet.settlements[0].return_amount ?? 0);
          continue;
        }
        const payout = payoutMap.get(
          key(bet.bet_type as BetType, (bet.combination ?? []).map(Number)),
        ) ?? 0;
        const returnAmount = Math.round(Number(bet.stake) / 100 * payout);
        const { error: settlementError } = await db.rpc("settle_paper_bet", {
          p_bet_id: bet.id,
          p_return_amount: returnAmount,
        });
        if (settlementError) throw settlementError;
        raceReturn += returnAmount;
        // Rollover is advisory context for Gemini's next allocation, not an
        // automatically enforced stake. A place loss ends the current chain.
        if (bet.strategy === "single" && bet.bet_type === "place") {
          const { data: current } = await db.from("rollover_states").select(
            "consecutive_hits",
          ).eq("strategy", "single").single();
          const { error: rolloverError } = await db.from("rollover_states")
            .upsert({
              strategy: "single",
              pending_amount: returnAmount > 0 ? returnAmount : 0,
              source_bet_id: returnAmount > 0 ? bet.id : null,
              consecutive_hits: returnAmount > 0
                ? Number(current?.consecutive_hits ?? 0) + 1
                : 0,
              updated_at: new Date().toISOString(),
            }, { onConflict: "strategy" });
          if (rolloverError) throw rolloverError;
        }
        settledBets++;
      }
      const { data: storedBankroll } = await db.from("daily_bankroll_states")
        .select("*").eq("strategy", "single").eq(
          "session_date",
          race.race_date,
        ).maybeSingle();
      if (storedBankroll) {
        const [{ data: account }, { data: available }] = await Promise.all([
          db.from("strategy_accounts").select("current_balance").eq(
            "strategy",
            "single",
          ).single(),
          db.rpc("available_paper_balance", { p_strategy: "single" }),
        ]);
        const openReservations = Math.max(
          0,
          Number(account?.current_balance ?? 0) - Number(available ?? 0),
        );
        const bankroll = calculateDailyBankrollState(
          Number(storedBankroll.opening_balance),
          Number(account?.current_balance ?? storedBankroll.opening_balance),
          Number(storedBankroll.peak_balance),
          openReservations,
        );
        const { error: bankrollUpdateError } = await db.from(
          "daily_bankroll_states",
        ).update({
          peak_balance: bankroll.peakBalance,
          loss_floor: bankroll.lossFloor,
          lock_balance: bankroll.lockBalance,
          peak_profit_rate: bankroll.peakProfitRate,
          lock_profit_rate: bankroll.lockProfitRate,
          mode: bankroll.mode,
          updated_at: new Date().toISOString(),
        }).eq("id", storedBankroll.id);
        if (bankrollUpdateError) throw bankrollUpdateError;
      }
      await db.from("races").update({
        status: "finished",
        updated_at: new Date().toISOString(),
      }).eq("id", race.id);
      if (raceReturn > 0) {
        try {
          await sendHitNotifications(db, race, raceStake, raceReturn);
        } catch (notificationError) {
          console.error("hit notification processing failed", race.id, notificationError);
        }
      }
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
      "id,ability_weight,suitability_weight,condition_weight,race_context_weight,formula_version",
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
        formula_version: profile.formula_version,
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
  let calibrationUpdates = 0;
  try {
    const { data: history, error: historyError } = await db.from("bets").select(
      "strategy,bet_type,raw_estimated_probability,estimated_probability,created_at,settlements(is_hit)",
    ).order("created_at").limit(10000);
    if (historyError) throw historyError;
    const groups = new Map<string, any[]>();
    for (const bet of history ?? []) {
      const settlement = Array.isArray(bet.settlements)
        ? bet.settlements[0]
        : bet.settlements;
      if (!settlement) continue;
      const segment = `${bet.strategy}:${bet.bet_type}`,
        observations = groups.get(segment) ?? [];
      observations.push({
        predicted: Number(
          bet.raw_estimated_probability ?? bet.estimated_probability,
        ),
        outcome: Boolean(settlement.is_hit),
        occurredAt: bet.created_at,
      });
      groups.set(segment, observations);
    }
    for (const [segment, observations] of groups) {
      const fitted = fitCalibration(observations);
      if (!fitted.adopted || !fitted.profile) continue;
      const [strategy, betType] = segment.split(":"),
        { data: existing } = await db.from("probability_calibration_profiles")
          .select("sample_size").eq("strategy", strategy).eq(
            "bet_type",
            betType,
          ).eq("is_active", true).maybeSingle();
      if (Number(existing?.sample_size ?? 0) >= fitted.sampleSize) continue;
      const { data: next, error: insertError } = await db.from(
        "probability_calibration_profiles",
      ).insert({
        strategy,
        bet_type: betType,
        bins: fitted.profile,
        sample_size: fitted.sampleSize,
        baseline_brier: fitted.baselineBrier,
        validation_brier: fitted.validationBrier,
        improvement: fitted.improvement,
        is_active: false,
      }).select("id").single();
      if (insertError) throw insertError;
      await db.from("probability_calibration_profiles").update({
        is_active: false,
      }).eq("strategy", strategy).eq("bet_type", betType).eq("is_active", true);
      const { error: activateError } = await db.from(
        "probability_calibration_profiles",
      ).update({ is_active: true }).eq("id", next.id);
      if (activateError) throw activateError;
      calibrationUpdates++;
    }
  } catch (error) {
    console.error("probability calibration failed", error);
  }
  return json({
    status: "ok",
    checked,
    settledRaces,
    settledBets,
    pending,
    weightUpdate,
    calibrationUpdates,
  });
});
