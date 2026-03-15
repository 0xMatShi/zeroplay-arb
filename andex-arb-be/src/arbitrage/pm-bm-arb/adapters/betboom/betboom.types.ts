// ── BetBoom / SporthHub Protobuf protocol — internal parsed types ──
//
// BetBoom uses a binary Protobuf WebSocket protocol (wss://ru-ws2.sporthub.bet:444).
// These types represent the in-memory result of decoding raw Protobuf messages.

// ── Decoded ModelsStake ────────────────────────────────────────

export interface BbStake {
  stakeId: string;
  matchId: string;
  isActive: boolean;
  isLive: boolean;
  /** Outcome label, e.g. "1", "2", "X", "Over", "Under" */
  name: string;
  /** Decimal odds (wire type 1 = double) */
  factor: number;
  /** Market category, e.g. "Результат" */
  marketName: string;
  /** Market group, e.g. "Winner" */
  groupName: string;
  /** Period label, e.g. "Main", "1st half" */
  periodName: string;
}

// ── Decoded MatchInfo ──────────────────────────────────────────

export interface BbMatchInfo {
  id: string;
  isActive: boolean;
  sportId: number;
  tournamentId: string;
  /** ISO 8601 datetime string, e.g. "2025-03-14T18:00:00" */
  startDttm: string;
  home: string;
  away: string;
}

// ── Decoded ModelsMatch ────────────────────────────────────────

export interface BbMatch {
  info: BbMatchInfo;
  stakes: BbStake[];
}

