export type DailyBankrollMode = "normal" | "attack" | "locked";

export type DailyBankrollState = {
  openingBalance: number;
  currentBalance: number;
  peakBalance: number;
  peakProfitRate: number;
  lockProfitRate: number;
  lossFloor: number;
  lockBalance: number;
  hardFloor: number;
  riskCapacity: number;
  mode: DailyBankrollMode;
};

const DAILY_RATCHET: readonly [number, number][] = [
  [0.30, 0.22],
  [0.20, 0.14],
  [0.15, 0.10],
  [0.10, 0.06],
  [0.075, 0.04],
  [0.05, 0.025],
  [0.03, 0.015],
  [0.0225, 0.01],
];

export function dailyLockProfitRate(peakProfitRate: number): number {
  return DAILY_RATCHET.find(([trigger]) => peakProfitRate + 1e-9 >= trigger)?.[1] ?? 0;
}

export function calculateDailyBankrollState(
  openingBalance: number,
  currentBalance: number,
  previousPeakBalance = openingBalance,
  openReservations = 0,
): DailyBankrollState {
  const peakBalance = Math.max(openingBalance, previousPeakBalance, currentBalance);
  const peakProfitRate = peakBalance / openingBalance - 1;
  const lockProfitRate = dailyLockProfitRate(peakProfitRate);
  const lossFloor = Math.ceil(openingBalance * 0.965);
  const lockBalance = lockProfitRate > 0
    ? Math.ceil(openingBalance * (1 + lockProfitRate))
    : lossFloor;
  const hardFloor = Math.max(lossFloor, lockBalance);
  const available = currentBalance - openReservations;
  const riskCapacity = Math.max(0, Math.floor((available - hardFloor) / 100) * 100);
  const targetReached = peakProfitRate + 1e-9 >= 0.0225;
  return {
    openingBalance,
    currentBalance,
    peakBalance,
    peakProfitRate,
    lockProfitRate,
    lossFloor,
    lockBalance,
    hardFloor,
    riskCapacity,
    mode: riskCapacity < 100 ? "locked" : targetReached ? "attack" : "normal",
  };
}

export function allocateDailyRiskBudget(
  openingBalance: number,
  races: { raceId: string; weight: number }[],
): Map<string, number> {
  const units = Math.floor(openingBalance * 0.035 / 100);
  const positive = races.map((race) => ({ ...race, weight: Math.max(1, race.weight) }));
  const totalWeight = positive.reduce((sum, race) => sum + race.weight, 0);
  const allocations = positive.map((race, index) => {
    const exact = units * race.weight / totalWeight;
    return { ...race, index, units: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = units - allocations.reduce((sum, race) => sum + race.units, 0);
  for (const race of [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining-- <= 0) break;
    race.units++;
  }
  return new Map(allocations.map((race) => [race.raceId, race.units * 100]));
}

export function currentRaceBudget(
  state: DailyBankrollState,
  initialBudget: number,
  futureReservedBudgets: number,
): number {
  if (state.mode === "locked") return 0;
  if (state.mode === "attack") return state.riskCapacity;
  const carryAvailable = Math.max(0, state.riskCapacity - futureReservedBudgets);
  return Math.min(state.riskCapacity, Math.max(initialBudget, carryAvailable));
}
