export interface SourceIdentity {
  horseNumber: number;
  horseName: string;
  externalId?: string;
}
export interface IdentityCheck {
  horseNumber: number;
  sourceHorseName: string;
  canonicalHorseName?: string;
  sourceExternalId?: string;
  canonicalExternalId?: string;
  status: "exact" | "normalized" | "mismatch";
  reason?: string;
}

export const normalizeHorseName = (value: string) =>
  value.normalize("NFKC").replace(/[\s\u3000]+/gu, "").trim();

export function verifySourceIdentities(
  source: SourceIdentity[],
  canonical: SourceIdentity[],
): IdentityCheck[] {
  const canonicalByNumber = new Map(
    canonical.map((entry) => [entry.horseNumber, entry]),
  );
  const seen = new Set<number>();
  return source.map((entry) => {
    const match = canonicalByNumber.get(entry.horseNumber);
    if (seen.has(entry.horseNumber)) {
      return {
        horseNumber: entry.horseNumber,
        sourceHorseName: entry.horseName,
        sourceExternalId: entry.externalId,
        status: "mismatch",
        reason: "DUPLICATE_SOURCE_HORSE_NUMBER",
      };
    }
    seen.add(entry.horseNumber);
    if (!match) {
      return {
        horseNumber: entry.horseNumber,
        sourceHorseName: entry.horseName,
        sourceExternalId: entry.externalId,
        status: "mismatch",
        reason: "HORSE_NUMBER_NOT_FOUND",
      };
    }
    const common = {
      horseNumber: entry.horseNumber,
      sourceHorseName: entry.horseName,
      canonicalHorseName: match.horseName,
      sourceExternalId: entry.externalId,
      canonicalExternalId: match.externalId,
    };
    if (
      entry.externalId && match.externalId && entry.externalId !== match.externalId
    ) {
      return { ...common, status: "mismatch" as const, reason: "EXTERNAL_ID_MISMATCH" };
    }
    if (entry.horseName.trim() === match.horseName.trim()) {
      return { ...common, status: "exact" as const };
    }
    if (normalizeHorseName(entry.horseName) === normalizeHorseName(match.horseName)) {
      return { ...common, status: "normalized" as const };
    }
    return { ...common, status: "mismatch" as const, reason: "HORSE_NAME_MISMATCH" };
  });
}

export const identitySummary = (checks: IdentityCheck[]) =>
  checks.some((check) => check.status === "mismatch")
    ? "failed"
    : checks.length
    ? "verified"
    : "partial";

export async function sha256Json(value: unknown) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
