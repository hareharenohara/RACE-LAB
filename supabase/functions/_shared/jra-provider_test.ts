import { parsePastRunsHtml } from "./jra-provider.ts";

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
        <div class="Data02"><a href="/race/202603010701/">テスト特別</a></div>
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
  assertEquals(run.raceName, "テスト特別", "race name");
  assertEquals(run.surface, "turf", "surface");
  assertEquals(run.distance, 2600, "distance");
  assertEquals(run.condition, "良", "condition");
  assertEquals(run.finishPosition, 2, "finish position");
  assertEquals(run.popularity, 4, "popularity");
  assertEquals(run.finishTime, "2:44.3", "finish time");
  assertEquals(run.last3f, 36.4, "last 3f");
  assertEquals(run.margin, 1.6, "margin");
  assertEquals(run.jockey, "長浜鴻緒", "jockey");
  assertEquals(run.weightCarried, 55, "weight carried");
  assertEquals(run.horseWeight, 470, "horse weight");
  assertEquals(run.runnerCount, 15, "runner count");
});

Deno.test("unrelated and incomplete cells are ignored", () => {
  const html = `<tr class="HorseList">
    <td class="Horse_Info"><a href="/horse/1/">A</a></td>
    <td class="Past"></td><td class="Other" id="myhorse_2">not a run</td>
  </tr>`;
  assertEquals(parsePastRunsHtml(html), [], "invalid cells");
});
