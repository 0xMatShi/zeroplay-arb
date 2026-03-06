// ── DexSport WebSocket protocol types ──────────────────────────

export interface DexsportOutcome {
  lid: string;
  price: number; // decimal odds (e.g. 1.85)
  status: number; // 3 = active
  isFrozen: boolean;
  isBetBuilderSupported: boolean;
}

export interface DexsportMarket {
  lid: string;
  sortIndex: number;
  intervalSortIndex?: number;
  tabSortIndex?: Record<string, number>;
  outcomes: DexsportOutcome[];
}

export interface DexsportEvent {
  lid: string;
  status: number; // 3 = active/live
  startTime: number; // unix seconds
  name?: string; // present in format=long
  matchWinnerId?: string | null;
  mainMarketIds?: (string | null)[];
  marketIds?: string[];
  hasScoreboard?: boolean;
  willBeLive?: boolean;
  topIndex?: number;
  tier?: number;
}

export interface DexsportDiscipline {
  lid: string;
  pid: string; // "1" = prematch, "2" = live
  id: string; // sport slug, e.g. "football"
  name?: string;
  shortName?: string;
  slug?: string;
  tournamentIds?: string[];
}

export interface DexsportTournament {
  lid: string;
  eventIds?: string[];
  name?: string;
}

export interface DexsportProfileResponse {
  id: string;
  guest?: boolean;
  currency?: { name: string };
  token: string;
}

// ── Internal cache types ────────────────────────────────────────

export interface CachedEvent {
  event: DexsportEvent;
  /** First non-null main market, if received */
  mainMarket?: DexsportMarket;
  sportSlug: string; // e.g. "football", "csgo"
  disciplineId: string; // e.g. "2.football"
}
