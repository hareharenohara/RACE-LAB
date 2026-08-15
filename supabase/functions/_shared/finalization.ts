export function marketKey(type: string, horses: unknown[]): string {
  return `${type}:${horses.map(Number).sort((a, b) => a - b).join("-")}`;
}

export function resolveFinalMarkets(
  bets: Array<Record<string, any>>,
  markets: Array<Record<string, any>>,
) {
  const byKey = new Map(
    markets.map((market) => [marketKey(market.type, market.horses), market]),
  );
  return bets.map((bet) => {
    const market = byKey.get(marketKey(bet.bet_type, bet.horses));
    if (!market) {
      throw new Error(`MARKET_ODDS_NOT_FOUND:${bet.bet_type}:${bet.horses}`);
    }
    return { bet, market };
  });
}
