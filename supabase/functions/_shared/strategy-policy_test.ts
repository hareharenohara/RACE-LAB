import { STRATEGY_POLICIES, strategyPrompt } from "./strategy-policy.ts";
const assert = (x: boolean, m: string) => {
  if (!x) throw new Error(m);
};
Deno.test("risk limits increase by strategy", () => {
  const c = STRATEGY_POLICIES.conservative,
    b = STRATEGY_POLICIES.balanced,
    a = STRATEGY_POLICIES.aggressive;
  assert(
    c.minimumExpectedValue > b.minimumExpectedValue &&
      b.minimumExpectedValue > a.minimumExpectedValue,
    "EV order",
  );
  assert(
    c.maxStakePerDay < b.maxStakePerDay && b.maxStakePerDay < a.maxStakePerDay,
    "stake order",
  );
});
Deno.test("prompt includes hard limits and skip reference", () => {
  const p = strategyPrompt("conservative", 100000);
  assert(
    p.includes("1.12") && p.includes("reference_pick") && p.includes("100000"),
    "prompt contract",
  );
});
