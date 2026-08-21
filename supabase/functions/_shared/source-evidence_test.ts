import {
  filterVerifiedSourceHorses,
  identitySummary,
  normalizeHorseName,
  verifySourceIdentities,
} from "./source-evidence.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("horse names only normalize Unicode and whitespace", () => {
  assert(normalizeHorseName(" アルファ　スター ") === "アルファスター", "space normalization failed");
  assert(normalizeHorseName("ＡＢＣ") === "ABC", "NFKC normalization failed");
});

Deno.test("identity requires the same horse number and compatible name", () => {
  const checks = verifySourceIdentities(
    [{ horseNumber: 4, horseName: "アルファ スター", externalId: "h4" }],
    [{ horseNumber: 4, horseName: "アルファスター", externalId: "h4" }],
  );
  assert(checks[0].status === "normalized", "normalized match was rejected");
  assert(identitySummary(checks) === "verified", "verified summary missing");
});

Deno.test("same name on another horse number is rejected", () => {
  const checks = verifySourceIdentities(
    [{ horseNumber: 5, horseName: "アルファスター" }],
    [{ horseNumber: 4, horseName: "アルファスター" }],
  );
  assert(checks[0].reason === "HORSE_NUMBER_NOT_FOUND", "number mismatch accepted");
  assert(identitySummary(checks) === "failed", "mismatch summary missing");
});

Deno.test("external id disagreement is rejected even when the name matches", () => {
  const checks = verifySourceIdentities(
    [{ horseNumber: 4, horseName: "アルファスター", externalId: "wrong" }],
    [{ horseNumber: 4, horseName: "アルファスター", externalId: "h4" }],
  );
  assert(checks[0].reason === "EXTERNAL_ID_MISMATCH", "external id mismatch accepted");
});

Deno.test("duplicate source horse numbers are rejected", () => {
  const checks = verifySourceIdentities(
    [
      { horseNumber: 4, horseName: "アルファスター" },
      { horseNumber: 4, horseName: "アルファスター" },
    ],
    [{ horseNumber: 4, horseName: "アルファスター" }],
  );
  assert(checks[1].reason === "DUPLICATE_SOURCE_HORSE_NUMBER", "duplicate accepted");
});

Deno.test("verified horse filtering keeps valid signals and reports partial evidence", () => {
  const filtered = filterVerifiedSourceHorses(
    [
      { horseNumber: 4, horseName: "アルファスター", rank: 1 },
      { horseNumber: 5, horseName: "別の馬", rank: 2 },
    ],
    [
      { horseNumber: 4, horseName: "アルファスター" },
      { horseNumber: 5, horseName: "ベータスター" },
    ],
  );
  assert(filtered.horses.length === 1, "mismatched signal was not removed");
  assert(filtered.horses[0].horseNumber === 4, "valid signal was removed");
  assert(filtered.identityStatus === "partial", "partial status missing");
});

Deno.test("verified horse filtering rejects an entirely mismatched source", () => {
  const filtered = filterVerifiedSourceHorses(
    [{ horseNumber: 9, horseName: "不明馬" }],
    [{ horseNumber: 4, horseName: "アルファスター" }],
  );
  assert(filtered.horses.length === 0, "mismatched source was accepted");
  assert(filtered.identityStatus === "failed", "failed status missing");
});
