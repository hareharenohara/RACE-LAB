import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  discoverRaceLink,
  hasEvidenceQuorum,
  normalizeSourcePage,
  SOURCE_PROFILES,
} from "./external-sources.ts";

Deno.test("discovers a matching relative race link", () => {
  assertEquals(
    discoverRaceLink('<a href="/race/tokyo-11">x</a>', "https://example.jp", [
      "tokyo",
      "11",
    ]),
    "https://example.jp/race/tokyo-11",
  );
});

Deno.test("does not discover a different date", () => {
  assertEquals(
    discoverRaceLink(
      '<a href="/race/20260815">8月15日 新潟 5R</a>',
      "https://example.jp",
      ["8月9日", "新潟", "5R"],
    ),
    null,
  );
});
Deno.test("normalizes horse scores without raw html", () => {
  const item = normalizeSourcePage(SOURCE_PROFILES[0], {
    html:
      "<table><tr><td>3</td><td>サンプルホース</td><td>指数 82.4</td></tr></table>"
        .replace(/<\/td><td>/g, " "),
    url: "https://x",
    route: "direct",
    capturedAt: "2026-01-01T00:00:00Z",
  });
  assertEquals(item.horses[0], {
    horseNumber: 3,
    horseName: "サンプルホース",
    rawScore: 82.4,
    rank: 1,
  });
});

Deno.test("parses muryou-keiba-ai race table", () => {
  const html = `<table class="race_table baken_race_table"><tbody>
    <tr><td>10</td><td>ナムラクララ<br>浜中俊<br>軸 紐 穴</td><td>1<br>3.6倍</td><td>◎<br>90.0</td></tr>
    <tr><td>3</td><td>ブラックチャリス<br>吉田隼人<br>軸 紐 穴</td><td>2<br>4.5倍</td><td>○<br>88.6</td></tr>
  </tbody></table>`;
  const result = normalizeSourcePage(SOURCE_PROFILES[1], {
    html,
    url: "https://muryou-keiba-ai.jp/test",
    route: "direct",
    capturedAt: "2026-08-09T00:00:00Z",
  });
  assertEquals(
    result.horses.map((x) => [x.horseNumber, x.horseName, x.rawScore]),
    [
      [10, "ナムラクララ", 90],
      [3, "ブラックチャリス", 88.6],
    ],
  );
});

Deno.test("parses uma-x overall table", () => {
  const html =
    `<table><tr><th>馬名</th><th>総合</th><th>SP</th><th>AG</th><th>実績</th></tr><tr><td>10ナムラクララ</td><td>58</td><td>55</td><td>49</td><td>44</td></tr></table>`;
  const result = normalizeSourcePage(SOURCE_PROFILES[2], {
    html,
    url: "x",
    route: "direct",
    capturedAt: "x",
  });
  assertEquals(result.horses[0], {
    horseNumber: 10,
    horseName: "ナムラクララ",
    rawScore: 58,
    rank: 1,
  });
});

Deno.test("parses kichiuma SP table", () => {
  const html =
    `<table><tr><th>馬</th><th>評価</th><th>SP<br>能力値</th><th>競　走　馬　名</th></tr><tr><td>13</td><td>◎</td><td>88.8</td><td>ルシード</td></tr></table>`;
  const result = normalizeSourcePage(SOURCE_PROFILES[3], {
    html,
    url: "x",
    route: "direct",
    capturedAt: "x",
  });
  assertEquals(result.horses[0], {
    horseNumber: 13,
    horseName: "ルシード",
    rawScore: 88.8,
    comment: "◎",
    rank: 1,
  });
});
Deno.test("quorum needs two sources and a numeric source", () => {
  const base = {
    sourceUrl: "x",
    capturedAt: "x",
    route: "direct" as const,
    status: "ok" as const,
    horses: [],
    missingFields: [],
  };
  assertEquals(
    hasEvidenceQuorum([{ ...base, source: "a", numeric: false }, {
      ...base,
      source: "b",
      numeric: true,
    }]).ready,
    true,
  );
});
