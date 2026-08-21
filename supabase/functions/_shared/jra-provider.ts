import type { BetType, Entry, RaceOdds, RaceSummary } from "./types.ts";
import * as cheerio from "npm:cheerio@1.0.0";
import { validateMarketOdds } from "./odds-validation.ts";

const BASE = "https://race.netkeiba.com";
const headers = { "user-agent": "RaceLab-Personal/1.0", "referer": `${BASE}/` };
const tracks: Record<string, string> = {
  "01": "札幌",
  "02": "函館",
  "03": "福島",
  "04": "新潟",
  "05": "東京",
  "06": "中山",
  "07": "中京",
  "08": "京都",
  "09": "阪神",
  "10": "小倉",
};
const clean = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ")
    .trim();
const num = (s?: string) => {
  const n = Number((s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const fetchText = async (url: string, timeoutMs = 10_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error(`JRA_SOURCE_HTTP_${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
};

export interface JraDetail {
  race: RaceSummary;
  entries: Entry[];
  odds: RaceOdds[];
}

export interface CollectedPastRun {
  externalHorseId: string;
  sourceRaceId: string;
  raceDate: string;
  track: string;
  raceName: string;
  raceClass?: string;
  surface?: "turf" | "dirt" | "jump";
  distance?: number;
  condition?: string;
  finishPosition?: number;
  popularity?: number;
  finishTime?: string;
  cornerPositions?: number[];
  last3f?: number;
  margin?: number;
  jockey?: string;
  weightCarried?: number;
  horseWeight?: number;
  runnerCount?: number;
  rawData: Record<string, unknown>;
}

const matchNumber = (value: string, pattern: RegExp) =>
  num(value.match(pattern)?.[1]);

export function inferRaceClass(value: string): string | undefined {
  const normalized = value.replace(/\s/g, "").toUpperCase();
  if (/(G1|GⅠ|GI)(?!I)/.test(normalized)) return "G1";
  if (/(G2|GⅡ|GII)(?!I)/.test(normalized)) return "G2";
  if (/(G3|GⅢ|GIII)/.test(normalized)) return "G3";
  if (/リステッド|\(L\)|（L）/.test(normalized)) return "listed";
  if (/オープン|OPEN/.test(normalized)) return "open";
  if (/3勝クラス|1600万下/.test(normalized)) return "3win";
  if (/2勝クラス|1000万下/.test(normalized)) return "2win";
  if (/1勝クラス|500万下/.test(normalized)) return "1win";
  if (/未勝利/.test(normalized)) return "maiden";
  if (/新馬/.test(normalized)) return "newcomer";
  return undefined;
}

export function parsePastRunsHtml(html: string): CollectedPastRun[] {
  const $ = cheerio.load(html), runs: CollectedPastRun[] = [];
  $("tr.HorseList").each((_, row) => {
    const horseHref = $(row).find('td.Horse_Info a[href*="/horse/"]').first()
        .attr("href") ?? "",
      externalHorseId = horseHref.match(/\/horse\/(\d+)/)?.[1];
    if (!externalHorseId) return;
    $(row).find("td.Past").each((_, cell) => {
      const past = $(cell),
        data01 = clean(past.find(".Data01").text()),
        dateText = clean(past.find(".Data01 span").first().text()),
        data02 = clean(past.find(".Data02").text()),
        data03 = clean(past.find(".Data03").text()),
        data05 = clean(past.find(".Data05").text()),
        data06 = clean(past.find(".Data06").text()),
        data07 = clean(past.find(".Data07").text()),
        date = dateText.match(/(\d{4})\.(\d{2})\.(\d{2})\s*(\S+)/),
        sourceRaceId = (past.attr("id") ?? "").match(/myhorse_(\d+)/)?.[1] ??
          (past.find('.Data02 a[href*="race_id="]').attr("href") ?? "").match(
            /race_id=(\d+)/,
          )?.[1],
        course = data05.match(/(芝|ダ|障)(\d+)/),
        detail = data03.match(/(\d+)頭\s*\d+番\s*(\d+)人\s*(.+?)\s+([\d.]+)$/),
        weight = data06.match(/(\d+)\s*\([+-]?\d+\)/);
      if (!date || !sourceRaceId || !data02) return;
      const parsed = {
        externalHorseId,
        sourceRaceId,
        raceDate: `${date[1]}-${date[2]}-${date[3]}`,
        track: date[4],
        raceName: data02,
        raceClass: inferRaceClass(data02),
        surface: course?.[1] === "芝"
          ? "turf" as const
          : course?.[1] === "ダ"
          ? "dirt" as const
          : course?.[1] === "障"
          ? "jump" as const
          : undefined,
        distance: num(course?.[2]),
        condition: data05.match(/\s(良|稍重|重|不良)(?:\s|$)/)?.[1],
        finishPosition: num(past.find(".Data01 .Num").first().text()),
        popularity: num(detail?.[2]),
        finishTime: data05.match(/\d+:\d+\.\d+/)?.[0],
        cornerPositions: data06.match(/\b\d+(?:-\d+)+\b/)?.[0].split("-")
          .map(Number),
        last3f: matchNumber(data06, /\(([\d.]+)\)/),
        margin: matchNumber(data07, /\(([-+\d.]+)\)\s*$/),
        jockey: detail?.[3],
        weightCarried: num(detail?.[4]),
        horseWeight: num(weight?.[1]),
        runnerCount: num(detail?.[1]),
      };
      runs.push({ ...parsed, rawData: { ...parsed, provider: "netkeiba" } });
    });
  });
  return runs;
}

const validRaceTime = (value: string) => {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour >= 9 && hour <= 18 && minute >= 0 && minute < 60;
};

export function validateRaceSchedule(races: RaceSummary[], date: string) {
  const invalid = races.filter((race) =>
    race.raceDate !== date ||
    !Number.isFinite(Date.parse(race.startTime)) ||
    !race.startTime.startsWith(`${date}T`) ||
    !validRaceTime(race.startTime.slice(11, 16))
  );
  if (invalid.length) {
    throw new Error(
      `JRA_RACE_SCHEDULE_INVALID:${
        invalid.map((race) => race.externalId).join(",")
      }`,
    );
  }
  const distinctTimes = new Set(races.map((race) => race.startTime));
  if (races.length > 1 && distinctTimes.size < 2) {
    throw new Error("JRA_RACE_SCHEDULE_SUSPICIOUS:all_start_times_identical");
  }
}

export function parseRaceListHtml(html: string, date: string): RaceSummary[] {
  const $ = cheerio.load(html),
    races: RaceSummary[] = [],
    seen = new Set<string>();
  $("li.RaceList_DataItem").each((_, element) => {
    const item = $(element),
      href = item.find('a[href*="shutuba.html"][href*="race_id="]').first()
        .attr("href") ?? "",
      id = href.match(/race_id=(\d{12})/)?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const time = clean(item.find(".RaceList_Itemtime").first().text()),
      courseText = clean(item.find(".RaceList_ItemLong").first().text()),
      course = courseText.match(/(芝|ダート|ダ|障害|障)\s*(\d{3,4})m/),
      raceNumber = Number(id.slice(-2)),
      track = tracks[id.slice(4, 6)] ?? `JRA${id.slice(4, 6)}`,
      raceName = clean(item.find(".ItemTitle, .RaceName").first().text()) ||
        `${track} ${raceNumber}R`;
    if (!validRaceTime(time)) {
      throw new Error(`JRA_RACE_TIME_MISSING:${id}`);
    }
    races.push({
      externalId: `jra:${id}`,
      raceDate: date,
      track,
      raceNumber,
      raceName,
      raceClass: inferRaceClass(raceName),
      startTime: `${date}T${time}:00+09:00`,
      surface: course?.[1] === "芝"
        ? "turf"
        : course?.[1]?.startsWith("障")
        ? "jump"
        : "dirt",
      distance: num(course?.[2]),
      sourceUrl: `${BASE}/race/shutuba.html?race_id=${id}`,
    });
  });
  validateRaceSchedule(races, date);
  return races;
}

export class JraProvider {
  async getRaceList(date: string): Promise<RaceSummary[]> {
    const ymd = date.replaceAll("-", "");
    const html = await fetchText(
      `${BASE}/top/race_list_sub.html?kaisai_date=${ymd}`,
    );
    return parseRaceListHtml(html, date);
  }

  async getDetail(race: RaceSummary): Promise<JraDetail> {
    const id = race.externalId.replace("jra:", ""),
      html = await fetchText(`${BASE}/race/shutuba.html?race_id=${id}`),
      entries: Entry[] = [];
    for (const m of html.matchAll(/<tr class="HorseList"[\s\S]*?<\/tr>/g)) {
      const row = m[0],
        horse = row.match(/\/horse\/(\d+)[^>]*[^>]*title="([^"]+)"/),
        horseNumber = num(row.match(/class="Umaban\d+ Txt_C">\s*(\d+)/)?.[1]);
      if (!horse || !horseNumber) continue;
      const sexAge = clean(
          row.match(/class="Barei Txt_C">([\s\S]*?)<\/td>/)?.[1] ?? "",
        ),
        weight = clean(row.match(/class="Weight">([\s\S]*?)<\/td>/)?.[1] ?? "");
      entries.push({
        umaxScores: { horse_id: horse[1] },
        horseNumber,
        gateNumber: num(row.match(/class="Waku\d+ Txt_C"><span>(\d+)</)?.[1]),
        horseName: horse[2],
        sex: sexAge.slice(0, 1),
        age: num(sexAge.slice(1)),
        jockey: row.match(/class="Jockey">[\s\S]*?title="([^"]+)"/)?.[1],
        trainer: row.match(/class="Trainer">[\s\S]*?title="([^"]+)"/)?.[1],
        weightCarried: num(
          row.match(
            /class="Barei Txt_C">[\s\S]*?<\/td>\s*<td class="Txt_C">\s*([\d.]+)/,
          )?.[1],
        ),
        horseWeight: num(weight.match(/\d+/)?.[0]),
        horseWeightDelta: num(weight.match(/\(([+-]?\d+)\)/)?.[1]),
        sourceData: { horse_id: horse[1] },
      });
    }
    const oddsJson = JSON.parse(
      await fetchText(
        `${BASE}/api/api_get_jra_odds.html?race_id=${id}&type=all&action=init`,
      ),
    );
    const odds: RaceOdds[] = [];
    const map: Record<string, BetType | undefined> = {
      "1": "win",
      "2": "place",
      "4": "quinella",
      "5": "wide",
      "6": "exacta",
      "7": "trio",
      "8": "trifecta",
    };
    for (const [code, items] of Object.entries(oddsJson?.data?.odds ?? {})) {
      const type = map[code];
      if (!type) continue;
      for (
        const [combo, raw] of Object.entries(items as Record<string, string[]>)
      ) {
        const horses = combo.match(/.{2}/g)?.map(Number) ?? [],
          values = raw as string[],
          price = num(values[0]);
        if (price) {
          const market = {
            type,
            horses,
            odds: price,
            oddsMax: num(values[1]),
            popularity: num(values[2]),
          };
          if (validateMarketOdds(market).valid) odds.push(market);
        }
      }
    }
    return { race, entries, odds };
  }

  async getPastRuns(race: RaceSummary): Promise<CollectedPastRun[]> {
    const id = race.externalId.replace("jra:", ""),
      html = await fetchText(`${BASE}/race/shutuba_past.html?race_id=${id}`);
    return parsePastRunsHtml(html);
  }
}
