import {
  inferRaceClass,
  parsePastRunsHtml,
  parseRaceListHtml,
  validateRaceSchedule,
} from "./jra-provider.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)}`);
  }
};

Deno.test("past-five page is parsed for every runner without per-horse requests", () => {
  const html = `
    <table class="Shutuba_Past5_Table"><tbody><tr class="HorseList">
      <td class="Horse_Info"><a href="https://db.netkeiba.com/horse/2023105726/">テストホース</a></td>
      <td class="Past" id="myhorse_202603010701">
        <div class="Data01"><span>2026.04.18 福島</span><span class="Num">2</span></div>
        <div class="Data02"><a href="/race/202603010701/">3歳1勝クラス</a></div>
        <div class="Data03">15頭 10番 4人 長浜鴻緒 55.0</div>
        <div class="Data05">芝2600 2:44.3 良</div>
        <div class="Data06">1-1-1-2 (36.4) 470(-14)</div>
        <div class="Data07">勝ち馬 (1.6)</div>
      </td>
    </tr></tbody></table>`;
  const [run] = parsePastRunsHtml(html);
  assertEquals(run.externalHorseId, "2023105726", "horse id");
  assertEquals(run.sourceRaceId, "202603010701", "race id");
  assertEquals(run.raceDate, "2026-04-18", "date");
  assertEquals(run.track, "福島", "track");
  assertEquals(run.raceName, "3歳1勝クラス", "race name");
  assertEquals(run.raceClass, "1win", "race class");
  assertEquals(run.surface, "turf", "surface");
  assertEquals(run.distance, 2600, "distance");
  assertEquals(run.condition, "良", "condition");
  assertEquals(run.finishPosition, 2, "finish position");
  assertEquals(run.popularity, 4, "popularity");
  assertEquals(run.finishTime, "2:44.3", "finish time");
  assertEquals(run.cornerPositions, [1, 1, 1, 2], "corner positions");
  assertEquals(run.last3f, 36.4, "last 3f");
  assertEquals(run.margin, 1.6, "margin");
  assertEquals(run.jockey, "長浜鴻緒", "jockey");
  assertEquals(run.weightCarried, 55, "weight carried");
  assertEquals(run.horseWeight, 470, "horse weight");
  assertEquals(run.runnerCount, 15, "runner count");
});

Deno.test("race classes are normalized from free-form names", () => {
  assertEquals(inferRaceClass("天皇賞（秋）GⅠ"), "G1", "grade one");
  assertEquals(inferRaceClass("3歳未勝利"), "maiden", "maiden");
  assertEquals(inferRaceClass("4歳以上2勝クラス"), "2win", "allowance");
});

Deno.test("unrelated and incomplete cells are ignored", () => {
  const html = `<tr class="HorseList">
    <td class="Horse_Info"><a href="/horse/1/">A</a></td>
    <td class="Past"></td><td class="Other" id="myhorse_2">not a run</td>
  </tr>`;
  assertEquals(parsePastRunsHtml(html), [], "invalid cells");
});

Deno.test("race list uses the time from the same race item", () => {
  const padding = " ".repeat(2500);
  const html = `<ul><li class="RaceList_DataItem">
    <a href="../race/shutuba.html?race_id=202604020801">1R</a>${padding}
    <span class="ItemTitle">2歳未勝利</span>
    <span class="RaceList_Itemtime">09:40 </span>
    <span class="RaceList_ItemLong Turf">芝1600m</span>
  </li><li class="RaceList_DataItem">
    <a href="../race/shutuba.html?race_id=202604020802">2R</a>
    <span class="ItemTitle">3歳未勝利</span>
    <span class="RaceList_Itemtime">10:10 </span>
    <span class="RaceList_ItemLong Dart">ダ1200m</span>
  </li></ul>`;
  const races = parseRaceListHtml(html, "2026-08-16");
  assertEquals(races.map((race) => race.startTime), [
    "2026-08-16T09:40:00+09:00",
    "2026-08-16T10:10:00+09:00",
  ], "race times");
  assertEquals(races[0].surface, "turf", "turf surface");
  assertEquals(races[1].surface, "dirt", "dirt surface");
});

Deno.test("missing race time fails closed instead of defaulting to 09:00", () => {
  let failed = false;
  try {
    parseRaceListHtml(
      `<li class="RaceList_DataItem"><a href="shutuba.html?race_id=202604020801">1R</a></li>`,
      "2026-08-16",
    );
  } catch (error) {
    failed = String(error).includes("JRA_RACE_TIME_MISSING");
  }
  if (!failed) throw new Error("missing time was accepted");
});

Deno.test("an implausible all-identical schedule is rejected", () => {
  let failed = false;
  try {
    validateRaceSchedule([
      {
        externalId: "jra:1",
        raceDate: "2026-08-16",
        track: "札幌",
        raceNumber: 1,
        raceName: "A",
        startTime: "2026-08-16T09:00:00+09:00",
        sourceUrl: "a",
      },
      {
        externalId: "jra:2",
        raceDate: "2026-08-16",
        track: "札幌",
        raceNumber: 2,
        raceName: "B",
        startTime: "2026-08-16T09:00:00+09:00",
        sourceUrl: "b",
      },
    ], "2026-08-16");
  } catch (error) {
    failed = String(error).includes("JRA_RACE_SCHEDULE_SUSPICIOUS");
  }
  if (!failed) throw new Error("identical schedule was accepted");
});

Deno.test("more than the JRA daily maximum of 36 races is rejected", () => {
  const races = Array.from({ length: 37 }, (_, index) => ({
    externalId: `jra:${index}`,
    raceDate: "2026-08-16",
    track: `会場${Math.floor(index / 12)}`,
    raceNumber: index % 12 + 1,
    raceName: `Race ${index}`,
    startTime: `2026-08-16T${
      String(9 + Math.floor(index / 6)).padStart(2, "0")
    }:${index % 6}0:00+09:00`,
    sourceUrl: `https://example.test/${index}`,
  }));
  let failed = false;
  try {
    validateRaceSchedule(races, "2026-08-16");
  } catch (error) {
    failed = String(error).includes("race_count_37_exceeds_36");
  }
  if (!failed) throw new Error("37-race schedule was accepted");
});

Deno.test("duplicate track and race number slots are rejected", () => {
  const race = {
    externalId: "jra:1",
    raceDate: "2026-08-16",
    track: "札幌",
    raceNumber: 1,
    raceName: "A",
    startTime: "2026-08-16T09:00:00+09:00",
    sourceUrl: "https://example.test/1",
  };
  let failed = false;
  try {
    validateRaceSchedule([
      race,
      { ...race, externalId: "jra:2", startTime: "2026-08-16T09:30:00+09:00" },
    ], "2026-08-16");
  } catch (error) {
    failed = String(error).includes("duplicate_track_race_number");
  }
  if (!failed) throw new Error("duplicate race slot was accepted");
});
