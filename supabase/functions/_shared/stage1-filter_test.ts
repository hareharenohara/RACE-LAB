import { assertEquals } from "jsr:@std/assert@1.0.14";
import { applyStage1Filter } from "./stage1-filter.ts";

Deno.test("stage1 keeps a normal allowance race", () => {
  assertEquals(
    applyStage1Filter({ raceName: "3歳以上1勝クラス", runnerCount: 14 }),
    { eligible: true, reasons: [] },
  );
});

Deno.test("stage1 explains every exclusion", () => {
  const result = applyStage1Filter({
    raceName: "2歳未勝利 ハンデ",
    runnerCount: 18,
  });
  assertEquals(result.eligible, false);
  assertEquals(result.reasons, [
    "MAIDEN",
    "HANDICAP",
    "TWO_YEAR_OLD",
    "TOO_MANY_RUNNERS",
  ]);
});
