(function (root) {
  const settlementOf = (bet) =>
    Array.isArray(bet.settlements) ? bet.settlements[0] : bet.settlements;
  const round = (value, digits = 4) => Number(value.toFixed(digits));

  function validationStats(bets) {
    const settled = bets.filter((bet) => {
      const probability = Number(bet.estimated_probability);
      return settlementOf(bet) && bet.estimated_probability != null &&
        Number.isFinite(probability) &&
        probability >= 0 && probability <= 1;
    });
    if (!settled.length) {
      return {
        count: 0,
        predictedRate: 0,
        observedRate: 0,
        calibrationGap: 0,
        brierScore: 0,
      };
    }
    const points = settled.map((bet) => ({
      predicted: Number(bet.estimated_probability),
      outcome: settlementOf(bet).is_hit ? 1 : 0,
    }));
    const predictedRate = points.reduce((sum, x) => sum + x.predicted, 0) /
      points.length;
    const observedRate = points.reduce((sum, x) => sum + x.outcome, 0) /
      points.length;
    const brierScore = points.reduce(
      (sum, x) => sum + (x.predicted - x.outcome) ** 2,
      0,
    ) / points.length;
    return {
      count: points.length,
      predictedRate: round(predictedRate),
      observedRate: round(observedRate),
      calibrationGap: round(Math.abs(predictedRate - observedRate)),
      brierScore: round(brierScore),
    };
  }

  function strategyStats(bets, strategy) {
    const settled = bets.filter((bet) =>
      bet.strategy === strategy && settlementOf(bet)
    );
    const staked = settled.reduce((sum, bet) => sum + Number(bet.stake), 0);
    const returned = settled.reduce(
      (sum, bet) => sum + Number(settlementOf(bet).return_amount),
      0,
    );
    const hits = settled.filter((bet) => settlementOf(bet).is_hit).length;
    return {
      settled: settled.length,
      staked,
      returned,
      profit: returned - staked,
      roi: staked ? returned / staked * 100 : 0,
      hit: settled.length ? hits / settled.length * 100 : 0,
      ...validationStats(settled),
    };
  }

  root.RaceAnalytics = { validationStats, strategyStats };
})(globalThis);
