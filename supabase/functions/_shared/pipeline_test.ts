import { nextAnalysisChunk } from "./pipeline.ts";

Deno.test("all 36 races are covered once across resource-safe chunks", () => {
  const races = Array.from({ length: 36 }, (_, index) => index + 1);
  const processed: number[] = [];
  let offset = 0, calls = 0, complete = false;
  while (!complete) {
    const chunk = nextAnalysisChunk(races, offset, 4);
    processed.push(...chunk.items);
    offset = chunk.nextOffset;
    complete = chunk.complete;
    calls++;
  }
  if (calls !== 9) throw new Error(`expected 9 chunks, got ${calls}`);
  if (JSON.stringify(processed) !== JSON.stringify(races)) {
    throw new Error("race coverage is incomplete or duplicated");
  }
});

Deno.test("chunk size is capped to protect Edge Function resources", () => {
  const chunk = nextAnalysisChunk([1, 2, 3, 4, 5, 6], 0, 99);
  if (chunk.items.length !== 4) throw new Error("unsafe chunk size accepted");
});
