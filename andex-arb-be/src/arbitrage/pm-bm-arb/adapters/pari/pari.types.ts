export interface PariSportEntry {
  id: number;
  kind: 'sport' | 'segment';
  parentId?: number;
  name: string;
}

export interface PariEvent {
  id: number;
  sportId: number;
  kind: number;
  level: number;
  noEventView?: boolean;
  parentId?: number;
  team1: string;
  team2?: string;
  name: string;
  place: 'live' | 'line';
  startTime: number; // Unix seconds
}

export interface PariFactor {
  f: number; // factor ID
  v: number; // decimal odds (0 = suspended)
}

export interface PariCustomFactors {
  e: number; // eventId
  factors: PariFactor[];
}

export interface PariListResponse {
  packetVersion: number;
  sports?: PariSportEntry[];
  events?: PariEvent[];
  customFactors?: PariCustomFactors[];
}
