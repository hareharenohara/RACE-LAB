export type Strategy = "conservative" | "balanced" | "aggressive";
export type BetType =
  | "win"
  | "place"
  | "wide"
  | "quinella"
  | "exacta"
  | "trio"
  | "trifecta";

export interface RaceOdds {
  type: BetType;
  horses: number[];
  odds: number;
  oddsMax?: number;
  popularity?: number;
}

export interface RaceSummary {
  externalId: string;
  raceDate: string;
  track: string;
  raceNumber: number;
  raceName: string;
  raceClass?: string;
  startTime: string;
  surface?: "turf" | "dirt" | "jump";
  distance?: number;
  condition?: string;
  weather?: string;
  runnerCount?: number;
  sourceUrl: string;
}

export interface Entry {
  umaxScores: { horse_id: string };
  horseNumber: number;
  gateNumber?: number;
  horseName: string;
  sex?: string;
  age?: number;
  jockey?: string;
  trainer?: string;
  weightCarried?: number;
  horseWeight?: number;
  horseWeightDelta?: number;
  winOdds?: number;
  placeOddsLow?: number;
  placeOddsHigh?: number;
  popularity?: number;
  sourceData: Record<string, number | string | null>;
}

export interface RaceDetail extends RaceSummary {
  entries: Entry[];
  pastRuns: Record<string, PastRun[]>;
}

export interface PastRun {
  raceDate?: string;
  track?: string;
  raceName?: string;
  raceClass?: string;
  surface?: string;
  distance?: number;
  condition?: string;
  finishPosition?: number;
  popularity?: number;
  odds?: number;
  finishTime?: string;
  cornerPositions?: number[];
  last3f?: number;
  margin?: number;
  jockey?: string;
  weightCarried?: number;
  horseWeight?: number;
  runnerCount?: number;
}

export interface RaceDataProvider {
  getRaceList(date: string): Promise<RaceSummary[]>;
  getRaceDetail(race: RaceSummary): Promise<RaceDetail>;
}
