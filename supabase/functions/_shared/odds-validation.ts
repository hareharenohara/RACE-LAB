const MIN_USABLE_ODDS = 1.01;
const MAX_USABLE_ODDS = 999;

export type OddsValidation = {
  valid: boolean;
  reason: "ODDS_UNAVAILABLE" | "ODDS_RANGE_INVALID" | null;
};

/** Rejects pre-sale placeholders and malformed range markets. */
export function validateMarketOdds(market: {
  type: string;
  odds: number;
  oddsMax?: number;
}): OddsValidation {
  const low = Number(market.odds);
  if (!Number.isFinite(low) || low < MIN_USABLE_ODDS || low > MAX_USABLE_ODDS) {
    return { valid: false, reason: "ODDS_UNAVAILABLE" };
  }
  if (["place", "wide"].includes(market.type)) {
    const high = Number(market.oddsMax);
    if (!Number.isFinite(high) || high < low || high > MAX_USABLE_ODDS) {
      return { valid: false, reason: "ODDS_RANGE_INVALID" };
    }
  }
  return { valid: true, reason: null };
}

/** Fixed-price markets sometimes arrive with oddsMax=0 as a provider placeholder. */
export function oddsHighForStorage(market: {
  type: string;
  oddsMax?: number | null;
}): number | null {
  if (!["place", "wide"].includes(market.type)) return null;
  const high = Number(market.oddsMax);
  return Number.isFinite(high) && high > 0 ? high : null;
}
