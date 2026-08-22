import { assertEquals } from "jsr:@std/assert@1.0.14";
import { errorMessage } from "./error-message.ts";

Deno.test("keeps Error messages readable", () => {
  assertEquals(errorMessage(new Error("network failed")), "network failed");
});

Deno.test("formats Supabase structured errors instead of object Object", () => {
  assertEquals(
    errorMessage({
      message: "constraint failed",
      details: "odds_high must be greater than odds_low",
      code: "23514",
    }),
    "constraint failed / odds_high must be greater than odds_low / 23514",
  );
});
