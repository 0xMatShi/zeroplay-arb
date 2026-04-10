export interface FonbetSportEntry {
  id: number;
  kind: 'sport' | 'segment';
  parentId?: number;
  name: string;
}

export interface FonbetEvent {
  id: number;
  sportId: number;
  kind: number;
  level: number;
  noEventView?: boolean;
  parentId?: number;
  team1: string;
  team2?: string;
  name: string;
  place: 'live' | 'line' | 'notActive';
  startTime: number; // Unix seconds
}

export interface FonbetFactor {
  f: number;    // factor ID
  v: number;    // decimal odds (0 = suspended)
  pt?: string;  // handicap/total line text (e.g. "+5.5", "-5.5", "223.5")
}

export interface FonbetCustomFactors {
  e: number; // eventId
  factors: FonbetFactor[];
}

export interface FonbetListResponse {
  packetVersion: number;
  sports?: FonbetSportEntry[];
  events?: FonbetEvent[];
  customFactors?: FonbetCustomFactors[];
}
