export const EXTERNAL_PARSER_VERSION = "external-multisource-v3";

export const SOURCE_PROFILES = [
  { name: "ai-shisu", origin: "https://www.ai-shisu.com", numeric: true },
  {
    name: "muryou-keiba-ai",
    origin: "https://muryou-keiba-ai.jp",
    numeric: false,
  },
  { name: "uma-x", origin: "https://uma-x.jp", numeric: true },
  { name: "kichiuma", origin: "https://kichiuma.net", numeric: true },
  { name: "athena", origin: "https://keiba-ai.jp", numeric: true },
  {
    name: "keiba-navi",
    origin: "https://m-jockey.co.jp/keiba-navi/jra/ai/",
    numeric: true,
  },
] as const;

export type SourceProfile = typeof SOURCE_PROFILES[number];
export type FetchRoute = "direct" | "scraperapi";
export type SourceFetch = {
  html: string;
  url: string;
  route: FetchRoute;
  capturedAt: string;
};
export type SourceHorseSignal = {
  horseNumber: number;
  horseName: string;
  rawScore?: number;
  rank?: number;
  comment?: string;
};
export type NormalizedSourceEvidence = {
  source: string;
  sourceUrl: string;
  capturedAt: string;
  route: FetchRoute;
  status: "ok" | "unavailable";
  numeric: boolean;
  horses: SourceHorseSignal[];
  raceMetrics?: {
    roughness?: number;
    roughnessScale?: "1-18";
    roughnessBasis?: "odds-derived";
  };
  missingFields: string[];
  identityStatus?: "verified" | "partial" | "failed";
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36";
const retryable = (status: number) =>
  status === 403 || status === 429 || status >= 500;

async function request(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSourcePage(
  url: string,
  timeoutMs = 12_000,
): Promise<SourceFetch> {
  let direct: Response | null = null;
  try {
    direct = await request(url, timeoutMs);
  } catch { /* fallback below */ }
  if (direct?.ok) {
    const html = await direct.text();
    if (html.length >= 500) {
      return {
        html,
        url,
        route: "direct",
        capturedAt: new Date().toISOString(),
      };
    }
  }
  if (direct && !retryable(direct.status)) {
    throw new Error(`SOURCE_HTTP_${direct.status}`);
  }
  const key = Deno.env.get("SCRAPERAPI_KEY");
  if (!key) throw new Error("SOURCE_UNAVAILABLE_AND_SCRAPERAPI_KEY_MISSING");
  const endpoint = `https://api.scraperapi.com?api_key=${
    encodeURIComponent(key)
  }&url=${encodeURIComponent(url)}`;
  const response = await request(endpoint, timeoutMs * 2);
  if (!response.ok) throw new Error(`SCRAPERAPI_HTTP_${response.status}`);
  const html = await response.text();
  if (html.length < 500) throw new Error("SCRAPERAPI_EMPTY_PAGE");
  return {
    html,
    url,
    route: "scraperapi",
    capturedAt: new Date().toISOString(),
  };
}

export function discoverRaceLink(
  html: string,
  baseUrl: string,
  tokens: string[],
): string | null {
  const anchors = [
    ...html.matchAll(
      /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ].map((m) => ({ href: m[1], label: clean(m[2]) }));
  const normalizedTokens = tokens.filter(Boolean).map((x) =>
    x.replace(/\s+/g, "").toLowerCase()
  );
  for (const { href, label } of anchors) {
    const nearby = `${href} ${label}`.replace(/\s+/g, "").toLowerCase();
    if (normalizedTokens.every((token) => nearby.includes(token))) {
      return new URL(href, baseUrl).toString();
    }
  }
  return null;
}

export async function fetchRaceSourcePage(
  profile: SourceProfile,
  race: { raceDate: string; track: string; raceNumber: number },
) {
  const trackCode: Record<
    string,
    { uma?: string; kichi?: string; jra?: string }
  > = {
    "札幌": { uma: "1", kichi: "71", jra: "01" },
    "函館": { uma: "2", kichi: "72", jra: "02" },
    "福島": { uma: "3", kichi: "73", jra: "03" },
    "新潟": { uma: "4", kichi: "74", jra: "04" },
    "東京": { uma: "5", kichi: "75", jra: "05" },
    "中山": { uma: "6", kichi: "76", jra: "06" },
    "中京": { uma: "7", kichi: "77", jra: "07" },
    "京都": { uma: "8", kichi: "78", jra: "08" },
    "阪神": { uma: "9", kichi: "79", jra: "09" },
    "小倉": { uma: "0", kichi: "70", jra: "10" },
  };
  const codes = trackCode[race.track];
  const compactDate = race.raceDate.replaceAll("-", "");
  if (profile.name === "keiba-navi" && codes?.jra) {
    return await fetchSourcePage(
      `${profile.origin}?ymd=${compactDate}&venue=${codes.jra}&race_num=${
        String(race.raceNumber).padStart(2, "0")
      }`,
    );
  }
  if (profile.name === "kichiuma" && codes?.kichi) {
    const [year, month, day] = race.raceDate.split("-").map(Number);
    const index = await fetchSourcePage(
      `${profile.origin}/php/search.php?date=${year}%2F${month}%2F${day}&id=${codes.kichi}`,
    );
    const escapedNo = `${race.raceNumber}`;
    const href = [...index.html.matchAll(/href=["']([^"']+)["']/gi)].map((m) =>
      m[1]
    )
      .find((value) =>
        value.includes(`no=${escapedNo}`) && value.includes("p=fp")
      );
    return href
      ? await fetchSourcePage(new URL(href, profile.origin).toString())
      : index;
  }
  const query = `${race.raceDate} ${race.track} ${race.raceNumber}R`;
  const index = await fetchSourcePage(
    `${profile.origin}/?s=${encodeURIComponent(query)}`,
  );
  if (profile.name === "athena") {
    const [year, month, day] = race.raceDate.split("-").map(Number);
    const dateLabel = `${year}年${String(month).padStart(2, "0")}月${
      String(day).padStart(2, "0")
    }日`;
    const dailyHref = [
      ...index.html.matchAll(
        /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      ),
    ].find((match) => {
      const label = clean(match[2]);
      return label.includes(dateLabel) && label.includes("レースAI予想") &&
        !label.includes("予想結果");
    })?.[1];
    const dailyUrl = dailyHref
      ? new URL(dailyHref, profile.origin).toString()
      : null;
    if (!dailyUrl) return index;
    const daily = await fetchSourcePage(dailyUrl);
    return {
      ...daily,
      html: extractAthenaRaceSection(
        daily.html,
        race.track,
        race.raceNumber,
      ),
    };
  }
  if (profile.name === "uma-x" && codes?.uma) {
    const suffix = `${String(race.raceNumber).padStart(2, "0")}${compactDate}`;
    const href = [
      ...index.html.matchAll(/href=["']([^"']*\/race_result\/([^"'/]+))["']/gi),
    ]
      .find((match) =>
        match[2].startsWith(codes.uma!) && match[2].endsWith(suffix)
      )?.[1];
    if (href) {
      return await fetchSourcePage(new URL(href, profile.origin).toString());
    }
  }
  const [year, month, day] = race.raceDate.split("-").map(Number);
  const dateTokens = [
    race.raceDate.replaceAll("-", ""),
    `${year}/${month}/${day}`,
    `${month}/${day}`,
    `${month}月${day}日`,
  ];
  const detailUrl =
    dateTokens.map((dateToken) =>
      discoverRaceLink(index.html, profile.origin, [
        dateToken,
        race.track,
        `${race.raceNumber}R`,
      ])
    ).find(Boolean) ?? null;
  return detailUrl && detailUrl !== index.url
    ? await fetchSourcePage(detailUrl)
    : index;
}

const clean = (value: string) =>
  value.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(
    /\s+/g,
    " ",
  ).trim();

const cells = (row: string) =>
  [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
    .map((match) => clean(match[1]));

function parseMuryouKeibaAi(html: string): SourceHorseSignal[] {
  const table = html.match(
    /<table\b[^>]*class=["'][^"']*\brace_table\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i,
  )?.[1];
  if (!table) return [];
  const horses: SourceHorseSignal[] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const values = cells(row[1]);
    if (values.length < 4) continue;
    const horseNumber = Number(values[0]);
    const horseName = values[1].split(/軸|紐|穴/)[0].trim().split(/\s+/)[0];
    const score = Number(values[3].match(/(-?\d+(?:\.\d+)?)\s*$/)?.[1]);
    if (
      horseNumber >= 1 && horseNumber <= 20 && horseName &&
      Number.isFinite(score)
    ) {
      horses.push({
        horseNumber,
        horseName,
        rawScore: score,
        comment: values[3].replace(String(score), "").trim() || undefined,
      });
    }
  }
  return horses;
}

function parseUmaX(html: string): SourceHorseSignal[] {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const table = tables.find((match) => {
    const header = clean(match[1]);
    return header.includes("馬名") && header.includes("総合") &&
      header.includes("SP") && header.includes("AG") && header.includes("実績");
  })?.[1];
  if (!table) return [];
  const horses: SourceHorseSignal[] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const values = cells(row[1]);
    const first = values[0]?.match(/^(\d{1,2})\s*(.+)$/);
    const score = Number(values[1]);
    if (first && Number.isFinite(score)) {
      horses.push({
        horseNumber: Number(first[1]),
        horseName: first[2].trim(),
        rawScore: score,
      });
    }
  }
  return horses;
}

function parseKichiuma(html: string): SourceHorseSignal[] {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const table = tables.find((match) => {
    const header = clean(match[1]);
    return header.includes("SP 能力値") && header.includes("競 走 馬 名");
  })?.[1];
  if (!table) return [];
  const horses: SourceHorseSignal[] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const values = cells(row[1]);
    const number = Number(values[0]),
      score = Number(values[2]),
      name = values[3]?.replace(/\s+/g, "");
    if (number >= 1 && number <= 20 && name && Number.isFinite(score)) {
      horses.push({
        horseNumber: number,
        horseName: name,
        rawScore: score,
        comment: values[1] || undefined,
      });
    }
  }
  return horses;
}

export function extractAthenaRaceSection(
  html: string,
  track: string,
  raceNumber: number,
) {
  const headings = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const trackHeading = headings.find((match) => clean(match[1]) === track);
  if (trackHeading?.index === undefined) return "";
  const nextTrack = headings.find((match) => match.index! > trackHeading.index!);
  const trackHtml = html.slice(trackHeading.index, nextTrack?.index ?? html.length);
  const titles = [
    ...trackHtml.matchAll(
      /<div\b[^>]*class=["'][^"']*\bsu-box-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    ),
  ];
  const wanted = `${String(raceNumber).padStart(2, "0")}R`;
  const raceTitle = titles.find((match) => clean(match[1]).startsWith(wanted));
  if (raceTitle?.index === undefined) return "";
  const nextRace = titles.find((match) => match.index! > raceTitle.index!);
  return trackHtml.slice(raceTitle.index, nextRace?.index ?? trackHtml.length);
}

function parseAthena(html: string): SourceHorseSignal[] {
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .find((match) => {
      const header = clean(match[1]).replace(/\s+/g, "");
      return header.includes("予想勝率") && header.includes("AI指数") &&
        header.includes("予想着順");
    })?.[1];
  if (!table) return [];
  const horses: SourceHorseSignal[] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const values = cells(row[1]);
    const horseNumber = Number(values[0]);
    const horseName = values[1]?.split(/\s+/)[0];
    const score = Number(values[6]?.match(/\((-?\d+(?:\.\d+)?)\)/)?.[1]);
    if (horseNumber >= 1 && horseNumber <= 20 && horseName && Number.isFinite(score)) {
      horses.push({ horseNumber, horseName, rawScore: score });
    }
  }
  return horses;
}

function parseKeibaNavi(html: string): SourceHorseSignal[] {
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .find((match) => {
      const header = clean(match[1]);
      return header.includes("馬番") && header.includes("馬名") &&
        header.includes("ナビ指数");
    })?.[1];
  if (!table) return [];
  const horses: SourceHorseSignal[] = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const values = cells(row[1]);
    const horseNumber = Number(values[1]);
    const horseName = clean(
      row[1].match(/<b>\s*<a\b[^>]*>([\s\S]*?)<\/a>\s*<\/b>/i)?.[1] ?? "",
    );
    const score = Number(values[4]);
    if (horseNumber >= 1 && horseNumber <= 20 && horseName && Number.isFinite(score)) {
      horses.push({ horseNumber, horseName, rawScore: score });
    }
  }
  return horses;
}

/** Conservative generic extractor; site-specific failures remain visible as missing data. */
export function normalizeSourcePage(
  profile: SourceProfile,
  page: SourceFetch,
): NormalizedSourceEvidence {
  const textRows = page.html.split(/<tr\b[^>]*>/i).slice(1).map(clean);
  const horses: SourceHorseSignal[] = profile.name === "muryou-keiba-ai"
    ? parseMuryouKeibaAi(page.html)
    : profile.name === "uma-x"
    ? parseUmaX(page.html)
    : profile.name === "kichiuma"
    ? parseKichiuma(page.html)
    : profile.name === "athena"
    ? parseAthena(page.html)
    : profile.name === "keiba-navi"
    ? parseKeibaNavi(page.html)
    : [];
  for (const row of textRows) {
    const match = row.match(
      /(?:^|\s)(\d{1,2})\s+([^\d]{2,30}?)\s+(?:指数|score|評価)?\s*(-?\d+(?:\.\d+)?)/i,
    );
    if (!match) continue;
    const horseNumber = Number(match[1]);
    if (
      horseNumber < 1 || horseNumber > 20 ||
      horses.some((x) => x.horseNumber === horseNumber)
    ) continue;
    horses.push({
      horseNumber,
      horseName: match[2].trim(),
      rawScore: Number(match[3]),
    });
  }
  horses.sort((a, b) => (b.rawScore ?? -Infinity) - (a.rawScore ?? -Infinity));
  horses.forEach((horse, index) => horse.rank = index + 1);
  const roughness = profile.name === "uma-x"
    ? Number(
      page.html.match(/\/(?:race|nar)_aredo\/(\d{1,2})(?:[?"'])/i)?.[1] ??
        clean(page.html).match(/荒れ度\s*(?:は|：|:)?\s*(\d{1,2})/)?.[1],
    )
    : NaN;
  return {
    source: profile.name,
    sourceUrl: page.url,
    capturedAt: page.capturedAt,
    route: page.route,
    status: horses.length ? "ok" : "unavailable",
    numeric: profile.numeric,
    horses,
    ...(Number.isInteger(roughness) && roughness >= 1 && roughness <= 18
      ? {
        raceMetrics: {
          roughness,
          roughnessScale: "1-18" as const,
          roughnessBasis: "odds-derived" as const,
        },
      }
      : {}),
    missingFields: horses.length ? [] : ["horse_signals"],
  };
}

export function hasEvidenceQuorum(items: NormalizedSourceEvidence[]) {
  const ok = items.filter((x) => x.status === "ok");
  return {
    ready: ok.length >= 2 && ok.some((x) => x.numeric),
    availableSources: ok.length,
    numericSources: ok.filter((x) => x.numeric).length,
  };
}
