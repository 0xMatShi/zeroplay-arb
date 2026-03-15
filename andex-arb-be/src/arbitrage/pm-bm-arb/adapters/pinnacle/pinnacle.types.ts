// ── Pinnacle888 REST API response types ────────────────────────

export interface PinnacleMoneyLine {
  lineId: number;
  homePrice: string;
  awayPrice: string;
  drawPrice?: string;
  unavailable: boolean;
  offline: boolean;
}

export interface PinnacleHandicap {
  lineId: number;
  isAlt: boolean;
  homeSpread: string;
  awaySpread: string;
  homeOdds: string;
  awayOdds: string;
  unavailable: boolean;
  offline: boolean;
}

export interface PinnacleOverUnder {
  lineId: number;
  isAlt: boolean;
  points: string;
  overOdds: string;
  underOdds: string;
  unavailable: boolean;
  offline: boolean;
}

export interface PinnaclePeriod {
  moneyLine?: PinnacleMoneyLine;
  handicap?: Array<PinnacleHandicap | { unavailable: true }>;
  overUnder?: Array<PinnacleOverUnder | { unavailable: true }>;
  indexMainLineHdp?: number;
  indexMainLineOU?: number;
}

export interface PinnacleParticipant {
  name: string;
  englishName: string;
  type: 'HOME' | 'AWAY';
  fav: boolean;
}

export interface PinnacleEvent {
  id: number;
  parentId: number;
  time: number; // Unix ms
  /** Present in FULL_ODDS; may be absent in UPDATE_ODDS partial events */
  participants?: PinnacleParticipant[];
  moreBet: number;
  /** Key = period number (0=full match, 3=map3, 4=map4, ...) */
  periods: Record<string, PinnaclePeriod>;
  live: boolean;
  homeTeamType: number;
  awayTeamType: number;
  parlayRestriction: number;
  rotNum: string;
  /**
   * Betting unit for this event variant.
   * Tennis has two events per match: "Sets" (moneyline = match winner) and "Games" (no moneyline).
   * We strip "(Sets)"/"(Games)" etc. from participant names when building the event name.
   */
  resultingUnit?: string;
  /** "Live Now" | "Pre Match" etc. */
  runningState?: string;
  hasLiveStream: boolean;
  hasScoreboard: boolean;
}

export interface PinnacleLeague {
  sportId: number;
  id: number;
  name: string;
  leagueCode: string;
  gameCode: string; // 'cs2' | 'dota-2' | 'valorant' | 'lol' | '' (regular sports)
  container: string;
  events: PinnacleEvent[];
  seqNo: number;
}

export interface PinnacleOddsResponse {
  sportId: number;
  version: number;
  leagues: PinnacleLeague[];
  refreshAll: boolean;
}
