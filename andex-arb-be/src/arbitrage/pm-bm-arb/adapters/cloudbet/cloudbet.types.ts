/**
 * Internal types for CloudbetAdapter.
 */

// ── Sport config ───────────────────────────────────────────────────────────────

/** Per-sport REST/WS configuration */
export interface CbSportConfig {
  /** Canonical sport key used by the pipeline (e.g. "csgo", "hockey") */
  sportKey: string;
  /** Cloudbet REST/WS sport slug (e.g. "counter-strike", "ice-hockey") */
  cbSlug: string;
  /** Cloudbet market key for the moneyline market (e.g. "basketball.moneyline") */
  marketKey: string;
  // No submarket field: each moneyline/winner market has exactly one submarket,
  // so we always take the first (and only) entry from market.submarkets.
  /** Additional market keys to fetch and expose (totals, handicap, etc.) */
  extraMarketKeys?: string[];
}

// ── REST API types ─────────────────────────────────────────────────────────────

/** Raw event as returned by GET /pub/v2/odds/events (inside competitions[].events) */
export interface CbEventRaw {
  id: number;
  name: string;
  status: string;              // "TRADING_LIVE" | "TRADING" | "SUSPENDED" | etc.
  startTime?: string;          // ISO-8601, e.g. "2026-03-16T17:00:00Z"
  cutoffTime?: string;
  home?: CbTeam;
  away?: CbTeam;
  markets: Record<string, CbMarket>;
  /** Enriched by adapter from parent competition object */
  sportKey: string;
  competitionKey: string;
  competitionName: string;
}

export interface CbTeam {
  name: string;
  key: string;
  abbreviation?: string;
  nationality?: string;
}

/** Market returned by REST (keyed by market key, e.g. "soccer.match_odds") */
export interface CbMarket {
  submarkets: Record<string, CbSubmarket>;
  liability?: number;
}

/**
 * Submarket keyed by specifier string, e.g.:
 *   "period=ft"
 *   "period=ot&period=ft"
 *   "period=default"
 */
export interface CbSubmarket {
  sequence: string;
  selections: CbSelection[];
}

export interface CbSelection {
  /** "home" | "away" | "draw" | "yes" | "no" */
  outcome: string;
  /** Non-empty for parameterised selections, e.g. "handicap=2.25". Empty for main moneyline. */
  params: string;
  /** Decimal odds */
  price: number;
  minStake?: number;
  maxStake?: number;
  probability?: number;
  status: string;   // "SELECTION_ENABLED" | "SELECTION_DISABLED"
  side: string;     // "BACK" | "LAY"
  marketUrl?: string;
}

// ── WebSocket (Pusher) types ───────────────────────────────────────────────────

/**
 * Outer envelope of a Cloudbet Pusher message (after base64 + gunzip):
 *   base64(gzip({ uuid, index, chunk, final }))
 */
export interface CbWsOuter {
  uuid: string;
  index: number;
  chunk: string;  // base64-encoded piece of the inner JSON
  final: boolean;
}

/**
 * Inner WS update payload (after assembling chunks + base64 decode).
 * Contains a partial event: only fields that changed are present.
 */
export interface CbWsUpdate {
  id?: number;
  status?: string;
  markets?: Record<string, CbMarket>;
}

/**
 * Payload of a live list update (v6_live_events_list_update topic).
 */
export interface CbWsLiveListUpdate {
  action: 'LIST_ADD' | 'LIST_REMOVE';
  events: CbWsLiveEvent[];
}

/** Minimal event data from the live list update */
export interface CbWsLiveEvent {
  id: number;
  name?: string;
  status?: string;
  startTime?: string;
  cutoffTime?: string;
  home?: CbTeam;
  away?: CbTeam;
  sport?: { key: string; name: string };
  competition?: { key: string; name: string };
}
